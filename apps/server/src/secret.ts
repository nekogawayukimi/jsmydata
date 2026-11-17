import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Secret {
  /** Clé AES-256-GCM pour les identifiants stockés en session. */
  encKey: Buffer;
  /** Secret de signature du cookie de session. */
  cookieSecret: string;
  /** D'où vient le secret : configuration ou fichier généré. */
  origin: 'config' | 'file' | 'generated';
  file?: string;
}

export function defaultSecretFile(): string {
  return join(homedir(), '.jsmydata', 'secret');
}

/**
 * Équivalent de blowfish_secret : fourni par la configuration, ou généré au premier lancement
 * et conservé dans ~/.jsmydata/secret (droits 600).
 */
export function resolveSecret(configured: string | undefined, file = defaultSecretFile()): Secret {
  let raw: string;
  let origin: Secret['origin'];
  if (configured) {
    raw = configured;
    origin = 'config';
  } else if (existsSync(file)) {
    raw = readFileSync(file, 'utf8').trim();
    origin = 'file';
  } else {
    raw = randomBytes(32).toString('hex');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, raw + '\n', { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows : droits POSIX non applicables */
    }
    origin = 'generated';
  }
  const ikm = createHash('sha256').update(raw).digest();
  const encKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'jsmydata/credentials', 32));
  const cookieSecret = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'jsmydata/cookie', 32)).toString(
    'hex',
  );
  return { encKey, cookieSecret, origin, file: configured ? undefined : file };
}

/** Chiffre une valeur JSON (AES-256-GCM, IV aléatoire de 12 octets). */
export function encrypt(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt<T>(key: Buffer, token: string): T {
  const [iv, tag, data] = token.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Jeton chiffré invalide');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(text) as T;
}
