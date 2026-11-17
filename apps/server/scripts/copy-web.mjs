// Copie le client compilé dans dist/public pour qu'un seul processus serve l'application.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../web/dist');
const dest = resolve(here, '../dist/public');

if (!existsSync(src)) {
  console.warn('[jsmydata] apps/web/dist absent : lancez « npm run build --workspace @jsmydata/web » avant.');
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log('[jsmydata] client copié dans', dest);
