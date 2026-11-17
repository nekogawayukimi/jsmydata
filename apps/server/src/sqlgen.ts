import {
  isBinary,
  SQL_FUNCTIONS,
  type CellInput,
  type CellValue,
  type RowLocator,
  type SearchCriterion,
  type SortSpec,
} from '@jsmydata/shared';
import type { Dialect } from '@jsmydata/sql';
import { HttpError } from './errors.js';

/**
 * Construit une requête paramétrée et, en parallèle, sa version lisible
 * (valeurs en clair) que l'interface affiche, comme phpMyAdmin.
 */
export class SqlBuilder {
  private exec = '';
  private shown = '';
  readonly params: unknown[] = [];

  constructor(readonly dialect: Dialect) {}

  raw(text: string): this {
    this.exec += text;
    this.shown += text;
    return this;
  }

  ident(name: string): this {
    return this.raw(this.dialect.quoteIdent(name));
  }

  value(v: unknown): this {
    if (v === null || v === undefined) return this.raw('NULL');
    this.params.push(v);
    this.exec += this.dialect.placeholder(this.params.length);
    this.shown += displayLiteral(this.dialect, v);
    return this;
  }

  get sql(): string {
    return this.exec;
  }

  get display(): string {
    return this.shown;
  }
}

export function displayLiteral(dialect: Dialect, v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return dialect.engine === 'sqlite' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
  return dialect.quoteLiteral(String(v));
}

/** Valeur d'un formulaire : NULL, valeur paramétrée, ou fonction SQL de la liste autorisée. */
export function appendInput(b: SqlBuilder, input: CellInput): void {
  if (input.fn) {
    const fn = SQL_FUNCTIONS[b.dialect.engine].find((f) => f.name === input.fn);
    if (!fn) throw new HttpError(400, 'BAD_FUNCTION', `Fonction non autorisée : ${input.fn}`);
    if (!fn.arg) {
      b.raw(/^CURRENT_(DATE|TIME|TIMESTAMP)$/.test(fn.name) ? fn.name : `${fn.name}()`);
      return;
    }
    b.raw(`${fn.name}(`).value(input.value).raw(')');
    return;
  }
  b.value(input.value);
}

/**
 * Condition localisant une ligne.
 * - clé unique : égalité sur les colonnes de la clé ;
 * - sans clé : égalité sur toutes les colonnes connues (hors binaires), une seule ligne visée.
 */
export function appendWhere(b: SqlBuilder, locator: RowLocator, full: boolean): void {
  const entries = Object.entries(locator).filter(([, v]) => !isBinary(v));
  if (entries.length === 0) throw new HttpError(400, 'NO_LOCATOR', 'Impossible de localiser la ligne.');
  entries.forEach(([col, v], i) => {
    if (i > 0) b.raw(' AND ');
    if (v === null) {
      b.ident(col).raw(' IS NULL');
      return;
    }
    // Sans clé, PostgreSQL compare en texte (json, tableaux… n'ont pas toujours d'opérateur =).
    if (full && b.dialect.engine === 'postgres') b.ident(col).raw('::text = ').value(String(v));
    else
      b.ident(col)
        .raw(' = ')
        .value(v as CellValue);
  });
}

/** WHERE visant exactement une ligne, avec LIMIT 1 ou son équivalent quand la clé manque. */
export function appendRowTarget(b: SqlBuilder, table: string, locator: RowLocator, full: boolean): void {
  const engine = b.dialect.engine;
  if (!full || engine === 'mysql') {
    b.raw(' WHERE ');
    appendWhere(b, locator, full);
    if (engine === 'mysql') b.raw(' LIMIT 1');
    return;
  }
  const id = engine === 'postgres' ? 'ctid' : 'rowid';
  b.raw(` WHERE ${id} = (SELECT ${id} FROM ${table} WHERE `);
  appendWhere(b, locator, full);
  b.raw(' LIMIT 1)');
}

export function appendOrderBy(b: SqlBuilder, sort: SortSpec[] | undefined): void {
  if (!sort?.length) return;
  b.raw(' ORDER BY ');
  sort.forEach((s, i) => {
    if (i > 0) b.raw(', ');
    b.ident(s.column).raw(s.dir === 'desc' ? ' DESC' : ' ASC');
  });
}

/** Colonne convertie en texte pour LIKE / expressions régulières, selon le moteur. */
function asText(b: SqlBuilder, column: string, textual: boolean) {
  if (textual) return b.ident(column);
  if (b.dialect.engine === 'postgres') return b.ident(column).raw('::text');
  if (b.dialect.engine === 'mysql') return b.raw('CAST(').ident(column).raw(' AS CHAR)');
  return b.ident(column);
}

const splitList = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

/** Un critère de l'onglet Rechercher (opérateurs de phpMyAdmin). */
export function appendCriterion(b: SqlBuilder, c: SearchCriterion, textual: boolean): void {
  const engine = b.dialect.engine;
  const value = c.value ?? '';
  switch (c.operator) {
    case 'IS NULL':
    case 'IS NOT NULL':
      b.ident(c.column).raw(` ${c.operator}`);
      return;
    case "= ''":
    case "!= ''":
      b.ident(c.column).raw(c.operator === "= ''" ? " = ''" : " <> ''");
      return;
    case 'LIKE':
    case 'NOT LIKE':
      asText(b, c.column, textual).raw(` ${c.operator} `).value(value);
      return;
    case 'LIKE %...%':
      asText(b, c.column, textual).raw(' LIKE ').value(`%${value}%`);
      return;
    case 'REGEXP':
    case 'NOT REGEXP': {
      const not = c.operator === 'NOT REGEXP';
      const op = engine === 'postgres' ? (not ? ' !~ ' : ' ~ ') : not ? ' NOT REGEXP ' : ' REGEXP ';
      asText(b, c.column, textual).raw(op).value(value);
      return;
    }
    case 'IN (...)':
    case 'NOT IN (...)': {
      const items = splitList(value);
      if (!items.length) throw new HttpError(400, 'BAD_CRITERION', `Liste vide pour ${c.column}`);
      b.ident(c.column).raw(c.operator === 'IN (...)' ? ' IN (' : ' NOT IN (');
      items.forEach((v, i) => {
        if (i > 0) b.raw(', ');
        b.value(v);
      });
      b.raw(')');
      return;
    }
    case 'BETWEEN':
    case 'NOT BETWEEN': {
      const [lo, hi] = splitList(value);
      if (lo === undefined || hi === undefined) {
        throw new HttpError(
          400,
          'BAD_CRITERION',
          `BETWEEN attend deux valeurs séparées par une virgule (${c.column})`,
        );
      }
      b.ident(c.column).raw(` ${c.operator} `).value(lo).raw(' AND ').value(hi);
      return;
    }
    case '=':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      b.ident(c.column)
        .raw(` ${c.operator === '!=' ? '<>' : c.operator} `)
        .value(value);
      return;
    default:
      throw new HttpError(400, 'BAD_OPERATOR', `Opérateur inconnu : ${String(c.operator)}`);
  }
}

/** Type « texte » : LIKE et REGEXP s'appliquent sans conversion. */
export function isTextual(type: string): boolean {
  return /char|text|clob|enum|set|uuid|citext|name|json/i.test(type) && !/\[\]$/.test(type);
}
