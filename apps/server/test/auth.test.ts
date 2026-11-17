import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSignonToken, verifySignonToken } from '../src/signon.js';
import { makeApp, server } from './helpers.js';

const pgUrl = process.env.JSMYDATA_TEST_PG;
const pg = pgUrl ? new URL(pgUrl) : null;
const pgUser = pg ? decodeURIComponent(pg.username) : '';
const pgPass = pg ? decodeURIComponent(pg.password) : '';
const SIGNON_SECRET = 'secret-partage-signon-0123456789';

describe('jetons signon', () => {
  it('vérifie signature, expiration et durée maximale', () => {
    const now = 1_000_000;
    const t = createSignonToken(SIGNON_SECRET, { server: 's', user: 'u', password: 'p', exp: now + 60 });
    expect(verifySignonToken(SIGNON_SECRET, t, now)).toMatchObject({ server: 's', user: 'u' });
    expect(() => verifySignonToken('autre-secret-0123456789', t, now)).toThrow(/Signature/);
    expect(() => verifySignonToken(SIGNON_SECRET, t, now + 120)).toThrow(/expiré/);
    const long = createSignonToken(SIGNON_SECRET, { server: 's', user: 'u', exp: now + 3600 });
    expect(() => verifySignonToken(SIGNON_SECRET, long, now)).toThrow(/trop longue/);
    expect(() => verifySignonToken(SIGNON_SECRET, 'abc', now)).toThrow(/mal formé/);
  });
});

describe('serveur saisi librement', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-arb-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('est refusé hors configuration par défaut sans AllowArbitraryServer', async () => {
    const { app, manager } = makeApp(dir, [], {}, false);
    const agent = request.agent(app);
    const me = await agent.get('/api/v1/auth/me');
    const servers = await agent.get('/api/v1/servers');
    expect(servers.body.allowArbitrary).toBe(false);
    const res = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({ server: '__arbitrary__', engine: 'mysql', host: 'db.local', user: 'u', password: 'p' });
    expect(res.body.code).toBe('ARBITRARY_DENIED');
    await manager.closeAll();
  });

  it('refuse un nom d’hôte invalide', async () => {
    const { app, manager } = makeApp(dir, []);
    const agent = request.agent(app);
    const me = await agent.get('/api/v1/auth/me');
    const res = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({ server: '__arbitrary__', host: 'a b;rm', user: 'u', password: 'p' });
    expect(res.body.code).toBe('BAD_HOST');
    await manager.closeAll();
  });

  it.skipIf(!pg)('se connecte à un PostgreSQL saisi à la main et le garde dans la session', async () => {
    const { app, manager } = makeApp(dir, []);
    const agent = request.agent(app);
    const me = await agent.get('/api/v1/auth/me');
    const res = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({
        server: '__arbitrary__',
        engine: 'postgres',
        host: pg!.hostname,
        port: Number(pg!.port || 5432),
        user: pgUser,
        password: pgPass,
      });
    expect(res.status).toBe(200);
    const srv = res.body.servers[0];
    expect(srv).toMatchObject({ engine: 'postgres', verbose: `${pg!.hostname}:${pg!.port || 5432}` });
    const dbs = await agent.get(`/api/v1/srv/${srv.id}/databases`);
    expect(dbs.status).toBe(200);
    await manager.closeAll();
  });
});

describe.skipIf(!pg)('authentification http et signon (PostgreSQL)', () => {
  let dir: string;
  let ctx: ReturnType<typeof makeApp>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-auth-'));
    const base = {
      engine: 'postgres' as const,
      host: pg!.hostname,
      port: Number(pg!.port || 5432),
      database: 'postgres',
    };
    ctx = makeApp(
      dir,
      [
        server({ id: 'h', auth_type: 'http', verbose: 'PG http', ...base }),
        server({
          id: 's',
          auth_type: 'signon',
          SignonURL: 'https://portail.example/login',
          LogoutURL: 'https://portail.example/bye',
          ...base,
        }),
      ],
      { SignonSecret: SIGNON_SECRET },
    );
  });
  afterAll(async () => {
    await ctx.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('http : demande l’authentification du navigateur puis ouvre la session', async () => {
    const agent = request.agent(ctx.app);
    const challenge = await agent.get('/api/v1/auth/http/h');
    expect(challenge.status).toBe(401);
    expect(challenge.headers['www-authenticate']).toBe('Basic realm="JsMyData PG http", charset="UTF-8"');
    const ok = await agent.get('/api/v1/auth/http/h').auth(pgUser, pgPass);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/server/h');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.servers.map((s: { id: string }) => s.id)).toEqual(['h']);
    const bad = await request.agent(ctx.app).get('/api/v1/auth/http/h').auth(pgUser, 'mauvais');
    expect(bad.status).toBe(400);
  });

  it('http : refuse la connexion par formulaire', async () => {
    const agent = request.agent(ctx.app);
    const me = await agent.get('/api/v1/auth/me');
    const res = await agent
      .post('/api/v1/auth/login')
      .set('x-csrf-token', me.body.csrfToken)
      .send({ server: 'h', user: pgUser, password: pgPass });
    expect(res.body.code).toBe('WRONG_AUTH_TYPE');
  });

  it('signon : expose l’URL du portail, accepte un jeton valide, renvoie LogoutURL', async () => {
    const servers = await request(ctx.app).get('/api/v1/servers');
    expect(servers.body.servers[1]).toMatchObject({
      id: 's',
      authType: 'signon',
      signonUrl: 'https://portail.example/login',
    });
    const agent = request.agent(ctx.app);
    const token = createSignonToken(SIGNON_SECRET, {
      server: 's',
      user: pgUser,
      password: pgPass,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await agent.get('/api/v1/auth/signon').query({ token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/server/s');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.servers[0]).toMatchObject({ id: 's', user: pgUser });
    const out = await agent.post('/api/v1/auth/logout').set('x-csrf-token', me.body.csrfToken).send({});
    expect(out.body.logoutUrl).toBe('https://portail.example/bye');
    const forged = await request(ctx.app)
      .get('/api/v1/auth/signon')
      .query({ token: token.slice(0, -3) + 'abc' });
    expect(forged.status).toBe(403);
  });
});
