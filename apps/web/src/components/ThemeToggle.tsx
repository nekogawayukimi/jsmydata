import { useTranslation } from 'react-i18next';
import { nextColorMode, useTheme } from '../theme';
import { Icon } from './Icon';

/** Bascule en un clic : Automatique → Clair → Sombre. */
export function ThemeToggle() {
  const { t } = useTranslation();
  const { mode, locked, setMode } = useTheme();
  const label = locked ? t('theme.locked') : t(`theme.${mode}`);
  return (
    <button
      type="button"
      className="icon-button"
      title={label}
      aria-label={label}
      disabled={locked}
      onClick={() => setMode(nextColorMode(mode))}
    >
      <Icon name={mode === 'auto' ? 'auto' : mode === 'light' ? 'sun' : 'moon'} />
    </button>
  );
}
