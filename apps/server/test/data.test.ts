import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeApp, server } from './helpers.js';

describe('Lot 1 — données (SQLite)', () => {
  let dir: string;
  let ctx: ReturnType<typeof makeApp>;
  let api: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsmydata-data-'));
    const db = new Database(join(dir, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE client (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, ville TEXT, solde REAL DEFAULT 0, photo BLOB);
      CREATE TABLE note (texte TEXT, auteur TEXT);
      CREATE VIEW v_client AS SELECT nom FROM client;
    `);
    const ins = db.prepare('INSERT INTO client (nom, ville, solde, photo) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 60; i++)
      ins.run(
        `Client ${i}`,
        i % 3 === 0 ? 'Lyon' : i % 3 === 1 ? 'Paris' : null,
        i * 1.5,
        i === 1 ? Buffer.from([1, 2, 3]) : null,
      );
    db.exec(`INSERT INTO note VALUES ('a', 'x'), ('a', 'x'), ('b', NULL)`);
    db.close();
    ctx = makeApp(dir, [server({ id: 'lite', engine: 'sqlite' })]);
    api = await login(ctx.app, { server: 'lite', file: 'shop.sqlite' });
  });

  afterAll(async () => {
    await ctx.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Parcourir : page, tri, total exact, binaire résumé, édition par clé', async () => {
    const res = await api.get('/srv/lite/db/main/tables/client/rows?count=10&offset=20&sort=desc:solde');
    expect(res.status).toBe(200);
    expect(res.body.sql).toBe('SELECT * FROM "main"."client" ORDER BY "solde" DESC LIMIT 10 OFFSET 20');
    expect(res.body.total).toBe(60);
    expect(res.body.totalEstimated).toBe(false);
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.rows[0][1]).toBe('Client 40');
    expect(res.body.editable).toEqual({
      db: 'main',
      table: 'client',
      key: ['id'],
      columns: ['id', 'nom', 'ville', 'solde', 'photo'],
    });
    const first = await api.get('/srv/lite/db/main/tables/client/rows?count=1');
    expect(first.body.rows[0][4]).toEqual({ $binary: 3, hex: '010203' });
  });

  it('SQL : multi-instructions, LIMIT automatique, total, résultats éditables', async () => {
    const res = await api.post('/srv/lite/sql', {
      sql: "SELECT id, nom FROM client WHERE ville = 'Lyon'; SELECT COUNT(*) AS n FROM client; UPDATE note SET auteur = 'y' WHERE texte = 'b'",
      db: 'main',
      count: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    const [a, b, c] = res.body.results;
    expect(a.sql).toBe("SELECT id, nom FROM client WHERE ville = 'Lyon'\nLIMIT 5");
    expect(a).toMatchObject({ limited: true, total: 20, offset: 0 });
    expect(a.rows).toHaveLength(5);
    expect(a.editable).toMatchObject({ table: 'client', key: ['id'], columns: ['id', 'nom'] });
    expect(b).toMatchObject({ total: 1, rows: [[60]], editable: null });
    expect(c).toMatchObject({ returnsRows: false, affectedRows: 1 });
  });

  it('SQL : s’arrête à la première erreur en gardant les résultats précédents', async () => {
    const res = await api.post('/srv/lite/sql', { sql: 'SELECT 1; SELECT * FROM absente; SELECT 3' });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.error).toMatchObject({ index: 1, statement: 'SELECT * FROM absente' });
    expect(res.body.error.message).toMatch(/no such table/);
  });

  it('SQL : « Tout afficher » et requêtes non limitables', async () => {
    const all = await api.post('/srv/lite/sql', { sql: 'SELECT id FROM client', showAll: true });
    expect(all.body.results[0].rows).toHaveLength(60);
    const pragma = await api.post('/srv/lite/sql', { sql: 'PRAGMA table_info(client)' });
    expect(pragma.body.results[0]).toMatchObject({ limited: false, returnsRows: true });
  });

  it('Modifier une cellule par clé primaire', async () => {
    const res = await api.patch('/srv/lite/db/main/tables/client/rows', {
      locator: { id: 2, nom: 'Client 2' },
      set: { ville: { value: 'Nantes' }, solde: { value: null } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sql: [`UPDATE "main"."client" SET "ville" = 'Nantes', "solde" = NULL WHERE "id" = 2`],
      affectedRows: 1,
    });
    const check = await api.post('/srv/lite/sql', { sql: 'SELECT ville, solde FROM client WHERE id = 2' });
    expect(check.body.results[0].rows).toEqual([['Nantes', null]]);
  });

  it('Sans clé unique : localisation par toutes les colonnes, une seule ligne touchée', async () => {
    const res = await api.patch('/srv/lite/db/main/tables/note/rows', {
      locator: { texte: 'a', auteur: 'x' },
      set: { auteur: { value: 'z' } },
    });
    expect(res.body.affectedRows).toBe(1);
    expect(res.body.sql[0]).toContain(
      'WHERE rowid = (SELECT rowid FROM "main"."note" WHERE "texte" = \'a\' AND "auteur" = \'x\' LIMIT 1)',
    );
    const rows = await api.post('/srv/lite/sql', {
      sql: "SELECT auteur FROM note WHERE texte = 'a' ORDER BY auteur",
    });
    expect(rows.body.results[0].rows).toEqual([['x'], ['z']]);
  });

  it('Insérer avec fonctions et NULL, puis supprimer', async () => {
    const ins = await api.post('/srv/lite/db/main/tables/client/rows', {
      rows: [
        { nom: { value: 'dupont', fn: 'UPPER' }, ville: { value: null } },
        { nom: { value: 'Martin' }, solde: { value: '12.5' } },
      ],
    });
    expect(ins.status).toBe(200);
    expect(ins.body.affectedRows).toBe(2);
    expect(ins.body.sql[0]).toBe(
      `INSERT INTO "main"."client" ("nom", "ville") VALUES (UPPER('dupont'), NULL)`,
    );
    expect(ins.body.insertId).toBe('62');
    const del = await api.del('/srv/lite/db/main/tables/client/rows', { locators: [{ id: 61 }, { id: 62 }] });
    expect(del.body.affectedRows).toBe(2);
    const bad = await api.post('/srv/lite/db/main/tables/client/rows', {
      rows: [{ nom: { value: 'x', fn: 'SLEEP' } }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_FUNCTION');
  });

  it('Refuse une colonne inconnue', async () => {
    const res = await api.patch('/srv/lite/db/main/tables/client/rows', {
      locator: { id: 1 },
      set: { 'x" = 1; --': { value: 'a' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_COLUMN');
  });

  it('Rechercher dans une table : opérateurs, colonnes affichées, total', async () => {
    const res = await api.post('/srv/lite/db/main/tables/client/search', {
      criteria: [
        { column: 'ville', operator: 'IN (...)', value: 'Lyon, Paris' },
        { column: 'nom', operator: 'LIKE %...%', value: '1' },
        { column: 'solde', operator: 'BETWEEN', value: '10,30' },
      ],
      columns: ['id', 'nom'],
      sort: [{ column: 'id', dir: 'asc' }],
      count: 50,
    });
    expect(res.status).toBe(200);
    expect(res.body.sql).toBe(
      `SELECT "id", "nom" FROM "main"."client" WHERE "ville" IN ('Lyon', 'Paris') AND "nom" LIKE '%1%' AND "solde" BETWEEN '10' AND '30' ORDER BY "id" ASC`,
    );
    expect(res.body.rows.map((r: unknown[]) => r[1])).toEqual([
      'Client 10',
      'Client 12',
      'Client 13',
      'Client 15',
      'Client 16',
      'Client 18',
      'Client 19',
    ]);
    expect(res.body.total).toBe(7);
    const re = await api.post('/srv/lite/db/main/tables/client/search', {
      criteria: [
        { column: 'nom', operator: 'REGEXP', value: '^Client 5[0-2]$' },
        { column: 'ville', operator: 'IS NOT NULL' },
      ],
    });
    expect(re.body.total).toBe(2);
  });

  it('Rechercher dans la base : occurrences par table', async () => {
    const res = await api.post('/srv/lite/db/main/search', { words: 'Lyon Nantes', mode: 'any' });
    expect(res.status).toBe(200);
    const byTable = Object.fromEntries(
      res.body.results.map((r: { table: string; count: number }) => [r.table, r.count]),
    );
    expect(byTable).toEqual({ client: 21, note: 0, v_client: 0 });
    expect(res.body.total).toBe(21);
    expect(res.body.results[0].sql).toContain(`SELECT * FROM "main"."client" WHERE ("id" LIKE '%Lyon%'`);
  });

  it('Pas d’édition en grille sans colonne unique dans le résultat', async () => {
    const note = await api.get('/srv/lite/db/main/tables/note/rows');
    expect(note.body.editable).toBeNull();
    const res = await api.get('/srv/lite/db/main/tables/v_client/rows');
    expect(res.status).toBe(200);
    expect(res.body.editable).toBeNull();
  });
});
