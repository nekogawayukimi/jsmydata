import type { ServerInfo } from '@jsmydata/shared';
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import type { Context } from '../context.js';
import { HttpError } from '../errors.js';
import { APP_VERSION } from '../version.js';

export function filterDatabases<T extends { name: string }>(server: ServerConfig, list: T[]): T[] {
  let out = list;
  if (server.only_db?.length) out = out.filter((d) => server.only_db!.includes(d.name));
  if (server.hide_db) {
    const re = new RegExp(server.hide_db);
    out = out.filter((d) => !re.test(d.name));
  }
  return out;
}

export function assertDbAllowed(server: ServerConfig, db: string) {
  if (filterDatabases(server, [{ name: db }]).length === 0) {
    throw new HttpError(403, 'DB_HIDDEN', `Base non accessible : ${db}`);
  }
}

export const schemaOf = (q: unknown) => (typeof q === 'string' && q ? q : undefined);

/** Informations serveur et arborescence : bases, schémas, tables, colonnes, clés. */
export function navigationRoutes(ctx: Context): Router {
  const r = Router();

  r.get('/srv/:srv/info', async (req, res) => {
    const { conn, server, dialect } = await ctx.useConnection(req);
    const v = await conn.serverVersion();
    const info: ServerInfo = {
      engine: server.engine,
      product: v.product,
      version: v.version,
      user: await conn.currentUser(),
      host:
        server.engine === 'sqlite'
          ? 'fichier local'
          : server.socket
            ? `Localhost via UNIX socket (${server.socket})`
            : `${server.host ?? '127.0.0.1'}:${server.port ?? (server.engine === 'postgres' ? 5432 : 3306)}`,
      ssl: Boolean(server.ssl),
      driver: dialect.driver,
      nodeVersion: process.version,
      appVersion: APP_VERSION,
    };
    res.json(info);
  });

  r.get('/srv/:srv/databases', async (req, res) => {
    const { conn, server } = await ctx.useConnection(req);
    res.json({ databases: filterDatabases(server, await conn.listDatabases()) });
  });

  r.get('/srv/:srv/db/:db/schemas', async (req, res) => {
    const { conn, server } = await ctx.useConnection(req);
    assertDbAllowed(server, String(req.params.db));
    res.json({ schemas: await conn.listSchemas(String(req.params.db)) });
  });

  r.get('/srv/:srv/db/:db/tables', async (req, res) => {
    const { conn, server } = await ctx.useConnection(req);
    const db = String(req.params.db);
    assertDbAllowed(server, db);
    res.json({ tables: await conn.listTables(db, schemaOf(req.query.schema)) });
  });

  r.get('/srv/:srv/db/:db/tables/:table/columns', async (req, res) => {
    const { conn, server } = await ctx.useConnection(req);
    const db = String(req.params.db);
    assertDbAllowed(server, db);
    const schema = schemaOf(req.query.schema);
    const table = String(req.params.table);
    const [columns, keys] = await Promise.all([
      conn.listColumns(db, table, schema),
      conn.uniqueKeys(db, table, schema),
    ]);
    res.json({ columns, uniqueKeys: keys });
  });

  return r;
}
