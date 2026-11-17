import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentification « signon » : une application tierce authentifie l'utilisateur,
 * puis le redirige vers /api/v1/auth/signon?token=… avec un jeton signé par SignonSecret.
 *
 * Jeton = base64url(JSON) + "." + base64url(HMAC-SHA256(secret, base64url(JSON)))
 * Charge utile : { server, user, password, exp } (exp en secondes Unix, 5 minutes au plus).
 */
export interface SignonPayload {
  server: string;
  user: string;
  password?: string;
  exp: number;
}

const MAX_LIFETIME_S = 300;

export function createSignonToken(secret: string, payload: SignonPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySignonToken(secret: string, token: string, now = Date.now() / 1000): SignonPayload {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new Error('Jeton signon mal formé');
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new Error('Signature signon invalide');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignonPayload;
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('Jeton signon expiré');
  if (payload.exp > now + MAX_LIFETIME_S) throw new Error('Durée de validité du jeton signon trop longue');
  if (typeof payload.server !== 'string' || typeof payload.user !== 'string')
    throw new Error('Jeton signon incomplet');
  return payload;
}
