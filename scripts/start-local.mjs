#!/usr/bin/env node
// Démarrage pour un gestionnaire de processus (PM2, Uxsagi…) :
// installe les dépendances et compile si nécessaire, puis lance le serveur.
// Les arguments sont transmis à JsMyData : node scripts/start-local.mjs --port 4820
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

function newest(dir) {
  let max = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}

function run(args) {
  console.log(`[jsmydata] npm ${args.join(' ')}`);
  const r = spawnSync(npm, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. Dépendances : réinstallées si package-lock.json a changé depuis la dernière installation.
const installed = join(root, 'node_modules', '.package-lock.json');
if (mtime(join(root, 'package-lock.json')) > mtime(installed)) run(['ci', '--no-audit', '--no-fund']);

// 2. Compilation : relancée si une source est plus récente que le serveur compilé.
const built = join(root, 'apps', 'server', 'dist', 'cli.js');
const sources = Math.max(
  newest(join(root, 'apps')),
  newest(join(root, 'packages')),
  mtime(join(root, 'package-lock.json')),
);
if (sources > mtime(built) || !existsSync(join(root, 'apps', 'server', 'dist', 'public', 'index.html'))) {
  run(['run', 'build']);
}

// 3. Serveur : le processus remplace ce script pour le gestionnaire (signaux transmis).
const child = spawn(process.execPath, [built, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
