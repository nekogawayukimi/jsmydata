import {
  ARBITRARY_SERVER,
  type LoginRequest,
  type MeResponse,
  type PublicServer,
  type ServersResponse,
} from '@jsmydata/shared';
import { getDialect, type Connection } from '@jsmydata/sql';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { Context, Credentials } from '../context.js';
import { listSqliteFiles } from '../detect.js';
import { HttpError } from '../errors.js';
import { verifySignonToken } from '../signon.js';

const loginSchema = z.object({
  server: z.string().min(1),
  user: z.string().max(256).optional(),
  password: z.string().max(4096).optional(),
  file: z.string().max(1024).optional(),
  host: z.string().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  engine: z.enum(['mysql', 'postgres']).optional(),
});

/** Connexion, déconnexion et modes d'authentification (cookie, config, http, signon). */
export function authRoutes(ctx: Context): Router {
  const r = Router();
  const { config, logger } = ctx;

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

  /** Ouvre une connexion de test puis installe la session (nouvel identifiant : anti-fixation). */
  const completeLogin = async (
    req: Request,
    server: ServerConfig,
    creds: Credentials,
    displayUser: string,
  ) => {
    const ip = req.ip ?? 'unknown';
    if (tooManyFailures(ip)) {
      throw new HttpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Trop de tentatives échouées, réessayez dans quelques minutes.',
      );
    }
    let conn: Connection;
    try {
      conn = await getDialect(server.engine).connect(ctx.connectionParams(server, creds));
      await conn.currentUser();
    } catch (err) {
      if (!(err instanceof HttpError)) recordFailure(ip);
      logger.warn({ ip, server: server.id, user: creds.user }, 'échec de connexion');
      throw err;
    }
    const previous = { logins: req.session.logins ?? {}, arbitrary: req.session.arbitrary };
    const oldId = req.sessionID;
    await new Promise<void>((ok, ko) => req.session.regenerate((e) => (e ? ko(e) : ok())));
    req.session.logins = previous.logins;
    req.session.arbitrary = previous.arbitrary;
    ctx.storeLogin(req, server, creds, displayUser);
    ctx.ensureCsrf(req);
    await ctx.manager.close(oldId);
    ctx.manager.set(req.sessionID, server.id!, conn);
    failures.delete(ip);
    logger.info({ ip, server: server.id, user: creds.user }, 'connexion réussie');
  };

  r.get('/servers', (_req, res) => {
    const list: PublicServer[] = ctx.servers.map((s) => ({
      id: s.id!,
      verbose: s.verbose ?? (s.engine === 'sqlite' ? 'SQLite' : `${s.host ?? 'localhost'}`),
      engine: s.engine,
      authType: s.auth_type,
      autoDetected: s.autoDetected,
      needsFile: s.engine === 'sqlite' && !s.file,
      files: s.engine === 'sqlite' && !s.file ? listSqliteFiles(ctx.sqliteDir) : undefined,
      signonUrl: s.auth_type === 'signon' ? s.SignonURL : undefined,
    }));
    const body: ServersResponse = {
      servers: list,
      defaultLang: config.DefaultLang,
      defaultColorMode: config.ThemeColorMode,
      allowColorModeChange: config.ThemeColorModeAllowChange,
      defaultConfig: ctx.defaultConfig,
      allowArbitrary: ctx.allowArbitrary,
      maxRows: config.MaxRows,
    };
    res.json(body);
  });

  r.get('/auth/me', (req, res) => {
    res.json(ctx.me(req));
  });

  r.post('/auth/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', 'Requête de connexion invalide.');
    const body: LoginRequest = parsed.data;
    const server =
      body.server === ARBITRARY_SERVER
        ? ctx.addArbitraryServer(req, parsed.data.engine ?? 'mysql', (body.host ?? '').trim(), body.port)
        : ctx.getServer(req, body.server);
    if (server.auth_type !== 'cookie') {
      throw new HttpError(
        400,
        'WRONG_AUTH_TYPE',
        `Ce serveur utilise l’authentification « ${server.auth_type} ».`,
      );
    }
    const user = body.user ?? '';
    const password = body.password ?? '';
    ctx.checkLoginRules(server, user, password);
    const display = server.engine === 'sqlite' ? (body.file ?? server.file ?? '') : user;
    await completeLogin(req, server, { user, password, file: body.file }, display);
    res.json(ctx.me(req));
  });

  /** auth_type http : le navigateur affiche sa fenêtre d'authentification (HTTP Basic). */
  r.get('/auth/http/:srv', async (req, res) => {
    const server = ctx.getServer(req, String(req.params.srv));
    if (server.auth_type !== 'http')
      throw new HttpError(400, 'WRONG_AUTH_TYPE', 'Ce serveur n’utilise pas l’authentification HTTP.');
    const header = req.get('authorization') ?? '';
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
    const decoded = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
    const sep = decoded.indexOf(':');
    if (sep < 0) {
      const realm = `JsMyData ${server.verbose ?? server.host ?? server.id}`.replace(/"/g, '');
      res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
      throw new HttpError(401, 'HTTP_AUTH_REQUIRED', 'Authentification HTTP requise.');
    }
    const user = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    ctx.checkLoginRules(server, user, password);
    await completeLogin(req, server, { user, password }, user);
    res.redirect(302, `/server/${encodeURIComponent(server.id!)}`);
  });

  /** auth_type signon : l'application tierce redirige ici avec un jeton signé (voir signon.ts). */
  r.get('/auth/signon', async (req, res) => {
    if (!config.SignonSecret)
      throw new HttpError(400, 'SIGNON_DISABLED', 'SignonSecret n’est pas configuré.');
    let payload;
    try {
      payload = verifySignonToken(config.SignonSecret, String(req.query.token ?? ''));
    } catch (err) {
      throw new HttpError(403, 'SIGNON_INVALID', (err as Error).message);
    }
    const server = ctx.getServer(req, payload.server);
    if (server.auth_type !== 'signon')
      throw new HttpError(400, 'WRONG_AUTH_TYPE', 'Ce serveur n’utilise pas l’authentification signon.');
    ctx.checkLoginRules(server, payload.user, payload.password ?? '');
    await completeLogin(req, server, { user: payload.user, password: payload.password }, payload.user);
    res.redirect(302, `/server/${encodeURIComponent(server.id!)}`);
  });

  r.post('/auth/logout', async (req, res) => {
    const target = typeof req.body?.server === 'string' ? req.body.server : undefined;
    if (target && req.session.logins) {
      delete req.session.logins[target];
      await ctx.manager.close(req.sessionID, target);
      return res.json(ctx.me(req));
    }
    // Retour vers l'application tierce pour les serveurs signon (LogoutURL).
    const signon = ctx.servers.find(
      (s) => s.auth_type === 'signon' && s.LogoutURL && req.session.logins?.[s.id!],
    );
    await ctx.manager.close(req.sessionID);
    await new Promise<void>((ok) => req.session.destroy(() => ok()));
    res.clearCookie('jsmydata');
    res.json({
      authenticated: false,
      csrfToken: '',
      servers: [],
      logoutUrl: signon?.LogoutURL,
    } as MeResponse & {
      logoutUrl?: string;
    });
  });

  return r;
}
