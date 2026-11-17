/** Identifiant MySQL : accents graves, accent grave doublé. */
export function quoteMysqlIdent(name: string): string {
  assertIdent(name);
  return '`' + name.replaceAll('`', '``') + '`';
}

/** Identifiant standard SQL (PostgreSQL, SQLite) : guillemets doubles, guillemet doublé. */
export function quoteAnsiIdent(name: string): string {
  assertIdent(name);
  return '"' + name.replaceAll('"', '""') + '"';
}

/** Littéral MySQL (sans NO_BACKSLASH_ESCAPES) : apostrophes et barres obliques échappées. */
export function quoteMysqlLiteral(value: string): string {
  return (
    "'" +
    // Caractères de contrôle volontaires : mêmes échappements que mysql_real_escape_string.
    // eslint-disable-next-line no-control-regex
    value.replace(/[\0\n\r\b\t\\'"\x1a]/g, (c) => {
      switch (c) {
        case '\0':
          return '\\0';
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\b':
          return '\\b';
        case '\t':
          return '\\t';
        case '\x1a':
          return '\\Z';
        default:
          return '\\' + c;
      }
    }) +
    "'"
  );
}

/** Littéral standard SQL : apostrophe doublée. */
export function quoteAnsiLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function assertIdent(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('Identifiant SQL vide');
  }
  if (name.includes('\0')) {
    throw new TypeError('Identifiant SQL invalide (caractère nul)');
  }
}
