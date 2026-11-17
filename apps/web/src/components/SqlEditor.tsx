import { autocompletion } from '@codemirror/autocomplete';
import { MySQL, PostgreSQL, SQLite, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import type { Engine } from '@jsmydata/shared';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

export interface SqlEditorHandle {
  insert: (text: string) => void;
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  engine: Engine;
  /** Tables et colonnes proposées par l'autocomplétion. */
  schema?: SQLNamespace;
  defaultTable?: string;
  placeholder?: string;
  minHeight?: number;
  handleRef?: (h: SqlEditorHandle | null) => void;
  ariaLabel?: string;
}

const DIALECTS = { mysql: MySQL, postgres: PostgreSQL, sqlite: SQLite };

/** Thème de l'éditeur branché sur les variables du thème jmd-default (clair / sombre). */
const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--input-border)',
    borderRadius: '3px',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '1px' },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    caretColor: 'var(--text)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--panel-bg)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--input-border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--code-bg)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-bg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--nav-active-bg) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel-bg)',
    border: '1px solid var(--panel-border)',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--nav-active-bg)',
    color: 'var(--text)',
  },
});

/** Couleurs de coloration syntaxique lisibles dans les deux modes. */
const highlight = EditorView.theme({
  '.tok-keyword': { color: 'var(--sql-keyword)', fontWeight: '600' },
  '.tok-string, .tok-string2': { color: 'var(--sql-string)' },
  '.tok-number': { color: 'var(--sql-number)' },
  '.tok-comment': { color: 'var(--text-muted)', fontStyle: 'italic' },
  '.tok-typeName, .tok-builtin': { color: 'var(--sql-type)' },
});

export default function SqlEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  // Création unique de l'éditeur.
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          keymap.of([
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                latest.current.onRun?.();
                return true;
              },
            },
          ]),
          basicSetup,
          language.current.of(
            sql({
              dialect: DIALECTS[latest.current.engine],
              schema: latest.current.schema,
              defaultTable: latest.current.defaultTable,
              upperCaseKeywords: true,
            }),
          ),
          autocompletion({ activateOnTyping: true }),
          EditorView.lineWrapping,
          theme,
          // Classes tok-* colorées par les variables du thème (lisibles en clair et en sombre).
          syntaxHighlighting(classHighlighter),
          highlight,
          EditorView.contentAttributes.of({ 'aria-label': latest.current.ariaLabel ?? 'SQL' }),
          placeholderExt(latest.current.placeholder ?? ''),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
          EditorView.theme({
            '.cm-content, .cm-gutter': { minHeight: `${latest.current.minHeight ?? 180}px` },
          }),
        ],
      }),
    });
    view.current = v;
    latest.current.handleRef?.({
      insert: (text) => {
        const sel = v.state.selection.main;
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
        });
        v.focus();
      },
      focus: () => v.focus(),
    });
    return () => {
      latest.current.handleRef?.(null);
      v.destroy();
      view.current = null;
    };
  }, []);

  // Valeur modifiée de l'extérieur (historique, modèle de requête…).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  // Dialecte et schéma d'autocomplétion.
  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(
        sql({
          dialect: DIALECTS[props.engine],
          schema: props.schema,
          defaultTable: props.defaultTable,
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [props.engine, props.schema, props.defaultTable]);

  return <div ref={host} className="sql-editor" />;
}
