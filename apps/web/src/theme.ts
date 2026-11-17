import type { ColorMode } from '@jsmydata/shared';
import { create } from 'zustand';

const STORAGE_KEY = 'jsmydata.colorMode';

function readStored(): ColorMode | null {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'auto' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(mode: ColorMode) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    /* stockage indisponible (navigation privée) : le choix vaut pour la session */
  }
}

export function systemPrefersDark(): boolean {
  return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

/** Mode effectivement appliqué : « auto » suit le système. */
export function resolveColorMode(mode: ColorMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
}

/** Ordre de bascule du bouton : Automatique → Clair → Sombre → Automatique. */
export function nextColorMode(mode: ColorMode): ColorMode {
  return mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
}

interface ThemeState {
  mode: ColorMode;
  /** Choix imposé par l'administrateur (ThemeColorModeAllowChange = false). */
  locked: boolean;
  setMode: (mode: ColorMode) => void;
  applyServerDefaults: (defaultMode: ColorMode, allowChange: boolean) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  mode: readStored() ?? 'auto',
  locked: false,
  setMode: (mode) => {
    if (get().locked) return;
    writeStored(mode);
    set({ mode });
  },
  applyServerDefaults: (defaultMode, allowChange) => {
    if (!allowChange) set({ mode: defaultMode, locked: true });
    else if (!readStored()) set({ mode: defaultMode, locked: false });
    else set({ locked: false });
  },
}));

/** Applique le thème sur <html> (attribut data-theme) et suit les changements du système. */
export function bindThemeToDocument(): () => void {
  const root = document.documentElement;
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const apply = () => {
    const resolved = resolveColorMode(useTheme.getState().mode, Boolean(media?.matches));
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  };
  apply();
  const unsub = useTheme.subscribe(apply);
  media?.addEventListener('change', apply);
  return () => {
    unsub();
    media?.removeEventListener('change', apply);
  };
}
