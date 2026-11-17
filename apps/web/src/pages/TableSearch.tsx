import type { SearchCriterion, SearchOperator, SortSpec, StatementResult } from '@jsmydata/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { ErrorMessage, Loading } from '../components/Message';
import { Pager, ResultBanner, ResultGrid } from '../components/ResultGrid';
import { useCurrentServer, useServers } from '../session';
import { enumValues } from './Insert';

const TEXT_OPS: SearchOperator[] = [
  'LIKE',
  'LIKE %...%',
  'NOT LIKE',
  '=',
  '!=',
  'REGEXP',
  'NOT REGEXP',
  "= ''",
  "!= ''",
  'IN (...)',
  'NOT IN (...)',
  'BETWEEN',
  'NOT BETWEEN',
  'IS NULL',
  'IS NOT NULL',
];
const NUM_OPS: SearchOperator[] = [
  '=',
  '>',
  '>=',
  '<',
  '<=',
  '!=',
  'LIKE',
  'LIKE %...%',
  'NOT LIKE',
  'IN (...)',
  'NOT IN (...)',
  'BETWEEN',
  'NOT BETWEEN',
  'IS NULL',
  'IS NOT NULL',
];
const NO_VALUE = new Set<SearchOperator>(['IS NULL', 'IS NOT NULL', "= ''", "!= ''"]);

const isNumeric = (type: string) =>
  /int|dec|num|float|double|real|serial|money|bit|year|date|time/i.test(type);

/** Onglet « Rechercher » d'une table : requête par l'exemple. */
export function TableSearch() {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const servers = useServers();
  const qc = useQueryClient();
  const { db, table } = useParams() as { db: string; table: string };
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const meta = useQuery({
    queryKey: ['nav', server.id, 'meta', db, schema ?? '', table],
    queryFn: () => api.tableMeta(server.id, db, table, schema),
  });
  const [ops, setOps] = useState<Record<string, SearchOperator>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<string[] | null>(null);
  const [distinct, setDistinct] = useState(false);
  const [order, setOrder] = useState<SortSpec | null>(null);
  const [page, setPage] = useState({ offset: 0, count: servers.data?.maxRows ?? 25, showAll: false });
  const [result, setResult] = useState<StatementResult | null>(null);
  const [formOpen, setFormOpen] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (meta.isLoading) return <Loading />;
  if (meta.error) return <ErrorMessage error={meta.error} />;
  const cols = meta.data!.columns;
  const opFor = (name: string, type: string) => ops[name] ?? (isNumeric(type) ? '=' : 'LIKE');

  const criteria = (): SearchCriterion[] =>
    cols.flatMap((c) => {
      const op = opFor(c.name, c.type);
      const v = values[c.name] ?? '';
      if (NO_VALUE.has(op) && ops[c.name]) return [{ column: c.name, operator: op }];
      if (v === '') return [];
      return [{ column: c.name, operator: op, value: v }];
    });

  const execute = async (p = page, sortOverride?: SortSpec[]) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.searchTable(server.id, db, table, schema, {
        criteria: criteria(),
        columns: shown ?? undefined,
        distinct,
        offset: p.showAll ? 0 : p.offset,
        count: p.showAll ? 1000 : p.count,
        sort: sortOverride ?? (order ? [order] : undefined),
      });
      setResult(res);
      setPage(p);
      setFormOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void execute({ ...page, offset: 0 });
  };

  return (
    <section>
      {result && !formOpen ? (
        <p>
          <button type="button" className="link-button" onClick={() => setFormOpen(true)}>
            {t('search.newSearch')}
          </button>
        </p>
      ) : null}
      {formOpen ? (
        <form onSubmit={submit}>
          <fieldset className="panel">
            <legend>{t('search.title')}</legend>
            <table className="data">
              <thead>
                <tr>
                  <th>{t('columns.name')}</th>
                  <th>{t('columns.type')}</th>
                  {server.engine === 'mysql' ? <th>{t('columns.collation')}</th> : null}
                  <th>{t('search.operator')}</th>
                  <th>{t('search.value')}</th>
                </tr>
              </thead>
              <tbody>
                {cols.map((c) => {
                  const op = opFor(c.name, c.type);
                  const options = enumValues(c.type);
                  return (
                    <tr key={c.name}>
                      <th scope="row">{c.name}</th>
                      <td>
                        <code>{c.type}</code>
                      </td>
                      {server.engine === 'mysql' ? <td>{c.collation ?? ''}</td> : null}
                      <td>
                        <select
                          aria-label={`${t('search.operator')} ${c.name}`}
                          value={op}
                          onChange={(e) => setOps({ ...ops, [c.name]: e.target.value as SearchOperator })}
                        >
                          {(isNumeric(c.type) ? NUM_OPS : TEXT_OPS).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {NO_VALUE.has(op) ? null : options && /^enum/i.test(c.type) && !op.includes('IN') ? (
                          <select
                            aria-label={`${t('search.value')} ${c.name}`}
                            value={values[c.name] ?? ''}
                            onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
                          >
                            <option value="" />
                            {options.map((o) => (
                              <option key={o}>{o}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            aria-label={`${t('search.value')} ${c.name}`}
                            size={30}
                            value={values[c.name] ?? ''}
                            onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="help">{t('search.valueHelp')}</p>
          </fieldset>

          <details className="panel">
            <summary>{t('search.options')}</summary>
            <div className="form-row">
              <label htmlFor="s-cols">{t('search.showColumns')}</label>
              <select
                id="s-cols"
                multiple
                size={Math.min(8, cols.length)}
                value={shown ?? cols.map((c) => c.name)}
                onChange={(e) => {
                  const sel = [...e.target.selectedOptions].map((o) => o.value);
                  setShown(sel.length === cols.length ? null : sel);
                }}
              >
                {cols.map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label className="inline-check">
                <input type="checkbox" checked={distinct} onChange={(e) => setDistinct(e.target.checked)} />{' '}
                {t('search.distinct')}
              </label>
            </div>
            <div className="form-row">
              <label htmlFor="s-order">{t('search.order')}</label>
              <select
                id="s-order"
                value={order?.column ?? ''}
                onChange={(e) =>
                  setOrder(e.target.value ? { column: e.target.value, dir: order?.dir ?? 'asc' } : null)
                }
              >
                <option value="">{t('search.none')}</option>
                {cols.map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
              <select
                aria-label={t('search.order')}
                value={order?.dir ?? 'asc'}
                disabled={!order}
                onChange={(e) => order && setOrder({ ...order, dir: e.target.value as 'asc' | 'desc' })}
              >
                <option value="asc">{t('search.asc')}</option>
                <option value="desc">{t('search.desc')}</option>
              </select>
            </div>
          </details>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('search.go')}
            </button>
          </div>
        </form>
      ) : null}

      {error ? <ErrorMessage error={error} /> : null}
      {result ? (
        <>
          <ResultBanner
            result={result}
            srv={server.id}
            db={db}
            schema={schema}
            onRefresh={() => void execute(page)}
          />
          <Pager
            offset={page.offset}
            count={page.count}
            total={result.total}
            rowsOnPage={result.rows?.length ?? 0}
            showAll={page.showAll}
            onChange={(p) => void execute(p)}
          />
          <ResultGrid
            result={result}
            srv={server.id}
            sort={order ? [order] : []}
            onSort={(s) => {
              setOrder(s[s.length - 1] ?? null);
              void execute({ ...page, offset: 0 }, s);
            }}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ['rows', server.id, db] });
              void execute(page);
            }}
          />
        </>
      ) : null}
    </section>
  );
}
