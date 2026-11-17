import type { ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo } from '@jsmydata/shared';
import { quoteAnsiIdent, quoteAnsiLiteral } from '../quote.js';
import {
  DialectError,
  type Connection,
  type ConnectionParams,
  type Dialect,
  type QueryResult,
} from '../types.js';

type Pg = typeof import('pg');
type PgClient = InstanceType<Pg['Client']>;

function wrap(err: unknown): DialectError {
  const e = err as { message?: string; code?: string };
  // Les codes PostgreSQL sont des SQLSTATE à 5 caractères.
  const sqlState = e.code && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
  return new DialectError(
    e.message ?? String(err),
    sqlState ? 'SQL_ERROR' : (e.code ?? 'SQL_ERROR'),
    sqlState,
  );
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Une connexion PostgreSQL est liée à une base : on garde un client par base consultée,
 * ouvert à la demande avec les mêmes identifiants.
 */
class PostgresConnection implements Connection {
  readonly engine = 'postgres' as const;
  private readonly clients = new Map<string, Promise<PgClient>>();

  constructor(
    private readonly pg: Pg,
    private readonly params: ConnectionParams,
    private readonly defaultDb: string,
    first: PgClient,
  ) {
    this.clients.set(defaultDb, Promise.resolve(first));
  }

  private client(database?: string): Promise<PgClient> {
    const db = database ?? this.defaultDb;
    let c = this.clients.get(db);
    if (!c) {
      c = openClient(this.pg, { ...this.params, database: db });
      c.catch(() => this.clients.delete(db));
      this.clients.set(db, c);
    }
    return c;
  }

  async query(sql: string, params: unknown[] = [], database?: string): Promise<QueryResult> {
    try {
      const client = await this.client(database);
      const res = await client.query({ text: sql, values: params });
      const r = Array.isArray(res) ? res[res.length - 1] : res;
      return {
        columns: (r.fields ?? []).map((f: { name: string }) => f.name),
        rows: r.rows ?? [],
        affectedRows: r.command === 'SELECT' ? undefined : (r.rowCount ?? 0),
      };
    } catch (err) {
      throw wrap(err);
    }
  }

  async serverVersion() {
    const { rows } = await this.query('SHOW server_version');
    const v = String(rows[0]?.server_version ?? '');
    return { product: 'PostgreSQL', version: v.split(' ')[0] ?? v };
  }

  async currentUser() {
    const { rows } = await this.query('SELECT current_user AS u');
    return String(rows[0]?.u ?? '');
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const { rows } = await this.query(
      `SELECT datname AS name, datcollate AS collation, datname IN ('postgres') AS system
         FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`,
    );
    return rows.map((r) => ({
      name: String(r.name),
      collation: String(r.collation ?? ''),
      system: Boolean(r.system),
    }));
  }

  async listSchemas(database: string): Promise<SchemaInfo[]> {
    const { rows } = await this.query(
      `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
              (n.nspname IN ('pg_catalog', 'information_schema') OR n.nspname LIKE 'pg\\_toast%' OR n.nspname LIKE 'pg\\_temp%') AS system
         FROM pg_namespace n
        WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
        ORDER BY system, n.nspname`,
      [],
      database,
    );
    return rows.map((r) => ({
      name: String(r.name),
      owner: String(r.owner ?? ''),
      system: Boolean(r.system),
    }));
  }

  async listTables(database: string, schema = 'public'): Promise<TableInfo[]> {
    const { rows } = await this.query(
      `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS rows_,
              pg_table_size(c.oid) AS data_length, pg_indexes_size(c.oid) AS index_length,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY c.relname`,
      [schema],
      database,
    );
    return rows.map((r) => {
      const k = String(r.kind);
      const kind = k === 'v' ? 'view' : k === 'm' ? 'materialized_view' : 'table';
      const rowsN = toNumber(r.rows_);
      return {
        name: String(r.name),
        kind,
        rows: kind === 'view' ? null : rowsN !== null && rowsN < 0 ? null : rowsN,
        rowsEstimated: kind !== 'view',
        engine: k === 'p' ? 'partitioned' : k === 'f' ? 'foreign' : null,
        dataLength: toNumber(r.data_length),
        indexLength: toNumber(r.index_length),
        comment: r.comment ? String(r.comment) : null,
      } satisfies TableInfo;
    });
  }

  async listColumns(database: string, table: string, schema = 'public'): Promise<ColumnInfo[]> {
    const { rows } = await this.query(
      `SELECT a.attnum AS position, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def,
              co.collname AS collation, a.attidentity AS identity, a.attgenerated AS generated,
              col_description(c.oid, a.attnum) AS comment,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0 AND co.collname <> 'default'
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table],
      database,
    );
    return rows.map((r) => {
      const identity = String(r.identity ?? '');
      const generated = String(r.generated ?? '');
      const extra =
        identity === 'a'
          ? 'GENERATED ALWAYS AS IDENTITY'
          : identity === 'd'
            ? 'GENERATED BY DEFAULT AS IDENTITY'
            : generated === 's'
              ? 'GENERATED ALWAYS AS (…) STORED'
              : null;
      return {
        position: Number(r.position),
        name: String(r.name),
        type: String(r.type),
        nullable: Boolean(r.nullable),
        default: r.def === null || r.def === undefined ? null : String(r.def),
        collation: r.collation ? String(r.collation) : null,
        primaryKey: Boolean(r.pk),
        extra,
        comment: r.comment ? String(r.comment) : null,
      };
    });
  }

  async close() {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => p.then((c) => c.end()).catch(() => undefined)));
  }
}

async function openClient(pg: Pg, params: ConnectionParams): Promise<PgClient> {
  const client = new pg.Client({
    host: params.socket ?? params.host ?? '127.0.0.1',
    port: params.port ?? 5432,
    user: params.user,
    password: params.password,
    database: params.database ?? 'postgres',
    connectionTimeoutMillis: params.connectTimeoutMs ?? 10_000,
    ssl: params.ssl === true ? { rejectUnauthorized: false } : params.ssl ? params.ssl : undefined,
    application_name: 'JsMyData',
  });
  // Une erreur réseau après connexion ne doit pas faire tomber le processus.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

let typesConfigured = false;

export const postgresDialect: Dialect = {
  engine: 'postgres',
  driver: 'pg',
  capabilities: {
    databases: true,
    schemas: true,
    users: true,
    routines: true,
    events: false,
    triggers: true,
    views: true,
    materializedViews: true,
    sequences: true,
    storageEngines: false,
    replication: true,
    processList: true,
    serverVariables: true,
  },
  quoteIdent: quoteAnsiIdent,
  quoteLiteral: quoteAnsiLiteral,
  async connect(params: ConnectionParams): Promise<Connection> {
    const mod = await import('pg');
    const pg = ((mod as unknown as { default?: Pg }).default ?? mod) as Pg;
    if (!typesConfigured) {
      // Affichage fidèle : dates, horodatages et grands entiers restent des chaînes, comme dans phpMyAdmin.
      for (const oid of [1082, 1114, 1184, 20, 1700]) pg.types.setTypeParser(oid, (v: string) => v);
      typesConfigured = true;
    }
    const db = params.database ?? 'postgres';
    try {
      const first = await openClient(pg, { ...params, database: db });
      return new PostgresConnection(pg, params, db, first);
    } catch (err) {
      throw wrap(err);
    }
  },
};
