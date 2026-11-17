import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Navigate, RouterProvider, useParams } from 'react-router';
import { Layout } from './components/Layout';
import { DatabaseStructure } from './pages/DatabaseStructure';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Placeholder } from './pages/Placeholder';
import { ServerDatabases } from './pages/ServerDatabases';
import { TableStructure } from './pages/TableStructure';
import { DATABASE_TABS, SERVER_TABS, TABLE_TABS, type TabDef } from './routes';

function TabPage<K extends string>({
  tabs,
  screens,
}: {
  tabs: TabDef<K>[];
  screens: Partial<Record<K, () => React.ReactNode>>;
}) {
  const { t } = useTranslation();
  const { tab } = useParams();
  const def = tabs.find((x) => x.key === tab);
  if (!def) return <Navigate to=".." relative="path" replace />;
  const screen = screens[def.key];
  return screen ? <>{screen()}</> : <Placeholder tabLabel={t(`tabs.${def.label}`)} lot={def.lot} />;
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: null },
      { path: 'server/:srv', element: <Home /> },
      {
        path: 'server/:srv/:tab',
        element: <TabPage tabs={SERVER_TABS} screens={{ databases: () => <ServerDatabases /> }} />,
      },
      {
        path: 'server/:srv/db/:db/:tab',
        element: <TabPage tabs={DATABASE_TABS} screens={{ structure: () => <DatabaseStructure /> }} />,
      },
      {
        path: 'server/:srv/db/:db/table/:table/:tab',
        element: <TabPage tabs={TABLE_TABS} screens={{ structure: () => <TableStructure /> }} />,
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
