import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api';

type Kind = 'success' | 'notice' | 'error';

/** Messages normalisés : succès (vert), avertissement (jaune), erreur (rouge), comme phpMyAdmin. */
export function Message({ kind, children }: { kind: Kind; children: ReactNode }) {
  return (
    <div className={`message message-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error instanceof ApiError) {
    return (
      <Message kind="error">
        <strong>{t('common.error')}</strong>
        {error.body.sqlState || error.body.errno ? (
          <span className="error-code">
            {' '}
            #{error.body.errno ?? ''} {error.body.sqlState ? `(${error.body.sqlState})` : ''}
          </span>
        ) : null}
        <div>{error.message}</div>
        {error.body.code === 'DB_UNREACHABLE' ? (
          <div className="help">{t('login.unreachableHelp')}</div>
        ) : null}
      </Message>
    );
  }
  return <Message kind="error">{error instanceof Error ? error.message : String(error)}</Message>;
}

export function Loading() {
  const { t } = useTranslation();
  return <div className="loading">{t('common.loading')}</div>;
}
