import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { summarize, useConsole, useHistory } from '../history';
import { useCurrentServer } from '../session';
import { cellText } from '../cells';
import type { StatementResult } from '@jsmydata/shared';

interface LogLine {
  id: number;
  sql: string;
  ok: boolean;
  info: string;
  preview?: StatementResult;
}

/** Console SQL repliable en bas de chaque page (Ctrl+Alt+C), dans le contexte courant. */
export function Console() {
  const { t, i18n } = useTranslation();
  const server = useCurrentServer();
  const { db } = useParams();
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  const { open, toggle } = useConsole();
  const history = useHistory();
  const [text, setText] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [log]);

  if (!server) return null;
  const ctx = [server.verbose, db, schema].filter(Boolean).join(' › ');

  const run = async () => {
    const sql = text.trim();
    if (!sql || busy) return;
    setBusy(true);
    try {
      const res = await api.sql(server.id, { sql, db, schema, count: 25 });
      const s = summarize(res, t);
      history.add({ server: server.id, db, schema, sql, ...s });
      const last = res.results[res.results.length - 1];
      setLog((l) => [...l, { id: Date.now(), sql, ...s, preview: last?.returnsRows ? last : undefined }]);
      setText('');
      setCursor(-1);
    } catch (err) {
      setLog((l) => [...l, { id: Date.now(), sql, ok: false, info: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
    }
    // Flèches haut / bas : parcours de l'historique quand le champ est vide ou déjà rappelé.
    const mine = history.entries.filter((h) => h.server === server.id);
    if (e.key === 'ArrowUp' && (text === '' || cursor >= 0) && mine.length) {
      e.preventDefault();
      const next = Math.min(cursor + 1, mine.length - 1);
      setCursor(next);
      setText(mine[next]!.sql);
    }
    if (e.key === 'ArrowDown' && cursor >= 0) {
      e.preventDefault();
      const next = cursor - 1;
      setCursor(next);
      setText(next >= 0 ? mine[next]!.sql : '');
    }
  };

  return (
    <div className={`console ${open ? 'open' : ''}`}>
      <button type="button" className="console-bar" onClick={toggle} aria-expanded={open}>
        {open ? '▾' : '▸'} {t('console.toggle')}
      </button>
      {open ? (
        <div className="console-body" role="region" aria-label={t('console.title')}>
          <div className="console-log">
            {log.map((l) => (
              <div key={l.id} className={`console-entry ${l.ok ? '' : 'error'}`}>
                <pre className="console-sql">{l.sql}</pre>
                <div className="console-info">{l.info}</div>
                {l.preview?.rows?.length ? (
                  <table className="data compact">
                    <thead>
                      <tr>
                        {(l.preview.fields ?? []).map((f, i) => (
                          <th key={i}>{f.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {l.preview.rows.slice(0, 10).map((r, i) => (
                        <tr key={i}>
                          {r.map((v, j) => (
                            <td key={j} className={v === null ? 'null' : undefined}>
                              {cellText(v, i18n.language, false, (size) => t('grid.blob', { size }))}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            ))}
            <div ref={end} />
          </div>
          <div className="console-input">
            <span className="help">{t('console.context', { ctx })}</span>
            <textarea
              ref={input}
              rows={2}
              value={text}
              placeholder={t('console.placeholder')}
              aria-label={t('console.placeholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
            <div className="console-actions">
              <button type="button" onClick={() => setLog([])}>
                {t('console.clear')}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !text.trim()}
                onClick={() => void run()}
              >
                {t('sql.run')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
