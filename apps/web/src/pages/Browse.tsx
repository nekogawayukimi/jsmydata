import type { SortSpec } from '@jsmydata/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { MutationResponse } from '@jsmydata/shared';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { ErrorMessage, Loading, Message } from '../components/Message';
import { Pager, ResultBanner, ResultGrid } from '../components/ResultGrid';
import { useCurrentServer, useServers } from '../session';

/** Onglet « Parcourir » : lignes paginées, tri, édition en ligne. */
export function Browse() {
  const { db, table } = useParams() as { db: string; table: string };
  const [search] = useSearchParams();
  const schema = search.get('schema') ?? undefined;
  // Nouvel état (page, tri) à chaque table.
  return <BrowseTable key={`${db}/${schema ?? ''}/${table}`} db={db} table={table} schema={schema} />;
}

function BrowseTable({ db, table, schema }: { db: string; table: string; schema?: string }) {
  const { t } = useTranslation();
  const location = useLocation();
  const mutation = (location.state as { mutation?: MutationResponse } | null)?.mutation;
  const server = useCurrentServer()!;
  const servers = useServers();
  const qc = useQueryClient();
  const [page, setPage] = useState({ offset: 0, count: servers.data?.maxRows ?? 25, showAll: false });
  const [sort, setSort] = useState<SortSpec[]>([]);
  const key = ['rows', server.id, db, schema ?? '', table, page, sort] as const;
  const rows = useQuery({
    queryKey: key,
    queryFn: () => api.browse(server.id, db, table, { schema, ...page, sort }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['rows', server.id, db, schema ?? '', table] });

  if (rows.isLoading) return <Loading />;
  if (rows.error) return <ErrorMessage error={rows.error} />;
  const result = rows.data!;
  const pager = (
    <Pager
      offset={page.offset}
      count={page.count}
      total={result.total}
      rowsOnPage={result.rows?.length ?? 0}
      showAll={page.showAll}
      onChange={setPage}
    />
  );
  return (
    <section className={rows.isFetching ? 'is-fetching' : undefined}>
      {mutation ? (
        <Message kind="success">
          {t('grid.saved', { count: mutation.affectedRows })}
          {mutation.sql.map((s, i) => (
            <pre key={i} className="sql-box">
              {s}
            </pre>
          ))}
        </Message>
      ) : null}
      <ResultBanner result={result} srv={server.id} db={db} schema={schema} onRefresh={refresh} />
      {pager}
      <ResultGrid
        result={result}
        srv={server.id}
        sort={sort}
        onSort={(s) => {
          setSort(s);
          setPage({ ...page, offset: 0 });
        }}
        onChanged={refresh}
      />
      {(result.rows?.length ?? 0) > 10 ? pager : null}
    </section>
  );
}
