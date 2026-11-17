import {
  API_PREFIX,
  CSRF_HEADER,
  type ApiErrorBody,
  type ColumnInfo,
  type DatabaseInfo,
  type DbSearchRequest,
  type DbSearchResponse,
  type DeleteRowsRequest,
  type InsertRowsRequest,
  type MutationResponse,
  type SortSpec,
  type SqlRequest,
  type SqlResponse,
  type StatementResult,
  type TableSearchRequest,
  type UpdateRowRequest,
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
    api.tableMeta(srv, db, table, schema).then((r) => r.columns),
  tableMeta: (srv: string, db: string, table: string, schema?: string) =>
    call<{ columns: ColumnInfo[]; uniqueKeys: string[][] }>(
      `/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/columns${schemaQuery(schema)}`,
    ),

  sql: (srv: string, req: SqlRequest) =>
    call<SqlResponse>(`/srv/${enc(srv)}/sql`, { method: 'POST', body: req }),
  cancel: (srv: string) =>
    call<{ cancelled: boolean }>(`/srv/${enc(srv)}/sql/cancel`, { method: 'POST', body: {} }),

  browse: (
    srv: string,
    db: string,
    table: string,
    opts: { schema?: string; offset: number; count: number; sort: SortSpec[]; showAll?: boolean },
  ) => {
    const q = new URLSearchParams();
    if (opts.schema) q.set('schema', opts.schema);
    q.set('offset', String(opts.offset));
    q.set('count', String(opts.count));
    if (opts.showAll) q.set('showAll', '1');
    for (const s of opts.sort) q.append('sort', `${s.dir}:${s.column}`);
    return call<StatementResult>(`/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/rows?${q}`);
  },

  insertRows: (srv: string, db: string, table: string, schema: string | undefined, body: InsertRowsRequest) =>
    call<MutationResponse>(`/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/rows${schemaQuery(schema)}`, {
      method: 'POST',
      body,
    }),
  updateRow: (srv: string, db: string, table: string, schema: string | undefined, body: UpdateRowRequest) =>
    call<MutationResponse>(`/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/rows${schemaQuery(schema)}`, {
      method: 'PATCH',
      body,
    }),
  deleteRows: (srv: string, db: string, table: string, schema: string | undefined, body: DeleteRowsRequest) =>
    call<MutationResponse>(`/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/rows${schemaQuery(schema)}`, {
      method: 'DELETE',
      body,
    }),

  searchTable: (
    srv: string,
    db: string,
    table: string,
    schema: string | undefined,
    body: TableSearchRequest,
  ) =>
    call<StatementResult>(
      `/srv/${enc(srv)}/db/${enc(db)}/tables/${enc(table)}/search${schemaQuery(schema)}`,
      {
        method: 'POST',
        body,
      },
    ),
  searchDb: (srv: string, db: string, schema: string | undefined, body: DbSearchRequest) =>
    call<DbSearchResponse>(`/srv/${enc(srv)}/db/${enc(db)}/search${schemaQuery(schema)}`, {
      method: 'POST',
      body,
    }),
};

export type { ColumnInfo };
