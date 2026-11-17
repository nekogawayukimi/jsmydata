import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { createApp } from './app.js';
import { assertSafeListen, loadConfig } from './config.js';
import { detectLocalServers } from './detect.js';
import { resolveSecret } from './secret.js';
import { createSessionStore } from './session-store.js';
import { APP_VERSION } from './version.js';

const HELP = `JsMyData ${APP_VERSION} — administration web MySQL/MariaDB, PostgreSQL et SQLite

Usage : jsmydata [options]

  -c, --config <fichier>   fichier de configuration (défaut : ./jsmydata.config.json)
  -H, --host <adresse>     adresse d'écoute (défaut : 127.0.0.1)
  -p, --port <port>        port d'écoute (défaut : 8080)
  -v, --version            affiche la version
  -h, --help               affiche cette aide

Sans configuration, JsMyData détecte MySQL/MariaDB et PostgreSQL locaux
et permet d'ouvrir les fichiers SQLite du dossier courant.`;

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      host: { type: 'string', short: 'H' },
      port: { type: 'string', short: 'p' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(APP_VERSION);

  const logger = pino({
    level: process.env.JSMYDATA_LOG_LEVEL ?? 'info',
    redact: ['password', '*.password', 'req.headers.cookie'],
  });

  const loaded = loadConfig({
    configPath: values.config,
    listenHost: values.host,
    listenPort: values.port ? Number(values.port) : undefined,
  });
  assertSafeListen(loaded);
  const { config } = loaded;

  const servers = config.Servers.length
    ? config.Servers
    : await detectLocalServers({ sqliteDir: config.SqliteDir });
  const secret = resolveSecret(config.blowfishSecret);
  if (secret.origin === 'generated') logger.info({ file: secret.file }, 'clé de chiffrement générée');

  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = [
    process.env.JSMYDATA_WEB_DIR,
    resolve(here, 'public'),
    resolve(here, '../../web/dist'),
  ].find((d): d is string => Boolean(d && existsSync(resolve(d, 'index.html'))));

  const sessionStore = await createSessionStore(config, logger);
  const { app, manager } = createApp({
    config,
    servers,
    secret,
    logger,
    webDir,
    defaultConfig: loaded.source === 'default',
    sessionStore,
  });

  const httpServer = app.listen(config.listen.port, config.listen.host, () => {
    const host = config.listen.host.includes(':') ? `[${config.listen.host}]` : config.listen.host;
    const url = `http://${host}:${config.listen.port}`;
    console.log(`\n  JsMyData ${APP_VERSION} prêt sur ${url}\n`);
    if (loaded.source === 'default') {
      console.log('  Configuration par défaut active (accès local uniquement). Serveurs proposés :');
      for (const s of servers) {
        const where = s.engine === 'sqlite' ? config.SqliteDir : (s.socket ?? `${s.host}:${s.port}`);
        console.log(`   - ${s.verbose} → ${where}${s.autoDetected ? '' : ' (non détecté)'}`);
      }
      console.log('');
    } else if (loaded.file) {
      console.log(`  Configuration : ${loaded.file}\n`);
    }
    if (!webDir) console.log('  Client non compilé : lancez « npm run dev:web » (Vite) en développement.\n');
  });

  const shutdown = async () => {
    httpServer.close();
    await manager.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: Error) => {
  console.error(`\n[jsmydata] ${err.message}\n`);
  process.exit(1);
});
