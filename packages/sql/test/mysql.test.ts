import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mysqlDialect, type Connection } from '../src/index.js';

/**
 * Tests sur un vrai MySQL ou MariaDB, activés par JSMYDATA_TEST_MYSQL=mysql://user:mdp@hôte:port
 * (la CI les lance sur MySQL 8.4 et MariaDB 11.4).
 */
const url = process.env.JSMYDATA_TEST_MYSQL;

describe.skipIf(!url)('dialecte MySQL / MariaDB', () => {
  let conn: Connection;
  const db = 'jsmydata_test';

  beforeAll(async () => {
    const u = new URL(url!);
    conn = await mysqlDialect.connect({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    });
    await conn.query(`DROP DATABASE IF EXISTS ${db}`);
    await conn.query(`CREATE DATABASE ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(
      `CREATE TABLE ${db}.artist (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL DEFAULT 'inconnu' COMMENT 'Nom') ENGINE=InnoDB COMMENT='Artistes'`,
    );
    await conn.query(`CREATE VIEW ${db}.v_artist AS SELECT name FROM ${db}.artist`);
  });

  afterAll(async () => {
    await conn?.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => undefined);
    await conn?.close();
  });

  it('identifie le produit', async () => {
    const v = await conn.serverVersion();
    expect(['MySQL', 'MariaDB', 'Percona Server']).toContain(v.product);
  });

  it('liste les bases et marque les bases système', async () => {
    const dbs = await conn.listDatabases();
    expect(dbs.find((d) => d.name === db)).toMatchObject({ system: false, collation: 'utf8mb4_unicode_ci' });
    expect(dbs.find((d) => d.name === 'information_schema')).toMatchObject({ system: true });
  });

  it('liste tables et vues', async () => {
    const tables = await conn.listTables(db);
    expect(tables.map((t) => [t.name, t.kind])).toEqual([
      ['artist', 'table'],
      ['v_artist', 'view'],
    ]);
    expect(tables[0]).toMatchObject({ engine: 'InnoDB', comment: 'Artistes', rowsEstimated: true });
  });

  it('décrit les colonnes', async () => {
    const cols = await conn.listColumns(db, 'artist');
    // MySQL 8 : « int unsigned » ; MariaDB : « int(10) unsigned ».
    expect(cols[0]).toMatchObject({ name: 'id', primaryKey: true, extra: 'auto_increment' });
    expect(cols[0]?.type).toMatch(/^int(\(\d+\))? unsigned$/);
    expect(cols[1]).toMatchObject({ name: 'name', nullable: false, comment: 'Nom' });
  });

  it('execute : origine des colonnes, CALL et clés uniques', async () => {
    await conn.query(`INSERT INTO ${db}.artist (name) VALUES ('Satie')`);
    const r = await conn.execute('SELECT a.id, a.name AS n, a.id, 1 AS one FROM artist a', { database: db });
    expect(r.fields.map((f) => [f.name, f.table, f.column, f.schema])).toEqual([
      ['id', 'artist', 'id', db],
      ['n', 'artist', 'name', db],
      ['id', 'artist', 'id', db],
      ['one', null, null, null],
    ]);
    expect(r.rows).toEqual([[1, 'Satie', 1, 1]]);
    const i = await conn.execute(`INSERT INTO artist (name) VALUES (?)`, { database: db, params: ['Ravel'] });
    expect(i).toMatchObject({ returnsRows: false, affectedRows: 1, insertId: 2 });
    expect(await conn.uniqueKeys(db, 'artist')).toEqual([['id']]);
    expect(conn.backendId()).toBeGreaterThan(0);
  });

  it('annule une requête en cours (KILL QUERY)', async () => {
    const u = new URL(url!);
    const params = {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
    const running = conn.execute('SELECT SLEEP(10)');
    await new Promise((r) => setTimeout(r, 300));
    await mysqlDialect.cancel(params, conn.backendId()!);
    // MySQL renvoie 1 (interrompu) ou une erreur 1317 selon la version.
    const res = await running.catch((e: { errno?: number }) => e);
    expect(JSON.stringify(res)).toMatch(/1317|\[\[1\]\]/);
  });
});
