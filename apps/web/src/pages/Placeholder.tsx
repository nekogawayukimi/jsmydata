import { useTranslation } from 'react-i18next';
import { Message } from '../components/Message';

/** Onglet présent pour la parité d'interface, livré dans un lot ultérieur. */
export function Placeholder({ tabLabel, lot }: { tabLabel: string; lot: number }) {
  const { t } = useTranslation();
  return (
    <section className="placeholder">
      <h2>{tabLabel}</h2>
      <Message kind="notice">
        <strong>{t('placeholder.title', { lot })}</strong>
        <div>{t('placeholder.body', { tab: tabLabel })}</div>
      </Message>
    </section>
  );
}
