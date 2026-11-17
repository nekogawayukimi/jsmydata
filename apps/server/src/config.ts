import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Configuration de JsMyData : équivalent de config.inc.php.
 * Les noms de directives reprennent ceux de phpMyAdmin pour faciliter la migration.
 */

const engineSchema = z.enum(['mysql', 'postgres', 'sqlite']);

export const serverSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  verbose: z.string().optional(),
  engine: engineSchema.default('mysql'),
  host: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  socket: z.string().optional(),
  auth_type: z.enum(['cookie', 'config', 'http', 'signon']).default('cookie'),
  /** signon : page de l'application tierce qui authentifie l'utilisateur. */
  SignonURL: z.string().url().optional(),
  /** signon : URL de retour après déconnexion. */
  LogoutURL: z.string().url().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  /** PostgreSQL : base de connexion initiale. */
  database: z.string().optional(),
  /** SQLite : fichier imposé (sinon choix dans SqliteDir). */
  file: z.string().optional(),
  ssl: z
    .union([z.boolean(), z.object({ ca: z.string().optional(), rejectUnauthorized: z.boolean().optional() })])
    .optional(),
  hide_db: z.string().optional(),
  only_db: z.array(z.string()).optional(),
  AllowRoot: z.boolean().default(true),
  AllowNoPassword: z.boolean().default(false),
  autoDetected: z.boolean().default(false),
});

export const configSchema = z.object({
  listen: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.coerce.number().int().min(0).max(65535).default(8080),
    })
    .default({ host: '127.0.0.1', port: 8080 }),
  blowfishSecret: z.string().min(16).optional(),
  Servers: z.array(serverSchema).default([]),
  LoginCookieValidity: z.coerce.number().int().positive().default(1440),
  DefaultLang: z.string().default('auto'),
  ThemeDefault: z.string().default('jmd-default'),
  ThemeColorMode: z.enum(['auto', 'light', 'dark']).default('auto'),
  ThemeColorModeAllowChange: z.boolean().default(true),
  SqliteDir: z.string().optional(),
  MaxRows: z.coerce.number().int().positive().default(25),
  TrustProxy: z.boolean().default(false),
  ForceSSL: z.boolean().default(false),
  /** Nombre d'échecs de connexion tolérés par IP sur 5 minutes. */
  LoginMaxFailures: z.coerce.number().int().positive().default(10),
  /** Autorise la saisie libre d'un serveur sur la page de connexion (toujours actif en configuration par défaut). */
  AllowArbitraryServer: z.boolean().default(false),
  /** Secret partagé avec l'application tierce pour l'authentification signon (jetons HMAC-SHA256). */
  SignonSecret: z.string().min(16).optional(),
  /** Stockage des sessions : mémoire (défaut) ou Redis (plusieurs instances derrière un répartiteur). */
  SessionStore: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('memory') }),
      z.object({
        type: z.literal('redis'),
        url: z.string().default('redis://127.0.0.1:6379'),
        prefix: z.string().default('jsmydata:'),
      }),
    ])
    .default({ type: 'memory' }),
  /** Nombre maximal de lignes renvoyées par « Tout afficher ». */
  MaxShowAllRows: z.coerce.number().int().positive().default(10_000),
  /** Durée maximale d'une requête lancée depuis l'interface (secondes, 0 = illimitée). */
  QueryTimeout: z.coerce.number().int().min(0).default(0),
});

export type ServerConfig = z.infer<typeof serverSchema>;
export type AppConfig = z.infer<typeof configSchema> & { SqliteDir: string };

export interface LoadedConfig {
  config: AppConfig;
  /** 'file' : fichier lu ; 'env' : variables d'environnement seules ; 'default' : configuration prête à l'emploi. */
  source: 'file' | 'env' | 'default';
  file?: string;
}

const CONFIG_FILES = ['jsmydata.config.json', 'jsmydata.config.yaml', 'jsmydata.config.yml'];

export interface LoadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  listenHost?: string;
  listenPort?: number;
}

function readConfigFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  if (/\.ya?ml$/i.test(path)) return parseYaml(text);
  return JSON.parse(text);
}

/** Variables d'environnement JSMYDATA_* (avec les alias PMA_* de l'image Docker phpmyadmin). */
function envOverrides(env: NodeJS.ProcessEnv): {
  raw: Record<string, unknown>;
  server?: Record<string, unknown>;
} {
  const pick = (...names: string[]) => names.map((n) => env[n]).find((v) => v !== undefined && v !== '');
  const raw: Record<string, unknown> = {};
  const listen: Record<string, unknown> = {};
  const lh = pick('JSMYDATA_LISTEN_HOST');
  const lp = pick('JSMYDATA_LISTEN_PORT', 'PORT');
  if (lh) listen.host = lh;
  if (lp) listen.port = lp;
  if (Object.keys(listen).length) raw.listen = listen;
  const secret = pick('JSMYDATA_SECRET', 'PMA_BLOWFISH_SECRET');
  if (secret) raw.blowfishSecret = secret;
  const sqliteDir = pick('JSMYDATA_SQLITE_DIR');
  if (sqliteDir) raw.SqliteDir = sqliteDir;
  const lang = pick('JSMYDATA_LANG');
  if (lang) raw.DefaultLang = lang;
  const mode = pick('JSMYDATA_COLOR_MODE');
  if (mode) raw.ThemeColorMode = mode;
  if (pick('JSMYDATA_TRUST_PROXY') === '1') raw.TrustProxy = true;
  if (pick('JSMYDATA_ARBITRARY', 'PMA_ARBITRARY') === '1') raw.AllowArbitraryServer = true;
  const redis = pick('JSMYDATA_REDIS_URL');
  if (redis) raw.SessionStore = { type: 'redis', url: redis };

  const host = pick('JSMYDATA_HOST', 'PMA_HOST');
  if (!host) return { raw };
  const server: Record<string, unknown> = { host, verbose: pick('JSMYDATA_VERBOSE', 'PMA_VERBOSE') };
  const port = pick('JSMYDATA_PORT', 'PMA_PORT');
  if (port) server.port = port;
  const engine = pick('JSMYDATA_ENGINE');
  if (engine) server.engine = engine;
  const user = pick('JSMYDATA_USER', 'PMA_USER');
  const password = pick('JSMYDATA_PASSWORD', 'PMA_PASSWORD');
  if (user) {
    server.auth_type = 'config';
    server.user = user;
    server.password = password ?? '';
    server.AllowNoPassword = password === undefined || password === '';
  }
  return { raw, server };
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const explicit = opts.configPath ?? env.JSMYDATA_CONFIG;

  let file: string | undefined;
  if (explicit) {
    file = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(file)) throw new Error(`Fichier de configuration introuvable : ${file}`);
  } else {
    file = CONFIG_FILES.map((f) => resolve(cwd, f)).find((f) => existsSync(f));
  }

  const base = (file ? readConfigFile(file) : {}) as Record<string, unknown>;
  const { raw, server } = envOverrides(env);
  const merged: Record<string, unknown> = { ...base, ...raw };
  if (raw.listen) merged.listen = { ...(base.listen as object), ...(raw.listen as object) };
  if (opts.listenHost || opts.listenPort !== undefined) {
    merged.listen = {
      ...(merged.listen as object),
      ...(opts.listenHost ? { host: opts.listenHost } : {}),
      ...(opts.listenPort !== undefined ? { port: opts.listenPort } : {}),
    };
  }
  if (server) merged.Servers = [server, ...((base.Servers as unknown[]) ?? [])];

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide${file ? ` (${file})` : ''} :\n${details}`);
  }
  const config: AppConfig = {
    ...parsed.data,
    SqliteDir: resolve(cwd, parsed.data.SqliteDir ?? '.'),
  };
  // Identifiants stables : utilisés dans les URL du client.
  const used = new Set<string>();
  config.Servers = config.Servers.map((s, i) => {
    let id = s.id ?? (s.engine === 'mysql' ? String(i + 1) : `${s.engine}${i + 1}`);
    while (used.has(id)) id = `${id}_`;
    used.add(id);
    return { ...s, id };
  });

  const source: LoadedConfig['source'] = file
    ? 'file'
    : server || Object.keys(raw).length
      ? 'env'
      : 'default';
  return { config, source, file };
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Garde-fou de la configuration prête à l'emploi : sans configuration explicite,
 * JsMyData n'écoute que sur la boucle locale.
 */
export function assertSafeListen(loaded: LoadedConfig): void {
  if (loaded.source === 'default' && !isLoopback(loaded.config.listen.host)) {
    throw new Error(
      `Refus de démarrer : écoute sur ${loaded.config.listen.host} sans configuration explicite.\n` +
        'Créez un fichier jsmydata.config.json (au minimum « blowfishSecret » et « Servers »),\n' +
        'ou définissez JSMYDATA_SECRET et JSMYDATA_HOST, puis relancez.',
    );
  }
}
