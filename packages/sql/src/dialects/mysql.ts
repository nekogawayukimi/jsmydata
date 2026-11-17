import type { ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo } from '@jsmydata/shared';
import { quoteMysqlIdent, quoteMysqlLiteral } from '../quote.js';
import {
  DialectError,
  type Connection,
  type ConnectionParams,
  type Dialect,
  type ExecOptions,
  type ExecResult,
  type QueryResult,
} from '../types.js';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

type Mysql2 = typeof import('mysql2/promise');

interface MysqlField {
  name: string;
  orgTable?: string;
  orgName?: string;
  db?: string;
  columnType?: number;
  type?: number;
}

/** Noms des types du protocole MySQL (mysql2 donne un numéro). */
const MYSQL_TYPES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINY',
  2: 'SHORT',
  3: 'LONG',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'LONGLONG',
  9: 'INT24',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'NEWDECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINY_BLOB',
  250: 'MEDIUM_BLOB',
  251: 'LONG_BLOB',
  252: 'BLOB',
  253: 'VAR_STRING',
  254: 'STRING',
  255: 'GEOMETRY',
};

function typeName(t: number | undefined): string | null {
  return t === undefined ? null : (MYSQL_TYPES[t] ?? String(t));
}

/** Regroupe les colonnes par index ; écarte les clés contenant une colonne NULL (non fiables pour localiser une ligne). */
export function groupKeys(rows: { idx: string; col: string; nullable: boolean }[]): string[][] {
  const keys = new Map<string, { cols: string[]; nullable: boolean }>();
  for (const r of rows) {
    const k = keys.get(r.idx) ?? { cols: [], nullable: false };
    k.cols.push(r.col);
    k.nullable ||= r.nullable;
    keys.set(r.idx, k);
  }
  return [...keys.values()].filter((k) => !k.nullable).map((k) => k.cols);
}
type MysqlConn = Awaited<ReturnType<Mysql2['createConnection']>>;

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function wrap(err: unknown): DialectError {
  const e = err as { message?: string; code?: string; sqlState?: string; errno?: number };
  return new DialectError(e.message ?? String(err), e.code ?? 'SQL_ERROR', e.sqlState, e.errno);
}

class MysqlConnection implements Connection {
  readonly engine = 'mysql' as const;
  private currentDb: string | undefined;

  constructor(
    private readonly conn: MysqlConn,
    private readonly timeoutMs = 0,
  ) {}

  async query(sql: string, params: unknown[] = [], database?: string): Promise<QueryResult> {
    try {
      if (database) await this.use(database);
      const [result, fields] = await this.conn.query({ sql, values: params, rowsAsArray: false });
      if (Array.isArray(result)) {
        return {
          columns: (fields ?? []).map((f) => f.name),
          rows: result as Record<string, unknown>[],
        };
      }
      const header = result as { affectedRows?: number; insertId?: number };
      return {
        columns: [],
        rows: [],
        affectedRows: header.affectedRows ?? 0,
        insertId: header.insertId ?? null,
      };
    } catch (err) {
      throw wrap(err);
    }
  }

  async serverVersion() {
    const { rows } = await this.query('SELECT VERSION() AS v, @@version_comment AS c');
    const version = String(rows[0]?.v ?? '');
    const comment = String(rows[0]?.c ?? '');
    const product = /mariadb/i.test(version + comment)
      ? 'MariaDB'
      : /percona/i.test(comment)
        ? 'Percona Server'
        : 'MySQL';
    return { product, version: version.split('-')[0] ?? version };
  }

  async currentUser() {
    const { rows } = await this.query('SELECT CURRENT_USER() AS u');
    return String(rows[0]?.u ?? '');
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const { rows } = await this.query(
      'SELECT SCHEMA_NAME AS name, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    return rows.map((r) => ({
      name: String(r.name),
      collation: r.collation ? String(r.collation) : undefined,
      system: SYSTEM_DATABASES.has(String(r.name).toLowerCase()),
    }));
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    return [];
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const { rows } = await this.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_, TABLE_COLLATION AS collation,
              DATA_LENGTH AS dataLength, INDEX_LENGTH AS indexLength, TABLE_COMMENT AS comment
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    );
    return rows.map((r) => {
      const isView = String(r.type) === 'VIEW';
      const engine = r.engine ? String(r.engine) : null;
      return {
        name: String(r.name),
        kind: isView ? 'view' : 'table',
        rows: isView ? null : toNumber(r.rows_),
        rowsEstimated: !isView && engine?.toLowerCase() !== 'myisam',
        engine,
        collation: r.collation ? String(r.collation) : null,
        dataLength: toNumber(r.dataLength),
        indexLength: toNumber(r.indexLength),
        comment: r.comment ? String(r.comment) : null,
      } satisfies TableInfo;
    });
  }

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    const { rows } = await this.query(
      `SELECT ORDINAL_POSITION AS position, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS def, COLLATION_NAME AS collation, COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table],
    );
    return rows.map((r) => ({
      position: Number(r.position),
      name: String(r.name),
      type: String(r.type),
      nullable: String(r.nullable) === 'YES',
      default: r.def === null || r.def === undefined ? null : String(r.def),
      collation: r.collation ? String(r.collation) : null,
      primaryKey: String(r.ckey) === 'PRI',
      extra: r.extra ? String(r.extra) : null,
      comment: r.comment ? String(r.comment) : null,
    }));
  }

  private async use(database: string) {
    if (database === this.currentDb) return;
    await this.conn.query(`USE ${quoteMysqlIdent(database)}`);
    this.currentDb = database;
  }

  async execute(sql: string, opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      if (opts.database) await this.use(opts.database);
      const [result, fields] = await this.conn.query({
        sql,
        values: opts.params,
        rowsAsArray: true,
        ...(this.timeoutMs > 0 ? { timeout: this.timeoutMs } : {}),
      });
      // CALL renvoie plusieurs jeux de résultats : on garde le premier, comme phpMyAdmin.
      let rows = result as unknown;
      let meta = fields as unknown;
      if (Array.isArray(rows) && Array.isArray(meta) && Array.isArray(meta[0])) {
        rows = (rows as unknown[])[0];
        meta = (meta as unknown[])[0];
      }
      // « USE autre_base » saisi par l'utilisateur : la base courante n'est plus connue.
      if (/^\s*use\s/i.test(sql)) this.currentDb = undefined;
      if (Array.isArray(rows)) {
        const list = rows as unknown[][];
        const max = opts.maxRows ?? Infinity;
        return {
          returnsRows: true,
          fields: ((meta as MysqlField[]) ?? []).map((f) => ({
            name: f.name,
            table: f.orgTable || null,
            column: f.orgName || null,
            schema: f.db || null,
            type: typeName(f.columnType ?? f.type),
          })),
          rows: list.length > max ? list.slice(0, max) : list,
          truncated: list.length > max,
        };
      }
      const header = rows as { affectedRows?: number; insertId?: number };
      return {
        returnsRows: false,
        fields: [],
        rows: [],
        affectedRows: header.affectedRows ?? 0,
        insertId: header.insertId ? header.insertId : null,
      };
    } catch (err) {
      throw wrap(err);
    }
  }

  async uniqueKeys(database: string, table: string): Promise<string[][]> {
    const { rows } = await this.query(
      `SELECT s.INDEX_NAME AS idx, s.COLUMN_NAME AS col, c.IS_NULLABLE AS nullable
         FROM information_schema.STATISTICS s
         JOIN information_schema.COLUMNS c
           ON c.TABLE_SCHEMA = s.TABLE_SCHEMA AND c.TABLE_NAME = s.TABLE_NAME AND c.COLUMN_NAME = s.COLUMN_NAME
        WHERE s.TABLE_SCHEMA = ? AND s.TABLE_NAME = ? AND s.NON_UNIQUE = 0
        ORDER BY s.INDEX_NAME = 'PRIMARY' DESC, s.INDEX_NAME, s.SEQ_IN_INDEX`,
      [database, table],
    );
    return groupKeys(
      rows.map((r) => ({ idx: String(r.idx), col: String(r.col), nullable: String(r.nullable) === 'YES' })),
    );
  }

  backendId(): number | null {
    return this.conn.threadId ?? null;
  }

  async close() {
    await this.conn.end().catch(() => this.conn.destroy());
  }
}

export const mysqlDialect: Dialect = {
  engine: 'mysql',
  driver: 'mysql2',
  capabilities: {
    databases: true,
    schemas: false,
    users: true,
    routines: true,
    events: true,
    triggers: true,
    views: true,
    materializedViews: false,
    sequences: false,
    storageEngines: true,
    replication: true,
    processList: true,
    serverVariables: true,
  },
  quoteIdent: quoteMysqlIdent,
  quoteLiteral: quoteMysqlLiteral,
  qualify: (database, table) => `${quoteMysqlIdent(database)}.${quoteMysqlIdent(table)}`,
  placeholder: () => '?',
  async cancel(params: ConnectionParams, backendId: number) {
    const c = await mysqlDialect.connect({ ...params, database: undefined });
    try {
      await c.query(`KILL QUERY ${Math.floor(backendId)}`);
    } finally {
      await c.close();
    }
  },
  async connect(params: ConnectionParams): Promise<Connection> {
    const mysql: Mysql2 = await import('mysql2/promise');
    try {
      const conn = await mysql.createConnection({
        host: params.socket ? undefined : (params.host ?? '127.0.0.1'),
        port: params.socket ? undefined : (params.port ?? 3306),
        socketPath: params.socket,
        user: params.user,
        password: params.password,
        database: params.database,
        connectTimeout: params.connectTimeoutMs ?? 10_000,
        ssl: params.ssl === true ? {} : params.ssl ? params.ssl : undefined,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
        charset: 'utf8mb4',
      });
      return new MysqlConnection(conn, params.queryTimeoutMs ?? 0);
    } catch (err) {
      throw wrap(err);
    }
  },
};
