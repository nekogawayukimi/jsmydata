import { SQL_FUNCTIONS, type CellInput, type ColumnInfo, type MutationResponse } from '@jsmydata/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { cellInputValue, decodeLocator } from '../cells';
import { ErrorMessage, Loading, Message } from '../components/Message';
import { paths } from '../routes';
import { useCurrentServer } from '../session';

interface Field {
  value: string;
  isNull: boolean;
  fn: string;
}
interface FormRow {
  ignore: boolean;
  fields: Record<string, Field>;
}

/** Valeurs d'une colonne ENUM / SET MySQL : enum('a','b') → ['a', 'b']. */
export function enumValues(type: string): string[] | null {
  const m = /^(enum|set)\((.*)\)$/i.exec(type);
  if (!m) return null;
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let x;
  while ((x = re.exec(m[2]!))) out.push(x[1]!.replaceAll("''", "'"));
  return out;
}

const isAuto = (c: ColumnInfo) =>
  /auto_increment|identity/i.test(c.extra ?? '') || /^nextval\(/i.test(c.default ?? '');
const isLongText = (c: ColumnInfo) => /text|blob|json|clob|bytea|xml/i.test(c.type);

const emptyRow = (cols: ColumnInfo[], ignore: boolean): FormRow => ({
  ignore,
  fields: Object.fromEntries(cols.map((c) => [c.name, { value: '', isNull: false, fn: '' }])),
});

/**
 * Valeur envoyée pour un champ, ou undefined pour laisser la colonne à sa valeur par défaut :
 * un champ vide est omis si la colonne a une valeur par défaut, accepte NULL ou s'incrémente seule.
 */
export function inputFor(c: ColumnInfo, f: Field): CellInput | undefined {
  if (f.fn) return { value: f.isNull ? null : f.value, fn: f.fn };
  if (f.isNull) return { value: null };
  if (f.value === '' && (c.default !== null || c.nullable || isAuto(c))) return undefined;
  return { value: f.value };
}

/** Onglet « Insérer », et formulaires Modifier / Copier une ligne (?mode=edit|copy&where=…). */
export function Insert() {
  const { t } = useTranslation();
  const server = useCurrentServer()!;
  const { db, table } = useParams() as { db: string; table: string };
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const mode = (search.get('mode') ?? 'insert') as 'insert' | 'edit' | 'copy';
  const where = search.get('where');
  const locator = useMemo(() => (where ? decodeLocator(where) : null), [where]);

  const meta = useQuery({
    queryKey: ['nav', server.id, 'meta', db, schema ?? '', table],
    queryFn: () => api.tableMeta(server.id, db, table, schema),
  });
  // Ligne à modifier ou à copier, relue par sa clé.
  const source = useQuery({
    queryKey: ['row', server.id, db, schema ?? '', table, where],
    enabled: Boolean(locator),
    queryFn: () =>
      api.searchTable(server.id, db, table, schema, {
        criteria: Object.entries(locator!).map(([column, v]) => ({
          column,
          operator: '=',
          value: String(v),
        })),
        count: 1,
      }),
  });

  if (meta.isLoading || source.isLoading) return <Loading />;
  if (meta.error) return <ErrorMessage error={meta.error} />;
  if (source.error) return <ErrorMessage error={source.error} />;
  const cols = meta.data!.columns;
  let initial: FormRow[];
  if (locator) {
    const r = source.data;
    const row = r?.rows?.[0];
    if (!r || !row) return <Message kind="error">{t('insert.notFound')}</Message>;
    const names = (r.fields ?? []).map((f) => f.name);
    const values: Record<string, Field> = {};
    for (const c of cols) {
      const v = cellInputValue(row[names.indexOf(c.name)] ?? null);
      values[c.name] =
        mode === 'copy' && isAuto(c)
          ? { value: '', isNull: false, fn: '' }
          : { value: v ?? '', isNull: v === null, fn: '' };
    }
    initial = [{ ignore: false, fields: values }];
  } else {
    initial = [emptyRow(cols, false), emptyRow(cols, true)];
  }
  return (
    <InsertForm
      key={`${table}-${mode}-${where ?? ''}`}
      srv={server.id}
      engine={server.engine}
      db={db}
      table={table}
      schema={schema}
      cols={cols}
      mode={mode}
      locator={locator}
      initial={initial}
    />
  );
}

function InsertForm(props: {
  srv: string;
  engine: 'mysql' | 'postgres' | 'sqlite';
  db: string;
  table: string;
  schema?: string;
  cols: ColumnInfo[];
  mode: 'insert' | 'edit' | 'copy';
  locator: Record<string, unknown> | null;
  initial: FormRow[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { cols, mode } = props;
  const [rows, setRows] = useState<FormRow[]>(props.initial);
  const [then, setThen] = useState<'back' | 'another'>(mode === 'insert' ? 'back' : 'back');
  const [insertMode, setInsertMode] = useState<'insert' | 'ignore' | 'replace'>('insert');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MutationResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const fns = SQL_FUNCTIONS[props.engine];

  const setField = (ri: number, name: string, patch: Partial<Field>) =>
    setRows(
      rows.map((r, i) =>
        i === ri ? { ...r, fields: { ...r.fields, [name]: { ...r.fields[name]!, ...patch } } } : r,
      ),
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let res: MutationResponse;
      if (mode === 'edit') {
        const original = props.initial[0]!.fields;
        const set: Record<string, CellInput> = {};
        for (const c of cols) {
          const f = rows[0]!.fields[c.name]!;
          const o = original[c.name]!;
          if (f.fn || f.isNull !== o.isNull || f.value !== o.value)
            set[c.name] = f.fn
              ? { value: f.isNull ? null : f.value, fn: f.fn }
              : { value: f.isNull ? null : f.value };
        }
        if (Object.keys(set).length === 0) {
          navigate(paths.table(props.srv, props.db, props.table, 'browse', props.schema));
          return;
        }
        res = await api.updateRow(props.srv, props.db, props.table, props.schema, {
          locator: props.locator as never,
          set,
        });
      } else {
        const payload = rows
          .filter((r) => !r.ignore)
          .map((r) =>
            Object.fromEntries(
              cols.flatMap((c) => {
                const v = inputFor(c, r.fields[c.name]!);
                return v ? [[c.name, v]] : [];
              }),
            ),
          );
        res = await api.insertRows(props.srv, props.db, props.table, props.schema, {
          rows: payload,
          mode: insertMode,
        });
      }
      void qc.invalidateQueries({ queryKey: ['rows', props.srv, props.db] });
      void qc.invalidateQueries({ queryKey: ['nav', props.srv, 'tables', props.db] });
      if (then === 'back') {
        navigate(paths.table(props.srv, props.db, props.table, 'browse', props.schema), {
          state: { mutation: res },
        });
      } else {
        setDone(res);
        setRows([emptyRow(cols, false), emptyRow(cols, true)]);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="insert-form">
      {mode !== 'insert' ? <h2>{mode === 'edit' ? t('insert.editTitle') : t('insert.copyTitle')}</h2> : null}
      {done ? (
        <Message kind="success">
          {t('insert.inserted', { count: done.affectedRows })}
          {done.sql.map((s, i) => (
            <pre key={i} className="sql-box">
              {s}
            </pre>
          ))}
        </Message>
      ) : null}
      {error ? <ErrorMessage error={error} /> : null}

      {rows.map((row, ri) => (
        <fieldset key={ri} className="panel">
          {ri > 0 ? (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={row.ignore}
                onChange={(e) =>
                  setRows(rows.map((r, i) => (i === ri ? { ...r, ignore: e.target.checked } : r)))
                }
              />{' '}
              {t('insert.ignore')}
            </label>
          ) : null}
          <table className="data insert-table" aria-disabled={row.ignore}>
            <thead>
              <tr>
                <th>{t('insert.column')}</th>
                <th>{t('insert.type')}</th>
                <th>{t('insert.function')}</th>
                <th>{t('insert.null')}</th>
                <th>{t('insert.value')}</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => {
                const f = row.fields[c.name]!;
                const id = `f-${ri}-${c.name}`;
                const options = enumValues(c.type);
                const disabled = row.ignore || f.isNull;
                return (
                  <tr key={c.name}>
                    <th scope="row">
                      <label htmlFor={id}>{c.name}</label>
                    </th>
                    <td>
                      <code>{c.type}</code>
                    </td>
                    <td>
                      <select
                        aria-label={`${t('insert.function')} ${c.name}`}
                        value={f.fn}
                        disabled={row.ignore}
                        onChange={(e) => setField(ri, c.name, { fn: e.target.value })}
                      >
                        <option value="" />
                        {fns.map((fn) => (
                          <option key={fn.name} value={fn.name}>
                            {fn.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {c.nullable ? (
                        <input
                          type="checkbox"
                          aria-label={`NULL ${c.name}`}
                          checked={f.isNull}
                          disabled={row.ignore}
                          onChange={(e) => setField(ri, c.name, { isNull: e.target.checked })}
                        />
                      ) : null}
                    </td>
                    <td>
                      {options && /^enum/i.test(c.type) ? (
                        <select
                          id={id}
                          value={f.value}
                          disabled={disabled}
                          onChange={(e) => setField(ri, c.name, { value: e.target.value })}
                        >
                          <option value="" />
                          {options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : isLongText(c) ? (
                        <textarea
                          id={id}
                          rows={3}
                          cols={50}
                          value={f.value}
                          disabled={disabled}
                          onChange={(e) => setField(ri, c.name, { value: e.target.value })}
                        />
                      ) : (
                        <input
                          id={id}
                          size={30}
                          value={f.value}
                          disabled={disabled}
                          placeholder={isAuto(c) ? 'auto' : (c.default ?? undefined)}
                          onChange={(e) => setField(ri, c.name, { value: e.target.value })}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </fieldset>
      ))}

      <div className="form-actions insert-actions">
        {mode !== 'edit' && props.engine !== 'postgres' ? (
          <label>
            {t('insert.mode')}{' '}
            <select value={insertMode} onChange={(e) => setInsertMode(e.target.value as typeof insertMode)}>
              <option value="insert">{t('insert.modes.insert')}</option>
              <option value="ignore">{t('insert.modes.ignore')}</option>
              <option value="replace">{t('insert.modes.replace')}</option>
            </select>
          </label>
        ) : null}
        {mode !== 'edit' ? (
          <label>
            {t('insert.then')}{' '}
            <select value={then} onChange={(e) => setThen(e.target.value as typeof then)}>
              <option value="back">{t('insert.back')}</option>
              <option value="another">{t('insert.another')}</option>
            </select>
          </label>
        ) : null}
        {mode === 'insert' ? (
          <label>
            {t('insert.rows', { count: rows.length })}{' '}
            <select
              value={rows.length}
              onChange={(e) => {
                const n = Number(e.target.value);
                setRows(
                  n > rows.length
                    ? [...rows, ...Array.from({ length: n - rows.length }, () => emptyRow(cols, false))]
                    : rows.slice(0, n),
                );
              }}
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('insert.go')}
        </button>
      </div>
    </form>
  );
}
