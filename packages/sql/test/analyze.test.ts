import { describe, expect, it } from 'vitest';
import {
  appendLimit,
  canAppendLimit,
  firstKeyword,
  isDestructive,
  splitStatements,
  statementVerb,
} from '../src/analyze.js';

const texts = (sql: string, d: 'mysql' | 'postgres' | 'sqlite' = 'mysql') =>
  splitStatements(sql, d).map((s) => s.sql);

describe('découpage des instructions', () => {
  it('ignore les points-virgules dans les chaînes, identifiants et commentaires', () => {
    expect(
      texts('SELECT \'a;b\', `c;d` FROM t; -- fin; ici\nSELECT "x;y" /* ; */ FROM u; # dièse ;\nSELECT 3'),
    ).toEqual([
      "SELECT 'a;b', `c;d` FROM t",
      '-- fin; ici\nSELECT "x;y" /* ; */ FROM u',
      '# dièse ;\nSELECT 3',
    ]);
  });

  it('gère les apostrophes échappées (MySQL) et doublées', () => {
    expect(texts("SELECT 'l\\'été;'; SELECT 'l''hiver;'")).toEqual([
      "SELECT 'l\\'été;'",
      "SELECT 'l''hiver;'",
    ]);
  });

  it('gère DELIMITER pour les routines MySQL', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();';
    expect(texts(sql)).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
  });

  it('gère les chaînes dollar de PostgreSQL', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT f()';
    expect(texts(sql, 'postgres')).toHaveLength(2);
    expect(texts('SELECT $$a;b$$; SELECT 2', 'postgres')).toEqual(['SELECT $$a;b$$', 'SELECT 2']);
  });

  it('gère les blocs BEGIN … END des déclencheurs SQLite', () => {
    const sql =
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE u SET n = n + 1; INSERT INTO log VALUES (1); END; SELECT 1';
    expect(texts(sql, 'sqlite')).toEqual([
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE u SET n = n + 1; INSERT INTO log VALUES (1); END',
      'SELECT 1',
    ]);
    expect(texts('BEGIN; INSERT INTO t VALUES (1); COMMIT', 'sqlite')).toHaveLength(3);
  });

  it('ignore les instructions vides et donne la position de départ', () => {
    const s = splitStatements(';; SELECT 1 ;\n\n SELECT 2;', 'mysql');
    expect(s.map((x) => x.sql)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(s[1]!.start).toBe(16);
  });
});

describe('LIMIT automatique', () => {
  it('s’applique aux SELECT sans limite', () => {
    expect(canAppendLimit('SELECT * FROM t WHERE a IN (SELECT b FROM u LIMIT 3)', 'mysql')).toBe(true);
    expect(canAppendLimit('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres')).toBe(true);
    expect(appendLimit('SELECT * FROM t;', 25, 50)).toBe('SELECT * FROM t\nLIMIT 25 OFFSET 50');
  });
  it('ne s’applique pas si la requête est déjà limitée ou ne s’y prête pas', () => {
    for (const sql of [
      'SELECT * FROM t LIMIT 5',
      'SELECT * FROM t FETCH FIRST 3 ROWS ONLY',
      'SELECT * INTO OUTFILE "/tmp/x" FROM t',
      'SELECT * FROM t FOR UPDATE',
      'SHOW TABLES',
      'INSERT INTO t SELECT * FROM u',
      'WITH x AS (SELECT 1) DELETE FROM t',
    ]) {
      expect(canAppendLimit(sql, 'mysql'), sql).toBe(false);
    }
  });
  it('ne confond pas « limit » dans une chaîne ou un commentaire', () => {
    expect(canAppendLimit("SELECT 'LIMIT 1' FROM t -- LIMIT 2", 'mysql')).toBe(true);
  });
});

describe('requêtes destructives', () => {
  it('repère DROP, TRUNCATE, DELETE/UPDATE sans WHERE', () => {
    expect(isDestructive('DROP TABLE t', 'mysql')).toBe(true);
    expect(isDestructive('truncate t', 'postgres')).toBe(true);
    expect(isDestructive('DELETE FROM t', 'sqlite')).toBe(true);
    expect(isDestructive('UPDATE t SET a = 1', 'mysql')).toBe(true);
    expect(isDestructive('ALTER TABLE t DROP COLUMN c', 'mysql')).toBe(true);
    expect(
      isDestructive("SELECT 1; DELETE FROM t WHERE id = 3; UPDATE t SET a = 'DROP' WHERE 1", 'mysql'),
    ).toBe(false);
  });
  it('donne le verbe de l’instruction', () => {
    expect(statementVerb('  select 1', 'mysql')).toBe('SELECT');
    expect(statementVerb('WITH x AS (SELECT 1) UPDATE t SET a = 1', 'postgres')).toBe('UPDATE');
    expect(firstKeyword('/* c */ show tables')).toBe('SHOW');
  });
});
