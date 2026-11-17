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

  it('execute : lignes en tableaux, origine des colonnes, colonnes homonymes', async () => {
    const r = await conn.execute(
      'SELECT a.id, b.id, a.name, 1 + 1 AS calc FROM artist a JOIN album b ON 1 = 0 UNION ALL SELECT 1, 2, ?, 3',
      { params: ['x'] },
    );
    expect(r.returnsRows).toBe(true);
    expect(r.fields.map((f) => f.name)).toEqual(['id', 'id', 'name', 'calc']);
    expect(r.rows).toEqual([[1n, 2n, 'x', 3n]]);
    const s = await conn.execute('SELECT name FROM artist ORDER BY id', { maxRows: 1 });
    expect(s.fields[0]).toMatchObject({ table: 'artist', column: 'name', schema: 'main' });
    expect(s.rows).toEqual([['Satie']]);
    expect(s.truncated).toBe(true);
  });

  it('execute : modification avec lignes affectées et identifiant inséré', async () => {
    const r = await conn.execute('INSERT INTO artist (name) VALUES (?)', { params: ['Fauré'] });
    expect(r).toMatchObject({ returnsRows: false, affectedRows: 1, insertId: '3' });
    const d = await conn.execute('DELETE FROM artist WHERE name = ?', { params: ['Fauré'] });
    expect(d).toMatchObject({ affectedRows: 1, insertId: null });
  });

  it('clés uniques : clé primaire puis index uniques NOT NULL', async () => {
    await conn.query('CREATE TABLE k (a INTEGER NOT NULL, b TEXT NOT NULL, c TEXT, PRIMARY KEY (a, b))');
    await conn.query('CREATE UNIQUE INDEX k_b ON k (b)');
    await conn.query('CREATE UNIQUE INDEX k_c ON k (c)');
    expect(await conn.uniqueKeys('main', 'k')).toEqual([['a', 'b'], ['b']]);
    expect(await conn.uniqueKeys('main', 'artist')).toEqual([['id']]);
  });
});
