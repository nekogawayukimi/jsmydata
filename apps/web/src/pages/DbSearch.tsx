import type { DbSearchMode, DbSearchResponse } from '@jsmydata/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { ErrorMessage, Loading } from '../components/Message';
import { paths } from '../routes';
import { useCurrentServer } from '../session';

/** Onglet « Rechercher » d'une base : un texte dans toutes les tables (ou une sélection). */
export function DbSearch() {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const { db } = useParams() as { db: string };
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const tables = useQuery({
    queryKey: ['nav', server.id, 'tables', db, schema ?? ''],
    queryFn: () => api.tables(server.id, db, schema),
  });
  const [words, setWords] = useState('');
  const [mode, setMode] = useState<DbSearchMode>('any');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [column, setColumn] = useState('');
  const [result, setResult] = useState<DbSearchResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (tables.isLoading) return <Loading />;
  if (tables.error) return <ErrorMessage error={tables.error} />;
  const names = (tables.data ?? []).map((x) => x.name);
  const selected = picked ?? names;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!words.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.searchDb(server.id, db, schema, {
          words,
          mode,
          tables: selected.length === names.length ? undefined : selected,
          column: column.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const sqlLink = (sql: string) => {
    const base = paths.database(server.id, db, 'sql', schema);
    return `${base}${base.includes('?') ? '&' : '?'}sql=${encodeURIComponent(sql)}&run=1`;
  };

  return (
    <section>
      <form onSubmit={submit}>
        <fieldset className="panel">
          <legend>{t('dbsearch.title')}</legend>
          <div className="form-row">
            <label htmlFor="dbs-words">{t('dbsearch.words')}</label>
            <input
              id="dbs-words"
              size={60}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              required
            />
          </div>
          <div className="form-row" role="radiogroup" aria-label={t('dbsearch.find')}>
            <span>{t('dbsearch.find')}</span>
            <div>
              {(['any', 'all', 'exact', 'regexp'] as DbSearchMode[]).map((m) => (
                <label key={m} className="radio-line">
                  <input type="radio" name="dbs-mode" checked={mode === m} onChange={() => setMode(m)} />{' '}
                  {t(`dbsearch.modes.${m}`)}
                </label>
              ))}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="dbs-tables">{t('dbsearch.tables')}</label>
            <div>
              <select
                id="dbs-tables"
                multiple
                size={Math.min(10, Math.max(4, names.length))}
                value={selected}
                onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))}
              >
                {names.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <div>
                <button type="button" className="link-button" onClick={() => setPicked(null)}>
                  {t('dbsearch.selectAll')}
                </button>{' '}
                /{' '}
                <button type="button" className="link-button" onClick={() => setPicked([])}>
                  {t('dbsearch.selectNone')}
                </button>
              </div>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="dbs-col">{t('dbsearch.column')}</label>
            <input
              id="dbs-col"
              value={column}
              placeholder={t('dbsearch.columnHelp')}
              onChange={(e) => setColumn(e.target.value)}
            />
          </div>
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={busy || selected.length === 0}>
            {t('dbsearch.go')}
          </button>
        </div>
      </form>

      {error ? <ErrorMessage error={error} /> : null}
      {busy ? <Loading /> : null}
      {result ? (
        <table className="data">
          <tbody>
            {result.results.map((r) => (
              <tr key={r.table} className={r.count === 0 ? 'muted' : undefined}>
                <td>{t('dbsearch.result', { count: r.count, table: r.table })}</td>
                <td>{r.count > 0 ? <Link to={sqlLink(r.sql)}>{t('dbsearch.browse')}</Link> : null}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>{t('dbsearch.total', { count: result.total })}</th>
            </tr>
          </tfoot>
        </table>
      ) : null}
    </section>
  );
}
