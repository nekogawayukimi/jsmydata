import type { SQLNamespace } from '@codemirror/lang-sql';
import type { Engine, SqlResponse } from '@jsmydata/shared';
import { isDestructive, statementVerb } from '@jsmydata/sql/analyze';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { ErrorMessage, Loading, Message } from '../components/Message';
import { Pager, ResultBanner, ResultGrid } from '../components/ResultGrid';
import type { SqlEditorHandle } from '../components/SqlEditor';
import { summarize, useHistory } from '../history';
import { useCurrentServer, useServers } from '../session';

const SqlEditor = lazy(() => import('../components/SqlEditor'));

const quote = (engine: Engine, name: string) =>
  engine === 'mysql' ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';

/** Modèles de requêtes de l'onglet SQL d'une table (boutons de phpMyAdmin). */
function templates(engine: Engine, table: string, cols: string[]) {
  const t = quote(engine, table);
  const yes = engine === 'postgres' ? 'true' : '1';
  const no = engine === 'postgres' ? 'false' : '0';
  const list = cols.map((c) => quote(engine, c)).join(', ');
  return {
    'SELECT *': `SELECT * FROM ${t} WHERE ${yes}`,
    SELECT: `SELECT ${list} FROM ${t} WHERE ${yes}`,
    INSERT: `INSERT INTO ${t}(${list}) VALUES (${cols.map((_, i) => `'[value-${i + 1}]'`).join(', ')})`,
    UPDATE: `UPDATE ${t} SET ${cols.map((c, i) => `${quote(engine, c)}='[value-${i + 1}]'`).join(', ')} WHERE ${yes}`,
    DELETE: `DELETE FROM ${t} WHERE ${no}`,
  };
}

const formatterLanguage: Record<Engine, 'mysql' | 'postgresql' | 'sqlite'> = {
  mysql: 'mysql',
  postgres: 'postgresql',
  sqlite: 'sqlite',
};

/**
 * Onglet SQL (serveur, base ou table) : éditeur, exécution multi-instructions, résultats, historique.
 * Une requête transmise par l'URL (?sql=…&run=1 : Éditer, Expliquer, Parcourir depuis la recherche)
 * réinitialise la page.
 */
export function SqlPage() {
  const [search] = useSearchParams();
  const location = useLocation();
  const key = search.has('sql') ? `${location.key}` : 'page';
  return <SqlPageInner key={key} />;
}

function SqlPageInner() {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const servers = useServers();
  const { db, table } = useParams();
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const engine = server.engine;
  const history = useHistory();

  const columns = useQuery({
    queryKey: ['nav', server.id, 'columns', db, schema ?? '', table],
    queryFn: () => api.columns(server.id, db!, table!, schema),
    enabled: Boolean(db && table),
  });
  const tables = useQuery({
    queryKey: ['nav', server.id, 'tables', db, schema ?? ''],
    queryFn: () => api.tables(server.id, db!, schema),
    enabled: Boolean(db),
  });
  const colNames = useMemo(() => (columns.data ?? []).map((c) => c.name), [columns.data]);

  const initial = search.get('sql') ?? (table ? templates(engine, table, colNames)['SELECT *'] : '');
  const [sql, setSql] = useState(initial);
  const [keep, setKeep] = useState(true);
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<SqlResponse | null>(null);
  const [lastRun, setLastRun] = useState<string>('');
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState({ offset: 0, count: servers.data?.maxRows ?? 25, showAll: false });
  const editor = useRef<SqlEditorHandle | null>(null);

  const completion: SQLNamespace = useMemo(() => {
    const ns: Record<string, string[]> = {};
    for (const tb of tables.data ?? []) ns[tb.name] = [];
    if (table) ns[table] = colNames;
    return ns;
  }, [tables.data, table, colNames]);

  const run = async (text = sql, paging = page) => {
    const query = text.trim();
    if (!query || running) return;
    if (
      paging.offset === 0 &&
      isDestructive(query, engine) &&
      !window.confirm(t('sql.confirmDestructive', { sql: query }))
    )
      return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.sql(server.id, { sql: query, db, schema, ...paging });
      setResponse(res);
      setLastRun(query);
      setPage(paging);
      if (paging.offset === 0 && !paging.showAll) {
        history.add({ server: server.id, db, schema, sql: query, ...summarize(res, t) });
      }
      if (!keep) setSql('');
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  };

  // Exécution automatique d'une requête transmise avec run=1 (une seule fois par navigation).
  const autoRun = useRef(false);
  useEffect(() => {
    if (search.get('run') === '1' && search.get('sql') && !autoRun.current) {
      autoRun.current = true;
      void run(search.get('sql')!, { ...page, offset: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const target = table
    ? t('sql.tableTarget', { name: table })
    : db
      ? t('sql.dbTarget', { name: schema ? `${db}.${schema}` : db })
      : t('sql.serverTarget', { name: server.verbose });
  const tpl = table ? templates(engine, table, colNames) : null;
  const single = response && response.results.length === 1 && !response.error ? response.results[0]! : null;

  return (
    <section>
      <fieldset className="panel">
        <legend>{t('sql.title', { target })}</legend>
        <div className="sql-layout">
          <div className="sql-main">
            <Suspense fallback={<textarea className="sql-fallback" value={sql} readOnly rows={8} />}>
              <SqlEditor
                value={sql}
                onChange={setSql}
                onRun={() => void run(undefined, { ...page, offset: 0, showAll: false })}
                engine={engine}
                schema={completion}
                defaultTable={table}
                placeholder={t('sql.shortcut')}
                handleRef={(h) => (editor.current = h)}
                ariaLabel={t('sql.title', { target })}
              />
            </Suspense>
            <div className="sql-buttons">
              {tpl
                ? Object.entries(tpl).map(([label, text]) => (
                    <button type="button" key={label} onClick={() => setSql(text)}>
                      {label}
                    </button>
                  ))
                : null}
              <button type="button" onClick={() => setSql('')}>
                {t('sql.clear')}
              </button>
              <button
                type="button"
                onClick={async () => {
                  // Formateur chargé à la demande (bundle principal plus léger).
                  const { format } = await import('sql-formatter');
                  try {
                    setSql(format(sql, { language: formatterLanguage[engine], keywordCase: 'upper' }));
                  } catch {
                    /* requête incomplète : on la laisse telle quelle */
                  }
                }}
              >
                {t('sql.format')}
              </button>
            </div>
          </div>
          {table && colNames.length ? (
            <div className="sql-columns">
              <label htmlFor="sql-cols">{t('sql.columns')}</label>
              <select id="sql-cols" multiple size={Math.min(12, Math.max(4, colNames.length))}>
                {colNames.map((c) => (
                  <option key={c} value={c} onDoubleClick={() => editor.current?.insert(quote(engine, c))}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const sel = document.getElementById('sql-cols') as HTMLSelectElement;
                  const names = [...sel.selectedOptions].map((o) => quote(engine, o.value));
                  if (names.length) editor.current?.insert(names.join(', '));
                }}
              >
                « {t('sql.insertColumn')}
              </button>
            </div>
          ) : null}
        </div>
        <div className="form-actions sql-actions">
          <label className="inline-check">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />{' '}
            {t('sql.keepQuery')}
          </label>
          {running ? (
            <button type="button" onClick={() => void api.cancel(server.id).catch(() => undefined)}>
              {t('sql.stop')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            disabled={running || !sql.trim()}
            onClick={() => void run(undefined, { ...page, offset: 0, showAll: false })}
          >
            {running ? t('sql.running') : t('sql.run')}
          </button>
        </div>
      </fieldset>

      {running && !response ? <Loading /> : null}
      {error ? <ErrorMessage error={error} /> : null}

      {response ? (
        <div className="sql-results">
          {response.results.map((r, i) => (
            <div key={i} className="statement-result">
              <ResultBanner
                result={r}
                srv={server.id}
                db={db}
                schema={schema}
                onRefresh={() => void run(lastRun, page)}
              />
              {r.returnsRows ? (
                <>
                  {single && r.limited ? (
                    <Pager
                      offset={page.offset}
                      count={page.count}
                      total={r.total}
                      rowsOnPage={r.rows?.length ?? 0}
                      showAll={page.showAll}
                      onChange={(p) => void run(lastRun, p)}
                    />
                  ) : null}
                  <ResultGrid result={r} srv={server.id} onChanged={() => void run(lastRun, page)} />
                </>
              ) : null}
            </div>
          ))}
          {response.error ? (
            <Message kind="error">
              <strong>{t('result.statementError', { index: response.error.index + 1 })}</strong>
              <pre className="sql-box">{response.error.statement}</pre>
              <div>
                {response.error.errno ? `#${response.error.errno} - ` : ''}
                {response.error.sqlState ? `(${response.error.sqlState}) ` : ''}
                {response.error.message}
              </div>
            </Message>
          ) : null}
        </div>
      ) : null}

      <QueryHistory server={server.id} onPick={(q) => setSql(q)} engine={engine} />
    </section>
  );
}

function QueryHistory({
  server,
  onPick,
  engine,
}: {
  server: string;
  onPick: (sql: string) => void;
  engine: Engine;
}) {
  const { t, i18n } = useTranslation();
  const entries = useHistory((s) => s.entries).filter((e) => e.server === server);
  return (
    <details className="panel history">
      <summary>
        {t('sql.history')} ({entries.length})
      </summary>
      {entries.length === 0 ? <p className="help">{t('sql.noHistory')}</p> : null}
      <ul className="history-list">
        {entries.map((e) => (
          <li key={e.id} className={e.ok ? undefined : 'history-error'}>
            <button type="button" className="link-button" onClick={() => onPick(e.sql)} title={e.sql}>
              <span className="history-verb">{statementVerb(e.sql, engine) || 'SQL'}</span>{' '}
              <code>{e.sql.length > 120 ? e.sql.slice(0, 120) + '…' : e.sql}</code>
            </button>
            <span className="help">
              {' '}
              — {e.db ? `${e.db} · ` : ''}
              {new Date(e.at).toLocaleTimeString(i18n.language)} · {e.info}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
