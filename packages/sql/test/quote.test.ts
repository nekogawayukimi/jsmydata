import { describe, expect, it } from 'vitest';
import {
  getDialect,
  quoteAnsiIdent,
  quoteAnsiLiteral,
  quoteMysqlIdent,
  quoteMysqlLiteral,
} from '../src/index.js';

describe('échappement des identifiants', () => {
  it('MySQL : accents graves doublés', () => {
    expect(quoteMysqlIdent('users')).toBe('`users`');
    expect(quoteMysqlIdent('a`b')).toBe('`a``b`');
  });
  it('ANSI (PostgreSQL, SQLite) : guillemets doublés', () => {
    expect(quoteAnsiIdent('users')).toBe('"users"');
    expect(quoteAnsiIdent('a"b')).toBe('"a""b"');
  });
  it('refuse un identifiant vide ou contenant un caractère nul', () => {
    expect(() => quoteMysqlIdent('')).toThrow();
    expect(() => quoteAnsiIdent('a\0b')).toThrow();
  });
});

describe('échappement des littéraux', () => {
  it('MySQL', () => {
    expect(quoteMysqlLiteral("l'été\n")).toBe("'l\\'été\\n'");
    expect(quoteMysqlLiteral('a\\b')).toBe("'a\\\\b'");
  });
  it('ANSI', () => {
    expect(quoteAnsiLiteral("l'été")).toBe("'l''été'");
  });
});

describe('registre des dialectes', () => {
  it('expose les trois moteurs avec leurs capacités', () => {
    expect(getDialect('mysql').capabilities.schemas).toBe(false);
    expect(getDialect('postgres').capabilities.schemas).toBe(true);
    expect(getDialect('sqlite').capabilities.users).toBe(false);
    expect(getDialect('postgres').quoteIdent('t')).toBe('"t"');
  });
});
