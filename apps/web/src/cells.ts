import { isBinary, type CellValue, type EditInfo, type RowLocator } from '@jsmydata/shared';
import { formatBytes } from './format';

/** Longueur affichée par défaut, comme LimitChars de phpMyAdmin. */
export const LIMIT_CHARS = 50;

export function cellText(
  v: CellValue,
  lang: string,
  full: boolean,
  blobLabel: (size: string) => string,
): string {
  if (v === null) return 'NULL';
  if (isBinary(v)) return blobLabel(formatBytes(v.$binary, lang));
  const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  return !full && s.length > LIMIT_CHARS ? s.slice(0, LIMIT_CHARS) + '…' : s;
}

/** Valeur éditable sous forme de texte (null pour NULL). */
export function cellInputValue(v: CellValue): string | null {
  if (v === null) return null;
  if (isBinary(v)) return null;
  return typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
}

/** Localisateur d'une ligne : valeurs des colonnes de la clé unique. */
export function locatorFor(row: CellValue[], edit: EditInfo): RowLocator {
  const loc: RowLocator = {};
  for (const col of edit.key) {
    const i = edit.columns.indexOf(col);
    if (i >= 0) loc[col] = row[i] ?? null;
  }
  return loc;
}

/** Encodage d'un localisateur dans l'URL (pages Modifier / Copier). */
export function encodeLocator(loc: RowLocator): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(loc))));
}

export function decodeLocator(s: string): RowLocator | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(s)))) as RowLocator;
  } catch {
    return null;
  }
}
