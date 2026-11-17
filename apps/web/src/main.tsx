import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError } from './api';
import { App } from './App';
import { applyServerLanguage } from './i18n';
import { meKey } from './session';
import './styles/theme.css';
import { bindThemeToDocument, useTheme } from './theme';

bindThemeToDocument();

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    // Session expirée : on rafraîchit l'état de connexion, la mise en page renvoie vers la page de connexion.
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401)
        void queryClient.invalidateQueries({ queryKey: meKey });
    },
  }),
});

// Préférences par défaut du serveur (langue, mode de couleur imposé ou non).
void api
  .servers()
  .then((s) => {
    queryClient.setQueryData(['servers'], s);
    applyServerLanguage(s.defaultLang);
    useTheme.getState().applyServerDefaults(s.defaultColorMode, s.allowColorModeChange);
  })
  .catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
