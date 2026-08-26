# TODO

Ideas parked from the competitive gap analysis against Prisma, Hasura, PostGraphile and
Supabase's `pg_graphql`. Roughly ordered within each group; nothing here is committed to.

## Planned

- **Nested writes on MySQL and on synchronous SQLite drivers** — `features.nestedWrites` has
  landed for PostgreSQL and for SQLite on an async driver. MySQL needs a way to read back the
  key of the row it just inserted without `RETURNING`; a synchronous SQLite driver needs the
  whole write path rewritten without `await` so it can run inside the driver's transaction
  callback. Both are rejected at build time today.
- **Deeper nested writes** — nesting is one level: the row a nested `create` inserts takes
  columns only. Arbitrary depth needs the plans to recurse and the input types to be cycle-safe.

## Medium priority

- **Multi-mutation transactions** — a caller can now run a whole request on one transaction
  by putting it on the GraphQL context under `drizzleExecutorKey`; every resolver reads it at
  resolve time. What is left is doing it automatically: wrapping a request that fires several
  mutations in a transaction the library opens itself, without the caller wiring up the
  context.
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
- **`affected_rows` on mutation payloads** — Hasura exposes it, and MySQL's returnless
  mutations would benefit most. (Descriptions and deprecations themselves have landed as the
  `describeColumn` / `describeTable` / `describeRelation` / `deprecateColumn` hooks; reading
  them out of database comments automatically is still open, and needs a catalogue query
  drizzle does not expose.)
- **Many-to-many relation filters** — relations declared with `.through()` are currently left
  out of the filter input entirely. Same gap exists for relation aggregates.

## Deliberately not doing

- **Column and table exposure control** — allow/deny lists for what appears in the schema.
  Better handled by `graphql-shield` or an equivalent layer, which already has the
  per-request context this library does not.
- **Per-request authorization hooks** — same reasoning: auth middleware sits above the schema
  and has the request context it needs.
