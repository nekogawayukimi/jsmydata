/**
 * Analyse légère du SQL, sans dépendance : utilisée par le serveur (découpage, LIMIT automatique)
 * et par le client (confirmation des requêtes destructives). Ce n'est pas un analyseur complet :
 * il reconnaît chaînes, identifiants délimités, commentaires et blocs, ce qui suffit à découper
 * et à repérer les mots-clés de premier niveau.
 */

export type SqlDialect = 'mysql' | 'postgres' | 'sqlite';

export interface Statement {
  sql: string;
  /** Position du début de l'instruction dans le texte d'origine. */
  start: number;
}

/** Saute une chaîne, un identifiant délimité ou un commentaire commençant en i ; renvoie la position après, ou i. */
function skipToken(sql: string, i: number, dialect: SqlDialect): number {
  const c = sql[i];
  const n = sql[i + 1];
  // Commentaires
  if (c === '-' && n === '-') {
    const end = sql.indexOf('\n', i);
    return end === -1 ? sql.length : end + 1;
  }
  if (c === '#' && dialect === 'mysql') {
    const end = sql.indexOf('\n', i);
    return end === -1 ? sql.length : end + 1;
  }
  if (c === '/' && n === '*') {
    const end = sql.indexOf('*/', i + 2);
    return end === -1 ? sql.length : end + 2;
  }
  // Chaînes et identifiants délimités
  if (c === "'" || c === '"' || (c === '`' && dialect !== 'postgres')) {
    const backslash = dialect === 'mysql' && c !== '`';
    let j = i + 1;
    while (j < sql.length) {
      const d = sql[j];
      if (backslash && d === '\\') {
        j += 2;
        continue;
      }
      if (d === c) {
        if (sql[j + 1] === c) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return sql.length;
  }
  if (c === '[' && dialect === 'sqlite') {
    const end = sql.indexOf(']', i + 1);
    return end === -1 ? sql.length : end + 1;
  }
  // Chaînes « dollar » PostgreSQL : $$…$$ ou $tag$…$tag$
  if (c === '$' && dialect === 'postgres') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66));
    if (m) {
      const tag = m[0];
      const end = sql.indexOf(tag, i + tag.length);
      return end === -1 ? sql.length : end + tag.length;
    }
  }
  return i;
}

const WORD = /[A-Za-z_]/;

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/**
 * Découpe un script en instructions. Gère la commande DELIMITER (MySQL) et les blocs
 * BEGIN … END des déclencheurs SQLite.
 */
export function splitStatements(sql: string, dialect: SqlDialect): Statement[] {
  const out: Statement[] = [];
  let delimiter = ';';
  let start = 0;
  let i = 0;
  let blockDepth = 0; // SQLite : CREATE TRIGGER … BEGIN … END;

  const push = (end: number, next: number) => {
    const text = sql.slice(start, end).trim();
    if (text) {
      const lead = sql.slice(start, end).search(/\S/);
      out.push({ sql: text, start: start + Math.max(lead, 0) });
    }
    start = next;
  };

  while (i < sql.length) {
    // Commande DELIMITER en début de ligne (MySQL)
    if (
      dialect === 'mysql' &&
      (i === 0 || sql[i - 1] === '\n') &&
      /^\s*delimiter\s/i.test(sql.slice(i, i + 20))
    ) {
      const lineEnd = sql.indexOf('\n', i);
      const line = sql.slice(i, lineEnd === -1 ? sql.length : lineEnd).trim();
      if (sql.slice(start, i).trim() === '') {
        const d = line.split(/\s+/)[1];
        if (d) delimiter = d;
        i = lineEnd === -1 ? sql.length : lineEnd + 1;
        start = i;
        continue;
      }
    }
    const skipped = skipToken(sql, i, dialect);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = sql[i]!;
    if (dialect === 'sqlite' && WORD.test(c) && !isWordChar(sql[i - 1])) {
      const word = /^[A-Za-z_]+/.exec(sql.slice(i, i + 12))![0].toUpperCase();
      const head = sql.slice(start, i).trim().toUpperCase();
      if (word === 'BEGIN' && /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/.test(head)) blockDepth++;
      else if (word === 'END' && blockDepth > 0) blockDepth--;
      i += word.length;
      continue;
    }
    if (blockDepth === 0 && sql.startsWith(delimiter, i)) {
      push(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }
    i++;
  }
  push(sql.length, sql.length);
  return out;
}

/** Mots-clés de premier niveau (hors chaînes, commentaires et parenthèses), en majuscules. */
export function topLevelKeywords(sql: string, dialect: SqlDialect): string[] {
  const words: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const skipped = skipToken(sql, i, dialect);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = sql[i]!;
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (WORD.test(c) && !isWordChar(sql[i - 1])) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      if (depth === 0) words.push(m[0].toUpperCase());
      i += m[0].length;
      continue;
    }
    i++;
  }
  return words;
}

export function firstKeyword(sql: string, dialect: SqlDialect = 'mysql'): string {
  return topLevelKeywords(sql, dialect)[0] ?? '';
}

/** Instruction de lecture à laquelle un LIMIT peut être ajouté (comme phpMyAdmin). */
export function canAppendLimit(sql: string, dialect: SqlDialect): boolean {
  const kw = topLevelKeywords(sql, dialect);
  const first = kw[0];
  if (first !== 'SELECT' && first !== 'WITH') return false;
  if (first === 'WITH' && !kw.includes('SELECT')) return false;
  // Déjà limité, ou forme où LIMIT est impossible / change le sens.
  for (const k of ['LIMIT', 'FETCH', 'INTO', 'PROCEDURE', 'OFFSET']) if (kw.includes(k)) return false;
  if (first === 'WITH' && ['INSERT', 'UPDATE', 'DELETE'].some((k) => kw.includes(k))) return false;
  if (kw.includes('FOR') && (kw.includes('UPDATE') || kw.includes('SHARE'))) return false;
  if (kw.includes('LOCK')) return false;
  return true;
}

export function appendLimit(sql: string, count: number, offset: number): string {
  const body = sql.replace(/;\s*$/, '');
  return `${body}\nLIMIT ${Math.max(0, Math.floor(count))}${offset > 0 ? ` OFFSET ${Math.floor(offset)}` : ''}`;
}

/**
 * Requête destructive : demande de confirmation côté client (option Confirm de phpMyAdmin).
 * DROP, TRUNCATE, ainsi que DELETE ou UPDATE sans WHERE.
 */
export function isDestructive(sql: string, dialect: SqlDialect): boolean {
  return splitStatements(sql, dialect).some(({ sql: s }) => {
    const kw = topLevelKeywords(s, dialect);
    const first = kw[0];
    if (first === 'DROP' || first === 'TRUNCATE') return true;
    if (first === 'ALTER' && kw.includes('DROP')) return true;
    if ((first === 'DELETE' || first === 'UPDATE') && !kw.includes('WHERE')) return true;
    return false;
  });
}

/** Type d'instruction affiché (« SELECT », « INSERT »…) pour l'historique et les messages. */
export function statementVerb(sql: string, dialect: SqlDialect): string {
  const kw = topLevelKeywords(sql, dialect);
  if (kw[0] === 'WITH') return kw.find((k) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(k)) ?? 'WITH';
  return kw[0] ?? '';
}
