import type { SessionServer } from '@jsmydata/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from './api';

export const meKey = ['me'] as const;
export const serversKey = ['servers'] as const;

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: api.me, staleTime: 30_000 });
}

export function useServers() {
  return useQuery({ queryKey: serversKey, queryFn: api.servers, staleTime: 60_000 });
}

/** Serveur courant (paramètre :srv de l'URL) parmi ceux de la session. */
export function useCurrentServer(): SessionServer | undefined {
  const { srv } = useParams();
  const me = useMe();
  return me.data?.servers.find((s) => s.id === srv);
}
