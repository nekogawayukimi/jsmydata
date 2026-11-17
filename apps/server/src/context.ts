import { createHash, randomBytes } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { MeResponse, SessionServer } from '@jsmydata/shared';
import { getDialect, type Connection, type ConnectionParams, type Dialect } from '@jsmydata/sql';
import type { Request } from 'express';
import type { Logger } from 'pino';
import type { AppConfig, ServerConfig } from './config.js';
import { ConnectionManager } from './connections.js';
import { SQLITE_EXTENSIONS } from './detect.js';
import { HttpError } from './errors.js';
import { decrypt, encrypt, type Secret } from './secret.js';

export interface StoredLogin {
  user: string;
  /** Identifiants chiffrés AES-256-GCM : jamais renvoyés au client. */
  enc: string;
}

export interface Credentials {
  user?: string;
  password?: string;
  file?: string;
}

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    logins?: Record<string, StoredLogin>;
    /** Serveurs saisis librement sur la page de connexion (AllowArbitraryServer). */
    arbitrary?: Record<string, ServerConfig>;
  }
}

export interface ContextOptions {
  config: AppConfig;
  servers: ServerConfig[];
  secret: Secret;
  logger: Logger;
  defaultConfig: boolean;
}

/** Requête en cours par session et serveur, pour « Arrêter ». */
interface Running {
  backendId: number;
  serverId: string;
}

/** État partagé par les routes : configuration, serveurs, sessions et connexions. */
export class Context {
  readonly config: AppConfig;
  readonly servers: ServerConfig[];
  readonly secret: Secret;
  readonly logger: Logger;
  readonly defaultConfig: boolean;
  readonly manager: ConnectionManager;
  readonly sqliteDir: string;
  readonly allowArbitrary: boolean;
  private readonly byId: Map<string, ServerConfig>;
  private readonly running = new Map<string, Running>();

  constructor(opts: ContextOptions) {
    this.config = opts.config;
    this.servers = opts.servers;
    this.secret = opts.secret;
    this.logger = opts.logger;
    this.defaultConfig = opts.defaultConfig;
    this.manager = new ConnectionManager(opts.config.LoginCookieValidity * 1000);
    this.sqliteDir = resolve(opts.config.SqliteDir);
    // En configuration par défaut (écoute locale imposée), la saisie libre d'un serveur est permise.
    this.allowArbitrary = opts.config.AllowArbitraryServer || opts.defaultConfig;
    this.byId = new Map(opts.servers.map((s) => [s.id!, s]));
  }

  ensureCsrf(req: Request): string {
    if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('base64url');
    return req.session.csrf;
  }

  getServer(req: Request, id: string): ServerConfig {
    const s = this.byId.get(id) ?? req.session.arbitrary?.[id];
    if (!s) throw new HttpError(404, 'UNKNOWN_SERVER', `Serveur inconnu : ${id}`);
    return s;
  }

  /** Serveur saisi librement : enregistré dans la session, identifiant stable dérivé de l'adresse. */
  addArbitraryServer(req: Request, engine: 'mysql' | 'postgres', host: string, port?: number): ServerConfig {
    if (!this.allowArbitrary)
      throw new HttpError(403, 'ARBITRARY_DENIED', 'La saisie libre d’un serveur est désactivée.');
    if (!/^[A-Za-z0-9._:[\]-]{1,255}$/.test(host))
      throw new HttpError(400, 'BAD_HOST', 'Nom d’hôte invalide.');
    const p = port ?? (engine === 'postgres' ? 5432 : 3306);
    const id = 'arb-' + createHash('sha1').update(`${engine}|${host}|${p}`).digest('hex').slice(0, 8);
    const server: ServerConfig = {
      id,
      engine,
      host,
      port: p,
      verbose: `${host}:${p}`,
      database: engine === 'postgres' ? 'postgres' : undefined,
      auth_type: 'cookie',
      AllowRoot: true,
      AllowNoPassword: this.defaultConfig,
      autoDetected: false,
    };
    req.session.arbitrary = { ...req.session.arbitrary, [id]: server };
    return server;
  }

  resolveSqliteFile(server: ServerConfig, requested?: string): string {
    if (server.file) return isAbsolute(server.file) ? server.file : resolve(this.sqliteDir, server.file);
    const name = (requested ?? '').trim();
    if (!name) throw new HttpError(400, 'SQLITE_FILE_REQUIRED', 'Indiquez le fichier SQLite à ouvrir.');
    if (!SQLITE_EXTENSIONS.test(extname(name) ? name : '')) {
      throw new HttpError(400, 'SQLITE_BAD_EXTENSION', 'Extension attendue : .sqlite, .sqlite3, .db, .db3');
    }
    const full = resolve(this.sqliteDir, name);
    const rel = relative(this.sqliteDir, full);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new HttpError(
        403,
        'SQLITE_OUTSIDE_DIR',
        'Le fichier doit se trouver dans le dossier SQLite autorisé.',
      );
    }
    return full;
  }

  connectionParams(server: ServerConfig, creds: Credentials): ConnectionParams {
    return {
      host: server.host,
      port: server.port,
      socket: server.socket,
      user: creds.user,
      password: creds.password,
      database: server.database,
      file: server.engine === 'sqlite' ? this.resolveSqliteFile(server, creds.file) : undefined,
      ssl: server.ssl,
      queryTimeoutMs: this.config.QueryTimeout * 1000,
    };
  }

  credentialsFor(req: Request, server: ServerConfig): Credentials | null {
    if (server.auth_type === 'config')
      return { user: server.user, password: server.password, file: server.file };
    const login = req.session.logins?.[server.id!];
    if (!login) return null;
    return decrypt<Credentials>(this.secret.encKey, login.enc);
  }

  /** Enregistre une connexion réussie dans la session (identifiants chiffrés). */
  storeLogin(req: Request, server: ServerConfig, creds: Credentials, displayUser: string) {
    req.session.logins = {
      ...req.session.logins,
      [server.id!]: { user: displayUser, enc: encrypt(this.secret.encKey, creds) },
    };
  }

  /** Vérifie les règles AllowRoot / AllowNoPassword avant toute tentative de connexion. */
  checkLoginRules(server: ServerConfig, user: string, password: string) {
    if (server.engine === 'sqlite') return;
    if (!user) throw new HttpError(400, 'USER_REQUIRED', "Indiquez un nom d'utilisateur.");
    if (!server.AllowRoot && user === 'root') {
      throw new HttpError(
        403,
        'ROOT_DENIED',
        'La connexion en tant que root est interdite par la configuration.',
      );
    }
    if (!server.AllowNoPassword && password === '') {
      throw new HttpError(
        403,
        'EMPTY_PASSWORD_DENIED',
        'Les mots de passe vides sont interdits par la configuration.',
      );
    }
  }

  async useConnection(
    req: Request,
  ): Promise<{ conn: Connection; server: ServerConfig; dialect: Dialect; params: ConnectionParams }> {
    const server = this.getServer(req, String(req.params.srv));
    const creds = this.credentialsFor(req, server);
    if (!creds) throw new HttpError(401, 'NOT_LOGGED_IN', 'Session expirée ou non connectée à ce serveur.');
    // Une session « config » n'a pas forcément de cookie : on en crée une pour indexer la connexion.
    this.ensureCsrf(req);
    const dialect = getDialect(server.engine);
    const params = this.connectionParams(server, creds);
    const conn = await this.manager.get(req.sessionID, server.id!, () => dialect.connect(params));
    return { conn, server, dialect, params };
  }

  sessionServers(req: Request): SessionServer[] {
    const all = [...this.servers, ...Object.values(req.session.arbitrary ?? {})];
    return all
      .filter((s) => s.auth_type === 'config' || req.session.logins?.[s.id!])
      .map((s) => ({
        id: s.id!,
        verbose: s.verbose ?? s.host ?? s.id!,
        engine: s.engine,
        user: s.auth_type === 'config' ? (s.user ?? '') : req.session.logins![s.id!]!.user,
        capabilities: getDialect(s.engine).capabilities,
      }));
  }

  me(req: Request): MeResponse {
    const list = this.sessionServers(req);
    return { authenticated: list.length > 0, csrfToken: this.ensureCsrf(req), servers: list };
  }

  setRunning(req: Request, serverId: string, backendId: number | null) {
    const key = `${req.sessionID}\u0000${serverId}`;
    if (backendId === null) this.running.delete(key);
    else this.running.set(key, { backendId, serverId });
  }

  getRunning(req: Request, serverId: string): Running | undefined {
    return this.running.get(`${req.sessionID}\u0000${serverId}`);
  }
}
