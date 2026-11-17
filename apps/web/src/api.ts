import {
  API_PREFIX,
  CSRF_HEADER,
  type ApiErrorBody,
  type ColumnInfo,
  type DatabaseInfo,
  type LoginRequest,
  type MeResponse,
  type SchemaInfo,
  type ServerInfo,
  type ServersResponse,
  type TableInfo,
} from '@jsmydata/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers[CSRF_HEADER] = csrfToken;
  const res = await fetch(API_PREFIX + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const body = (data as ApiErrorBody | undefined) ?? {
      code: 'HTTP_' + res.status,
      message: res.statusText,
    };
    throw new ApiError(res.status, body);
  }
  return data as T;
}

const enc = encodeURIComponent;
const schemaQuery = (schema?: string) => (schema ? `?schema=${enc(schema)}` : '');

export const api = {
  servers: () => call<ServersResponse>('/servers'),
  me: async () => {
    const me = await call<MeResponse>('/auth/me');
    setCsrfToken(me.csrfToken);
    return me;
  },
  login: async (req: LoginRequest) => {
    const me = await call<MeResponse>('/auth/login', { method: 'POST', body: req });
    setCsrfToken(me.csrfToken);
    return me;
  },
  logout: (server?: string) =>
    call<MeResponse>('/auth/logout', { method: 'POST', body: server ? { server } : {} }),
  info: (srv: string) => call<ServerInfo>(`/srv/${enc(srv)}/info`),
  databases: (srv: string) =>
    call<{ databases: DatabaseInfo[] }>(`/srv/${enc(srv)}/databases`).then((r) => r.databases),
  schemas: (srv: string, db: string) =>
    call<{ schemas: SchemaInfo[] }>(`/srv/${enc(srv)}/db/${enc(db)}/schemas`).then((r) => r.schemas),
  tables: (srv: string, db: string, schema?: string) =>
    call<{ tables: TableInfo[] }>(`/srv/${enc(srv)}/db/${enc(db)}/tables${schemaQuery(schema)}`).then(
      (r) => r.tables,
    ),
  columns: (srv: string, db: string, table: string, schema?: string) =>
    call<{ columns: ColumnInfo[] }>(
      `/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/columns${schemaQuery(schema)}`,
    ).then((r) => r.columns),
};
