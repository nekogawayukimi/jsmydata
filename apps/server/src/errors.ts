import type { ApiErrorBody } from '@jsmydata/shared';
import { DialectError } from '@jsmydata/sql';
import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Erreurs de connexion au SGBD : traduites en messages lisibles, sans détail technique superflu. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ECONNRESET',
]);

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let body: ApiErrorBody = { code: 'INTERNAL', message: 'Erreur interne du serveur' };

    if (err instanceof HttpError) {
      status = err.status;
      body = { code: err.code, message: err.message };
    } else if (err instanceof DialectError) {
      const connection = CONNECTION_CODES.has(err.code);
      status = connection ? 502 : 400;
      body = {
        code: connection ? 'DB_UNREACHABLE' : err.code,
        message: err.message,
        sqlState: err.sqlState,
        errno: err.errno,
      };
    } else if ((err as { type?: string }).type === 'entity.parse.failed') {
      status = 400;
      body = { code: 'BAD_JSON', message: 'Corps de requête JSON invalide' };
    } else {
      logger.error({ err, url: req.originalUrl }, 'erreur non gérée');
    }
    res.status(status).json(body);
  };
}
