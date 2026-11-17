import type { SessionServer, TableInfo } from '@jsmydata/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { paths } from '../routes';
import { useMe } from '../session';
import { Icon } from './Icon';
import { ThemeToggle } from './ThemeToggle';

/** Panneau de navigation : logo, icônes, choix du serveur, arbre bases → (schémas) → tables → colonnes. */
export function NavigationPanel({ onLogout }: { onLogout: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const { srv } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [collapseSignal, setCollapseSignal] = useState(0);
  const server = me.data?.servers.find((s) => s.id === srv) ?? me.data?.servers[0];

  return (
    <nav className="navigation" aria-label="Navigation">
      <div className="nav-logo">
        <Link to={server ? paths.server(server.id) : '/'} className="logo" aria-label={t('nav.home')}>
          <span className="logo-js">Js</span>
          <span className="logo-my">My</span>
          <span className="logo-data">Data</span>
        </Link>
      </div>
      <div className="nav-icons">
        <Link to={server ? paths.server(server.id) : '/'} className="icon-button" title={t('nav.home')}>
          <Icon name="home" title={t('nav.home')} />
        </Link>
        <button type="button" className="icon-button" title={t('nav.logout')} onClick={onLogout}>
          <Icon name="logout" title={t('nav.logout')} />
        </button>
        <ThemeToggle />
        <button
          type="button"
          className="icon-button"
          title={t('nav.reload')}
          onClick={() => void qc.invalidateQueries({ queryKey: ['nav'] })}
        >
          <Icon name="reload" title={t('nav.reload')} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t('nav.collapse')}
          onClick={() => setCollapseSignal((n) => n + 1)}
        >
          <Icon name="collapse" title={t('nav.collapse')} />
        </button>
      </div>

      {me.data && me.data.servers.length > 0 ? (
        <div className="nav-server">
          <label htmlFor="nav-server-select" className="visually-hidden">
            {t('login.server')}
          </label>
          <select
            id="nav-server-select"
            value={server?.id ?? ''}
            onChange={(e) => {
              if (e.target.value === '__other__') navigate(paths.login());
              else navigate(paths.server(e.target.value));
            }}
          >
            {me.data.servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.verbose}
              </option>
            ))}
            <option value="__other__">{t('nav.otherServer')}</option>
          </select>
        </div>
      ) : null}

      <div className="nav-filter">
        <input
          type="search"
          placeholder={t('nav.filter')}
          aria-label={t('nav.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {server ? (
        <DatabaseTree key={`${server.id}-${collapseSignal}`} server={server} filter={filter} />
      ) : null}
    </nav>
  );
}

function DatabaseTree({ server, filter }: { server: SessionServer; filter: string }) {
  const { t } = useTranslation();
  const dbs = useQuery({ queryKey: ['nav', server.id, 'dbs'], queryFn: () => api.databases(server.id) });
  const f = filter.trim().toLowerCase();
  const list = (dbs.data ?? []).filter((d) => !f || d.name.toLowerCase().includes(f));
  return (
    <ul className="tree" role="tree">
      {server.capabilities.databases && server.engine !== 'sqlite' ? (
        <li className="tree-new" role="none">
          <Link to={paths.server(server.id, 'databases')} role="treeitem">
            <Icon name="plus" /> {t('nav.newDatabase')}
          </Link>
        </li>
      ) : null}
      {dbs.isLoading ? <li className="tree-loading">…</li> : null}
      {list.map((d) => (
        <DatabaseNode key={d.name} server={server} db={d.name} autoOpen={list.length === 1} />
      ))}
    </ul>
  );
}

function Toggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="tree-toggle" aria-expanded={open} aria-label={label} onClick={onClick}>
      <Icon name={open ? 'minusBox' : 'plusBox'} size={12} />
    </button>
  );
}

function DatabaseNode({ server, db, autoOpen }: { server: SessionServer; db: string; autoOpen: boolean }) {
  const params = useParams();
  const active = params.db === db;
  // Ouvert par défaut si la base est affichée (ou seule) ; le choix de l'utilisateur prime ensuite.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (active || autoOpen);
  return (
    <li role="treeitem" aria-expanded={open} className={active ? 'tree-active' : undefined}>
      <Toggle open={open} onClick={() => setUserOpen(!open)} label={db} />
      <Link to={paths.database(server.id, db)} className="tree-link">
        <Icon name="db" /> {db}
      </Link>
      {open ? (
        server.capabilities.schemas ? (
          <SchemaList server={server} db={db} />
        ) : (
          <TableGroups server={server} db={db} />
        )
      ) : null}
    </li>
  );
}

function SchemaList({ server, db }: { server: SessionServer; db: string }) {
  const schemas = useQuery({
    queryKey: ['nav', server.id, 'schemas', db],
    queryFn: () => api.schemas(server.id, db),
  });
  const [search] = useSearchParams();
  const current = search.get('schema');
  return (
    <ul role="group">
      {(schemas.data ?? [])
        .filter((s) => !s.system)
        .map((s) => (
          <SchemaNode
            key={s.name}
            server={server}
            db={db}
            schema={s.name}
            initiallyOpen={current === s.name || s.name === 'public'}
          />
        ))}
    </ul>
  );
}

function SchemaNode(props: { server: SessionServer; db: string; schema: string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(props.initiallyOpen);
  return (
    <li role="treeitem" aria-expanded={open}>
      <Toggle open={open} onClick={() => setOpen(!open)} label={props.schema} />
      <Link to={paths.database(props.server.id, props.db, 'structure', props.schema)} className="tree-link">
        <Icon name="schema" /> {props.schema}
      </Link>
      {open ? <TableGroups server={props.server} db={props.db} schema={props.schema} /> : null}
    </li>
  );
}

function TableGroups({ server, db, schema }: { server: SessionServer; db: string; schema?: string }) {
  const { t } = useTranslation();
  const tables = useQuery({
    queryKey: ['nav', server.id, 'tables', db, schema ?? ''],
    queryFn: () => api.tables(server.id, db, schema),
  });
  if (tables.isLoading)
    return (
      <ul role="group">
        <li className="tree-loading">…</li>
      </ul>
    );
  const all = tables.data ?? [];
  const groups: [string, TableInfo[]][] = [
    [t('nav.tables'), all.filter((x) => x.kind === 'table')],
    [t('nav.views'), all.filter((x) => x.kind !== 'table')],
  ];
  return (
    <ul role="group">
      {groups
        .filter(([, items]) => items.length > 0)
        .map(([label, items]) => (
          <TableGroup key={label} label={label} items={items} server={server} db={db} schema={schema} />
        ))}
    </ul>
  );
}

function TableGroup(props: {
  label: string;
  items: TableInfo[];
  server: SessionServer;
  db: string;
  schema?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li role="treeitem" aria-expanded={open} className="tree-group">
      <Toggle open={open} onClick={() => setOpen(!open)} label={props.label} />
      <span className="tree-group-label">
        {props.label} ({props.items.length})
      </span>
      {open ? (
        <ul role="group">
          {props.items.map((tb) => (
            <TableNode key={tb.name} table={tb} {...props} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TableNode(props: { table: TableInfo; server: SessionServer; db: string; schema?: string }) {
  const { t } = useTranslation();
  const params = useParams();
  const [open, setOpen] = useState(false);
  const active = params.db === props.db && params.table === props.table.name;
  const columns = useQuery({
    queryKey: ['nav', props.server.id, 'columns', props.db, props.schema ?? '', props.table.name],
    queryFn: () => api.columns(props.server.id, props.db, props.table.name, props.schema),
    enabled: open,
  });
  return (
    <li role="treeitem" aria-expanded={open} className={active ? 'tree-active' : undefined}>
      <Toggle open={open} onClick={() => setOpen(!open)} label={`${t('nav.columns')} ${props.table.name}`} />
      {/* Lot 0 : le lien ouvre la structure ; il ouvrira « Parcourir » au lot 1, comme phpMyAdmin. */}
      <Link
        to={paths.table(props.server.id, props.db, props.table.name, 'structure', props.schema)}
        className="tree-link"
      >
        <Icon name={props.table.kind === 'table' ? 'table' : 'view'} /> {props.table.name}
      </Link>
      {open ? (
        <ul role="group" className="tree-columns">
          {(columns.data ?? []).map((c) => (
            <li key={c.name} role="treeitem" title={c.type}>
              <Icon name={c.primaryKey ? 'key' : 'column'} size={12} /> {c.name}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
