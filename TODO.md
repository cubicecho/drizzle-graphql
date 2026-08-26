# TODO

Ideas parked from the competitive gap analysis against Prisma, Hasura, PostGraphile and
Supabase's `pg_graphql`. Roughly ordered within each group; nothing here is committed to.

## Planned

- **Nested writes** — designed in
  [docs/plans/upsert-and-nested-writes.md](docs/plans/upsert-and-nested-writes.md). Upsert
  (step 3) and the shared groundwork (steps 1, 2 and 4) have landed; nested `create` /
  `connect` on the insert inputs has not.

## Medium priority

- **Multi-mutation transactions** — a caller can now run a whole request on one transaction
  by putting it on the GraphQL context under `drizzleExecutorKey`; every resolver reads it at
  resolve time. What is left is doing it automatically: wrapping a request that fires several
  mutations in a transaction the library opens itself, without the caller wiring up the
  context.
- **`groupBy` / `having` on aggregates** — the aggregate queries compute one row over the
  whole filtered set. Grouping is the obvious next step and the most-asked-for aggregate
  feature after the ones already built.
- **Query depth and complexity limits** — currently unbounded; a cyclic relation graph lets
  a client ask for arbitrarily deep nesting. `graphql-depth-limit` and
  `graphql-query-complexity` cover this from outside, but per-field complexity hints
  (a relation with `limit: 1000` costs more than a scalar) can only come from the generator.
- **Full-text search** — Postgres `tsvector` / `websearch_to_tsquery`, MySQL `MATCH … AGAINST`,
  SQLite FTS5. Would slot in as an operator on the filter input for qualifying columns.

## Lower priority

- **Nulls ordering** — `orderBy` cannot say `NULLS FIRST` / `NULLS LAST`. The default differs
  between Postgres (nulls last on ASC) and MySQL/SQLite (nulls first), so ordering a nullable
  column is not portable today.
- **Views and computed fields** — Drizzle views are not picked up, and there is no way to add
  a derived field backed by SQL. Reachable now by composing a custom schema.
- **Relay connections** — `Node` interface, global IDs, `PageInfo`, cursor pagination. A large
  surface, and the current `limit`/`offset` covers most uses; worth doing only if a client
  framework demands it.
- **Subscriptions / live queries** — needs a change-feed (`LISTEN`/`NOTIFY`, binlog, polling)
  that this library does not have and cannot fake cheaply.
- **Descriptions and deprecations from the database** — carry column and table comments into
  GraphQL descriptions, and mark deprecated columns with `@deprecated`. Also `affected_rows`
  on mutation payloads, which Hasura exposes and MySQL's returnless mutations would benefit
  from.
- **Many-to-many relation filters** — relations declared with `.through()` are currently left
  out of the filter input entirely. Same gap exists for relation aggregates.

## Deliberately not doing

- **Column and table exposure control** — allow/deny lists for what appears in the schema.
  Better handled by `graphql-shield` or an equivalent layer, which already has the
  per-request context this library does not.
- **Per-request authorization hooks** — same reasoning: auth middleware sits above the schema
  and has the request context it needs.
