import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Les paquets du monorepo sont intégrés au bundle ; les dépendances npm restent externes.
  noExternal: [/^@jsmydata\//],
  // Pilotes SQL (dont un module natif) : chargés depuis node_modules, jamais intégrés au bundle.
  external: ['mysql2', 'mysql2/promise', 'pg', 'better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
});
