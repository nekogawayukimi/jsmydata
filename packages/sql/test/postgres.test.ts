import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresDialect, type Connection } from '../src/index.js';

/**
 * Tests sur un vrai PostgreSQL, activés par JSMYDATA_TEST_PG=postgres://user:mdp@hôte:port/base
 * (la CI démarre un service PostgreSQL ; en local ils sont ignorés sans cette variable).
 */
const url = process.env.JSMYDATA_TEST_PG;

describe.skipIf(!url)('dialecte PostgreSQL', () => {
  let conn: Connection;
  const db = 'jsmydata_test';

  beforeAll(async () => {
    const u = new URL(url!);
    const params = {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1) || 'postgres',
    };
    const admin = await postgresDialect.connect(params);
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.close();
    conn = await postgresDialect.connect(params);
    await conn.query(`CREATE SCHEMA music`, [], db);
    await conn.query(
      `CREATE TABLE music.artist (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL DEFAULT 'inconnu', tags text[])`,
      [],
      db,
    );
    await conn.query(`COMMENT ON TABLE music.artist IS 'Artistes'`, [], db);
    await conn.query(`CREATE VIEW music.v_artist AS SELECT name FROM music.artist`, [], db);
    await conn.query(`CREATE MATERIALIZED VIEW music.mv_artist AS SELECT name FROM music.artist`, [], db);
  });

  afterAll(async () => {
    await conn?.close();
  });

  it('donne la version', async () => {
    const v = await conn.serverVersion();
    expect(v.product).toBe('PostgreSQL');
    expect(v.version).toMatch(/^\d+/);
  });

  it('liste les bases, sans les modèles', async () => {
    const names = (await conn.listDatabases()).map((d) => d.name);
    expect(names).toContain(db);
    expect(names).not.toContain('template0');
  });

  it('liste les schémas d’une autre base (connexion ouverte à la demande)', async () => {
    const schemas = await conn.listSchemas(db);
    expect(schemas.find((s) => s.name === 'music')).toMatchObject({ system: false });
    expect(schemas.find((s) => s.name === 'pg_catalog')).toMatchObject({ system: true });
  });

  it('liste tables, vues et vues matérialisées d’un schéma', async () => {
    const tables = await conn.listTables(db, 'music');
    expect(tables.map((t) => [t.name, t.kind])).toEqual([
      ['artist', 'table'],
      ['mv_artist', 'materialized_view'],
      ['v_artist', 'view'],
    ]);
    expect(tables[0]?.comment).toBe('Artistes');
  });

  it('décrit les colonnes (identité, tableau, défaut)', async () => {
    const cols = await conn.listColumns(db, 'artist', 'music');
    expect(cols[0]).toMatchObject({
      name: 'id',
      type: 'integer',
      primaryKey: true,
      extra: 'GENERATED ALWAYS AS IDENTITY',
    });
    expect(cols[1]).toMatchObject({ name: 'name', nullable: false, default: "'inconnu'::text" });
    expect(cols[2]).toMatchObject({ name: 'tags', type: 'text[]' });
  });

  it('remonte le SQLSTATE en cas d’erreur', async () => {
    await expect(conn.query('SELECT * FROM absente', [], db)).rejects.toMatchObject({ sqlState: '42P01' });
  });

  it('execute : origine des colonnes résolue via le catalogue, search_path', async () => {
    await conn.query(`INSERT INTO music.artist (name) VALUES ('Satie')`, [], db);
    const r = await conn.execute('SELECT a.id, a.name, a.id AS id, now() IS NOT NULL AS ok FROM artist a', {
      database: db,
      schema: 'music',
    });
    expect(r.fields.map((f) => [f.name, f.table, f.column, f.schema])).toEqual([
      ['id', 'artist', 'id', 'music'],
      ['name', 'artist', 'name', 'music'],
      ['id', 'artist', 'id', 'music'],
      ['ok', null, null, null],
    ]);
    expect(r.fields[0]?.type).toBe('integer');
    expect(r.rows).toEqual([[1, 'Satie', 1, true]]);
    const u = await conn.execute('UPDATE artist SET name = $1 WHERE id = $2', {
      database: db,
      schema: 'music',
      params: ['Erik Satie', 1],
    });
    expect(u).toMatchObject({ returnsRows: false, affectedRows: 1 });
  });

  it('clés uniques et identifiant de processus', async () => {
    await conn.query(
      'CREATE TABLE music.k (a int NOT NULL, b text NOT NULL, c text UNIQUE, UNIQUE (b), PRIMARY KEY (a, b))',
      [],
      db,
    );
    expect(await conn.uniqueKeys(db, 'k', 'music')).toEqual([['a', 'b'], ['b']]);
    expect(conn.backendId(db)).toBeGreaterThan(0);
  });

  it('annule une requête en cours', async () => {
    const u = new URL(url!);
    const params = {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
    const running = conn.execute('SELECT pg_sleep(10)', { database: db });
    await new Promise((r) => setTimeout(r, 300));
    await postgresDialect.cancel(params, conn.backendId(db)!);
    await expect(running).rejects.toMatchObject({ sqlState: '57014' });
  });
});
