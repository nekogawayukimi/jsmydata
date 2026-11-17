import type { Engine } from '@jsmydata/shared';
import { mysqlDialect } from './dialects/mysql.js';
import { postgresDialect } from './dialects/postgres.js';
import { sqliteDialect } from './dialects/sqlite.js';
import type { Dialect } from './types.js';

export * from './types.js';
export * from './quote.js';
export { mysqlDialect, postgresDialect, sqliteDialect };

const DIALECTS: Record<Engine, Dialect> = {
  mysql: mysqlDialect,
  postgres: postgresDialect,
  sqlite: sqliteDialect,
};

export function getDialect(engine: Engine): Dialect {
  const d = DIALECTS[engine];
  if (!d) throw new Error(`Moteur inconnu : ${String(engine)}`);
  return d;
}
