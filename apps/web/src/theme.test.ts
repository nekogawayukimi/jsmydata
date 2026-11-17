import { describe, expect, it } from 'vitest';
import { nextColorMode, resolveColorMode, useTheme } from './theme';

describe('thème clair / sombre', () => {
  it('le mode automatique suit le système', () => {
    expect(resolveColorMode('auto', true)).toBe('dark');
    expect(resolveColorMode('auto', false)).toBe('light');
    expect(resolveColorMode('dark', false)).toBe('dark');
    expect(resolveColorMode('light', true)).toBe('light');
  });

  it('le bouton fait le cycle Automatique → Clair → Sombre', () => {
    expect(nextColorMode('auto')).toBe('light');
    expect(nextColorMode('light')).toBe('dark');
    expect(nextColorMode('dark')).toBe('auto');
  });

  it('respecte le mode imposé par l’administrateur', () => {
    useTheme.getState().applyServerDefaults('dark', false);
    expect(useTheme.getState()).toMatchObject({ mode: 'dark', locked: true });
    useTheme.getState().setMode('light');
    expect(useTheme.getState().mode).toBe('dark');
    useTheme.getState().applyServerDefaults('auto', true);
    useTheme.getState().setMode('light');
    expect(useTheme.getState().mode).toBe('light');
  });
});
