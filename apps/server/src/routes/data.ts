import {
  type CellValue,
  type DbSearchResponse,
  type EditInfo,
  type FieldMeta,
  type MutationResponse,
  type RowLocator,
  type SortSpec,
  type SqlResponse,
  type StatementResult,
} from '@jsmydata/shared';
import { appendLimit, canAppendLimit, splitStatements } from '@jsmydata/sql/analyze';
import { DialectError, type Connection, type Dialect, type ExecResult } from '@jsmydata/sql';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { Context } from '../context.js';
import { HttpError } from '../errors.js';
import {
  appendCriterion,
  appendInput,
  appendOrderBy,
  appendRowTarget,
  isTextual,
  SqlBuilder,
} from '../sqlgen.js';
import { assertDbAllowed, schemaOf } from './navigation.js';

/** Au-delà, le nombre de lignes affiché est l'estimation du moteur (comme MaxExactCount de phpMyAdmin). */
const MAX_EXACT_COUNT = 50_000;

/* ----------------------------- sérialisation ----------------------------- */

export function serializeCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint')
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  if (v instanceof Uint8Array) {
    return { $binary: v.byteLength, hex: Buffer.from(v.subarray(0, 32)).toString('hex') };
  }
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? String(v) : v.toISOString().replace('T', ' ').replace('Z', '');
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

/* ------------------------------- schémas ------------------------------- */

const cellInput = z.object({ value: z.string().nullable(), fn: z.string().max(40).optional() });
const cellValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ $binary: z.number(), hex: z.string() }),
]);
const locator = z.record(z.string(), cellValue);

const sqlSchema = z.object({
  sql: z.string().min(1).max(5_000_000),
  db: z.string().optional(),
  schema: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  count: z.coerce.number().int().min(1).max(1000).optional(),
  showAll: z.boolean().optional(),
});

const sortSchema = z.array(z.object({ column: z.string(), dir: z.enum(['asc', 'desc']) })).max(10);

const searchSchema = z.object({
  criteria: z
    .array(
      z.object({
        column: z.string(),
        operator: z.string(),
        value: z.string().max(100_000).optional(),
      }),
    )
    .max(500),
  columns: z.array(z.string()).optional(),
  distinct: z.boolean().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  count: z.coerce.number().int().min(1).max(1000).optional(),
  sort: sortSchema.optional(),
});

const dbSearchSchema = z.object({
  words: z.string().min(1).max(1000),
  mode: z.enum(['any', 'all', 'exact', 'regexp']),
  tables: z.array(z.string()).max(1000).optional(),
  column: z.string().optional(),
});

/* ------------------------------- routes ------------------------------- */

export function dataRoutes(ctx: Context): Router {
  const r = Router();
  const { config } = ctx;
  const pageSize = (n?: number) => n ?? config.MaxRows;

  /** Base de travail, vérifiée contre hide_db / only_db. */
  const dbParam = (req: Request, server: ServerConfig) => {
    const db = String(req.params.db);
    assertDbAllowed(server, db);
    return db;
  };

  /** Exécute en mémorisant l'identifiant de session SGBD, pour le bouton « Arrêter ». */
  const run = async (
    req: Request,
    server: ServerConfig,
    conn: Connection,
    sql: string,
    opts: Parameters<Connection['execute']>[1],
  ) => {
    ctx.setRunning(req, server.id!, conn.backendId(opts?.database));
    try {
      return await conn.execute(sql, opts);
    } finally {
      ctx.setRunning(req, server.id!, null);
    }
  };

  const tableColumns = async (conn: Connection, db: string, table: string, schema?: string) => {
    const cols = await conn.listColumns(db, table, schema);
    if (cols.length === 0) throw new HttpError(404, 'UNKNOWN_TABLE', `Table introuvable : ${table}`);
    return cols;
  };

  /**
   * Résultat éditable ? Toutes les colonnes doivent provenir d'une même table
   * et le résultat doit contenir une clé unique de cette table pour localiser chaque ligne.
   */
  const detectEditable = async (
    conn: Connection,
    server: ServerConfig,
    requestDb: string | undefined,
    fields: FieldMeta[],
  ): Promise<EditInfo | null> => {
    if (!fields.length || fields.some((f) => !f.table || !f.column)) return null;
    const first = fields[0]!;
    if (fields.some((f) => f.table !== first.table || f.schema !== first.schema)) return null;
    const table = first.table!;
    const db = server.engine === 'postgres' ? requestDb : (first.schema ?? requestDb);
    if (!db) return null;
    const schema = server.engine === 'postgres' ? (first.schema ?? undefined) : undefined;
    const columns = fields.map((f) => f.column!);
    // Une même colonne deux fois : édition ambiguë.
    if (new Set(columns).size !== columns.length) return null;
    // Comme phpMyAdmin : sans colonne unique dans le résultat, pas d'édition en grille
    // (« Current selection does not contain a unique column »).
    const keys = await conn.uniqueKeys(db, table, schema);
    const key = keys.find((k) => k.every((c) => columns.includes(c)));
    if (!key) return null;
    return { db, schema, table, key, columns };
  };

  const toResult = (
    exec: ExecResult,
    sql: string,
    durationMs: number,
    extra: Partial<StatementResult> = {},
  ): StatementResult => ({
    sql,
    durationMs: Math.round(durationMs * 10) / 10,
    returnsRows: exec.returnsRows,
    ...(exec.returnsRows
      ? { fields: exec.fields, rows: exec.rows.map((row) => row.map(serializeCell)) }
      : { affectedRows: exec.affectedRows ?? 0, insertId: exec.insertId ?? null }),
    ...extra,
  });

  /* ------------------------------ SQL ------------------------------ */

  r.post('/srv/:srv/sql', async (req, res) => {
    const parsed = sqlSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', 'Requête SQL invalide.');
    const body = parsed.data;
    const { conn, server } = await ctx.useConnection(req);
    if (body.db) assertDbAllowed(server, body.db);
    const statements = splitStatements(body.sql, server.engine);
    if (statements.length === 0) throw new HttpError(400, 'EMPTY_QUERY', 'Requête vide.');
    const count = pageSize(body.count);
    const opts = { database: body.db, schema: body.schema, maxRows: config.MaxShowAllRows };
    const out: SqlResponse = { results: [] };

    for (const [index, stmt] of statements.entries()) {
      let sql = stmt.sql;
      let limited = false;
      if (canAppendLimit(sql, server.engine)) {
        sql = body.showAll
          ? appendLimit(sql, config.MaxShowAllRows, 0)
          : appendLimit(sql, count, body.offset);
        limited = true;
      }
      const t0 = performance.now();
      let exec: ExecResult;
      try {
        exec = await run(req, server, conn, sql, opts);
      } catch (err) {
        if (!(err instanceof DialectError)) throw err;
        out.error = {
          code: err.code,
          message: err.message,
          sqlState: err.sqlState,
          errno: err.errno,
          statement: stmt.sql,
          index,
        };
        break;
      }
      const duration = performance.now() - t0;
      const extra: Partial<StatementResult> = {};
      if (exec.returnsRows) {
        extra.limited = limited;
        extra.offset = limited && !body.showAll ? body.offset : 0;
        if (limited && !body.showAll) {
          if (body.offset === 0 && exec.rows.length < count) extra.total = exec.rows.length;
          else {
            // Nombre total : peut échouer (colonnes homonymes dans une sous-requête MySQL) → inconnu.
            const c = await conn
              .execute(`SELECT COUNT(*) AS n FROM (${stmt.sql.replace(/;\s*$/, '')}) jmd_count`, opts)
              .catch(() => null);
            extra.total = c ? Number(c.rows[0]?.[0] ?? 0) : null;
          }
        } else extra.total = exec.rows.length;
        if (out.results.length < 5)
          extra.editable = await detectEditable(conn, server, body.db, exec.fields).catch(() => null);
      }
      out.results.push(toResult(exec, sql, duration, extra));
    }
    res.json(out);
  });

  r.post('/srv/:srv/sql/cancel', async (req, res) => {
    const server = ctx.getServer(req, String(req.params.srv));
    const running = ctx.getRunning(req, server.id!);
    if (!running) return res.json({ cancelled: false });
    const creds = ctx.credentialsFor(req, server);
    if (!creds) throw new HttpError(401, 'NOT_LOGGED_IN', 'Session expirée.');
    const { getDialect } = await import('@jsmydata/sql');
    await getDialect(server.engine).cancel(ctx.connectionParams(server, creds), running.backendId);
    res.json({ cancelled: true });
  });

  /* ---------------------------- Parcourir ---------------------------- */

  const parseSort = (q: unknown): SortSpec[] => {
    const list = Array.isArray(q) ? q : q === undefined ? [] : [q];
    return list
      .map(String)
      .map((s) => {
        const i = s.indexOf(':');
        return { dir: s.slice(0, i) === 'desc' ? 'desc' : 'asc', column: s.slice(i + 1) } as SortSpec;
      })
      .filter((s) => s.column);
  };

  /** Nombre de lignes : exact sous MAX_EXACT_COUNT, sinon estimation du moteur. */
  const countRows = async (
    conn: Connection,
    dialect: Dialect,
    db: string,
    table: string,
    schema?: string,
  ) => {
    let estimate: number | null = null;
    if (conn.engine === 'mysql') {
      const q = await conn.query(
        'SELECT TABLE_ROWS AS n, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [db, table],
      );
      if (String(q.rows[0]?.e ?? '').toLowerCase() !== 'myisam') estimate = Number(q.rows[0]?.n ?? 0);
    } else if (conn.engine === 'postgres') {
      const q = await conn.query(
        `SELECT c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
        [schema ?? 'public', table],
        db,
      );
      estimate = Number(q.rows[0]?.n ?? -1);
    }
    if (estimate !== null && estimate > MAX_EXACT_COUNT) return { total: estimate, estimated: true };
    const q = await conn.execute(`SELECT COUNT(*) FROM ${dialect.qualify(db, table, schema)}`, {
      database: db,
      schema,
    });
    return { total: Number(q.rows[0]?.[0] ?? 0), estimated: false };
  };

  r.get('/srv/:srv/db/:db/tables/:table/rows', async (req, res) => {
    const { conn, server, dialect } = await ctx.useConnection(req);
    const db = dbParam(req, server);
    const table = String(req.params.table);
    const schema = schemaOf(req.query.schema);
    const showAll = req.query.showAll === '1';
    const offset = showAll ? 0 : Math.max(0, Number(req.query.offset ?? 0) || 0);
    const count = showAll
      ? config.MaxShowAllRows
      : Math.min(1000, Math.max(1, Number(req.query.count ?? config.MaxRows) || config.MaxRows));
    const qualified = dialect.qualify(db, table, schema);

    const b = new SqlBuilder(dialect).raw(`SELECT * FROM ${qualified}`);
    appendOrderBy(b, parseSort(req.query.sort));
    b.raw(` LIMIT ${count}${offset ? ` OFFSET ${offset}` : ''}`);
    const t0 = performance.now();
    const exec = await run(req, server, conn, b.sql, {
      database: db,
      schema,
      params: b.params,
      maxRows: config.MaxShowAllRows,
    });
    const duration = performance.now() - t0;
    const { total, estimated } = await countRows(conn, dialect, db, table, schema);
    const editable = await detectEditable(conn, server, db, exec.fields).catch(() => null);
    res.json(
      toResult(exec, b.display, duration, {
        total,
        totalEstimated: estimated,
        offset,
        limited: !showAll,
        editable,
      }),
    );
  });

  /* ----------------------- Insérer / Modifier / Supprimer ----------------------- */

  /** Restreint le localisateur à une clé unique quand il la contient ; sinon toutes les colonnes. */
  const resolveLocator = async (
    conn: Connection,
    db: string,
    table: string,
    schema: string | undefined,
    loc: RowLocator,
  ) => {
    const keys = await conn.uniqueKeys(db, table, schema);
    const key = keys.find((k) => k.every((c) => c in loc));
    if (!key) return { locator: loc, full: true };
    return { locator: Object.fromEntries(key.map((c) => [c, loc[c]!])), full: false };
  };

  const assertColumns = (known: { name: string }[], names: string[]) => {
    const set = new Set(known.map((c) => c.name));
    const bad = names.find((n) => !set.has(n));
    if (bad) throw new HttpError(400, 'UNKNOWN_COLUMN', `Colonne inconnue : ${bad}`);
  };

  r.post('/srv/:srv/db/:db/tables/:table/rows', async (req, res) => {
    const body = z
      .object({
        rows: z.array(z.record(z.string(), cellInput)).min(1).max(500),
        mode: z.enum(['insert', 'ignore', 'replace']).optional(),
      })
      .parse(req.body);
    const { conn, server, dialect } = await ctx.useConnection(req);
    const db = dbParam(req, server);
    const table = String(req.params.table);
    const schema = schemaOf(req.query.schema);
    const columns = await tableColumns(conn, db, table, schema);
    const qualified = dialect.qualify(db, table, schema);
    const mode = body.mode ?? 'insert';
    if (mode === 'replace' && server.engine === 'postgres') {
      throw new HttpError(
        400,
        'UNSUPPORTED',
        'PostgreSQL ne connaît pas REPLACE : utilisez « Ignorer les doublons ».',
      );
    }
    const out: MutationResponse = { sql: [], affectedRows: 0, insertId: null };
    for (const row of body.rows) {
      const names = Object.keys(row);
      assertColumns(columns, names);
      const verb =
        mode === 'replace'
          ? server.engine === 'mysql'
            ? 'REPLACE INTO'
            : 'INSERT OR REPLACE INTO'
          : mode === 'ignore'
            ? server.engine === 'mysql'
              ? 'INSERT IGNORE INTO'
              : server.engine === 'sqlite'
                ? 'INSERT OR IGNORE INTO'
                : 'INSERT INTO'
            : 'INSERT INTO';
      const b = new SqlBuilder(dialect).raw(`${verb} ${qualified}`);
      if (names.length === 0) b.raw(server.engine === 'mysql' ? ' () VALUES ()' : ' DEFAULT VALUES');
      else {
        b.raw(' (');
        names.forEach((n, i) => (i > 0 ? b.raw(', ') : b).ident(n));
        b.raw(') VALUES (');
        names.forEach((n, i) => {
          if (i > 0) b.raw(', ');
          appendInput(b, row[n]!);
        });
        b.raw(')');
      }
      if (mode === 'ignore' && server.engine === 'postgres') b.raw(' ON CONFLICT DO NOTHING');
      const exec = await run(req, server, conn, b.sql, { database: db, schema, params: b.params });
      out.sql.push(b.display);
      out.affectedRows += exec.affectedRows ?? 0;
      if (exec.insertId !== null && exec.insertId !== undefined) out.insertId = exec.insertId;
    }
    res.json(out);
  });

  r.patch('/srv/:srv/db/:db/tables/:table/rows', async (req, res) => {
    const body = z.object({ locator, set: z.record(z.string(), cellInput) }).parse(req.body);
    const { conn, server, dialect } = await ctx.useConnection(req);
    const db = dbParam(req, server);
    const table = String(req.params.table);
    const schema = schemaOf(req.query.schema);
    const columns = await tableColumns(conn, db, table, schema);
    const names = Object.keys(body.set);
    if (names.length === 0) throw new HttpError(400, 'NOTHING_TO_UPDATE', 'Aucune valeur à modifier.');
    assertColumns(columns, [...names, ...Object.keys(body.locator)]);
    const qualified = dialect.qualify(db, table, schema);
    const target = await resolveLocator(conn, db, table, schema, body.locator);
    const b = new SqlBuilder(dialect).raw(`UPDATE ${qualified} SET `);
    names.forEach((n, i) => {
      if (i > 0) b.raw(', ');
      b.ident(n).raw(' = ');
      appendInput(b, body.set[n]!);
    });
    appendRowTarget(b, qualified, target.locator, target.full);
    const exec = await run(req, server, conn, b.sql, { database: db, schema, params: b.params });
    res.json({ sql: [b.display], affectedRows: exec.affectedRows ?? 0 } satisfies MutationResponse);
  });

  r.delete('/srv/:srv/db/:db/tables/:table/rows', async (req, res) => {
    const body = z.object({ locators: z.array(locator).min(1).max(1000) }).parse(req.body);
    const { conn, server, dialect } = await ctx.useConnection(req);
    const db = dbParam(req, server);
    const table = String(req.params.table);
    const schema = schemaOf(req.query.schema);
    const columns = await tableColumns(conn, db, table, schema);
    const qualified = dialect.qualify(db, table, schema);
    const out: MutationResponse = { sql: [], affectedRows: 0 };
    for (const loc of body.locators) {
      assertColumns(columns, Object.keys(loc));
      const target = await resolveLocator(conn, db, table, schema, loc);
      const b = new SqlBuilder(dialect).raw(`DELETE FROM ${qualified}`);
      appendRowTarget(b, qualified, target.locator, target.full);
      const exec = await run(req, server, conn, b.sql, { database: db, schema, params: b.params });
      out.sql.push(b.display);
      out.affectedRows += exec.affectedRows ?? 0;
    }
    res.json(out);
  });

  /* ---------------------------- Rechercher ---------------------------- */

  r.post('/srv/:srv/db/:db/tables/:table/search', async (req, res) => {
    const body = searchSchema.parse(req.body);
    const { conn, server, dialect } = await ctx.useConnection(req);
    const db = dbParam(req, server);
    const table = String(req.params.table);
    const schema = schemaOf(req.query.schema);
    const columns = await tableColumns(conn, db, table, schema);
    const typeOf = new Map(columns.map((c) => [c.name, c.type]));
    const shown = body.columns?.length ? body.columns : null;
    assertColumns(columns, [...(shown ?? []), ...body.criteria.map((c) => c.column)]);
    const qualified = dialect.qualify(db, table, schema);
    const count = pageSize(body.count);

    const where = (b: SqlBuilder) => {
      if (!body.criteria.length) return;
      b.raw(' WHERE ');
      body.criteria.forEach((c, i) => {
        if (i > 0) b.raw(' AND ');
        appendCriterion(b, c as Parameters<typeof appendCriterion>[1], isTextual(typeOf.get(c.column) ?? ''));
      });
    };
    const select = (b: SqlBuilder) => {
      b.raw(body.distinct ? 'SELECT DISTINCT ' : 'SELECT ');
      if (shown) shown.forEach((c, i) => (i > 0 ? b.raw(', ') : b).ident(c));
      else b.raw('*');
      b.raw(` FROM ${qualified}`);
      where(b);
    };

    const b = new SqlBuilder(dialect);
    select(b);
    appendOrderBy(b, body.sort);
    const display = b.display;
    b.raw(` LIMIT ${count}${body.offset ? ` OFFSET ${body.offset}` : ''}`);
    const t0 = performance.now();
    const exec = await run(req, server, conn, b.sql, { database: db, schema, params: b.params });
    const duration = performance.now() - t0;

    const cb = new SqlBuilder(dialect);
    if (body.distinct) {
      cb.raw('SELECT COUNT(*) FROM (');
      select(cb);
      cb.raw(') jmd_count');
    } else {
      cb.raw(`SELECT COUNT(*) FROM ${qualified}`);
      where(cb);
    }
    const c = await conn.execute(cb.sql, { database: db, schema, params: cb.params });
    const editable = body.distinct
      ? null
      : await detectEditable(conn, server, db, exec.fields).catch(() => null);
    res.json(
      toResult(exec, display, duration, {
        total: Number(c.rows[0]?.[0] ?? 0),
        offset: body.offset,
        limited: true,
        editable,
      }),
    );
  });

  /** Onglet Rechercher de la base : occurrences par table (requêtes LIKE / REGEXP). */
  r.post('/srv/:srv/db/:db/search', async (req, res) => {
    const body = dbSearchSchema.parse(req.body);
    const { conn, server, dialect } = await ctx.useConnection(req);
    const db = dbParam(req, server);
    const schema = schemaOf(req.query.schema);
    const all = (await conn.listTables(db, schema)).map((t) => t.name);
    const tables = body.tables?.length ? all.filter((t) => body.tables!.includes(t)) : all;
    const words =
      body.mode === 'any' || body.mode === 'all' ? body.words.split(/\s+/).filter(Boolean) : [body.words];
    const out: DbSearchResponse = { results: [], total: 0 };

    for (const table of tables.slice(0, 500)) {
      const cols = (await conn.listColumns(db, table, schema)).filter(
        (c) => !body.column || c.name === body.column,
      );
      if (!cols.length) continue;
      const qualified = dialect.qualify(db, table, schema);
      const where = (b: SqlBuilder) => {
        b.raw(' WHERE ');
        words.forEach((w, wi) => {
          if (wi > 0) b.raw(body.mode === 'all' ? ' AND ' : ' OR ');
          b.raw('(');
          cols.forEach((c, ci) => {
            if (ci > 0) b.raw(' OR ');
            appendCriterion(
              b,
              { column: c.name, operator: body.mode === 'regexp' ? 'REGEXP' : 'LIKE %...%', value: w },
              isTextual(c.type),
            );
          });
          b.raw(')');
        });
      };
      const cb = new SqlBuilder(dialect).raw(`SELECT COUNT(*) FROM ${qualified}`);
      where(cb);
      const sb = new SqlBuilder(dialect).raw(`SELECT * FROM ${qualified}`);
      where(sb);
      const c = await conn.execute(cb.sql, { database: db, schema, params: cb.params });
      const n = Number(c.rows[0]?.[0] ?? 0);
      out.results.push({ table, count: n, sql: sb.display });
      out.total += n;
    }
    res.json(out);
  });

  return r;
}
