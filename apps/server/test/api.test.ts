import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, legacyRedirect } from '../src/app.js';
import { configSchema, type AppConfig, type ServerConfig } from '../src/config.js';
import { resolveSecret } from '../src/secret.js';

const logger = pino({ level: 'silent' });
const pgUrl = process.env.JSMYDATA_TEST_PG;

function makeApp(dir: string, servers: ServerConfig[], extra: Partial<AppConfig> = {}) {
  const config = { ...configSchema.parse({}), SqliteDir: dir, ...extra } as AppConfig;
  const webDir = join(dir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>JsMyData</title>');
  return createApp({
    config,
    servers,
    secret: resolveSecret('cle-de-test-pour-les-sessions-1234'),
    logger,
    webDir,
    defaultConfig: true,
  });
}

const sqliteServer: ServerConfig = {
  id: 'sqlite',
  engine: 'sqlite',
  verbose: 'SQLite',
  auth_type: 'cookie',
  AllowRoot: true,
  AllowNoPassword: false,
  autoDetected: true,
};

describe('API — SQLite', () => {
  let dir: string;
  let ctx: ReturnType<typeof makeApp>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-api-'));
    const db = new Database(join(dir, 'chinook.sqlite'));
    db.exec(
      `CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO artist(name) VALUES ('Satie');`,
    );
    db.close();
    ctx = makeApp(dir, [sqliteServer]);
  });
  afterAll(async () => {
    await ctx.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /health', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('liste les serveurs et les fichiers SQLite, sans secret', async () => {
    const res = await request(ctx.app).get('/api/v1/servers');
    expect(res.status).toBe(200);
    expect(res.body.defaultConfig).toBe(true);
    expect(res.body.defaultColorMode).toBe('auto');
    expect(res.body.servers[0]).toMatchObject({
      id: 'sqlite',
      engine: 'sqlite',
      needsFile: true,
      files: ['chinook.sqlite'],
    });
  });

  it('applique les en-têtes de sécurité', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('refuse une requête modifiante sans jeton CSRF', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ server: 'sqlite', file: 'chinook.sqlite' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF');
  });

  it('refuse l’accès aux données sans connexion', async () => {
    const res = await request(ctx.app).get('/api/v1/srv/sqlite/databases');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NOT_LOGGED_IN');
  });

  it('refuse un fichier hors du dossier autorisé', async () => {
    const agent = request.agent(ctx.app);
    const { body } = await agent.get('/api/v1/auth/me');
    const res = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send({ server: 'sqlite', file: '../../etc/passwd.db' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SQLITE_OUTSIDE_DIR');
  });

  it('parcours complet : connexion, bases, tables, colonnes, info, déconnexion', async () => {
    const agent = request.agent(ctx.app);
    const me0 = await agent.get('/api/v1/auth/me');
    expect(me0.body.authenticated).toBe(false);

    const login = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me0.body.csrfToken)
      .send({ server: 'sqlite', file: 'chinook.sqlite' });
    expect(login.status).toBe(200);
    expect(login.body.authenticated).toBe(true);
    expect(login.body.servers[0]).toMatchObject({ id: 'sqlite', user: 'chinook.sqlite' });
    expect(login.body.servers[0].capabilities.users).toBe(false);
    // La session est régénérée : le cookie change et le jeton CSRF aussi.
    const csrf = login.body.csrfToken;

    const dbs = await agent.get('/api/v1/srv/sqlite/databases');
    expect(dbs.body.databases).toEqual([{ name: 'main', system: false }]);

    const tables = await agent.get('/api/v1/srv/sqlite/db/main/tables');
    expect(tables.body.tables).toEqual([expect.objectContaining({ name: 'artist', kind: 'table', rows: 1 })]);

    const cols = await agent.get('/api/v1/srv/sqlite/db/main/tables/artist/columns');
    expect(cols.body.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name']);

    const info = await agent.get('/api/v1/srv/sqlite/info');
    expect(info.body).toMatchObject({ engine: 'sqlite', product: 'SQLite', driver: 'better-sqlite3' });

    const out = await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrf).send({});
    expect(out.body.authenticated).toBe(false);
    expect((await agent.get('/api/v1/srv/sqlite/databases')).status).toBe(401);
  });

  it('les identifiants ne quittent jamais le serveur', async () => {
    const agent = request.agent(ctx.app);
    const me = await agent.get('/api/v1/auth/me');
    const login = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({ server: 'sqlite', file: 'chinook.sqlite', password: 'ne-doit-pas-fuiter' });
    expect(JSON.stringify(login.body)).not.toContain('ne-doit-pas-fuiter');
    expect(String(login.headers['set-cookie'] ?? '')).not.toContain('ne-doit-pas-fuiter');
  });

  it('sert le client et redirige les anciennes URL phpMyAdmin', async () => {
    const page = await request(ctx.app).get('/server/sqlite/databases');
    expect(page.status).toBe(200);
    expect(page.text).toContain('JsMyData');
    const legacy = await request(ctx.app).get('/index.php?route=/table/sql&db=shop&table=orders&server=1');
    expect(legacy.status).toBe(302);
    expect(legacy.headers.location).toBe('/server/1/db/shop/table/orders/sql');
    expect((await request(ctx.app).get('/api/v1/inconnu')).status).toBe(404);
  });

  it('limite les tentatives de connexion échouées', async () => {
    const limited = makeApp(
      dir,
      [{ ...sqliteServer, engine: 'mysql', id: 'm', host: '127.0.0.1', port: 1 }],
      {
        LoginMaxFailures: 2,
      },
    );
    const agent = request.agent(limited.app);
    const { body } = await agent.get('/api/v1/auth/me');
    const attempt = () =>
      agent
        .post('/api/v1/auth/login')
        .set('x-csrf-token', body.csrfToken)
        .send({ server: 'm', user: 'u', password: 'p' });
    expect((await attempt()).status).toBe(502);
    expect((await attempt()).status).toBe(502);
    const third = await attempt();
    expect(third.status).toBe(429);
    await limited.manager.closeAll();
  });

  it('applique AllowRoot et AllowNoPassword', async () => {
    const strict = makeApp(dir, [
      {
        ...sqliteServer,
        engine: 'mysql',
        id: 'm',
        host: '127.0.0.1',
        port: 1,
        AllowRoot: false,
        AllowNoPassword: false,
      },
    ]);
    const agent = request.agent(strict.app);
    const { body } = await agent.get('/api/v1/auth/me');
    const root = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send({ server: 'm', user: 'root', password: 'x' });
    expect(root.body.code).toBe('ROOT_DENIED');
    const empty = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', body.csrfToken)
      .send({ server: 'm', user: 'app', password: '' });
    expect(empty.body.code).toBe('EMPTY_PASSWORD_DENIED');
    await strict.manager.closeAll();
  });
});

describe.skipIf(!pgUrl)('API — PostgreSQL', () => {
  let dir: string;
  let ctx: ReturnType<typeof makeApp>;
  const u = pgUrl ? new URL(pgUrl) : null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-api-pg-'));
    ctx = makeApp(dir, [
      {
        id: 'pg',
        engine: 'postgres',
        host: u!.hostname,
        port: Number(u!.port || 5432),
        database: 'postgres',
        auth_type: 'cookie',
        AllowRoot: true,
        AllowNoPassword: false,
        autoDetected: false,
        hide_db: '^template',
      },
    ]);
  });
  afterAll(async () => {
    await ctx.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('connexion, schémas et tables du catalogue', async () => {
    const agent = request.agent(ctx.app);
    const me = await agent.get('/api/v1/auth/me');
    const bad = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({ server: 'pg', user: decodeURIComponent(u!.username), password: 'mauvais' });
    expect(bad.status).toBe(400);
    expect(bad.body.sqlState).toBe('28P01');

    const login = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({
        server: 'pg',
        user: decodeURIComponent(u!.username),
        password: decodeURIComponent(u!.password),
      });
    expect(login.status).toBe(200);
    expect(login.body.servers[0].capabilities.schemas).toBe(true);

    const dbs = await agent.get('/api/v1/srv/pg/databases');
    expect(dbs.body.databases.map((d: { name: string }) => d.name)).toContain('postgres');

    const schemas = await agent.get('/api/v1/srv/pg/db/postgres/schemas');
    expect(schemas.body.schemas.map((s: { name: string }) => s.name)).toContain('public');

    const tables = await agent.get('/api/v1/srv/pg/db/postgres/tables?schema=information_schema');
    expect(tables.body.tables.length).toBeGreaterThan(10);

    const info = await agent.get('/api/v1/srv/pg/info');
    expect(info.body).toMatchObject({ engine: 'postgres', product: 'PostgreSQL', driver: 'pg' });
  });
});

describe('redirections phpMyAdmin', () => {
  it('convertit les routes courantes', () => {
    expect(legacyRedirect({ route: '/server/databases', server: '2' })).toBe('/server/2/databases');
    expect(legacyRedirect({ route: '/database/structure', db: 'shop' })).toBe('/server/1/db/shop/structure');
    expect(legacyRedirect({ route: '/table/structure', db: 'a', table: 'b' })).toBe(
      '/server/1/db/a/table/b/structure',
    );
    expect(legacyRedirect({ route: '/' })).toBe('/');
  });
});
