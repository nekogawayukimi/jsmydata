import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresDialect } from '@jsmydata/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeApp, server } from './helpers.js';

const url = process.env.JSMYDATA_TEST_PG;

describe.skipIf(!url)('Lot 1 — données (PostgreSQL)', () => {
  let dir: string;
  let ctx: ReturnType<typeof makeApp>;
  let api: Awaited<ReturnType<typeof login>>;
  const u = url ? new URL(url) : null;
  const db = 'jsmydata_lot1';
  const params = () => ({
    host: u!.hostname,
    port: Number(u!.port || 5432),
    user: decodeURIComponent(u!.username),
    password: decodeURIComponent(u!.password),
  });

  beforeAll(async () => {
    const admin = await postgresDialect.connect(params());
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.close();
    const c = await postgresDialect.connect({ ...params(), database: db });
    await c.query(`CREATE SCHEMA ventes`);
    await c.query(
      `CREATE TABLE ventes.produit (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nom text NOT NULL, prix numeric(8,2), tags text[], meta jsonb, maj timestamptz DEFAULT now())`,
    );
    await c.query(
      `INSERT INTO ventes.produit (nom, prix, tags, meta) SELECT 'P' || g, g * 2, ARRAY['a','b'], '{"k":1}' FROM generate_series(1, 30) g`,
    );
    await c.close();
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-pg-'));
    ctx = makeApp(dir, [
      server({
        id: 'pg',
        engine: 'postgres',
        host: u!.hostname,
        port: Number(u!.port || 5432),
        database: 'postgres',
      }),
    ]);
    api = await login(ctx.app, { server: 'pg', user: params().user, password: params().password });
  });

  afterAll(async () => {
    await ctx.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Parcourir dans un schéma, valeurs typées, édition par clé', async () => {
    const res = await api.get(`/srv/pg/db/${db}/tables/produit/rows?schema=ventes&count=5&sort=desc:id`);
    expect(res.status).toBe(200);
    expect(res.body.sql).toBe('SELECT * FROM "ventes"."produit" ORDER BY "id" DESC LIMIT 5');
    expect(res.body.total).toBe(30);
    const row = res.body.rows[0];
    expect(row.slice(0, 5)).toEqual([30, 'P30', '60.00', '["a","b"]', '{"k":1}']);
    expect(res.body.editable).toMatchObject({ db, schema: 'ventes', table: 'produit', key: ['id'] });
  });

  it('SQL avec search_path, édition puis insertion avec fonction', async () => {
    const sql = await api.post('/srv/pg/sql', {
      sql: 'SELECT id, nom FROM produit WHERE prix > 50',
      db,
      schema: 'ventes',
    });
    expect(sql.body.results[0]).toMatchObject({ total: 5, limited: true });
    expect(sql.body.results[0].editable).toMatchObject({
      table: 'produit',
      schema: 'ventes',
      columns: ['id', 'nom'],
    });

    const upd = await api.patch(`/srv/pg/db/${db}/tables/produit/rows?schema=ventes`, {
      locator: { id: 3 },
      set: { nom: { value: 'renommé', fn: 'UPPER' }, prix: { value: '9.99' } },
    });
    expect(upd.body).toEqual({
      sql: [`UPDATE "ventes"."produit" SET "nom" = UPPER('renommé'), "prix" = '9.99' WHERE "id" = 3`],
      affectedRows: 1,
    });

    const ins = await api.post(`/srv/pg/db/${db}/tables/produit/rows?schema=ventes`, {
      rows: [{ nom: { value: 'Nouveau' }, maj: { value: null, fn: 'NOW' } }],
    });
    expect(ins.status).toBe(200);
    expect(ins.body.sql[0]).toBe(`INSERT INTO "ventes"."produit" ("nom", "maj") VALUES ('Nouveau', NOW())`);
  });

  it('Rechercher : LIKE sur une colonne numérique (conversion en texte) et ~', async () => {
    const res = await api.post(`/srv/pg/db/${db}/tables/produit/search?schema=ventes`, {
      criteria: [
        { column: 'prix', operator: 'LIKE %...%', value: '.00' },
        { column: 'nom', operator: 'REGEXP', value: '^P1[0-9]$' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.sql).toContain(`"prix"::text LIKE '%.00%' AND "nom" ~ '^P1[0-9]$'`);
    expect(res.body.total).toBe(10);
  });

  it('Erreur SQL : SQLSTATE remonté avec l’instruction fautive', async () => {
    const res = await api.post('/srv/pg/sql', { sql: 'SELECT 1; SELECT * FROM nulle_part', db });
    expect(res.body.error).toMatchObject({ sqlState: '42P01', index: 1 });
  });

  it('Arrêter une requête longue', async () => {
    // supertest n'envoie la requête qu'à l'appel de then() : on la lance explicitement.
    const running = api.post('/srv/pg/sql', { sql: 'SELECT pg_sleep(10)', db }).then((r) => r);
    await new Promise((r) => setTimeout(r, 400));
    const cancel = await api.post('/srv/pg/sql/cancel', {});
    expect(cancel.body.cancelled).toBe(true);
    const res = await running;
    expect(res.body.error).toMatchObject({ sqlState: '57014' });
  });
});
