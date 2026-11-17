import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { ErrorMessage, Loading } from '../components/Message';
import { useCurrentServer } from '../session';

/** Onglet « Structure » du niveau table : tableau des colonnes (lecture seule au lot 0). */
export function TableStructure() {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const { db, table } = useParams() as { db: string; table: string };
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const columns = useQuery({
    queryKey: ['nav', server.id, 'columns', db, schema ?? '', table],
    queryFn: () => api.columns(server.id, db, table, schema),
  });

  if (columns.isLoading) return <Loading />;
  if (columns.error) return <ErrorMessage error={columns.error} />;
  const showCollation = server.engine !== 'sqlite';
  const showComment = server.engine !== 'sqlite';

  return (
    <section>
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('columns.name')}</th>
            <th>{t('columns.type')}</th>
            {showCollation ? <th>{t('columns.collation')}</th> : null}
            <th>{t('columns.null')}</th>
            <th>{t('columns.default')}</th>
            {showComment ? <th>{t('columns.comment')}</th> : null}
            <th>{t('columns.extra')}</th>
          </tr>
        </thead>
        <tbody>
          {(columns.data ?? []).map((c) => (
            <tr key={c.name}>
              <td className="num">{c.position}</td>
              <td>
                <span className={c.primaryKey ? 'pk' : undefined}>
                  {c.name} {c.primaryKey ? <Icon name="key" title={t('columns.primary')} size={12} /> : null}
                </span>
              </td>
              <td>
                <code>{c.type}</code>
              </td>
              {showCollation ? <td>{c.collation ?? ''}</td> : null}
              <td>{c.nullable ? t('columns.yes') : t('columns.no')}</td>
              <td>
                {c.default === null ? (
                  <em>{c.nullable ? 'NULL' : t('columns.none')}</em>
                ) : (
                  <code>{c.default}</code>
                )}
              </td>
              {showComment ? <td>{c.comment ?? ''}</td> : null}
              <td>{c.extra ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
