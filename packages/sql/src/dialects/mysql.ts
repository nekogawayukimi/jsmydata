import type { ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo } from '@jsmydata/shared';
import { quoteMysqlIdent, quoteMysqlLiteral } from '../quote.js';
import {
  DialectError,
  type Connection,
  type ConnectionParams,
  type Dialect,
  type QueryResult,
} from '../types.js';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

type Mysql2 = typeof import('mysql2/promise');
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
  constructor(private readonly conn: MysqlConn) {}

  async query(sql: string, params: unknown[] = [], database?: string): Promise<QueryResult> {
    try {
      if (database) await this.conn.query(`USE ${quoteMysqlIdent(database)}`);
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
      return new MysqlConnection(conn);
    } catch (err) {
      throw wrap(err);
    }
  },
};
