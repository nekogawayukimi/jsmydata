import type { ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo } from '@jsmydata/shared';
import { firstKeyword } from '../analyze.js';
import { quoteAnsiIdent, quoteAnsiLiteral } from '../quote.js';
import {
  DialectError,
  type Connection,
  type ConnectionParams,
  type Dialect,
  type ExecOptions,
  type ExecResult,
  type QueryResult,
} from '../types.js';

type BetterSqlite3 = typeof import('better-sqlite3');
type Db = InstanceType<BetterSqlite3>;

function wrap(err: unknown): DialectError {
  const e = err as { message?: string; code?: string };
  return new DialectError(e.message ?? String(err), e.code ?? 'SQL_ERROR');
}

/**
 * SQLite : un fichier = un « serveur ». Les « bases » sont main, temp et les bases attachées.
 * better-sqlite3 est synchrone ; les appels restent courts en lot 0 (navigation, introspection).
 */
class SqliteConnection implements Connection {
  readonly engine = 'sqlite' as const;
  constructor(
    private readonly db: Db,
    private readonly file: string,
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    try {
      const stmt = this.db.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all(...params) as Record<string, unknown>[];
        return { columns: stmt.columns().map((c) => c.name), rows };
      }
      const info = stmt.run(...params);
      return { columns: [], rows: [], affectedRows: info.changes, insertId: Number(info.lastInsertRowid) };
    } catch (err) {
      throw wrap(err);
    }
  }

  async serverVersion() {
    const { rows } = await this.query('SELECT sqlite_version() AS v');
    return { product: 'SQLite', version: String(rows[0]?.v ?? '') };
  }

  async currentUser() {
    return this.file;
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const { rows } = await this.query('PRAGMA database_list');
    return rows
      .filter((r) => String(r.name) !== 'temp')
      .map((r) => ({ name: String(r.name), system: false }));
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    return [];
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const q = quoteAnsiIdent(database);
    const { rows } = await this.query(
      `SELECT name, type FROM ${q}.sqlite_schema
        WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY name`,
    );
    const tables: TableInfo[] = [];
    for (const r of rows) {
      const name = String(r.name);
      const isView = String(r.type) === 'view';
      let count: number | null = null;
      if (!isView) {
        // Comptage exact : SQLite n'a pas d'estimation. Borné pour ne pas bloquer sur de très grosses tables.
        const c = await this.query(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q}.${quoteAnsiIdent(name)} LIMIT 1000001)`,
        );
        count = Number(c.rows[0]?.n ?? 0);
      }
      tables.push({
        name,
        kind: isView ? 'view' : 'table',
        rows: count !== null && count > 1_000_000 ? 1_000_000 : count,
        rowsEstimated: count !== null && count > 1_000_000,
        engine: null,
      });
    }
    return tables;
  }

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    const { rows } = await this.query(
      `SELECT cid, name, type, "notnull" AS nn, dflt_value AS def, pk, hidden FROM pragma_table_xinfo(?, ?)`,
      [table, database],
    );
    return rows.map((r) => {
      const hidden = Number(r.hidden ?? 0);
      return {
        position: Number(r.cid) + 1,
        name: String(r.name),
        type: String(r.type || ''),
        nullable: Number(r.nn) === 0,
        default: r.def === null || r.def === undefined ? null : String(r.def),
        primaryKey: Number(r.pk) > 0,
        extra:
          hidden === 2
            ? 'GENERATED ALWAYS AS (…) VIRTUAL'
            : hidden === 3
              ? 'GENERATED ALWAYS AS (…) STORED'
              : null,
      };
    });
  }

  async execute(sql: string, opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const stmt = this.db.prepare(sql);
      const params = opts.params ?? [];
      if (stmt.reader) {
        stmt.safeIntegers(true);
        const fields = stmt.columns().map((c) => ({
          name: c.name,
          table: c.table ?? null,
          column: c.column ?? null,
          schema: c.database ?? null,
          type: c.type ?? null,
        }));
        const max = opts.maxRows ?? Infinity;
        const rows: unknown[][] = [];
        let truncated = false;
        for (const row of stmt.raw(true).iterate(...params) as Iterable<unknown[]>) {
          if (rows.length >= max) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        return { returnsRows: true, fields, rows, truncated };
      }
      const info = stmt.run(...params);
      const verb = firstKeyword(sql, 'sqlite');
      return {
        returnsRows: false,
        fields: [],
        rows: [],
        affectedRows: info.changes,
        insertId:
          (verb === 'INSERT' || verb === 'REPLACE') && info.changes > 0 ? String(info.lastInsertRowid) : null,
      };
    } catch (err) {
      throw wrap(err);
    }
  }

  async uniqueKeys(database: string, table: string): Promise<string[][]> {
    const cols = await this.query(
      `SELECT name, pk, "notnull" AS nn FROM pragma_table_xinfo(?, ?) ORDER BY pk`,
      [table, database],
    );
    const keys: string[][] = [];
    const pk = cols.rows.filter((r) => Number(r.pk) > 0).map((r) => String(r.name));
    if (pk.length) keys.push(pk);
    const notNull = new Set(cols.rows.filter((r) => Number(r.nn) === 1).map((r) => String(r.name)));
    const idx = await this.query(
      `SELECT name FROM pragma_index_list(?, ?) WHERE "unique" = 1 AND origin <> 'pk' AND partial = 0 ORDER BY name`,
      [table, database],
    );
    for (const r of idx.rows) {
      const parts = await this.query(`SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno`, [
        String(r.name),
        database,
      ]);
      const names = parts.rows.map((p) => (p.name === null ? null : String(p.name)));
      if (names.length && names.every((n): n is string => n !== null && notNull.has(n)))
        keys.push(names as string[]);
    }
    return keys;
  }

  backendId(): number | null {
    return null;
  }

  async close() {
    this.db.close();
  }
}

export const sqliteDialect: Dialect = {
  engine: 'sqlite',
  driver: 'better-sqlite3',
  capabilities: {
    databases: true,
    schemas: false,
    users: false,
    routines: false,
    events: false,
    triggers: true,
    views: true,
    materializedViews: false,
    sequences: false,
    storageEngines: false,
    replication: false,
    processList: false,
    serverVariables: true,
  },
  quoteIdent: quoteAnsiIdent,
  quoteLiteral: quoteAnsiLiteral,
  qualify: (database, table) => `${quoteAnsiIdent(database)}.${quoteAnsiIdent(table)}`,
  placeholder: () => '?',
  async cancel() {
    throw new DialectError('SQLite ne permet pas d’annuler une requête en cours.', 'CANCEL_UNSUPPORTED');
  },
  async connect(params: ConnectionParams): Promise<Connection> {
    if (!params.file) throw new DialectError('Aucun fichier SQLite indiqué', 'SQLITE_NO_FILE');
    const mod = await import('better-sqlite3');
    const Database = ((mod as unknown as { default?: BetterSqlite3 }).default ?? mod) as BetterSqlite3;
    try {
      const db = new Database(params.file, { readonly: params.readOnly ?? false, fileMustExist: false });
      db.pragma('foreign_keys = ON');
      // REGEXP n'existe pas nativement dans SQLite : fonction fournie pour l'onglet Rechercher.
      db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
        if (pattern === null || value === null) return null;
        try {
          return new RegExp(String(pattern), 'u').test(String(value)) ? 1 : 0;
        } catch {
          return 0;
        }
      });
      return new SqliteConnection(db, params.file);
    } catch (err) {
      throw wrap(err);
    }
  },
};
