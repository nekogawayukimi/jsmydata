import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { ErrorMessage, Loading, Message } from '../components/Message';
import { formatBytes, formatNumber } from '../format';
import { paths } from '../routes';
import { useCurrentServer } from '../session';

/** Onglet « Structure » du niveau base : liste des tables et vues avec totaux. */
export function DatabaseStructure() {
  const { t, i18n } = useTranslation();
  const server = useCurrentServer()!;
  const db = useParams().db!;
  const [search] = useSearchParams();
  const schemaParam = search.get('schema') ?? undefined;

  const schemas = useQuery({
    queryKey: ['nav', server.id, 'schemas', db],
    queryFn: () => api.schemas(server.id, db),
    enabled: server.capabilities.schemas && !schemaParam,
  });

  // PostgreSQL sans schéma choisi : liste des schémas, comme un niveau intermédiaire.
  if (server.capabilities.schemas && !schemaParam) {
    if (schemas.isLoading) return <Loading />;
    if (schemas.error) return <ErrorMessage error={schemas.error} />;
    return (
      <section>
        <h2>
          <Icon name="schema" /> {t('structure.schema')}
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>{t('structure.schema')}</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {(schemas.data ?? []).map((s) => (
              <tr key={s.name} className={s.system ? 'muted' : undefined}>
                <td>
                  <Link to={paths.database(server.id, db, 'structure', s.name)}>{s.name}</Link>
                </td>
                <td>{s.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  }

  return <TableList db={db} schema={schemaParam} lang={i18n.language} />;
}

function TableList({ db, schema, lang }: { db: string; schema?: string; lang: string }) {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const tables = useQuery({
    queryKey: ['nav', server.id, 'tables', db, schema ?? ''],
    queryFn: () => api.tables(server.id, db, schema),
  });

  if (tables.isLoading) return <Loading />;
  if (tables.error) return <ErrorMessage error={tables.error} />;
  const list = tables.data ?? [];
  if (list.length === 0) return <Message kind="notice">{t('structure.empty')}</Message>;

  const showEngine = server.engine === 'mysql';
  const showSize = server.engine !== 'sqlite';
  const totalRows = list.reduce((s, x) => s + (x.rows ?? 0), 0);
  const totalSize = list.reduce((s, x) => s + (x.dataLength ?? 0) + (x.indexLength ?? 0), 0);
  const anyEstimated = list.some((x) => x.rowsEstimated);

  return (
    <section>
      <table className="data">
        <thead>
          <tr>
            <th>{t('structure.table')}</th>
            <th className="num">{t('structure.rows')}</th>
            <th>{t('structure.type')}</th>
            {showEngine ? <th>{t('structure.collation')}</th> : null}
            {showSize ? <th className="num">{t('structure.size')}</th> : null}
            <th>{t('structure.comment')}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((tb) => (
            <tr key={tb.name}>
              <td>
                <Link to={paths.table(server.id, db, tb.name, 'browse', schema)}>
                  <Icon name={tb.kind === 'table' ? 'table' : 'view'} /> {tb.name}
                </Link>
              </td>
              <td className="num" title={tb.rowsEstimated ? t('structure.estimated') : undefined}>
                {tb.kind === 'view' ? '-' : `${tb.rowsEstimated ? '~' : ''}${formatNumber(tb.rows, lang)}`}
              </td>
              <td>
                {tb.kind === 'view'
                  ? t('structure.view')
                  : tb.kind === 'materialized_view'
                    ? t('structure.mview')
                    : (tb.engine ?? '')}
              </td>
              {showEngine ? <td>{tb.collation ?? ''}</td> : null}
              {showSize ? (
                <td className="num">
                  {tb.kind === 'view' ? '-' : formatBytes((tb.dataLength ?? 0) + (tb.indexLength ?? 0), lang)}
                </td>
              ) : null}
              <td>{tb.comment ?? ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>{t('structure.sumTables', { count: list.length })}</th>
            <th className="num">
              {anyEstimated ? '~' : ''}
              {formatNumber(totalRows, lang)}
            </th>
            <th>{t('structure.sum')}</th>
            {showEngine ? <th /> : null}
            {showSize ? <th className="num">{formatBytes(totalSize, lang)}</th> : null}
            <th />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
