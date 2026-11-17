import type { Capabilities, ColumnInfo, DatabaseInfo, Engine, SchemaInfo, TableInfo } from '@jsmydata/shared';

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
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: number | string | null;
}

/** Connexion ouverte pour une session et un serveur. */
export interface Connection {
  readonly engine: Engine;
  query(sql: string, params?: unknown[], database?: string): Promise<QueryResult>;
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
