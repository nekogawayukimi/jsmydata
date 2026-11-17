import {
  isBinary,
  type CellValue,
  type ColumnInfo,
  type SortSpec,
  type StatementResult,
} from '@jsmydata/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { cellInputValue, cellText, encodeLocator, locatorFor } from '../cells';
import { paths } from '../routes';
import { ErrorMessage, Message } from './Message';

interface Props {
  result: StatementResult;
  srv: string;
  sort?: SortSpec[];
  onSort?: (sort: SortSpec[]) => void;
  /** Appelé après une modification ou une suppression, pour recharger. */
  onChanged?: () => void;
}

interface Editing {
  row: number;
  col: number;
  value: string | null;
}

/** Grille de résultats : tri, filtre, textes complets, édition en ligne, sélection, actions par ligne. */
export function ResultGrid({ result, srv, sort = [], onSort, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const edit = result.editable ?? null;
  const fields = result.fields ?? [];
  const rows = useMemo(() => result.rows ?? [], [result.rows]);
  const [full, setFull] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [feedback, setFeedback] = useState<{ sql: string[]; count: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const meta = useQuery({
    queryKey: ['nav', srv, 'meta', edit?.db, edit?.schema ?? '', edit?.table],
    queryFn: () => api.tableMeta(srv, edit!.db, edit!.table, edit!.schema),
    enabled: Boolean(edit),
    staleTime: 60_000,
  });
  const colInfo = useMemo(
    () => new Map<string, ColumnInfo>((meta.data?.columns ?? []).map((c) => [c.name, c])),
    [meta.data],
  );

  const blob = (size: string) => t('grid.blob', { size });
  const f = filter.trim().toLowerCase();
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) => !f || row.some((v) => cellText(v, i18n.language, true, blob).toLowerCase().includes(f)),
    );

  const sortDir = (name: string) => sort.find((s) => s.column === name)?.dir;
  const clickHeader = (e: MouseEvent, name: string) => {
    if (!onSort) return;
    const current = sortDir(name);
    const next: SortSpec | null =
      current === 'asc'
        ? { column: name, dir: 'desc' }
        : current === 'desc'
          ? null
          : { column: name, dir: 'asc' };
    const others = e.ctrlKey || e.metaKey ? sort.filter((s) => s.column !== name) : [];
    onSort(next ? [...others, next] : others);
  };

  const mutate = async (fn: () => Promise<{ sql: string[]; affectedRows: number }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setFeedback({ sql: r.sql, count: r.affectedRows });
      setSelected(new Set());
      onChanged?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const saveCell = async () => {
    if (!editing || !edit) return;
    const column = edit.columns[editing.col];
    const row = rows[editing.row];
    if (!column || !row) return;
    const original = cellInputValue(row[editing.col] ?? null);
    const value = editing.value;
    setEditing(null);
    if (value === original) return;
    await mutate(() =>
      api.updateRow(srv, edit.db, edit.table, edit.schema, {
        locator: locatorFor(row, edit),
        set: { [column]: { value } },
      }),
    );
  };

  const deleteRows = async (indexes: number[]) => {
    if (!edit || indexes.length === 0) return;
    if (!window.confirm(t('grid.deleteConfirm', { count: indexes.length }))) return;
    await mutate(() =>
      api.deleteRows(srv, edit.db, edit.table, edit.schema, {
        locators: indexes.map((i) => locatorFor(rows[i]!, edit)),
      }),
    );
  };

  const goForm = (mode: 'edit' | 'copy', index: number) => {
    if (!edit) return;
    const where = encodeLocator(locatorFor(rows[index]!, edit));
    navigate(
      `${paths.table(srv, edit.db, edit.table, 'insert', edit.schema)}${edit.schema ? '&' : '?'}mode=${mode}&where=${encodeURIComponent(where)}`,
    );
  };

  const onEditorKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setEditing(null);
    if (e.key === 'Enter' && (!e.shiftKey || (e.target as HTMLElement).tagName === 'INPUT')) {
      e.preventDefault();
      void saveCell();
    }
  };

  const toggleAll = () =>
    setSelected(selected.size === visible.length ? new Set() : new Set(visible.map((v) => v.index)));

  return (
    <div className="result-grid">
      {feedback ? (
        <Message kind="success">
          {t('grid.saved', { count: feedback.count })}
          {feedback.sql.map((s, i) => (
            <pre key={i} className="sql-box">
              {s}
            </pre>
          ))}
        </Message>
      ) : null}
      {error ? <ErrorMessage error={error} /> : null}
      {!edit && fields.length > 0 ? <Message kind="notice">{t('grid.noUnique')}</Message> : null}

      <div className="grid-toolbar">
        <label className="inline-check">
          <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />{' '}
          {t('grid.fullTexts')}
        </label>
        <input
          type="search"
          className="grid-filter"
          placeholder={t('grid.filterRows')}
          aria-label={t('grid.filterRows')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {edit ? <span className="help">{t('grid.inlineHelp')}</span> : null}
      </div>

      <div className="grid-scroll">
        <table className="data grid">
          <thead>
            <tr>
              {edit ? (
                <th className="grid-actions-col">
                  <input
                    type="checkbox"
                    aria-label={t('grid.checkAll')}
                    checked={visible.length > 0 && selected.size === visible.length}
                    onChange={toggleAll}
                  />
                </th>
              ) : null}
              {fields.map((fd, i) => {
                const dir = sortDir(fd.name);
                return (
                  <th
                    key={i}
                    className={onSort ? 'sortable' : undefined}
                    onClick={(e) => clickHeader(e, fd.name)}
                    title={onSort ? t('grid.sortHint') : (fd.type ?? undefined)}
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                  >
                    {fd.name}
                    {dir ? <span className="sort-mark">{dir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, index }) => (
              <tr key={index} className={selected.has(index) ? 'marked' : undefined}>
                {edit ? (
                  <td className="grid-actions">
                    <input
                      type="checkbox"
                      aria-label={`#${index + 1}`}
                      checked={selected.has(index)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        setSelected(next);
                      }}
                    />
                    <button type="button" className="link-button" onClick={() => goForm('edit', index)}>
                      {t('grid.edit')}
                    </button>
                    <button type="button" className="link-button" onClick={() => goForm('copy', index)}>
                      {t('grid.copy')}
                    </button>
                    <button
                      type="button"
                      className="link-button danger"
                      disabled={busy}
                      onClick={() => void deleteRows([index])}
                    >
                      {t('grid.delete')}
                    </button>
                  </td>
                ) : null}
                {row.map((v, ci) =>
                  editing && editing.row === index && editing.col === ci ? (
                    <td key={ci} className="editing">
                      <CellEditor
                        editing={editing}
                        nullable={colInfo.get(edit?.columns[ci] ?? '')?.nullable ?? true}
                        onChange={(value) => setEditing({ ...editing, value })}
                        onKeyDown={onEditorKey}
                        onSave={() => void saveCell()}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  ) : (
                    <Cell
                      key={ci}
                      value={v}
                      full={full}
                      editable={Boolean(edit?.columns[ci]) && !isBinary(v) && !busy}
                      onEdit={() => setEditing({ row: index, col: ci, value: cellInputValue(v) })}
                    />
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && rows.length > 0 ? (
        <div className="grid-bulk">
          <span>{t('grid.withSelected')}</span>
          <button
            type="button"
            disabled={selected.size === 0 || busy}
            onClick={() => void deleteRows([...selected])}
          >
            {t('grid.delete')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Cell({
  value,
  full,
  editable,
  onEdit,
}: {
  value: CellValue;
  full: boolean;
  editable: boolean;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const text = cellText(value, i18n.language, full, (size) => t('grid.blob', { size }));
  const numeric = typeof value === 'number';
  return (
    <td
      className={
        [value === null ? 'null' : '', numeric ? 'num' : '', editable ? 'editable' : ''].join(' ').trim() ||
        undefined
      }
      onDoubleClick={editable ? onEdit : undefined}
      title={typeof value === 'string' && value.length > 50 && !full ? value.slice(0, 500) : undefined}
    >
      {value === null ? <em>NULL</em> : full ? <span className="pre">{text}</span> : text}
    </td>
  );
}

function CellEditor(props: {
  editing: Editing;
  nullable: boolean;
  onChange: (v: string | null) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { value } = props.editing;
  const multiline = (value ?? '').length > 60 || (value ?? '').includes('\n');
  return (
    <div className="cell-editor">
      {multiline ? (
        <textarea
          autoFocus
          rows={4}
          value={value ?? ''}
          disabled={value === null}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={props.onKeyDown}
        />
      ) : (
        <input
          autoFocus
          value={value ?? ''}
          disabled={value === null}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={props.onKeyDown}
        />
      )}
      <div className="cell-editor-actions">
        {props.nullable ? (
          <label className="inline-check">
            <input
              type="checkbox"
              checked={value === null}
              onChange={(e) => props.onChange(e.target.checked ? null : '')}
            />{' '}
            {t('grid.setNull')}
          </label>
        ) : null}
        <button type="button" onClick={props.onSave}>
          {t('grid.save')}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t('grid.cancel')}
        </button>
      </div>
    </div>
  );
}

/** Navigation entre les pages : Début, Précédent, n° de page, Suivant, Fin, lignes par page, Tout afficher. */
export function Pager(props: {
  offset: number;
  count: number;
  total: number | null | undefined;
  rowsOnPage: number;
  showAll: boolean;
  onChange: (next: { offset: number; count: number; showAll: boolean }) => void;
}) {
  const { t } = useTranslation();
  const { offset, count, total, rowsOnPage, showAll } = props;
  const pages = total ? Math.max(1, Math.ceil(total / count)) : null;
  const page = Math.floor(offset / count);
  const hasNext = total !== null && total !== undefined ? offset + count < total : rowsOnPage >= count;
  const go = (o: number) => props.onChange({ offset: Math.max(0, o), count, showAll: false });
  return (
    <div className="pager" role="navigation" aria-label="pagination">
      <button type="button" disabled={showAll || offset === 0} onClick={() => go(0)}>
        « {t('pager.first')}
      </button>
      <button type="button" disabled={showAll || offset === 0} onClick={() => go(offset - count)}>
        ‹ {t('pager.prev')}
      </button>
      {pages && pages > 1 && !showAll ? (
        <label>
          {t('pager.page')}{' '}
          <select value={page} onChange={(e) => go(Number(e.target.value) * count)}>
            {Array.from({ length: Math.min(pages, 1000) }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>{' '}
          / {pages}
        </label>
      ) : null}
      <button type="button" disabled={showAll || !hasNext} onClick={() => go(offset + count)}>
        {t('pager.next')} ›
      </button>
      <button type="button" disabled={showAll || !hasNext || !pages} onClick={() => go((pages! - 1) * count)}>
        {t('pager.last')} »
      </button>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={showAll}
          onChange={(e) => props.onChange({ offset: 0, count, showAll: e.target.checked })}
        />{' '}
        {t('pager.showAll')}
      </label>
      <label>
        {t('pager.rows')}{' '}
        <select
          value={count}
          disabled={showAll}
          onChange={(e) => props.onChange({ offset: 0, count: Number(e.target.value), showAll: false })}
        >
          {[25, 50, 100, 250, 500].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Bandeau de résultat : message (lignes affichées, total, durée) et requête exécutée avec ses actions. */
export function ResultBanner(props: {
  result: StatementResult;
  srv: string;
  db?: string;
  schema?: string;
  onRefresh?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { result } = props;
  const secs = (result.durationMs / 1000).toLocaleString(i18n.language, { maximumFractionDigits: 4 });
  let message: string;
  if (!result.returnsRows) {
    message = t('result.affected', { count: result.affectedRows ?? 0, secs });
  } else if (!result.rows?.length) {
    message = t('result.empty', { secs });
  } else {
    const from = result.offset ?? 0;
    const to = from + result.rows.length - 1;
    const total = result.total;
    message = `${t('result.showing', { from, to })} ${
      total === null || total === undefined
        ? t('result.totalUnknown', { secs })
        : t(result.totalEstimated ? 'result.totalApprox' : 'result.total', {
            total: total.toLocaleString(i18n.language),
            secs,
          })
    }`;
  }
  const toSql = (sql: string, run = false) => {
    const base = props.db
      ? paths.database(props.srv, props.db, 'sql', props.schema)
      : paths.server(props.srv, 'sql');
    navigate(`${base}${base.includes('?') ? '&' : '?'}sql=${encodeURIComponent(sql)}${run ? '&run=1' : ''}`);
  };
  const explain = () => {
    const stripped = result.sql.replace(/\nLIMIT \d+( OFFSET \d+)?$/, '');
    toSql(`EXPLAIN ${stripped}`, true);
  };
  return (
    <Message kind="success">
      <div>{message}</div>
      {result.insertId !== null && result.insertId !== undefined && !result.returnsRows ? (
        <div>{t('result.insertId', { id: result.insertId })}</div>
      ) : null}
      <pre className="sql-box">{result.sql}</pre>
      <div className="sql-links">
        <button
          type="button"
          className="link-button"
          onClick={() => toSql(result.sql.replace(/\nLIMIT \d+( OFFSET \d+)?$/, ''))}
        >
          [{t('result.editQuery')}]
        </button>
        {result.returnsRows ? (
          <button type="button" className="link-button" onClick={explain}>
            [{t('result.explain')}]
          </button>
        ) : null}
        {props.onRefresh ? (
          <button type="button" className="link-button" onClick={props.onRefresh}>
            [{t('result.refresh')}]
          </button>
        ) : null}
      </div>
    </Message>
  );
}
