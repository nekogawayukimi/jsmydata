/**
 * Types partagés entre le client React et l'API Express.
 * Toute réponse de l'API v1 est décrite ici.
 */

export type Engine = 'mysql' | 'postgres' | 'sqlite';

export type AuthType = 'cookie' | 'config' | 'http' | 'signon';

export const ENGINE_LABELS: Record<Engine, string> = {
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
};

/** Ce que sait faire un moteur : le client masque les onglets et options non supportés. */
export interface Capabilities {
  /** Plusieurs bases sur un même serveur. */
  databases: boolean;
  /** Niveau « schéma » entre base et table (PostgreSQL). */
  schemas: boolean;
  users: boolean;
  routines: boolean;
  events: boolean;
  triggers: boolean;
  views: boolean;
  materializedViews: boolean;
  sequences: boolean;
  storageEngines: boolean;
  replication: boolean;
  processList: boolean;
  serverVariables: boolean;
}

/** Serveur tel que présenté sur la page de connexion (aucun secret). */
export interface PublicServer {
  id: string;
  verbose: string;
  engine: Engine;
  authType: AuthType;
  /** Serveur ajouté automatiquement par la détection locale (configuration prête à l'emploi). */
  autoDetected: boolean;
  /** Pour SQLite : le client doit fournir un nom de fichier. */
  needsFile: boolean;
  /** Pour SQLite : fichiers disponibles dans le dossier autorisé. */
  files?: string[];
  /** auth_type signon : page de connexion de l'application tierce. */
  signonUrl?: string;
}

export interface ServersResponse {
  servers: PublicServer[];
  defaultLang: string;
  defaultColorMode: ColorMode;
  allowColorModeChange: boolean;
  /** Vrai quand aucun fichier de configuration n'a été trouvé. */
  defaultConfig: boolean;
  /** Saisie libre d'un serveur autorisée sur la page de connexion. */
  allowArbitrary: boolean;
  /** Nombre de lignes par page par défaut (MaxRows). */
  maxRows: number;
}

export type ColorMode = 'auto' | 'light' | 'dark';

export interface LoginRequest {
  server: string;
  user?: string;
  password?: string;
  /** SQLite : fichier à ouvrir, relatif au dossier autorisé. */
  file?: string;
  /** Serveur saisi librement (server = ARBITRARY_SERVER). */
  host?: string;
  port?: number;
  engine?: Engine;
}

export const ARBITRARY_SERVER = '__arbitrary__';

export interface SessionServer {
  id: string;
  verbose: string;
  engine: Engine;
  user: string;
  capabilities: Capabilities;
}

export interface MeResponse {
  authenticated: boolean;
  csrfToken: string;
  servers: SessionServer[];
}

export interface ServerInfo {
  engine: Engine;
  product: string;
  version: string;
  user: string;
  host: string;
  charset?: string;
  ssl?: boolean;
  driver: string;
  nodeVersion: string;
  appVersion: string;
}

export interface DatabaseInfo {
  name: string;
  collation?: string;
  system?: boolean;
}

export interface SchemaInfo {
  name: string;
  owner?: string;
  system?: boolean;
}

export type TableKind = 'table' | 'view' | 'materialized_view';

export interface TableInfo {
  name: string;
  kind: TableKind;
  /** Estimation (InnoDB, PostgreSQL) ou valeur exacte (SQLite, MyISAM). */
  rows?: number | null;
  rowsEstimated?: boolean;
  engine?: string | null;
  collation?: string | null;
  dataLength?: number | null;
  indexLength?: number | null;
  comment?: string | null;
}

export interface ColumnInfo {
  position: number;
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  collation?: string | null;
  primaryKey: boolean;
  extra?: string | null;
  comment?: string | null;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  sql?: string;
  sqlState?: string;
  errno?: number;
}

export const API_PREFIX = '/api/v1';
export const CSRF_HEADER = 'x-csrf-token';

/* ------------------------------------------------------------------ */
/* Lot 1 : exécution SQL, parcours, édition, recherche                 */
/* ------------------------------------------------------------------ */

/** Origine d'une colonne de résultat (pour l'édition en ligne). */
export interface FieldMeta {
  name: string;
  /** Table d'origine, si la colonne vient directement d'une table. */
  table?: string | null;
  /** Colonne d'origine dans cette table. */
  column?: string | null;
  /** Base (MySQL, SQLite) ou schéma (PostgreSQL) de la table d'origine. */
  schema?: string | null;
  /** Type tel que rapporté par le pilote (indicatif). */
  type?: string | null;
}

/** Valeur binaire, transmise sous forme résumée (taille + début en hexadécimal). */
export interface BinaryValue {
  $binary: number;
  hex: string;
}

export type CellValue = string | number | boolean | null | BinaryValue;

export function isBinary(v: unknown): v is BinaryValue {
  return typeof v === 'object' && v !== null && '$binary' in v;
}

/** Résultat éditable : la table d'origine et la façon de localiser une ligne. */
export interface EditInfo {
  db: string;
  schema?: string;
  table: string;
  /** Colonnes de la clé unique présente dans le résultat, qui localise chaque ligne. */
  key: string[];
  /** Pour chaque colonne du résultat, la colonne de la table (null si expression non éditable). */
  columns: (string | null)[];
}

export interface StatementResult {
  /** Requête exécutée (avec LIMIT ajouté le cas échéant). */
  sql: string;
  durationMs: number;
  /** true si la requête renvoie des lignes (SELECT, SHOW, PRAGMA…). */
  returnsRows: boolean;
  fields?: FieldMeta[];
  rows?: CellValue[][];
  /** Nombre total de lignes (null si inconnu). */
  total?: number | null;
  totalEstimated?: boolean;
  offset?: number;
  /** LIMIT ajouté automatiquement par JsMyData. */
  limited?: boolean;
  affectedRows?: number;
  insertId?: string | number | null;
  editable?: EditInfo | null;
}

export interface SqlRequest {
  sql: string;
  db?: string;
  schema?: string;
  offset?: number;
  count?: number;
  /** Ne pas ajouter de LIMIT automatique (« Tout afficher », plafonné par MaxShowAllRows). */
  showAll?: boolean;
}

export interface SqlResponse {
  results: StatementResult[];
  /** Erreur de l'instruction qui a interrompu l'exécution (les précédentes ont réussi). */
  error?: ApiErrorBody & { statement: string; index: number };
}

export type SortDir = 'asc' | 'desc';
export interface SortSpec {
  column: string;
  dir: SortDir;
}

/** Valeur saisie dans un formulaire : null = NULL, fn = fonction SQL de la liste autorisée. */
export interface CellInput {
  value: string | null;
  fn?: string;
}

/** Valeurs permettant de retrouver une ligne (clé unique, ou toutes les colonnes). */
export type RowLocator = Record<string, CellValue>;

export interface UpdateRowRequest {
  locator: RowLocator;
  set: Record<string, CellInput>;
}

export interface InsertRowsRequest {
  rows: Record<string, CellInput>[];
  mode?: 'insert' | 'ignore' | 'replace';
}

export interface DeleteRowsRequest {
  locators: RowLocator[];
}

export interface MutationResponse {
  sql: string[];
  affectedRows: number;
  insertId?: string | number | null;
}

export type SearchOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'LIKE %...%'
  | 'NOT LIKE'
  | 'REGEXP'
  | 'NOT REGEXP'
  | 'IN (...)'
  | 'NOT IN (...)'
  | 'BETWEEN'
  | 'NOT BETWEEN'
  | 'IS NULL'
  | 'IS NOT NULL'
  | "= ''"
  | "!= ''";

export interface SearchCriterion {
  column: string;
  operator: SearchOperator;
  value?: string;
}

export interface TableSearchRequest {
  criteria: SearchCriterion[];
  /** Colonnes à afficher (toutes si absent). */
  columns?: string[];
  distinct?: boolean;
  offset?: number;
  count?: number;
  sort?: SortSpec[];
}

export type DbSearchMode = 'any' | 'all' | 'exact' | 'regexp';

export interface DbSearchRequest {
  words: string;
  mode: DbSearchMode;
  tables?: string[];
  column?: string;
}

export interface DbSearchResponse {
  results: { table: string; count: number; sql: string }[];
  total: number;
}

/** Fonctions proposées dans les formulaires Insérer / Modifier. */
export const SQL_FUNCTIONS: Record<Engine, { name: string; arg: boolean }[]> = {
  mysql: [
    { name: 'ABS', arg: true },
    { name: 'BIN', arg: true },
    { name: 'CHAR', arg: true },
    { name: 'CURDATE', arg: false },
    { name: 'CURRENT_TIMESTAMP', arg: false },
    { name: 'CURTIME', arg: false },
    { name: 'DATE', arg: true },
    { name: 'FROM_BASE64', arg: true },
    { name: 'FROM_UNIXTIME', arg: true },
    { name: 'HEX', arg: true },
    { name: 'INET_ATON', arg: true },
    { name: 'INET_NTOA', arg: true },
    { name: 'LCASE', arg: true },
    { name: 'LOWER', arg: true },
    { name: 'LTRIM', arg: true },
    { name: 'MD5', arg: true },
    { name: 'NOW', arg: false },
    { name: 'RAND', arg: false },
    { name: 'RTRIM', arg: true },
    { name: 'SHA1', arg: true },
    { name: 'SOUNDEX', arg: true },
    { name: 'TO_BASE64', arg: true },
    { name: 'TRIM', arg: true },
    { name: 'UCASE', arg: true },
    { name: 'UNHEX', arg: true },
    { name: 'UNIX_TIMESTAMP', arg: false },
    { name: 'UPPER', arg: true },
    { name: 'UTC_DATE', arg: false },
    { name: 'UTC_TIMESTAMP', arg: false },
    { name: 'UUID', arg: false },
    { name: 'YEAR', arg: true },
  ],
  postgres: [
    { name: 'ABS', arg: true },
    { name: 'CURRENT_DATE', arg: false },
    { name: 'CURRENT_TIMESTAMP', arg: false },
    { name: 'GEN_RANDOM_UUID', arg: false },
    { name: 'LOWER', arg: true },
    { name: 'MD5', arg: true },
    { name: 'NOW', arg: false },
    { name: 'TO_TIMESTAMP', arg: true },
    { name: 'TRIM', arg: true },
    { name: 'UPPER', arg: true },
  ],
  sqlite: [
    { name: 'ABS', arg: true },
    { name: 'CURRENT_DATE', arg: false },
    { name: 'CURRENT_TIME', arg: false },
    { name: 'CURRENT_TIMESTAMP', arg: false },
    { name: 'HEX', arg: true },
    { name: 'LOWER', arg: true },
    { name: 'RANDOM', arg: false },
    { name: 'TRIM', arg: true },
    { name: 'UPPER', arg: true },
  ],
};
