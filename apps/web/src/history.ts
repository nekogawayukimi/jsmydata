import type { SqlResponse } from '@jsmydata/shared';
import type { TFunction } from 'i18next';
import { create } from 'zustand';

/** Historique des requêtes de la session (QueryHistoryMax de phpMyAdmin : 25 entrées). */
export interface HistoryEntry {
  id: number;
  at: number;
  server: string;
  db?: string;
  schema?: string;
  sql: string;
  ok: boolean;
  /** Résumé : « 12 lignes », « 3 lignes affectées », message d'erreur… */
  info: string;
}

const KEY = 'jsmydata.history';
const MAX = 25;

function load(): HistoryEntry[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function save(list: HistoryEntry[]) {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible : l'historique vit le temps de la page */
  }
}

interface HistoryState {
  entries: HistoryEntry[];
  add: (e: Omit<HistoryEntry, 'id' | 'at'>) => void;
  clear: () => void;
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: load(),
  add: (e) => {
    const entries = [{ ...e, id: Date.now() + Math.random(), at: Date.now() }, ...get().entries].slice(
      0,
      MAX,
    );
    save(entries);
    set({ entries });
  },
  clear: () => {
    save([]);
    set({ entries: [] });
  },
}));

/** Ouverture de la console (Ctrl+Alt+C) et requête à y préremplir. */
interface ConsoleState {
  open: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

export const useConsole = create<ConsoleState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
}));

/** Résumé d'une exécution pour l'historique et la console. */
export function summarize(res: SqlResponse, t: TFunction): { ok: boolean; info: string } {
  if (res.error) return { ok: false, info: res.error.message };
  const last = res.results[res.results.length - 1];
  if (!last) return { ok: true, info: '' };
  return last.returnsRows
    ? { ok: true, info: t('console.rows', { count: last.total ?? last.rows?.length ?? 0 }) }
    : { ok: true, info: t('grid.saved', { count: last.affectedRows ?? 0 }) };
}
