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
}

export interface ServersResponse {
  servers: PublicServer[];
  defaultLang: string;
  defaultColorMode: ColorMode;
  allowColorModeChange: boolean;
  /** Vrai quand aucun fichier de configuration n'a été trouvé. */
  defaultConfig: boolean;
}

export type ColorMode = 'auto' | 'light' | 'dark';

export interface LoginRequest {
  server: string;
  user?: string;
  password?: string;
  /** SQLite : fichier à ouvrir, relatif au dossier autorisé. */
  file?: string;
}

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
