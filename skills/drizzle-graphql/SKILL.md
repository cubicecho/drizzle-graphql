---
name: drizzle-graphql
description: How to use @vantreeseba/drizzle-graphql to generate a GraphQL schema from a Drizzle ORM schema - setup, naming, choosing operations, hiding tables/columns, row scoping, limits, errors, transactions, custom resolvers, and documenting the SDL with descriptions kept next to the Drizzle schema. Use when a project builds, configures or extends a schema with buildSchema().
---

# drizzle-graphql

`@vantreeseba/drizzle-graphql` turns a Drizzle ORM database instance into a GraphQL schema:
object types, filter/order inputs, list and single queries, mutations, aggregates and
relation fields. It supports PostgreSQL, MySQL and SQLite and detects which from the
instance.

The README in this repo is the full reference. This skill is the short version, plus the
mistakes agents tend to make.

- Full docs: https://cubicecho.github.io/drizzle-graphql/ (same content as `README.md`)
- Descriptions on the generated SDL: [schema-descriptions.md](schema-descriptions.md)

## Setup

Peer dependencies: `drizzle-orm ^1.0.0-rc.4`, `graphql >=16.4.0` (16 and 17 both work),
`graphql-scalars ^1.25.0 || ^2.0.0`.

```ts
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createYoga } from 'graphql-yoga';
import { buildSchema } from '@vantreeseba/drizzle-graphql';
import * as tables from './schema';

const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  users: { posts: r.many.posts({ from: r.users.id, to: r.posts.authorId }) },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
});

const db = drizzle({ client: pool, relations });
const { schema, entities } = buildSchema(db, { typeNameMapper: 'singularize' });

const yoga = createYoga({ schema });
```

- The instance **must be built with relations** (`buildRelations` / `defineRelations`).
  Drizzle 1.0 rc.4+ no longer takes a separate `schema` argument; the tables come from the
  relations config.
- `buildSchema` returns `{ schema, entities }`. Serve `schema` as is, or compose your own
  schema from `entities` (`queries`, `mutations`, `inputs`, `types`, `fieldResolvers`).
- Import only from the package root, never from `dist/` or deep paths.

## Rules that are easy to get wrong

**Every config key that names a table or column uses the Drizzle schema key**: the property
name in your schema object (`users`, `createdAt`). It is not the database name
(`created_at`) and not the generated GraphQL name (`User`). This applies to `exclude`,
`scope`, `contextValues`, `softDelete`, `limits.tables`, `defaults`, `features` predicates,
`eagerLoadRelations` and every `describe*` hook. Names in `exclude`, `scope` and
`contextValues` that match nothing throw at build time.

**Naming.** By default the table key `tasks` gives type `Tasks` and queries `tasks` /
`tasksSingle`. Most projects want `typeNameMapper: 'singularize'`, which gives type `Task`,
queries `tasks` / `task`, and `createTasks` / `createTask`. A mapper renames the keys on
`entities` too, so composed schemas must use the mapped names.

**No auth is generated.** Every table the instance knows about is readable and writable by
anyone who reaches the endpoint. Pick the right tool:

| Need | Use |
| --- | --- |
| A table or column must not exist in the API at all | `exclude: { tables: [...], columns: { users: ['passwordHash'] } }` |
| Turn off operations (no delete, read-only, opt-in upsert) | `features` (booleans or `(tableKey) => boolean`) |
| Callers only see their tenant's rows | `scope: { posts: (ctx, table) => eq(table.orgId, ctx.orgId) }` |
| The server, not the client, sets a column | `contextValues: { posts: { orgId: (ctx) => ctx.orgId } }` |
| Per-request field permissions | `graphql-shield` / `graphql-middleware` above the schema |

- In a `scope` predicate, build the condition from the `table` argument, not the imported
  table. Relational reads pass Drizzle's aliased copy.
- `scope` filters and never refuses: an out-of-scope update or delete matches nothing and
  returns `[]`. It does not apply to plain inserts, so pair it with `contextValues`.
- `exclude` removes a column from every surface: output, inputs, filters, orderBy and
  aggregates. There is no read-only variant on purpose, because a filterable hidden column
  leaks its values.

**Opt-in features default to off**: `upsert`, `nestedWrites`, `fieldUpdateOperations`,
`countMutations`, `requireWhere` and `uniqueKeyFilters`. Everything else defaults to on.

**Public endpoints need bounds the library does not add for you:**

- `limits: { defaultLimit: 25, maxLimit: 100 }`. With no limit a list query returns every
  row.
- Fields carry `complexity` hints for `graphql-query-complexity`'s
  `fieldExtensionsEstimator`. They do nothing until you install that rule.
- Depth, aliases and tokens are not bounded. Put GraphQL Armor (`maxDepth`, `maxAliases`,
  `costLimit`, `blockFieldSuggestion`) in front, because relation graphs are usually cyclic.

**Errors.** Driver errors become `Internal server error`, and the original stays on
`originalError`. The library's own errors pass through. Use `onError` to log (return
nothing) or to map an error (return a `GraphQLError`).

**Transactions.** By default each mutation field commits on its own.
`transactions: 'auto'` wraps any document with more than one root mutation in one
transaction. It needs a driver that supports `db.transaction()` (not `neon-http`; for
SQLite, only async drivers) and a fresh context object per request.

**Relations.** Root queries load every selected relation in one round trip through
Drizzle's `with:`. To-many fields are `[T!]!`. To-one fields are nullable unless the
relation declares `optional: false`, which is never inferred from column nullability.
Paginated to-many relations and the `distinct` argument need window functions: PostgreSQL,
MySQL 8+ or SQLite 3.25+.

**MySQL differences.** Mutations return a success flag rather than rows. The upsert
conflict branch cannot be scoped.

## Extending the generated schema

- **Override a relation resolver:** first remove it from eager loading with
  `eagerLoadRelations: (table, rel) => !(table === 'users' && rel === 'posts')`, then add
  your resolver (for example `addResolversToSchema` from `@graphql-tools/schema`).
  Otherwise the parent query still fetches the relation you replaced.
- **Write your own resolver that returns a generated type:** use
  `resolveSelection(info, { db, table, where, executor })` to read rows shaped for the
  selection, or `selectionToWith(info, { db, table })` to get just the `with:` tree. If the
  schema used a `typeNameMapper`, pass the same one to both.
- **Middleware, audit and cache code:** use `drizzleExtension(field)` for
  `{ table, kind, operation, single, targetArg, primaryKey }`, and `identifyRows(field, args)`
  for the affected primary keys (check `complete`). Don't parse field names, because
  prefixes, suffixes and mappers change them.
- `extractFilters` and `extractOrderBy` are exported for building Drizzle conditions from
  the generated `where` / `orderBy` arguments.

## Documenting the SDL

Descriptions come from four `buildSchema` hooks: `describeColumn`, `describeTable`,
`describeRelation` and `deprecateColumn`. `describeColumn` receives the built Drizzle
column. `describeTable` receives the Drizzle table (in releases after 15.0.0). So the text
can live next to the schema definition. See [schema-descriptions.md](schema-descriptions.md)
for the pattern, and the trap it avoids.

## Configuration reference

| Key | What it does |
| --- | --- |
| `mutations` | `false` drops the Mutation type |
| `features` | which operations exist, build-wide or per table |
| `exclude` | tables/columns left out entirely |
| `relationsDepthLimit` | how deep relation fields go; `0` = columns only |
| `prefixes` / `suffixes` / `typeNameMapper` | operation and type names |
| `typeNamePrefix` / `typeNameSuffix` / `derivedTypeNameMapper` | names of filters, inputs, aggregates |
| `scalars` / `mapColumnType` | override a column's GraphQL type |
| `enumNameMapper` / `enumValueNameMapper` | enum type and value names (`'constant'` for CONSTANT_CASE) |
| `describeColumn` / `describeTable` / `describeRelation` / `deprecateColumn` | SDL descriptions and deprecations |
| `conflictDoNothing` | PostgreSQL only: `ON CONFLICT DO NOTHING` on insert |
| `complexity` | cost hints; `false` turns them off |
| `transactions` | `'auto'` for multi-mutation atomicity |
| `limits` | default and maximum page size, global or per table |
| `defaults` | per-table default `orderBy` |
| `scope` / `contextValues` / `softDelete` | row scoping, server-owned columns, soft delete |
| `onWrite` | hook that runs inside the mutation's transaction |
| `onError` | error logging and mapping |
| `eagerLoadRelations` | which relations are fetched with the parent query |
