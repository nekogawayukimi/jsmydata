import session from 'express-session';
import createMemoryStore from 'memorystore';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Stockage des sessions : en mémoire par défaut, Redis pour faire tourner plusieurs instances.
 * Les identifiants restent chiffrés (AES-256-GCM) quel que soit le stockage.
 */
export async function createSessionStore(config: AppConfig, logger: Logger): Promise<session.Store> {
  if (config.SessionStore.type === 'redis') {
    const { createClient } = await import('redis');
    const { RedisStore } = await import('connect-redis');
    const client = createClient({ url: config.SessionStore.url });
    client.on('error', (err: Error) => logger.error({ err }, 'Redis'));
    await client.connect();
    logger.info(
      { url: config.SessionStore.url.replace(/\/\/[^@]*@/, '//***@') },
      'sessions stockées dans Redis',
    );
    return new RedisStore({ client, prefix: config.SessionStore.prefix, ttl: config.LoginCookieValidity });
  }
  const MemoryStore = createMemoryStore(session);
  return new MemoryStore({ checkPeriod: 60_000 });
}
