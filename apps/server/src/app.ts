import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { API_PREFIX, CSRF_HEADER } from '@jsmydata/shared';
import express, { type RequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import createMemoryStore from 'memorystore';
import type { Logger } from 'pino';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig, ServerConfig } from './config.js';
import { Context } from './context.js';
import { errorHandler, HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { navigationRoutes } from './routes/navigation.js';
import type { Secret } from './secret.js';
import { APP_VERSION } from './version.js';

export interface AppOptions {
  config: AppConfig;
  servers: ServerConfig[];
  secret: Secret;
  logger: Logger;
  /** Dossier du client compilé (absent en développement : Vite sert le client). */
  webDir?: string;
  defaultConfig: boolean;
  /** Stockage des sessions (mémoire par défaut ; Redis via createSessionStore). */
  sessionStore?: session.Store;
}

export function createApp(opts: AppOptions) {
  const { config, logger } = opts;
  const ctx = new Context(opts);
  const app = express();

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
      secret: opts.secret.cookieSecret,
      store: opts.sessionStore ?? new MemoryStore({ checkPeriod: 60_000 }),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: 'auto',
        maxAge: config.LoginCookieValidity * 1000,
      },
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '8mb' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // CSRF : jeton par session, exigé pour toute requête modifiante.
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

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: APP_VERSION });
  });
  api.use(authRoutes(ctx));
  api.use(navigationRoutes(ctx));
  api.use(dataRoutes(ctx));

  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Point d’accès API inconnu')));
  api.use(errorHandler(logger));
  app.use(API_PREFIX, api);

  // Client React (production) : fichiers statiques + repli SPA.
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

  return { app, manager: ctx.manager, ctx };
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
        : route.startsWith('/table/search')
          ? 'search'
          : route.startsWith('/table/change')
            ? 'insert'
            : 'browse';
    return `/server/${srv}/db/${db}/table/${table}/${tab}`;
  }
  if (db) {
    const tab = route.startsWith('/database/sql')
      ? 'sql'
      : route.startsWith('/database/search')
        ? 'search'
        : 'structure';
    return `/server/${srv}/db/${db}/${tab}`;
  }
  if (route.startsWith('/server/databases')) return `/server/${srv}/databases`;
  if (route.startsWith('/server/sql')) return `/server/${srv}/sql`;
  return '/';
}
