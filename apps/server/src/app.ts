import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  API_PREFIX,
  CSRF_HEADER,
  type LoginRequest,
  type MeResponse,
  type PublicServer,
  type ServerInfo,
  type ServersResponse,
  type SessionServer,
} from '@jsmydata/shared';
import { getDialect, type Connection, type ConnectionParams } from '@jsmydata/sql';
import express, { type Request, type RequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import createMemoryStore from 'memorystore';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig, ServerConfig } from './config.js';
import { ConnectionManager } from './connections.js';
import { listSqliteFiles, SQLITE_EXTENSIONS } from './detect.js';
import { errorHandler, HttpError } from './errors.js';
import { decrypt, encrypt, type Secret } from './secret.js';
import { APP_VERSION } from './version.js';

interface StoredLogin {
  user: string;
  /** Identifiants chiffrés AES-256-GCM : jamais renvoyés au client. */
  enc: string;
}

interface Credentials {
  user?: string;
  password?: string;
  file?: string;
}

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    logins?: Record<string, StoredLogin>;
  }
}

export interface AppOptions {
  config: AppConfig;
  servers: ServerConfig[];
  secret: Secret;
  logger: Logger;
  /** Dossier du client compilé (absent en développement : Vite sert le client). */
  webDir?: string;
  defaultConfig: boolean;
}

const loginSchema = z.object({
  server: z.string().min(1),
  user: z.string().max(256).optional(),
  password: z.string().max(4096).optional(),
  file: z.string().max(1024).optional(),
});

export function createApp(opts: AppOptions) {
  const { config, servers, secret, logger } = opts;
  const app = express();
  const idleMs = config.LoginCookieValidity * 1000;
  const manager = new ConnectionManager(idleMs);
  const byId = new Map(servers.map((s) => [s.id!, s]));

  app.disable('x-powered-by');
  if (config.TrustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': config.ForceSSL ? [] : null,
        },
      },
      strictTransportSecurity: config.ForceSSL,
    }),
  );

  if (config.ForceSSL) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    });
  }

  const MemoryStore = createMemoryStore(session);
  app.use(
    session({
      name: 'jsmydata',
      secret: secret.cookieSecret,
      store: new MemoryStore({ checkPeriod: 60_000 }),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'strict', secure: 'auto', maxAge: idleMs },
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // --- CSRF : jeton par session, exigé pour toute requête modifiante ---
  const ensureCsrf = (req: Request): string => {
    if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('base64url');
    return req.session.csrf;
  };
  const csrfGuard: RequestHandler = (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const sent = req.get(CSRF_HEADER) ?? '';
    const expected = req.session.csrf ?? '';
    const ok =
      expected.length > 0 &&
      sent.length === expected.length &&
      timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok)
      return next(new HttpError(403, 'CSRF', 'Jeton de sécurité invalide ou expiré, rechargez la page.'));
    next();
  };
  api.use(csrfGuard);

  // --- Limitation des échecs de connexion par IP ---
  const failures = new Map<string, { count: number; reset: number }>();
  const tooManyFailures = (ip: string) => {
    const f = failures.get(ip);
    return Boolean(f && f.reset > Date.now() && f.count >= config.LoginMaxFailures);
  };
  const recordFailure = (ip: string) => {
    const now = Date.now();
    const f = failures.get(ip);
    if (!f || f.reset < now) failures.set(ip, { count: 1, reset: now + 5 * 60_000 });
    else f.count++;
  };

  // --- Ouverture d'une connexion à partir de la configuration et des identifiants ---
  const sqliteDir = resolve(config.SqliteDir);
  const resolveSqliteFile = (server: ServerConfig, requested?: string): string => {
    if (server.file) return isAbsolute(server.file) ? server.file : resolve(sqliteDir, server.file);
    const name = (requested ?? '').trim();
    if (!name) throw new HttpError(400, 'SQLITE_FILE_REQUIRED', 'Indiquez le fichier SQLite à ouvrir.');
    if (!SQLITE_EXTENSIONS.test(extname(name) ? name : '')) {
      throw new HttpError(400, 'SQLITE_BAD_EXTENSION', 'Extension attendue : .sqlite, .sqlite3, .db, .db3');
    }
    const full = resolve(sqliteDir, name);
    const rel = relative(sqliteDir, full);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new HttpError(
        403,
        'SQLITE_OUTSIDE_DIR',
        'Le fichier doit se trouver dans le dossier SQLite autorisé.',
      );
    }
    return full;
  };

  const connectionParams = (server: ServerConfig, creds: Credentials): ConnectionParams => ({
    host: server.host,
    port: server.port,
    socket: server.socket,
    user: creds.user,
    password: creds.password,
    database: server.database,
    file: server.engine === 'sqlite' ? resolveSqliteFile(server, creds.file) : undefined,
    ssl: server.ssl,
  });

  const credentialsFor = (req: Request, server: ServerConfig): Credentials | null => {
    if (server.auth_type === 'config')
      return { user: server.user, password: server.password, file: server.file };
    const login = req.session.logins?.[server.id!];
    if (!login) return null;
    return decrypt<Credentials>(secret.encKey, login.enc);
  };

  const getServer = (id: string): ServerConfig => {
    const s = byId.get(id);
    if (!s) throw new HttpError(404, 'UNKNOWN_SERVER', `Serveur inconnu : ${id}`);
    return s;
  };

  const useConnection = async (req: Request): Promise<{ conn: Connection; server: ServerConfig }> => {
    const server = getServer(String(req.params.srv));
    const creds = credentialsFor(req, server);
    if (!creds) throw new HttpError(401, 'NOT_LOGGED_IN', 'Session expirée ou non connectée à ce serveur.');
    // Une session « config » n'a pas forcément de cookie : on en crée une pour indexer la connexion.
    ensureCsrf(req);
    const conn = await manager.get(req.sessionID, server.id!, () =>
      getDialect(server.engine).connect(connectionParams(server, creds)),
    );
    return { conn, server };
  };

  const sessionServers = (req: Request): SessionServer[] =>
    servers
      .filter((s) => s.auth_type === 'config' || req.session.logins?.[s.id!])
      .map((s) => ({
        id: s.id!,
        verbose: s.verbose ?? s.host ?? s.id!,
        engine: s.engine,
        user: s.auth_type === 'config' ? (s.user ?? '') : req.session.logins![s.id!]!.user,
        capabilities: getDialect(s.engine).capabilities,
      }));

  const me = (req: Request): MeResponse => {
    const list = sessionServers(req);
    return { authenticated: list.length > 0, csrfToken: ensureCsrf(req), servers: list };
  };

  // --- Routes publiques ---
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: APP_VERSION });
  });

  api.get('/servers', (_req, res) => {
    const list: PublicServer[] = servers.map((s) => ({
      id: s.id!,
      verbose: s.verbose ?? (s.engine === 'sqlite' ? 'SQLite' : `${s.host ?? 'localhost'}`),
      engine: s.engine,
      authType: s.auth_type,
      autoDetected: s.autoDetected,
      needsFile: s.engine === 'sqlite' && !s.file,
      files: s.engine === 'sqlite' && !s.file ? listSqliteFiles(sqliteDir) : undefined,
    }));
    const body: ServersResponse = {
      servers: list,
      defaultLang: config.DefaultLang,
      defaultColorMode: config.ThemeColorMode,
      allowColorModeChange: config.ThemeColorModeAllowChange,
      defaultConfig: opts.defaultConfig,
    };
    res.json(body);
  });

  api.get('/auth/me', (req, res) => {
    res.json(me(req));
  });

  api.post('/auth/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (tooManyFailures(ip)) {
      throw new HttpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Trop de tentatives échouées, réessayez dans quelques minutes.',
      );
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', 'Requête de connexion invalide.');
    const body: LoginRequest = parsed.data;
    const server = getServer(body.server);
    const user = body.user ?? '';
    const password = body.password ?? '';

    if (server.engine !== 'sqlite') {
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

    const creds: Credentials = { user, password, file: body.file };
    let conn: Connection;
    try {
      conn = await getDialect(server.engine).connect(connectionParams(server, creds));
      await conn.currentUser();
    } catch (err) {
      if (!(err instanceof HttpError)) recordFailure(ip);
      logger.warn({ ip, server: server.id, user }, 'échec de connexion');
      throw err;
    }

    // Nouvel identifiant de session après authentification (protection contre la fixation de session).
    const previous = { logins: req.session.logins ?? {} };
    const oldId = req.sessionID;
    await new Promise<void>((ok, ko) => req.session.regenerate((e) => (e ? ko(e) : ok())));
    req.session.logins = {
      ...previous.logins,
      [server.id!]: {
        user: server.engine === 'sqlite' ? (body.file ?? server.file ?? '') : user,
        enc: encrypt(secret.encKey, creds),
      },
    };
    ensureCsrf(req);
    await manager.close(oldId);
    manager.set(req.sessionID, server.id!, conn);
    failures.delete(ip);
    logger.info({ ip, server: server.id, user }, 'connexion réussie');
    res.json(me(req));
  });

  api.post('/auth/logout', async (req, res) => {
    const target = typeof req.body?.server === 'string' ? req.body.server : undefined;
    if (target && req.session.logins) {
      delete req.session.logins[target];
      await manager.close(req.sessionID, target);
      return res.json(me(req));
    }
    await manager.close(req.sessionID);
    await new Promise<void>((ok) => req.session.destroy(() => ok()));
    res.clearCookie('jsmydata');
    res.json({ authenticated: false, csrfToken: '', servers: [] } satisfies MeResponse);
  });

  // --- Routes serveur / base / table ---
  const filterDatabases = (server: ServerConfig, names: { name: string }[]) => {
    let list = names;
    if (server.only_db?.length) list = list.filter((d) => server.only_db!.includes(d.name));
    if (server.hide_db) {
      const re = new RegExp(server.hide_db);
      list = list.filter((d) => !re.test(d.name));
    }
    return list;
  };

  api.get('/srv/:srv/info', async (req, res) => {
    const { conn, server } = await useConnection(req);
    const v = await conn.serverVersion();
    const dialect = getDialect(server.engine);
    const info: ServerInfo = {
      engine: server.engine,
      product: v.product,
      version: v.version,
      user: await conn.currentUser(),
      host:
        server.engine === 'sqlite'
          ? 'fichier local'
          : server.socket
            ? `Localhost via UNIX socket (${server.socket})`
            : `${server.host ?? '127.0.0.1'}:${server.port ?? (server.engine === 'postgres' ? 5432 : 3306)}`,
      ssl: Boolean(server.ssl),
      driver: dialect.driver,
      nodeVersion: process.version,
      appVersion: APP_VERSION,
    };
    res.json(info);
  });

  api.get('/srv/:srv/databases', async (req, res) => {
    const { conn, server } = await useConnection(req);
    res.json({ databases: filterDatabases(server, await conn.listDatabases()) });
  });

  const assertDbAllowed = (server: ServerConfig, db: string) => {
    if (filterDatabases(server, [{ name: db }]).length === 0) {
      throw new HttpError(403, 'DB_HIDDEN', `Base non accessible : ${db}`);
    }
  };

  api.get('/srv/:srv/db/:db/schemas', async (req, res) => {
    const { conn, server } = await useConnection(req);
    assertDbAllowed(server, String(req.params.db));
    res.json({ schemas: await conn.listSchemas(String(req.params.db)) });
  });

  api.get('/srv/:srv/db/:db/tables', async (req, res) => {
    const { conn, server } = await useConnection(req);
    const db = String(req.params.db);
    assertDbAllowed(server, db);
    const schema = typeof req.query.schema === 'string' ? req.query.schema : undefined;
    res.json({ tables: await conn.listTables(db, schema) });
  });

  api.get('/srv/:srv/db/:db/tables/:table/columns', async (req, res) => {
    const { conn, server } = await useConnection(req);
    const db = String(req.params.db);
    assertDbAllowed(server, db);
    const schema = typeof req.query.schema === 'string' ? req.query.schema : undefined;
    res.json({ columns: await conn.listColumns(db, String(req.params.table), schema) });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Point d’accès API inconnu')));
  api.use(errorHandler(logger));
  app.use(API_PREFIX, api);

  // --- Client React (production) : fichiers statiques + repli SPA ---
  if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) {
    const webDir = opts.webDir;
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      // Anciennes URL phpMyAdmin : index.php?route=/table/sql&db=x&table=y → écran équivalent.
      if (req.path === '/index.php' && typeof req.query.route === 'string') {
        return res.redirect(302, legacyRedirect(req.query as Record<string, string>));
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDir, 'index.html'));
    });
  }

  return { app, manager };
}

/** Redirection des URL phpMyAdmin les plus courantes vers les routes JsMyData. */
export function legacyRedirect(q: Record<string, string>): string {
  const srv = encodeURIComponent(q.server ?? '1');
  const db = q.db ? encodeURIComponent(q.db) : undefined;
  const table = q.table ? encodeURIComponent(q.table) : undefined;
  const route = q.route ?? '/';
  if (db && table) {
    const tab = route.startsWith('/table/structure')
      ? 'structure'
      : route.startsWith('/table/sql')
        ? 'sql'
        : 'browse';
    return `/server/${srv}/db/${db}/table/${table}/${tab}`;
  }
  if (db) return `/server/${srv}/db/${db}/structure`;
  if (route.startsWith('/server/databases')) return `/server/${srv}/databases`;
  return '/';
}
