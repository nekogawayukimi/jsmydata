import { existsSync, readdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';

/** Emplacements courants du socket MySQL / MariaDB (Linux, macOS Homebrew, MAMP, XAMPP). */
export const MYSQL_SOCKETS = [
  '/var/run/mysqld/mysqld.sock',
  '/run/mysqld/mysqld.sock',
  '/tmp/mysql.sock',
  '/opt/homebrew/var/mysql/mysql.sock',
  '/usr/local/var/mysql/mysql.sock',
  '/Applications/MAMP/tmp/mysql/mysql.sock',
  '/opt/lampp/var/mysql/mysql.sock',
  '/var/lib/mysql/mysql.sock',
];

/** Dossiers contenant le socket PostgreSQL (.s.PGSQL.5432). */
export const POSTGRES_SOCKET_DIRS = ['/var/run/postgresql', '/run/postgresql', '/tmp'];

export const SQLITE_EXTENSIONS = /\.(sqlite3?|db|db3|s3db|sl3)$/i;

export function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

export interface DetectOptions {
  sqliteDir: string;
  mysqlSockets?: string[];
  postgresSocketDirs?: string[];
  probe?: (host: string, port: number) => Promise<boolean>;
}

/**
 * Configuration prête à l'emploi : détecte les serveurs locaux.
 * MySQL/MariaDB est toujours proposé (comme phpMyAdmin), même s'il ne répond pas encore.
 */
export async function detectLocalServers(opts: DetectOptions): Promise<ServerConfig[]> {
  const probe = opts.probe ?? portOpen;
  const servers: ServerConfig[] = [];
  const base = { auth_type: 'cookie' as const, AllowRoot: true, AllowNoPassword: false, autoDetected: true };

  const mysqlSocket = (opts.mysqlSockets ?? MYSQL_SOCKETS).find(isSocket);
  const mysqlTcp = mysqlSocket ? false : await probe('127.0.0.1', 3306);
  servers.push({
    ...base,
    id: '1',
    engine: 'mysql',
    verbose: 'MySQL / MariaDB (localhost)',
    ...(mysqlSocket ? { socket: mysqlSocket } : { host: '127.0.0.1', port: 3306 }),
    autoDetected: Boolean(mysqlSocket || mysqlTcp),
  });

  const pgDir = (opts.postgresSocketDirs ?? POSTGRES_SOCKET_DIRS).find((d) =>
    isSocket(join(d, '.s.PGSQL.5432')),
  );
  if (pgDir || (await probe('127.0.0.1', 5432))) {
    servers.push({
      ...base,
      id: 'pg',
      engine: 'postgres',
      verbose: 'PostgreSQL (localhost)',
      ...(pgDir ? { socket: pgDir } : { host: '127.0.0.1' }),
      port: 5432,
      database: 'postgres',
    });
  }

  servers.push({ ...base, id: 'sqlite', engine: 'sqlite', verbose: 'SQLite (dossier local)' });
  return servers;
}

/** Fichiers SQLite proposés à la connexion (premier niveau du dossier autorisé). */
export function listSqliteFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && SQLITE_EXTENSIONS.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
