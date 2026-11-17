import type { ColorMode } from '@jsmydata/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { ErrorMessage, Loading } from '../components/Message';
import { changeLanguage, LANGUAGES } from '../i18n';
import { useCurrentServer } from '../session';
import { useTheme } from '../theme';

/** Page d'accueil du serveur : paramètres généraux et d'affichage, informations serveur et application. */
export function Home() {
  const { t, i18n } = useTranslation();
  const server = useCurrentServer()!;
  const info = useQuery({ queryKey: ['info', server.id], queryFn: () => api.info(server.id) });
  const { mode, locked, setMode } = useTheme();

  return (
    <div className="home">
      <div className="home-col">
        <section className="panel">
          <h2>{t('home.appearance')}</h2>
          <div className="form-row">
            <label htmlFor="home-lang">{t('home.language')}</label>
            <select id="home-lang" value={i18n.language} onChange={(e) => changeLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="home-theme">{t('home.theme')}</label>
            <select id="home-theme" value="jmd-default" disabled>
              <option value="jmd-default">jmd-default</option>
            </select>
          </div>
          <div className="form-row">
            <span id="home-mode-label">{t('home.colorMode')}</span>
            <div className="segmented" role="radiogroup" aria-labelledby="home-mode-label">
              {(['auto', 'light', 'dark'] as ColorMode[]).map((m) => (
                <label key={m} className={mode === m ? 'checked' : undefined}>
                  <input
                    type="radio"
                    name="color-mode"
                    value={m}
                    checked={mode === m}
                    disabled={locked}
                    onChange={() => setMode(m)}
                  />
                  {t(`home.modes.${m}`)}
                </label>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="home-col">
        <section className="panel">
          <h2>{t('home.dbServer')}</h2>
          {info.isLoading ? <Loading /> : null}
          {info.error ? <ErrorMessage error={info.error} /> : null}
          {info.data ? (
            <ul className="info-list">
              <li>
                {t('home.serverLabel')} {info.data.host}
              </li>
              <li>
                {t('home.type')} {info.data.product}
              </li>
              {info.data.engine !== 'sqlite' ? (
                <li>
                  {t('home.ssl')} {info.data.ssl ? t('home.sslOn') : t('home.sslOff')}
                </li>
              ) : null}
              <li>
                {t('home.version')} {info.data.version}
              </li>
              <li>
                {t('home.user')} {info.data.user}
              </li>
            </ul>
          ) : null}
        </section>

        <section className="panel">
          <h2>{t('home.webServer')}</h2>
          {info.data ? (
            <ul className="info-list">
              <li>
                {t('home.node')} {info.data.nodeVersion}
              </li>
              <li>
                {t('home.driver')} {info.data.driver}
              </li>
            </ul>
          ) : null}
        </section>

        <section className="panel">
          <h2>{t('home.about')}</h2>
          <ul className="info-list">
            <li>
              {t('home.appVersion')} {info.data?.appVersion ?? '…'}
            </li>
            <li>
              <a href="https://github.com/nekogawayukimi/jsmydata#readme" target="_blank" rel="noreferrer">
                {t('home.docs')}
              </a>
            </li>
            <li>
              <a href="https://github.com/nekogawayukimi/jsmydata/commits" target="_blank" rel="noreferrer">
                {t('home.changelog')}
              </a>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
