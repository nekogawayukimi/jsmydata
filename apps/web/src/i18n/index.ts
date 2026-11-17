import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import fr from './fr';

export const LANGUAGES = [
  { code: 'fr', label: 'Français - French' },
  { code: 'en', label: 'English' },
] as const;

const STORAGE_KEY = 'jsmydata.lang';

function storedLang(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function pick(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const short = candidate.toLowerCase().split('-')[0]!;
  return LANGUAGES.some((l) => l.code === short) ? short : null;
}

/** Langue initiale : choix de l'utilisateur, sinon navigateur, sinon français. */
export function initialLanguage(): string {
  return pick(storedLang()) ?? pick(globalThis.navigator?.language) ?? 'fr';
}

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'fr',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.language;

export function changeLanguage(code: string) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, code);
  } catch {
    /* stockage indisponible */
  }
  void i18n.changeLanguage(code);
}

/** Langue par défaut du serveur (DefaultLang), appliquée si l'utilisateur n'a rien choisi. */
export function applyServerLanguage(defaultLang: string) {
  if (storedLang() || defaultLang === 'auto') return;
  const lang = pick(defaultLang);
  if (lang && lang !== i18n.language) void i18n.changeLanguage(lang);
}

export default i18n;
