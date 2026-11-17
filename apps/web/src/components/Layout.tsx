import type { SessionServer } from '@jsmydata/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import { api } from '../api';
import {
  DATABASE_TABS,
  paths,
  SERVER_TABS,
  TABLE_TABS,
  visibleTabs,
  type DatabaseTab,
  type ServerTab,
  type TableTab,
} from '../routes';
import { meKey, useCurrentServer, useMe } from '../session';
import { Console } from './Console';
import { Icon } from './Icon';
import { Loading } from './Message';
import { NavigationPanel } from './NavigationPanel';

/** Disposition de phpMyAdmin : navigation à gauche, fil d'Ariane, onglets, contenu. */
export function Layout() {
  const me = useMe();
  const { srv } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const server = useCurrentServer();

  if (me.isLoading) return <Loading />;
  if (!me.data?.authenticated) return <Navigate to={paths.login(srv)} replace />;
  if (srv && !server) return <Navigate to={paths.login(srv)} replace state={{ from: location.pathname }} />;
  if (!srv) return <Navigate to={paths.server(me.data.servers[0]!.id)} replace />;

  const logout = async () => {
    const res = (await api.logout()) as { logoutUrl?: string };
    qc.clear();
    // Authentification signon : retour vers le portail de l'application tierce.
    if (res.logoutUrl) window.location.assign(res.logoutUrl);
    else navigate(paths.login(), { replace: true });
  };

  return (
    <div className="app">
      <NavigationPanel onLogout={() => void logout()} />
      <div className="main">
        <header className="main-header">
          <Breadcrumb server={server!} />
          <TabBar server={server!} />
        </header>
        <main className="content">
          <Outlet />
        </main>
        <Console />
      </div>
    </div>
  );
}

function Breadcrumb({ server }: { server: SessionServer }) {
  const { t } = useTranslation();
  const { db, table } = useParams();
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  return (
    <div className="breadcrumb" aria-label="breadcrumb">
      <Link to={paths.server(server.id)}>
        <Icon name="home" /> {t('crumb.server')}: <strong>{server.verbose}</strong>
      </Link>
      {db ? (
        <>
          <span className="sep">»</span>
          <Link to={paths.database(server.id, db)}>
            <Icon name="db" /> {t('crumb.database')}: <strong>{db}</strong>
          </Link>
        </>
      ) : null}
      {db && schema ? (
        <>
          <span className="sep">»</span>
          <Link to={paths.database(server.id, db, 'structure', schema)}>
            <Icon name="schema" /> {t('crumb.schema')}: <strong>{schema}</strong>
          </Link>
        </>
      ) : null}
      {db && table ? (
        <>
          <span className="sep">»</span>
          <Link to={paths.table(server.id, db, table, 'structure', schema)}>
            <Icon name="table" /> {t('crumb.table')}: <strong>{table}</strong>
          </Link>
        </>
      ) : null}
    </div>
  );
}

function TabBar({ server }: { server: SessionServer }) {
  const { t } = useTranslation();
  const { db, table } = useParams();
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const caps = server.capabilities;

  let items: { key: string; label: string; to: string; lot: number }[];
  if (db && table) {
    items = visibleTabs(TABLE_TABS, caps).map((tab) => ({
      key: tab.key,
      label: t(`tabs.${tab.label}`),
      lot: tab.lot,
      to: paths.table(server.id, db, table, tab.key as TableTab, schema),
    }));
  } else if (db) {
    items = visibleTabs(DATABASE_TABS, caps).map((tab) => ({
      key: tab.key,
      label: t(`tabs.${tab.label}`),
      lot: tab.lot,
      to: paths.database(server.id, db, tab.key as DatabaseTab, schema),
    }));
  } else {
    items = visibleTabs(SERVER_TABS, caps).map((tab) => ({
      key: tab.key,
      label: t(`tabs.${tab.label}`),
      lot: tab.lot,
      to: paths.server(server.id, tab.key as ServerTab),
    }));
  }

  return (
    <ul className="tabs" role="tablist">
      {items.map((it) => (
        <li key={it.key} role="presentation">
          <NavLink
            role="tab"
            to={it.to}
            end
            className={({ isActive }) =>
              [isActive ? 'active' : '', it.lot > 0 ? 'planned' : ''].join(' ').trim()
            }
            title={it.lot > 0 ? t('placeholder.title', { lot: it.lot }) : undefined}
          >
            {it.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function useInvalidateMe() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: meKey });
}
