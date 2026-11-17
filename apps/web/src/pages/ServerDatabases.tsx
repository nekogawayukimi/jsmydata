import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { ErrorMessage, Loading, Message } from '../components/Message';
import { paths } from '../routes';
import { useCurrentServer } from '../session';

/** Onglet « Bases de données » du niveau serveur. */
export function ServerDatabases() {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const dbs = useQuery({ queryKey: ['nav', server.id, 'dbs'], queryFn: () => api.databases(server.id) });
  const [showSystem, setShowSystem] = useState(true);
  const list = (dbs.data ?? []).filter((d) => showSystem || !d.system);

  return (
    <section>
      <h2>
        <Icon name="db" /> {t('tabs.databases')}
      </h2>

      {server.engine !== 'sqlite' ? (
        <fieldset className="panel">
          <legend>
            <Icon name="plus" /> {t('databases.create')}
          </legend>
          <Message kind="notice">{t('databases.createSoon')}</Message>
        </fieldset>
      ) : null}

      {dbs.isLoading ? <Loading /> : null}
      {dbs.error ? <ErrorMessage error={dbs.error} /> : null}

      {dbs.data ? (
        <>
          <label className="inline-check">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />{' '}
            {t('databases.showSystem')}
          </label>
          <table className="data">
            <thead>
              <tr>
                <th>{t('databases.name')}</th>
                {server.engine !== 'sqlite' ? <th>{t('databases.collation')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.name}>
                  <td>
                    <Link to={paths.database(server.id, d.name)}>{d.name}</Link>
                    {d.system ? <span className="badge">{t('databases.system')}</span> : null}
                  </td>
                  {server.engine !== 'sqlite' ? <td>{d.collation ?? ''}</td> : null}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={server.engine !== 'sqlite' ? 2 : 1}>
                  {t('databases.total', { count: list.length })}
                </th>
              </tr>
            </tfoot>
          </table>
        </>
      ) : null}
    </section>
  );
}
