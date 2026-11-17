import type {
  Capabilities,
  ColumnInfo,
  DatabaseInfo,
  Engine,
  FieldMeta,
  SchemaInfo,
  TableInfo,
} from '@jsmydata/shared';

/** Paramètres de connexion, communs aux trois moteurs (chaque dialecte lit ce qui le concerne). */
export interface ConnectionParams {
  host?: string;
  port?: number;
  socket?: string;
  user?: string;
  password?: string;
  /** Base initiale (PostgreSQL : obligatoire, défaut « postgres »). */
  database?: string;
  /** SQLite : chemin absolu du fichier. */
  file?: string;
  ssl?: boolean | { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean };
  connectTimeoutMs?: number;
  readOnly?: boolean;
  /** Durée maximale d'une requête en millisecondes (0 ou absent = illimitée). */
  queryTimeoutMs?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: number | string | null;
}

export interface ExecOptions {
  params?: unknown[];
  /** Base courante (USE / client PostgreSQL de cette base). */
  database?: string;
  /** PostgreSQL : schéma placé en tête du search_path. */
  schema?: string;
  /** Plafond de lignes lues (protection mémoire). */
  maxRows?: number;
}

/** Résultat brut d'une instruction : lignes sous forme de tableaux (les noms de colonnes peuvent se répéter). */
export interface ExecResult {
  returnsRows: boolean;
  fields: FieldMeta[];
  rows: unknown[][];
  affectedRows?: number;
  insertId?: number | string | null;
  /** Lignes non lues au-delà de maxRows. */
  truncated?: boolean;
}

/** Connexion ouverte pour une session et un serveur. */
export interface Connection {
  readonly engine: Engine;
  query(sql: string, params?: unknown[], database?: string): Promise<QueryResult>;
  /** Exécute une instruction saisie par l'utilisateur, avec l'origine de chaque colonne. */
  execute(sql: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Clés uniques de la table, clé primaire en premier. */
  uniqueKeys(database: string, table: string, schema?: string): Promise<string[][]>;
  /** Identifiant de la session côté SGBD (pour annuler une requête), pour la base indiquée. */
  backendId(database?: string): number | null;
  serverVersion(): Promise<{ product: string; version: string }>;
  currentUser(): Promise<string>;
  listDatabases(): Promise<DatabaseInfo[]>;
  listSchemas(database: string): Promise<SchemaInfo[]>;
  listTables(database: string, schema?: string): Promise<TableInfo[]>;
  listColumns(database: string, table: string, schema?: string): Promise<ColumnInfo[]>;
  close(): Promise<void>;
}

export interface Dialect {
  readonly engine: Engine;
  readonly driver: string;
  readonly capabilities: Capabilities;
  /** Échappe un identifiant (nom de base, table, colonne). */
  quoteIdent(name: string): string;
  /** Échappe une valeur littérale (affichage des requêtes uniquement : l'exécution passe par des paramètres). */
  quoteLiteral(value: string): string;
  connect(params: ConnectionParams): Promise<Connection>;
  /** Annule la requête en cours d'une session (KILL QUERY, pg_cancel_backend), via une connexion distincte. */
  cancel(params: ConnectionParams, backendId: number): Promise<void>;
  /** Nom qualifié d'une table : `base`.`table`, "schéma"."table" ou "base"."table". */
  qualify(database: string, table: string, schema?: string): string;
  /** Marqueur de paramètre n° i (à partir de 1) : ? ou $i. */
  placeholder(i: number): string;
}

export class DialectError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly sqlState?: string,
    readonly errno?: number,
  ) {
    super(message);
    this.name = 'DialectError';
  }
}
