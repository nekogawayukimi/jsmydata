import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import { ErrorMessage, Loading, Message } from '../components/Message';
import { ThemeToggle } from '../components/ThemeToggle';
import { changeLanguage, LANGUAGES } from '../i18n';
import { paths } from '../routes';
import { meKey, useMe, useServers } from '../session';

/** Page de connexion : langue, serveur, utilisateur, mot de passe (ou fichier pour SQLite). */
export function Login() {
  const { t, i18n } = useTranslation();
  const servers = useServers();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const requested = search.get('server');

  const [chosenServer, setServerId] = useState<string>('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [file, setFile] = useState('');

  const list = useMemo(() => servers.data?.servers ?? [], [servers.data]);
  // Serveur proposé : celui demandé dans l'URL, sinon le premier détecté, sinon le premier de la liste.
  const proposed =
    list.find((s) => s.id === requested)?.id ?? list.find((s) => s.autoDetected)?.id ?? list[0]?.id ?? '';
  const serverId = chosenServer || proposed;
  const selected = list.find((s) => s.id === serverId);

  const login = useMutation({
    mutationFn: async () => {
      // Le jeton CSRF est obtenu avant toute requête modifiante.
      if (!me.data) await qc.fetchQuery({ queryKey: meKey, queryFn: api.me });
      return api.login({ server: serverId, user, password, file: selected?.needsFile ? file : undefined });
    },
    onSuccess: (data) => {
      qc.setQueryData(meKey, data);
      navigate(paths.server(serverId), { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  if (servers.isLoading) return <Loading />;

  return (
    <div className="login-page">
      <div className="login-toolbar">
        <ThemeToggle />
      </div>
      <div className="login-box">
        <h1 className="logo logo-large">
          <span className="logo-js">Js</span>
          <span className="logo-my">My</span>
          <span className="logo-data">Data</span>
        </h1>
        <p className="login-welcome">{t('login.welcome')}</p>

        {search.get('expired') ? <Message kind="notice">{t('login.expired')}</Message> : null}
        {servers.data?.defaultConfig ? <Message kind="notice">{t('login.defaultConfig')}</Message> : null}
        {servers.error ? <ErrorMessage error={servers.error} /> : null}

        <fieldset className="panel">
          <legend>{t('login.language')}</legend>
          <select
            aria-label={t('login.language')}
            value={i18n.language}
            onChange={(e) => changeLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </fieldset>

        <form onSubmit={submit} className="panel">
          <fieldset>
            <legend>{t('login.title')}</legend>
            {login.error ? <ErrorMessage error={login.error} /> : null}

            <div className="form-row">
              <label htmlFor="login-server">{t('login.server')} :</label>
              <select id="login-server" value={serverId} onChange={(e) => setServerId(e.target.value)}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.verbose}
                    {!s.autoDetected && s.engine !== 'sqlite' ? ` (${t('login.notDetected')})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {selected?.needsFile ? (
              <div className="form-row">
                <label htmlFor="login-file">{t('login.file')}</label>
                <input
                  id="login-file"
                  list="login-files"
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                  placeholder="base.sqlite"
                  autoComplete="off"
                  required
                />
                <datalist id="login-files">
                  {(selected.files ?? []).map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
                <small className="help">{t('login.fileHelp')}</small>
              </div>
            ) : (
              <>
                <div className="form-row">
                  <label htmlFor="login-user">{t('login.user')}</label>
                  <input
                    id="login-user"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="login-password">{t('login.password')}</label>
                  <input
                    id="login-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}
          </fieldset>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={login.isPending || !serverId}>
              {t('login.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
