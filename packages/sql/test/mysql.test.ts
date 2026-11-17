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
});
