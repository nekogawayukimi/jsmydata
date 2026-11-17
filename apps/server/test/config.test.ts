import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeListen, loadConfig } from '../src/config.js';
import { detectLocalServers, listSqliteFiles } from '../src/detect.js';
import { decrypt, encrypt, resolveSecret } from '../src/secret.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsmydata-conf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('configuration prête à l’emploi', () => {
  it('sans fichier ni variable : valeurs par défaut, écoute locale', () => {
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.source).toBe('default');
    expect(loaded.config.listen).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(loaded.config.ThemeColorMode).toBe('auto');
    expect(loaded.config.LoginCookieValidity).toBe(1440);
    expect(loaded.config.SqliteDir).toBe(dir);
    expect(() => assertSafeListen(loaded)).not.toThrow();
  });

  it('refuse d’écouter hors boucle locale sans configuration explicite', () => {
    const loaded = loadConfig({ cwd: dir, env: {}, listenHost: '0.0.0.0' });
    expect(() => assertSafeListen(loaded)).toThrow(/Refus de démarrer/);
  });

  it('accepte une écoute publique avec un fichier de configuration', () => {
    writeFileSync(
      join(dir, 'jsmydata.config.json'),
      JSON.stringify({ listen: { host: '0.0.0.0' }, Servers: [{ host: 'db', verbose: 'Prod' }] }),
    );
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.source).toBe('file');
    expect(loaded.config.Servers[0]).toMatchObject({
      id: '1',
      engine: 'mysql',
      host: 'db',
      auth_type: 'cookie',
    });
    expect(() => assertSafeListen(loaded)).not.toThrow();
  });

  it('lit un fichier YAML', () => {
    writeFileSync(join(dir, 'jsmydata.config.yaml'), 'Servers:\n  - engine: postgres\n    host: pg.local\n');
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.config.Servers[0]).toMatchObject({ id: 'postgres1', engine: 'postgres', host: 'pg.local' });
  });

  it('accepte les variables PMA_* de l’image Docker phpmyadmin', () => {
    const loaded = loadConfig({
      cwd: dir,
      env: { PMA_HOST: 'db', PMA_PORT: '3307', PMA_USER: 'app', PMA_PASSWORD: 'x' },
    });
    expect(loaded.source).toBe('env');
    expect(loaded.config.Servers[0]).toMatchObject({
      host: 'db',
      port: 3307,
      auth_type: 'config',
      user: 'app',
    });
  });

  it('signale une configuration invalide avec le chemin de l’option', () => {
    writeFileSync(join(dir, 'jsmydata.config.json'), JSON.stringify({ Servers: [{ engine: 'oracle' }] }));
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/Servers\.0\.engine/);
  });
});

describe('détection des serveurs locaux', () => {
  it('propose MySQL (même absent), PostgreSQL s’il répond, et SQLite', async () => {
    const servers = await detectLocalServers({
      sqliteDir: dir,
      mysqlSockets: [],
      postgresSocketDirs: [],
      probe: async (_h, port) => port === 5432,
    });
    expect(servers.map((s) => [s.id, s.engine, s.autoDetected])).toEqual([
      ['1', 'mysql', false],
      ['pg', 'postgres', true],
      ['sqlite', 'sqlite', true],
    ]);
  });

  it('détecte le socket MySQL', async () => {
    const sock = join(dir, 'mysql.sock');
    const srv = createServer().listen(sock);
    await new Promise((r) => srv.once('listening', r));
    const servers = await detectLocalServers({
      sqliteDir: dir,
      mysqlSockets: ['/inexistant.sock', sock],
      postgresSocketDirs: [],
      probe: async () => false,
    });
    srv.close();
    expect(servers[0]).toMatchObject({ engine: 'mysql', socket: sock, autoDetected: true });
    expect(servers.map((s) => s.engine)).toEqual(['mysql', 'sqlite']);
  });

  it('liste les fichiers SQLite du dossier', () => {
    for (const f of ['a.sqlite', 'b.db', 'notes.txt', 'c.sqlite3']) writeFileSync(join(dir, f), '');
    expect(listSqliteFiles(dir)).toEqual(['a.sqlite', 'b.db', 'c.sqlite3']);
  });
});

describe('secret et chiffrement', () => {
  it('génère la clé au premier lancement (droits 600) puis la réutilise', () => {
    const file = join(dir, 'sub', 'secret');
    const a = resolveSecret(undefined, file);
    expect(a.origin).toBe('generated');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const b = resolveSecret(undefined, file);
    expect(b.origin).toBe('file');
    expect(b.encKey.equals(a.encKey)).toBe(true);
  });

  it('chiffre et déchiffre ; détecte une altération', () => {
    const { encKey } = resolveSecret('une-clé-de-test-suffisamment-longue');
    const token = encrypt(encKey, { user: 'root', password: 's3cr3t' });
    expect(token).not.toContain('s3cr3t');
    expect(decrypt(encKey, token)).toEqual({ user: 'root', password: 's3cr3t' });
    const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    expect(() => decrypt(encKey, tampered)).toThrow();
  });
});
