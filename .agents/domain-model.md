# Domain model

This file lives at `.agents/domain-model.md` and describes `@vantreeseba/drizzle-graphql` as the
code on this branch actually behaves, warts included. It is not a design: proposed changes are
tracked as M items in `.agents/coding-standards-todos.md`. Use the terms below, with these
meanings, in code, tests, docs and reviews.

## Purpose

Turn a Drizzle ORM database handle (PostgreSQL, MySQL or SQLite) into a ready-to-serve
`GraphQLSchema` plus the generated pieces (`entities`) a consumer can recompose, with reads,
writes, filters, pagination, aggregates and row policies all compiled to SQL.

## Flow

- **Schema build:** drizzle db + `BuildSchemaConfig` → `buildSchema` (table map from `db._.relations`) → `resolveBuildConfig` (validate, resolve features/limits/defaults/policies/hooks) → dialect dispatch (`generatePG` / `generateMySQL` / `generateSQLite`) → `createSchemaBuilder.prepareBuild` (drop excluded tables, reset per-build registries, relation graph, unique keys, filter context, bound policies, type cache, preflight, nested-write plans, per-table types) → `forEachTable` (read fields + dialect's mutation half → `defineRootField`) → `finalizeBuild` (relation field resolvers, transaction roster, build registry) → `applyErrorMapper` → `new GraphQLSchema` → `{ schema, entities }`.
- **List read:** client `users(where, orderBy, limit, offset, after, distinct, deleted)` → select resolver → `withDefaultOrderBy` → `parseResolveInfo` → `resolveQueryExecutor` → `applyLimitPolicy` → `runRelationalSelect` (cursor entries, distinct subquery, filters + scope, `with:` from `extractRelationsParams`) → `db.query[table].findMany` → `attachRowCursors` → `remapToGraphQLArrayOutput`.
- **Single-row read:** `usersSingle(where, orderBy, offset)` → same path with `single: true` → `findFirst` (PK order by default, no limit policy, no cursor) → `remapToGraphQLSingleOutput` or `null`.
- **Relation field read:** parent row → relation resolver → eager value on the parent? return it : `getOrCreateRequestValue` (args → loader key, per execution) → `getOrCreateLoader` (per execution + key) → next microtask: one `IN`/OR query per chunk, windowed when paginated, scoped + soft-delete filtered → group by parent key → remap.
- **Aggregate read:** `usersAggregate(where, deleted)` / `usersGroupBy(by, having, …)` / `postsAggregate` on a parent → `parseAggregateRequest` → `select(aggregates).from(table)` with filters + scope (grouped / batched by FK for relation aggregates) → `assembleAggregateRow`.
- **Mutation (insert / update / delete / upsert / restore / updateMany / count):** client mutation → `writeResolver` → `runMutation` (pick executor: caller's, request's shared tx, forced tx for hooks, or `db`) → body: validate input → `before` hook → remap input, stamp/strip context values → `scopedWhere` (+ `assertSingleMatch` for `Single`) → statement with `RETURNING` (PG/SQLite) or plain (MySQL) → `after` hook → strip hook-only columns → `withEagerRelations` re-fetch → remap → rows, `{ isSuccess }` (MySQL) or an `Int` (count).
- **Nested write:** create/update/upsert input → `nested.split` (columns vs relation ops) → `writeWithNestedOps` / `updateWithNestedOps` opens a transaction → per entry `writeNestedEntry`: `applyParentSide` (create/connect target first, key into parent) → parent write → `checkParentSide` → `applyChildSide` (attach children / junction rows) → `refreshed` → each nested statement fires the target table's hooks with `payload.nested`.

Dependency direction: `index.ts` → `build-config.ts` → `builders/{pg,sqlite,mysql}.ts` → `schema-data.ts` / `build-context.ts` → `write-resolvers.ts`, `select.ts`, `aggregates.ts`, `nested-writes.ts` → `builders/common/*` → `type-converter`, `data-mappers`, `parse-resolve-info`, `batch-loader`; `selection.ts` sits beside `index.ts` and reads the build through `common/build-registry.ts`.

## Actors

| Actor | Is | Reaches the system through | May change |
|---|---|---|---|
| App author (consumer) | The developer calling `buildSchema` once at startup | `BuildSchemaConfig`, the Drizzle schema + relations, `entities` | Which tables/columns exist (`exclude`), which operations exist (`features`, `mutations`), names (`prefixes`, `suffixes`, `typeNameMapper`, `derivedTypeNameMapper`, `typeNamePrefix/Suffix`, enum mappers), scalars (`scalars`, `mapColumnType`), page bounds (`limits`), default order (`defaults`), cost hints (`complexity`), eager loading, transactions mode, error mapping (`onError`), deprecated `conflictDoNothing` |
| GraphQL client | Whoever sends a document at request time | Generated queries and mutations | Rows only within the scope and soft-delete view; filter/order/page/cursor/distinct/deleted args; nested ops where offered; `hard` delete where opted in; never context-value or soft-delete marker columns |
| Host server | Executes the schema (yoga, apollo, …) | GraphQL `context` object per request (may be reused; per-request state is keyed on the execution) | Which executor runs (`drizzleExecutorKey`) |
| Row policies | Consumer functions run per request | `scope`, `contextValues`, `softDelete` (function form at build) | Which rows a read/write reaches; values stamped on insert |
| Write hooks | Consumer `onWrite` functions | `before` / `after` inside the mutation's executor | Anything via `tx`; can veto by throwing (rolls back when in a transaction) |
| Schema hooks | Consumer `describe*`, `deprecateColumn`, `enumNameMapper`, `enumValueNameMapper`, `mapColumnType`, `derivedTypeNameMapper` | Called at build time | Descriptions, deprecations, type and enum names, column scalars |
| Overriding resolver | Consumer code over generated types | `entities`, `fieldResolvers`, `resolveSelection`, `selectionToWith`, `extensions.drizzle` | Its own reads, reusing the build's policies via the build registry |

## Lifecycles

Write request — owner `common/write-scaffold.ts writeResolver` + `common/transactions.ts runMutation`:
```
received --runMutation, library--> executor chosen (caller tx | shared tx | forced tx when hooked | db)
executor chosen --body validates input, library--> validated        (MySQL insert/update; PG/SQLite insert/upsert/updateMany)
executor chosen --before hook, consumer--> pre-hooked --validate--> validated   (PG/SQLite update, MySQL insertSingle/delete/updateMany)
validated --statement, library--> written --after hook, consumer--> hooked
hooked --withEagerRelations re-fetch, library--> enriched --remap--> answered
any state --throw--> failed --toGraphQLError + onError mapper--> error response (rolled back only if a tx was open)
```

Auto-transaction per execution (`transactions: 'auto'`) — owner `transactions.ts runMutation / openSharedTx / runOnSharedTx`; state keyed by `executionKey`:
```
(no state) --first mutation resolver, ≤1 known root field or unknown field--> passthrough (kept for this execution)
(no state) --first mutation resolver, ≥2 known root fields--> open (tx stashed on context[drizzleExecutorKey], timer armed)
open --field completes, completed < expected--> open (timer re-armed)
open --last field completes--> committed (state deleted, executor key removed)
open --field throws | inactivity timeout--> aborted --later fields--> fail fast DRIZZLE_TRANSACTION_ABORTED
aborted --rollback settles--> rolled back (state kept for this execution so its stragglers keep failing)
```
The next execution starts with no state, even on a reused context object or a cached document.

Batch loader — owner `batch-loader/index.ts BatchLoader`, created by `getOrCreateLoader`:
```
idle --load(key), resolver--> queued --microtask--> dispatching --batchFn resolves--> idle (all callers resolved)
dispatching --batchFn throws--> idle (all callers rejected)
```
Loaders live in a weak map keyed by the execution (`executionKey`) for its whole length; there is no result cache, only batching. `getOrCreateRequestValue` memoizes per-field derived values (args → loader key) keyed by the execution, then the field's AST nodes, so a reused context or cached document never serves one execution another's args.

Cursor — owner `common/cursor.ts`:
```
row read --attachRowCursors (ordering + PK values, base64url JSON)--> issued
issued --client passes as `after`, same orderBy--> decoded --buildCursorCondition--> next page
issued --client passes with different ordering | distinct | table without PK--> rejected DRIZZLE_INVALID_CURSOR
```

Soft-deleted row — owner `write-resolvers.ts generateDelete` + `policies.ts softDeletePredicate`:
```
live --delete, client--> marked --restore, client--> live
live | marked --delete(hard: true), client, opted-in table--> gone
```

Nested entry — owner `nested-writes.ts writeNestedEntry`:
```
pending --applyParentSide--> parent-keyed --parent write--> written --checkParentSide--> checked --applyChildSide--> attached --refreshed--> done
parent-keyed --parent write returns no row (savepoint)--> rolled back, entry yields []
```

Per-build registries — owner `build-context.ts prepareBuild`:
```
(previous build's state) --registerScalarOverrides / registerEnumConfig / registerColumnExclusions / resetAggregateColumnCache--> this build's state --next buildSchema--> overwritten
```

## Invariants

| Invariant | Enforced by |
|---|---|
| A table's scope and soft-delete predicate are ANDed after the client's `where`, so a client can only narrow them | `policies.withScope`, `mutation-helpers.scopedWhere`, `select-runtime.runRelationalSelect` |
| Soft-delete predicate comes before the scope predicate in the SQL | `policies.resolveScope` (`on`) |
| A scope hook returns SQL, a filter object or nothing | `policies.resolveScope` (`DRIZZLE_INVALID_SCOPE`) |
| Inserts stamp every `contextValues` column (and a NOT NULL soft-delete marker's restored value) | `policies.insertStamps`, `policies.applyContextValues` |
| Updates never write a `contextValues` column | `policies.stripContextValues` |
| A `Single` update/delete is refused before writing if its `where` matches more than one row | `mutation-helpers.assertSingleMatch` |
| `Single` writes and `requireWhere` writes refuse a `where` that matches every row (`{}`, `notInArray: []`, `NOT: { inArray: [] }`) | `mutation-helpers.extractRequiredFilters` (`DRIZZLE_WHERE_REQUIRED`) |
| An update must write a column or carry nested ops | `write-resolvers.generateUpdate`, `update-many.createUpdateManyGenerator`, `mysql.ts` update |
| A field-update input carries exactly one operation | `field-updates.remapUpdateInput` |
| A limit above `maxLimit` is rejected (or clamped when `clampToMax`); a negative limit/offset is rejected | `limits.applyLimitPolicy`, `limits.assertPagingNotNegative` |
| Two generated root fields never share a name | `root-fields.defineRootField` |
| List and single suffixes differ unless a `typeNameMapper` is set | `build-config.resolveBuildConfig` |
| Every table/column name in `exclude`, `scope`, `contextValues`, `softDelete`, `defaults`, `onWrite` exists | `build-config.resolveBuildConfig` |
| A default ordering never uses an excluded or unorderable column | `build-config.resolveBuildConfig` |
| Excluded tables generate nothing and no relation points at them | `build-context.prepareBuild` |
| A field with an `onWrite` hook runs in a transaction | `write-scaffold.writeResolver` → `transactions.runMutation(forceTx)` |
| A caller-supplied executor is used as-is; the library never nests its own shared tx in it | `transactions.runMutation` |
| After a failure in the shared tx, later mutation fields do not run | `transactions.runOnSharedTx` |
| `hard` only purges on a soft-delete table that opted in | `write-resolvers.generateDelete`, `mutation-helpers.generateWriteCount` |
| `after` cannot combine with `distinct`; cursors need a primary key and a cursor-expressible ordering | `select-runtime.runRelationalSelect` |
| A nested to-one `connect` matches exactly one row | `nested-writes.createNestedWriteRuntime` (`connectMatchError`) |
| Nested writes are rejected on MySQL; nested writes, `transactions: 'auto'` and `onWrite` are rejected on a sync SQLite driver | `mysql.ts` / `sqlite.ts` `preflight` |
| Two enum columns mapped to one name must have the same values | `type-converter.generateEnumCached` |
| An error the library did not raise reaches the client as `Internal server error` (unless `onError` says otherwise) | `errors.defaultErrorMapper` via `errors.applyErrorMapper` |
| An empty Mutation type is omitted | `index.buildSchema` |

### Claimed but not enforced (findings)

- `DRIZZLE_MULTI_ROW_MATCH` is documented as "so nothing was written" (`src/util/builders/common/errors.ts:13`), but the post-write re-check throws after the update/delete already ran (`src/util/builders/write-resolvers.ts:517-518`, `:628-629`); it is only undone when a transaction happens to be open.
- `BuildSchemaConfig.features` says every flag defaults to `true` except `upsert` and `nestedWrites` (`src/types.ts:1280`); five more are off (`src/util/features.ts` `featureDefaults`, and `types.ts:764` says so).
- `updateMany`'s result is described as "aligned with the input, one slot per entry" (`schema-data.ts:352`), yet a multi-row entry contributes several slots (`update-many.ts` output loop), so slots no longer map to entries.
- The eager re-fetch says "the write has already committed" (`common/select-runtime.ts:353`); under a hook-forced, nested or shared transaction it has not.
- `transactions: 'auto'` says two executions must not share one context object at the same time (`types.ts` `transactions`); nothing checks it, and the second would find the first's transaction under `drizzleExecutorKey` and run on it.
- AGENTS.md's dispatch snippet names `MySqlDatabase` / `BaseSQLiteDatabase` (`AGENTS.md:309-310`) and calls `common.ts` "shared helpers (extractFilters, extractOrderBy)" (`AGENTS.md:18`); the code dispatches on `MySqlAsyncDatabase` first and PG/SQLite share `schema-data.ts` + `build-context.ts`.
- `WriteHookFor` takes the operation (`common/write-hooks.ts` `WriteHookFor`), but the resolved lookup ignores it (`build-config.ts:330-331`): hooks are per table, not per operation.

## Glossary

### Schema build

- **Build (buildSchema call):** One call that turns a database handle and a config into a schema; done once at startup. Owner: `src/index.ts buildSchema`; internally `generateSchemaData`, `prepareBuild`/`forEachTable`/`finalizeBuild`.
- **Config (BuildSchemaConfig, options):** Everything the app author can say about the generated schema. Owner: `src/types.ts BuildSchemaConfig`; resolved into `SchemaGeneratorOptions` by `build-config.resolveBuildConfig` (code says "options" or "generatorOptions").
- **Entities (generated data):** The parts of the schema handed back separately — queries, mutations, inputs, types, relation field resolvers — for composing your own schema. Owner: `GeneratedEntities`; the code also calls the output `generatorOutput`, and `types` is `ctx.outputs` renamed.
- **Feature (feature switch, feature flag):** An on/off choice per operation family, globally or per table. Owner: `src/util/features.ts resolveTableFeatures`; `TableFeatures`, `featureOf`, `anyTable`.
- **Exclusion (exclude):** A table or column kept out of every schema surface. Owner: `common/exclusions.ts visibleColumns`; `registerColumnExclusions`.
- **Naming (field names, type names):** How tables become query, mutation and type names. Owner: `common/resolver-names.ts computeResolverFieldNames`, `common/type-names.ts resolveGeneratedTypeNames`; spread across `typeNameMapper`, `TypeNameResolver`/`resolveName`/`cacheCtx.typeName`, `resolveObjectTypeName`, `applyObjectTypeName`.
- **Field identity (extensions.drizzle):** A stable tag on each generated field and type saying what it is (table, operation, single, target arg). Owner: `src/util/extensions.ts tableFieldExtensions`, `drizzleExtension`; meta type `DrizzleMutationMeta`.
- **Cost hint (complexity):** Per-field price for query-complexity tools. Owner: `common/limits.ts listFieldComplexity`, `aggregateFieldComplexity`.

### Tables & columns

- **Table (table key, tableName):** A Drizzle table, always named by its key in the schema object, not its SQL name. Owner: `build-context.ts` (`tables`, `tableEntries`); `tableName` everywhere means the schema key.
- **Object type (row type):** The GraphQL type a table's rows read as. Owner: `common/table-types.ts generateTableTypes`; `selectSingleOutput`, `selectArrOutput`.
- **Item type (`${Table}Item`):** The row type a PG/SQLite mutation returns; MySQL has none. Owner: `generateTableTypes`; `singleTableItemOutput`, `arrTableItemOutput`.
- **Scalar mapping (scalar override):** Which GraphQL scalar a column uses, built-in or overridden. Owner: `type-converter/index.ts drizzleColumnToGraphQLType`, `registerScalarOverrides`.
- **Enum type:** A GraphQL enum for an enum column, shared per named `pgEnum`. Owner: `type-converter/index.ts generateEnumCached`.
- **Value mapping (remap):** Converting values between database form and GraphQL form, both ways. Owner: `src/util/data-mappers/index.ts` (`remapToGraphQL*`, `remapFromGraphQL*`).
- **Primary key (pkNames):** The columns identifying a row, composite-aware; also the default order and cursor tiebreak. Owner: `common/keys.ts getPrimaryKeyPropNamesFromConfig`; `primaryKeyPropNames`, `pkNames`, `targetPkNames`.

### Reads

- **List query (`<table>`):** Reads many rows. Owner: `select.ts generateSelectArray`.
- **Single query (`<table>Single`):** Reads the first matching row or null. Owner: `select.ts generateSelectSingle`.
- **Selection:** The fields a request asked for, which decide the columns and relations fetched. Owner: `parse-resolve-info.ts parseResolveInfo`, `common/selected-columns.ts`; `ResolveTree`, `parsedInfo`, `fieldsByTypeName`.
- **Executor (drizzleExecutorKey):** The connection or transaction a resolver runs on; a caller may supply one on the context. Owner: `common/executor.ts resolveExecutor`.
- **Distinct:** Keep one row per combination of chosen columns. Owner: `common/distinct.ts distinctRowsCondition`.
- **Selection helpers (resolveSelection, selectionToWith):** Run a generated-style read from your own resolver, with the build's policies. Owner: `src/util/selection.ts`; finds the build via `common/build-registry.ts`.

### Filters & ordering

- **Filter (where, Filters input):** The `where` argument: column operators, `AND`/`OR`/`NOT`, relation keys. Owner: `common/relation-filters.ts extractFilters`, `common/filters.ts`; also `tableFilters`, `filterArgs`.
- **Matches every row:** A filter that restricts nothing, such as `{}`, `notInArray: []` or `NOT: { inArray: [] }`, so a read adds no condition for it and a write that requires a `where` rejects it. Owner: `common/filters.ts MATCHES_EVERY_ROW` (`CompiledFilter`), folded by `compileBooleanBranches` and `allOf`.
- **Operator filter (`StringFilter`, …):** The per-scalar set of operators a column gets. Owner: `common/column-filters.ts`.
- **Relation filter (some / none / every):** Filtering rows by their related rows. Owner: `common/relation-filters.ts`; `RelationFilterBase`, `filterCtx`.
- **Unique-key filter:** One `where` field per compound unique constraint. Owner: `common/unique-keys.ts buildUniqueKeyMap`.
- **Order (orderBy):** Sort entries with direction, priority and nulls, including via a to-one relation. Owner: `common/order-by.ts extractOrderBy`; `tableOrder`, `orderArgs`.
- **Default order (defaults.orderBy):** The order a read uses when the request gives none. Owner: `limits.ts withDefaultOrderBy`; `defaultOrderBy` policy.

### Pagination

- **Limit / offset:** Page size and skip. Owner: `limits.ts effectiveOffset`, `offsetOnlyLimit`.
- **Limit policy (limits):** Default and maximum page size per table. Owner: `limits.ts applyLimitPolicy`, `resolveLimitPolicy`; `LimitPolicyFor`.
- **Cursor (after):** An opaque token for "rows after this one" under the same ordering. Owner: `common/cursor.ts encodeCursor`, `decodeCursor`, `buildCursorCondition`; `CursorOrderEntry`.

### Relations

- **Relation:** A named link from one table to another, from Drizzle's relations config. Owner: `common/relations.ts buildNamedRelations`; `namedRelations`, `TableNamedRelations`, `relEntry`.
- **To-one / to-many:** Whether a relation yields a row or a list. Owner: `is(relation, One)`; `isOne`.
- **Junction (through, many-to-many):** A middle table linking two tables. Owner: `relations.ts extractJunctionColumns`; `NestedThroughPlan`, `junctionPolicy`.
- **Relation's own where:** A filter declared on the relation itself, applied on every read and write through it. Owner: `relations.ts relationOwnCondition`, `relationOwnWhere`.
- **Eager loading (with:):** Fetching selected relations in the parent's query. Owner: `common/relation-params.ts extractRelationsParams`, `pruneNonEagerRelations`; `eagerRelations`, `shouldEagerLoad`.
- **Relation resolver (field resolver):** The resolver on each relation field, returning the eager value or a batched load. Owner: `common/relation-resolvers.ts createRelationResolverFactory`; exported as `entities.fieldResolvers`.
- **Mutation re-fetch:** Reloading written rows by key to eager-load their selected relations. Owner: `select-runtime.ts eagerLoadMutationRelations`, `withEagerRelations`.

### Aggregates

- **Aggregate (`<plural>Aggregate`):** Count, sum, avg, min, max over the matching rows. Owner: `aggregates.ts generateAggregate`, `generateAggregateTypes`.
- **Group by (`<plural>GroupBy`, having):** Aggregates per group of column values, filtered by `having`. Owner: `aggregates.ts generateGroupBy`, `generateHavingInput`.
- **Relation aggregate (`<relation>Aggregate`):** An aggregate of a parent's to-many related rows. Owner: `aggregates.ts createRelationAggregateFactory`.

### Writes

- **Mutation (write):** A generated field that changes rows. Owner: `common/write-scaffold.ts writeResolver`; `WriteOperation`.
- **Insert (create):** Adds rows. Owner: `write-resolvers.ts generateInsert`; MySQL `generateInsertArray`/`generateInsertSingle`; prefix `create`.
- **Update:** Changes matching rows' columns. Owner: `write-resolvers.ts generateUpdate`.
- **Update many (updateMany):** Several `where`/`set` entries in one transaction. Owner: `update-many.ts createUpdateManyGenerator`; dialect `UpdateManyBatchRunner`.
- **Delete:** Removes (or soft-marks) matching rows. Owner: `write-resolvers.ts generateDelete`.
- **Count mutation:** An update or delete that answers how many rows instead of the rows. Owner: `mutation-helpers.ts generateWriteCount`.
- **Upsert (onConflict):** Insert, or on a key conflict update or do nothing. Owner: `write-resolvers.ts generateUpsert`, `common/conflict.ts resolveConflictPlan`; `ConflictPlan`, deprecated `conflictDoNothing`.
- **Field update operation (increment, push):** Change a column relative to its current value. Owner: `field-updates.ts remapUpdateInput`, `fieldUpdateInputType`.
- **Single write (`…Single`):** A write meant to touch exactly one row. Owner: `assertSingleMatch`; the `single` flag.
- **Require where (requireWhere):** No unbounded update or delete. Owner: `extractRequiredFilters`.
- **Returnless result (isSuccess):** What every MySQL mutation answers. Owner: `mysql.ts isSuccess`; `MutationReturnlessResult`.

### Nested writes

- **Nested write (nested op):** Writing related rows through a relation field of a create/update/upsert input. Owner: `nested-writes.ts`; ops `create`, `connect`, `disconnect`, `set` (`NestedWriteOp`).
- **Nested plan:** Build-time decision of which ops a relation offers and which side holds the key. Owner: `buildNestedWritePlans`, `gateNestedWritePlans`; `NestedRelationPlan`, `fkSide` (`child` / `parent`).
- **Parent side / child side:** Ops that must run before the parent row (key lives on parent) versus after it (key lives on the child). Owner: `NestedWriteRuntime.applyParentSide`, `applyChildSide`.

### Policies & hooks

- **Row scope (scope):** A per-table, per-request predicate every read and write is confined to. Owner: config `ScopeFor`; compiled by `policies.resolveScope`. Homonym: `ScopeResolver` bundles scope *and* soft delete, and `SoftDeleteColumn.scope` means something else (see below).
- **Context value (server-owned column):** A column the server fills from the request context, absent from inputs. Owner: `policies.ts applyContextValues`, `stripContextValues`; `ContextValuesFor`.
- **Soft delete (marker column):** Delete by marking a column; reads hide marked rows. Owner: `policies.ts resolveSoftDeleteInfo`, `softDeletePredicate`; `SoftDeleteInfo`.
- **Deleted view (deleted: EXCLUDE / INCLUDE / ONLY):** Which marked rows a read returns. Owner: `DeletedMode`, enum `DeletedFilter`; `relationDeletedDefault` uses `SoftDeleteColumn.scope` (`'root'`/`'all'`).
- **Restore:** Un-marks soft-deleted rows. Owner: `generateDelete({ restore: true })`; prefix `restore`.
- **Hard delete (hard):** A real `DELETE` on a soft-delete table that opted in. Owner: `hardDeleteArg`.
- **Policies:** The bundle of scope, context values, soft delete, hooks and default order for a build. Owner: `policies.ts TablePolicies` (unbound) and `ResolverPolicies` (scope bound per context) — two shapes of one concept, see `bindPolicies`.
- **Write hook (onWrite, before / after):** Consumer code run around a write on the same executor. Owner: `common/write-hooks.ts normalizeWriteHooks`, `runWriteHook`; `WriteHookPayload`, hook `columns`.
- **Auto transaction (transactions: 'auto'):** One transaction for a document with several mutation fields. Owner: `transactions.ts runMutation`; `MutationTxCtx`, shared tx.
- **Error mapping (onError):** What a thrown error becomes before the client sees it. Owner: `common/errors.ts applyErrorMapper`, `defaultErrorMapper`, `drizzleError`; `DrizzleErrorCode`.

### Dialects

- **Dialect:** PostgreSQL, MySQL or SQLite; picked from the handle's class. Owner: `index.ts` dispatch; `selection.ts tableConfigFor` repeats it.
- **Dialect adapter:** What a dialect supplies to the shared build: table class, table config, PK lookup, null ordering, whether writes return rows, preflight. Owner: `build-context.ts SchemaBuildAdapter`, `schema-data.ts DialectSchemaAdapter`.
- **Null ordering:** Whether the database sorts NULLs first or last, which cursors must match. Owner: `cursor.ts NullOrdering`.
- **Preflight:** Build-time refusal of options a dialect/driver cannot honour. Owner: `SchemaBuildAdapter.preflight` in `mysql.ts`, `sqlite.ts`.
- **Sync driver:** A SQLite driver whose transaction commits when its callback returns. Owner: implicit — `db.resultKind === 'sync'` in `sqlite.ts`, plus `.then` probes in `sqlite.ts` and `write-resolvers.ts`.

### Internals

- **Build context:** Everything a build accumulates before its root fields exist. Owner: `build-context.ts SchemaBuildContext`.
- **Type cache:** Per-build caches so each generated type is built once. Owner: `common/type-cache.ts TypeCacheCtx`; plus module-level caches (`sharedType`, `field-updates.ts` `kindCache`/`inputCache`, `table-inputs.ts orderMap`).
- **Per-build registry:** Module-global state reset at the start of each build (scalar overrides, enums, exclusions, aggregate column sets). Owner: `registerScalarOverrides`, `registerEnumConfig`, `registerColumnExclusions`, `resetAggregateColumnCache`.
- **Build registry:** Maps generated types and db handles back to the build that made them, for the selection helpers. Owner: `common/build-registry.ts registerBuildRuntime`, `runtimeForType`, `runtimeForDb`.
- **Execution:** One run of a GraphQL document (one `execute()` call); per-request state — the request cache, batch loaders and auto-transaction — belongs to it, not to the context object. Owner: `src/util/execution.ts executionKey` (`info.variableValues`, which graphql builds once per execution).
- **Request cache:** Per-execution memo of a field's derived values. Owner: `batch-loader/index.ts getOrCreateRequestValue`.
- **Batch loader:** Per-execution batching of sibling relation loads. Owner: `batch-loader/index.ts getOrCreateLoader`.
- **Mutation registration:** A dialect's generated mutation plus its return type and identity, registered by the shared loop. Owner: `build-context.ts MutationRegistration`.
- **Variables reader:** Reads variables and fragment arguments the same way under graphql 16 and 17. Owner: `src/util/graphql-variables.ts`.

## Explain test

An app author runs a build over a Drizzle handle with a config; features, exclusions and naming decide which tables get an object type, list and single queries, aggregates, group by and relation aggregates, and which mutations (insert, update, update many, delete, restore, count mutations, upsert) exist, and the dialect adapter's preflight refuses what the dialect cannot do. At request time a GraphQL client sends a filter, order, limit/offset or cursor, distinct and deleted view; the resolver picks an executor, applies the limit policy and default order, ANDs the soft-delete predicate and row scope after the filter, and eager-loads the selection's relations, while any relation it did not load is served by the relation resolver through the request's batch loader. A mutation runs inside the write scaffold: the auto transaction or a hook-forced transaction holds it, write hooks run before and after, context values are stamped on inserts and stripped from updates, a single write checks that one row matches, nested writes run their parent-side and child-side ops from the nested plan, and the result is the item type re-fetched with its relations (or a returnless result on MySQL). Anything thrown passes through error mapping, and every generated field carries its field identity so wrappers and the selection helpers can find the build again through the build registry.
