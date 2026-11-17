import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqliteDialect, type Connection } from '../src/index.js';

describe('dialecte SQLite', () => {
  let dir: string;
  let conn: Connection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-sqlite-'));
    conn = await sqliteDialect.connect({ file: join(dir, 'test.sqlite') });
    await conn.query(
      `CREATE TABLE artist (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT 'inconnu', born INTEGER)`,
    );
    await conn.query(
      `CREATE TABLE album (id INTEGER PRIMARY KEY, artist_id INTEGER REFERENCES artist(id), title TEXT)`,
    );
    await conn.query(`CREATE VIEW v_artist AS SELECT name FROM artist`);
    await conn.query(`INSERT INTO artist (name, born) VALUES (?, ?), (?, ?)`, [
      'Satie',
      1866,
      'Debussy',
      1862,
    ]);
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('donne la version', async () => {
    const v = await conn.serverVersion();
    expect(v.product).toBe('SQLite');
    expect(v.version).toMatch(/^3\./);
  });

  it('liste la base main', async () => {
    expect(await conn.listDatabases()).toEqual([{ name: 'main', system: false }]);
  });

  it('liste tables et vues avec le nombre exact de lignes', async () => {
    const tables = await conn.listTables('main');
    expect(tables.map((t) => [t.name, t.kind, t.rows])).toEqual([
      ['album', 'table', 0],
      ['artist', 'table', 2],
      ['v_artist', 'view', null],
    ]);
  });

  it('décrit les colonnes', async () => {
    const cols = await conn.listColumns('main', 'artist');
    expect(cols).toHaveLength(3);
    expect(cols[0]).toMatchObject({ name: 'id', type: 'INTEGER', primaryKey: true, position: 1 });
    expect(cols[1]).toMatchObject({ name: 'name', nullable: false, default: "'inconnu'" });
    expect(cols[2]).toMatchObject({ name: 'born', nullable: true, default: null });
  });

  it('exécute des requêtes paramétrées et renvoie lignes et colonnes', async () => {
    const r = await conn.query('SELECT name FROM artist WHERE born < ? ORDER BY born', [1870]);
    expect(r.columns).toEqual(['name']);
    expect(r.rows).toEqual([{ name: 'Debussy' }, { name: 'Satie' }]);
    const u = await conn.query('UPDATE artist SET born = born WHERE 1');
    expect(u.affectedRows).toBe(2);
  });

  it('remonte les erreurs SQL sous forme de DialectError', async () => {
    await expect(conn.query('SELECT * FROM table_absente')).rejects.toMatchObject({ name: 'DialectError' });
  });
});
