import type { Capabilities } from '@jsmydata/shared';
import type { Messages } from './i18n/fr';

/** Construction des URL : /server/:srv/db/:db/table/:table/:tab, schéma PostgreSQL en paramètre ?schema=. */
const e = encodeURIComponent;
const withSchema = (path: string, schema?: string) => (schema ? `${path}?schema=${e(schema)}` : path);

export const paths = {
  login: (server?: string, expired = false) => {
    const q = new URLSearchParams();
    if (server) q.set('server', server);
    if (expired) q.set('expired', '1');
    const s = q.toString();
    return s ? `/login?${s}` : '/login';
  },
  server: (srv: string, tab?: ServerTab) => (tab ? `/server/${e(srv)}/${tab}` : `/server/${e(srv)}`),
  database: (srv: string, db: string, tab: DatabaseTab = 'structure', schema?: string) =>
    withSchema(`/server/${e(srv)}/db/${e(db)}/${tab}`, schema),
  table: (srv: string, db: string, table: string, tab: TableTab = 'structure', schema?: string) =>
    withSchema(`/server/${e(srv)}/db/${e(db)}/table/${e(table)}/${tab}`, schema),
};

type TabKey = keyof Messages['tabs'];

export interface TabDef<K extends string> {
  key: K;
  label: TabKey;
  /** Lot de livraison ; 0 = disponible dès maintenant. */
  lot: number;
  /** Onglet masqué si le moteur ne le supporte pas. */
  requires?: keyof Capabilities;
}

export type ServerTab =
  | 'databases'
  | 'sql'
  | 'status'
  | 'users'
  | 'export'
  | 'import'
  | 'settings'
  | 'replication'
  | 'variables'
  | 'charsets'
  | 'engines'
  | 'plugins';

export type DatabaseTab =
  | 'structure'
  | 'sql'
  | 'search'
  | 'query'
  | 'export'
  | 'import'
  | 'operations'
  | 'privileges'
  | 'routines'
  | 'events'
  | 'triggers'
  | 'tracking'
  | 'designer'
  | 'central';

export type TableTab =
  | 'browse'
  | 'structure'
  | 'sql'
  | 'search'
  | 'insert'
  | 'export'
  | 'import'
  | 'privileges'
  | 'operations'
  | 'tracking'
  | 'triggers';

/** Mêmes onglets, dans le même ordre, que phpMyAdmin 5.2. */
export const SERVER_TABS: TabDef<ServerTab>[] = [
  { key: 'databases', label: 'databases', lot: 0 },
  { key: 'sql', label: 'sql', lot: 1 },
  { key: 'status', label: 'status', lot: 4 },
  { key: 'users', label: 'users', lot: 4, requires: 'users' },
  { key: 'export', label: 'export', lot: 3 },
  { key: 'import', label: 'import', lot: 3 },
  { key: 'settings', label: 'settings', lot: 5 },
  { key: 'replication', label: 'replication', lot: 4, requires: 'replication' },
  { key: 'variables', label: 'variables', lot: 4, requires: 'serverVariables' },
  { key: 'charsets', label: 'charsets', lot: 4, requires: 'users' },
  { key: 'engines', label: 'engines', lot: 4, requires: 'storageEngines' },
  { key: 'plugins', label: 'plugins', lot: 4, requires: 'users' },
];

export const DATABASE_TABS: TabDef<DatabaseTab>[] = [
  { key: 'structure', label: 'structure', lot: 0 },
  { key: 'sql', label: 'sql', lot: 1 },
  { key: 'search', label: 'search', lot: 1 },
  { key: 'query', label: 'query', lot: 5 },
  { key: 'export', label: 'export', lot: 3 },
  { key: 'import', label: 'import', lot: 3 },
  { key: 'operations', label: 'operations', lot: 2 },
  { key: 'privileges', label: 'privileges', lot: 4, requires: 'users' },
  { key: 'routines', label: 'routines', lot: 5, requires: 'routines' },
  { key: 'events', label: 'events', lot: 5, requires: 'events' },
  { key: 'triggers', label: 'triggers', lot: 5, requires: 'triggers' },
  { key: 'tracking', label: 'tracking', lot: 5 },
  { key: 'designer', label: 'designer', lot: 5 },
  { key: 'central', label: 'central', lot: 5 },
];

export const TABLE_TABS: TabDef<TableTab>[] = [
  { key: 'browse', label: 'browse', lot: 1 },
  { key: 'structure', label: 'structure', lot: 0 },
  { key: 'sql', label: 'sql', lot: 1 },
  { key: 'search', label: 'search', lot: 1 },
  { key: 'insert', label: 'insert', lot: 1 },
  { key: 'export', label: 'export', lot: 3 },
  { key: 'import', label: 'import', lot: 3 },
  { key: 'privileges', label: 'privileges', lot: 4, requires: 'users' },
  { key: 'operations', label: 'operations', lot: 2 },
  { key: 'tracking', label: 'tracking', lot: 5 },
  { key: 'triggers', label: 'triggers', lot: 5, requires: 'triggers' },
];

export function visibleTabs<K extends string>(
  tabs: TabDef<K>[],
  caps: Capabilities | undefined,
): TabDef<K>[] {
  return tabs.filter((t) => !t.requires || !caps || caps[t.requires]);
}
