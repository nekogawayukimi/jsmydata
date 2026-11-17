import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configSchema, type AppConfig, type ServerConfig } from '../src/config.js';
import { resolveSecret } from '../src/secret.js';

export const logger = pino({ level: 'silent' });

export function makeApp(
  dir: string,
  servers: ServerConfig[],
  extra: Partial<AppConfig> = {},
  defaultConfig = true,
) {
  const config = { ...configSchema.parse({}), SqliteDir: dir, ...extra } as AppConfig;
  const webDir = join(dir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>JsMyData</title>');
  return createApp({
    config,
    servers,
    secret: resolveSecret('cle-de-test-pour-les-sessions-1234'),
    logger,
    webDir,
    defaultConfig,
  });
}

export const server = (s: Partial<ServerConfig> & Pick<ServerConfig, 'id' | 'engine'>): ServerConfig => ({
  auth_type: 'cookie',
  AllowRoot: true,
  AllowNoPassword: false,
  autoDetected: false,
  ...s,
});

/** Agent connecté : renvoie l'agent et une fonction d'appel avec le jeton CSRF à jour. */
export async function login(app: Parameters<typeof request.agent>[0], body: Record<string, unknown>) {
  const agent = request.agent(app);
  const me = await agent.get('/api/v1/auth/me');
  const res = await agent.post('/api/v1/auth/login').set('x-csrf-token', me.body.csrfToken).send(body);
  if (res.status !== 200) throw new Error(`connexion refusée : ${res.status} ${JSON.stringify(res.body)}`);
  const csrf: string = res.body.csrfToken;
  return {
    agent,
    csrf,
    get: (url: string) => agent.get('/api/v1' + url),
    post: (url: string, data: unknown) =>
      agent
        .post('/api/v1' + url)
        .set('x-csrf-token', csrf)
        .send(data as object),
    patch: (url: string, data: unknown) =>
      agent
        .patch('/api/v1' + url)
        .set('x-csrf-token', csrf)
        .send(data as object),
    del: (url: string, data: unknown) =>
      agent
        .delete('/api/v1' + url)
        .set('x-csrf-token', csrf)
        .send(data as object),
  };
}
