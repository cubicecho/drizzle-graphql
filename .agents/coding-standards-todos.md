# Coding standards ledger

Findings from the `coding-standards` skill's refactor workflow. This file lives at
`.agents/coding-standards-todos.md`. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

Pass 1 (2026-10-27): correctness review of `main` @ 884aa15 (17.0.2). Baseline: `biome ci`
clean, `npm run typecheck` clean, full suite green (2390 tests; Docker available). Every `B`
item marked CONFIRMED has a failing repro; the repro sources live outside the repo, in the
session scratchpad (`repro/`, `reads-rev/repros/`, `filters-review/src/`,
`zz-build-reviewer/src/`, `review-nested/`), because `tests/globalSetup.ts` deletes
`tests/.temp` on every run. Each fix turns its repro into a regression test in `tests/`.

## Summary

| Prefix | Kind |
|---|---|
| `M` | Model change: a change to `.agents/domain-model.md`, made true by the items that implement it |
| `B` | Bug, or near copies that behave differently |
| `D` | Comment or doc that no longer matches the code |

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| M1 | Model change | Name "writable column": one owner decides which columns a create, update or upsert input may carry | B7 has one place to land; inputs stop drifting apart | — | done |
| M2 | Model change | Name "matches every row" as a filter result instead of an opaque `true` SQL | `requireWhere` can see it (B4) | — | done |
| M3 | Model change | Per-request state is keyed on the execution, not on the context object alone | B12 and B22 fixed at the cause | — | done |
| B7 | Bug | Drop generated and identity-ALWAYS columns from create/update/upsert inputs and field updates | Creates stop demanding a value the DB ignores; updates stop failing in the DB | M1 | done |
| B4 | Bug | Make `requireWhere` reject filters that match every row, such as `notInArray: []` | An empty variable list can no longer update or delete a whole table | M2 | done |
| B12 | Bug | Key the per-request field memo on the execution, so a reused context with new variables gets fresh relation args | Stops a cached document returning the previous request's filtered rows | M3 | done |
| B22 | Bug | Clear auto-transaction state once a request's fields finish, and refuse it for non-object contexts | A reused context keeps getting transactions; no shared state across requests | M3 | done |
| B1 | Bug | On Postgres, stop swallowing a failed relation reload after a write inside a transaction | A mutation that reports success can no longer be silently rolled back | — | done |
| B2 | Bug | Alias every column in the paginated many-to-many subquery | Stops rows grouping under the wrong parent (SQLite) or erroring (PG/MySQL) | — | done |
| B3 | Bug | Run `…Single` update/delete so a multi-row match never commits | "Matched more than one row" really means nothing was written | — | done |
| B5 | Bug | Treat an explicit `null` nested op (`create: null`) as absent everywhere | No blank rows, no replaced relations, no internal errors | — | done |
| B6 | Bug | Refuse a to-one nested attach when a NOT NULL, non-unique FK already has a different row attached | A to-one relation can no longer end up with two rows, or steal another parent's row | — | done |
| B8 | Bug | Type MySQL unsigned `int` and `serial` as `Float` instead of 32-bit `Int` | Values above 2^31 read and write | — | done |
| B9 | Bug | Compare MySQL `float` cursor and `eq` operands at single precision | Cursor walks end; `eq` matches the value just read | — | done |
| B10 | Bug | Encode `NaN`/`±Infinity` in cursors instead of letting them become NULL | Postgres walks over float columns stop dropping rows | — | done |
| B11 | Bug (question) | Decide whether `every` should fail a related row whose compared column is NULL | Either fixes the SQL or documents the caveat | — | done |
| B14 | Bug | Type `bigint({ mode: 'string' })` as `BigIntString`, with number filters | Consistent bigint typing; no SQL errors from `like` on a bigint | — | done |
| B15 | Bug | Type MySQL unsigned `decimal` as `Decimal` like the signed one | Same validation and filters for both | — | done |
| B16 | Bug | Let Postgres array elements be null in output types | A `{1,NULL,3}` value reads instead of erroring the field or row | — | done |
| B13 | Bug | Stop the field-update kind cache outliving a build | A later build's scalar override is respected | — | done |
| B17 | Bug | Detect relation `orderBy` hops correctly when the target table has a `direction` column | Internal errors become the right result or error | — | done |
| B18 | Bug | Round `lt`/`gte` operands up on SQLite second-precision timestamps | Fractional-second bounds return the right rows | — | done |
| B19 | Bug (question) | Pick one rule for JSON `path` `as: NUMBER/BOOLEAN` on string values, across dialects | Same query, same rows on every dialect | — | done |
| B20 | Bug | A relation field's `cursor` under `matchFilterOrder` resolves to null like the root list | Internal error becomes null | — | done |
| B21 | Bug | Validate decoded cursor values; reject bad ones as `DRIZZLE_INVALID_CURSOR` | Forged cursors stop causing internal errors or silent empty pages | — | done |
| B23 | Bug (question) | Run the `before` hook at the same point (before or after input validation) on every write path | A rejected write fires the hook on all paths or on none | — | done |
| D1 | Docs | Fix docs that disagree with code: feature defaults, `updateMany` slots, "already committed", stale AGENTS.md lines | Docs match code | B1, B3 | done |
| D2 | Docs | Document the `every` + NULL caveat in the README if B11 keeps the behaviour | Users are told | B11 | declined (B11 was fixed instead) |
| B24 | Bug · low value | Stop remapping write args in place (hooks see remapped args; a shared variable is remapped twice) (unverified) | Hooks see what the docs promise | — | open (confirmed: hooks see converted args; a variable shared by two fields fails the second) |
| B25 | Bug · low value | Add `PgSparseVector` to the no-min/max column list (unverified: no pgvector in PGlite) | No SQL error from `min(sparsevec)` | — | done |
| B26 | Bug · low value | Gate the junction restore UPDATE on the junction's `update` feature | Feature switch honoured | — | done |
| B27 | Bug · low value | Match nested `refreshed` rows by `keyString`, not `String()` (unverified) | Timestamp keys under 1s apart stay distinct | — | done |
| B28 | Bug · low value | `resolveSelection` fallback: derive null ordering from the dialect (unverified) | Correct cursors in the multi-build fallback | — | deferred |
| B29 | Bug · low value | `matchFilterOrder` + `insensitive` ranks case-insensitive matches as "not in list" (unverified) | Correct order | — | done |

Status is `open`, `approved`, `declined`, `waiting on decision` or `done`.

Implemented on branch `fix/correctness-pass`, one commit per item (`Ledger: <ID>` in each body).

Follow-ups found while fixing:

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| B30 | Bug | Close the `…Single` race on MySQL and sync SQLite | B3 holds on every dialect | — | done (in B3) |
| B32 | Bug | Check a decoded cursor value fits its column's type (B21 checks only that it is well formed) | Cleaner `DRIZZLE_INVALID_CURSOR` | — | open |
| B34 | Bug (question) | Root `restore` mutations are generated for every soft-deleting table, ignoring feature flags (unverified) | Feature switches honoured | — | open |
| B33 | Bug (question) | Postgres array *inputs* still require non-null elements (`[T!]`); B16 relaxed only outputs | Your call | — | waiting on decision |

## Model changes

### M1 — name: writable column

As-is: `table-types.ts` builds the insert/update inputs by dropping context-value columns and
the soft-delete marker inline; `field-updates.ts` and `conflict.ts` decide their own column
sets; nothing reads `column.generated` / `generatedIdentity`. To-be: a **writable column** is
a column a client may set on create (and, separately, on update); one function owns both
answers and every input and field-update builder uses it. Why it is simpler: one rule for
four inputs instead of four partial copies. Implemented by: B7. Status: open.

### M2 — name: matches every row

As-is: empty `notInArray`, `NOT inArray: []` and similar compile to `sqlTrue()`, which is
indistinguishable from a real condition; `extractRequiredFilters` only rejects "no
condition". To-be: the filter compiler returns a distinct **matches every row** result;
reads treat it as no condition, `requireWhere` rejects it. Implemented by: B4. Status: open.

### M3 — introduce a scope: execution

As-is: the request memo (`getOrCreateRequestValue`) and auto-transaction state hang off the
context object (or `info.operation` when the context isn't an object), so a reused context
or a cached document shares state across executions. To-be: an **execution** (one
`execute()` call, identified by `info.variableValues` / the operation per run) owns
per-request state. Implemented by: B12, B22. Status: open.

---

## Conventions

- Failures throw a `drizzleError` with a `DRIZZLE_*` code and a teaching message (`common/errors.ts`).
- Relation join columns are read only through `relationColumns` / `unwrapRelationColumn`.
- Every RQB config goes through `omitUndefinedKeys`.
- Regression tests: PGlite in `tests/pglite/`, SQLite in `tests/sqlite-*.test.ts`, MySQL-only in `tests/mysql-*.test.ts`.
- Commits: Conventional Commits, no `Co-Authored-By` trailer (AGENTS.md).

---

## Bugs

### B1 — PG: failed eager re-fetch after a write is swallowed, then the transaction rolls back silently (HIGH)

**File:** `src/util/builders/common/select-runtime.ts:345-362` (`eagerLoadMutationRelations`),
reached from `common/mutation-helpers.ts:159` by insert, upsert, update and updateMany. The
catch assumes the write committed. Inside a transaction (auto, hook-forced, caller's), the
failed statement aborts the PG transaction, the resolver returns success, and COMMIT becomes
ROLLBACK. Repro: `articles(where: { price: { eq: "1e200000" } })` on the returned row.
CONFIRMED (`repro/eager-abort.test.ts`). Fix: run the re-fetch in a savepoint when the
executor is a transaction, or rethrow there.

### B2 — Lazy paginated many-to-many: subquery columns collide by DB name (HIGH)

**File:** `src/util/builders/common/relation-resolvers.ts:92-111`, `:413-415`. The window
subquery selects unaliased columns; with `Posts.user_id` and `Likes.user_id` the outer select
picks the wrong one. SQLite groups liked posts under the author instead of the liker (rows
leak across parents); PG errors (ambiguous column); MySQL errors (duplicate column, reasoned).
Reached on default eager builds too (two aliases, junction scope + `defaultLimit`, cursor).
CONFIRMED (`reads-rev/repros/junction-name-clash*.test.ts`). Fix: alias every subquery entry to
its key (generalise `subquerySafeSelection`).

### B3 — `…Single` update/delete commits a multi-row write, then errors

Done: the check reads the matched row's primary key and the write is narrowed to it, on every dialect and driver. A first version forced a transaction instead, which on libsql `:memory:` swaps to a fresh empty database, so it was replaced. Tables without a primary key keep the old race.

**File:** `src/util/builders/write-resolvers.ts:516-519`, `:627-630`. Probe, write, re-check;
on bare `db` a row arriving between probe and write is changed and committed, yet the client
gets `DRIZZLE_MULTI_ROW_MATCH` ("nothing was written"). MySQL has only the probe and reports
success. CONFIRMED for update and delete (`repro/single-race.test.ts`). Fix: force a
transaction for Single writes, or narrow the statement to the key the probe found.

### B4 — `requireWhere` lets constant-true filters through

**File:** `src/util/builders/common/mutation-helpers.ts:207`, `common/filters.ts` `sqlTrue()`.
`deleteItems(where:{id:{notInArray:[]}})` deletes every row under `requireWhere`.
CONFIRMED (`filters-review/src/sqlite-a.test.ts`). Implements: M2.

### B5 — Nested ops: explicit `null` operand is treated as one operand

**File:** `src/util/builders/nested-writes.ts:1191-1206`, `1219-1220`, `1603-1682`, `1800`,
`1828`. `!== undefined` + `asArray(null) → [null]`, while the one-op check uses `supplied()`.
`create: null` inserts a blank row; to-one `create: null` replaces the attached row;
`{create: null, connect}` inserts a blank parent-side row and drops the connect;
`connect/set/disconnect: null` crash as Internal server error. CONFIRMED
(`review-nested/null-operands.test.ts`). Fix: drop null op keys once in `split`.

### B6 — Nested to-one child side with NOT NULL non-unique FK attaches a second row

**File:** `src/util/builders/nested-writes.ts:498-526`, `1648-1653`. `canDetach` is false, so
the detach is skipped; `connect` steals another parent's row and `create` adds a second.
CONFIRMED (`review-nested/null-operands.test.ts`, last two cases). Fix: refuse with
`DRIZZLE_NESTED_WRITE_INVALID` when a different row is attached, or plan such relations only
when the FK is unique. Question: which of the two?

### B7 — Generated and identity-ALWAYS columns appear in write inputs

**File:** `src/util/builders/common/table-types.ts:287-336`. SQLite generated `notNull` column
is `String!` on create (value silently dropped) and offered on update (DB error). PG identity
ALWAYS: create ignores the value, update errors. CONFIRMED
(`zz-build-reviewer/src/generated-columns.test.ts`). Schema change: fields leave input types.
Implements: M1.

### B8 — MySQL unsigned `int` / `serial` typed as GraphQL `Int`

**File:** `src/util/type-converter/index.ts:437-445`. Values above 2^31 fail to read or write.
CONFIRMED on real MySQL (`mysql-unsigned-int.test.ts`, `mysql-schema-types.test.ts`).
Schema change: `Int` → `Float` on these columns.

### B9 — MySQL `float`: cursor walk never ends; `eq` misses the value read back

**File:** `src/util/builders/common/cursor.ts` (`buildCursorCondition`), `common/filters.ts`.
Bound doubles compare against single-precision storage. CONFIRMED on real MySQL
(`filters-review/src/mysql-a.test.ts`). Fix: bind as `cast(? as float)` or read the column as
double into the cursor.

### B10 — PG `NaN` / `±Infinity` become NULL in cursors

**File:** `src/util/builders/common/cursor.ts` `encodeCursorValue`. `JSON.stringify` turns them
into `null`; a walk ended after 4 of 6 rows with no error. CONFIRMED
(`filters-review/src/pglite-a.test.ts`). Fix: tag non-finite numbers like dates and bigints.

### B11 — `every` passes a related row whose compared column is NULL (question)

**File:** `src/util/builders/common/relation-filters.ts` `buildRelationExists`. `NOT (NULL = x)`
is NULL. The code comment accepts this as Prisma's caveat; the README does not mention it.
CONFIRMED (`sqlite-a.test.ts`). Question: fix with `coalesce(inner, false)`, or keep and
document (D2)?

### B12 — Per-request memo reuses the first execution's relation args

**File:** `src/util/batch-loader/index.ts:78-112`, used at `relation-resolvers.ts:266`,
`aggregates.ts:651`. Keyed on context + AST nodes, not variables. Same context object + cached
document + new variables → previous rows. CONFIRMED (`reads-rev/repros/aliases.test.ts`).
Implements: M3.

### B13 — Field-update kind cache outlives a build

**File:** `src/util/builders/field-updates.ts:60-88`. Module-level `WeakMap` by Column; the
scalar-override registry it reads is reset per build. CONFIRMED (`repro/kind-cache.test.ts`).
Fix: reset with the other per-build registries.

### B14 — `bigint({ mode: 'string' })` typed `String`

**File:** `src/util/type-converter/index.ts:406-429`. Gets `StringFilter`; `like` fails on PG.
CONFIRMED (`pg-column-types.test.ts`, `mysql-schema-types.test.ts`). Schema change.

### B15 — MySQL unsigned `decimal` typed `String`

**File:** `src/util/type-converter/index.ts:415` (`'numeric'` only, not `'unumeric'`).
CONFIRMED (`mysql-schema-types.test.ts`). Schema change.

### B16 — PG array elements declared non-null

**File:** `src/util/type-converter/index.ts:357-363`. `{1,NULL,3}` errors the field.
CONFIRMED (`pg-column-types.test.ts`). Schema change (output `[T!]` → `[T]`); question: inputs too?

### B17 — Relation `orderBy` misdetected when target has a `direction` column

**File:** `common/cursor.ts:76` `orderByHasRelationEntry`, `common/order-by.ts:42`. CONFIRMED
(`filters-review/src/sqlite-b.test.ts`). Fix: `typeof config.direction !== 'string'` or a
column-key check.

### B18 — SQLite second-precision timestamps: `lt` / `gte` with fractional operand

Done for `lt`/`gte` only. `eq`/`ne`/`inArray` keep the documented floor (an "instant" rule for them was drafted and dropped: it reverses documented behaviour; ask before changing it).

**File:** `src/util/data-mappers/index.ts` `remapFromGraphQLCore` via `filters.ts`. Operand is
floored. CONFIRMED (`sqlite-a.test.ts`). Fix: ceil for `lt`/`gte`.

### B19 — JSON `path` `as: NUMBER/BOOLEAN` differs by dialect (question)

**File:** `src/util/builders/common/filters.ts` `jsonPathExprs`. PG/MySQL cast text (string
`"3"` matches 3); SQLite checks `json_type`. CONFIRMED (`pglite-a.test.ts`). Question: strict
(type must match) or lenient everywhere?

### B20 — Relation field `cursor` under `matchFilterOrder` errors

**File:** `src/util/builders/common/relation-resolvers.ts:~290`. Uses `orderByHasRelationEntry`
instead of `orderByCursorObstacle`. CONFIRMED (`sqlite-a.test.ts`).

### B21 — Forged cursor values are not validated

**File:** `src/util/builders/common/cursor.ts` `decodeCursor`. Bad date → empty page; bad
bigint/object/array → Internal server error. CONFIRMED (`sqlite-a.test.ts`).

### B22 — Auto-transaction state on reused or non-object contexts

Done: state is keyed on the execution. Non-object contexts now get a working shared transaction instead of a refusal. Still unchecked: two executions sharing one context object at the same time (documented requirement).

**File:** `src/util/builders/common/transactions.ts:338`, `:379`, `:261`. Non-object context
keys state on the cached AST node; a reused context keeps `passthrough` forever. PLAUSIBLE
(outside the documented fresh-context requirement). Implements: M3.

### B23 — `before` hook vs input validation order differs by path (question)

`write-resolvers.ts:439` vs `:466` (PG/SQLite update), `mysql.ts:115` (insertSingle),
`mysql.ts:334` vs `:343` (updateMany) run `before` first; the rest validate first. A rejected
write fires `before` on some paths only. Question: which order is intended?

---

## Docs

### D1 — Docs that disagree with the code

- `src/types.ts:1280`: says every feature defaults on except `upsert` and `nestedWrites`; `features.ts` turns five more off.
- `src/util/builders/schema-data.ts:352`: `updateMany` result "one slot per entry", but a multi-row entry yields several.
- `common/select-runtime.ts:353`: "the write has already committed" (false in a transaction; changes with B1).
- `common/errors.ts:13`: `DRIZZLE_MULTI_ROW_MATCH` "nothing was written" (made true by B3).
- `common/errors.ts:15`: `DRIZZLE_WHERE_REQUIRED` "matching every row" (made true by B4).
- `AGENTS.md:18` (`common.ts` description) and `:309-310` (`MySqlDatabase` / `BaseSQLiteDatabase` names).

### D2 — README: `every` + NULL caveat (only if B11 keeps the behaviour)

---

## Low value

### B24 — Write args remapped in place (unverified)
`remapFromGraphQLSingleInput` mutates `payload.args`; hooks see remapped args, and a variable
shared by two fields is remapped twice (bytea throws "is not an array!").

### B25 — `PgSparseVector` offered min/max (unverified)
`aggregates.ts:150-156`, `NO_MIN_MAX_COLUMN_TYPES`.

### B26 — Junction restore UPDATE ignores the junction's `update` feature
`nested-writes.ts:567-582` vs `1399-1430`.

### B27 — Nested `refreshed` matches by `String()` (unverified)
`nested-writes.ts:1765`; use `keyString`.

### B28 — `resolveSelection` fallback null ordering (unverified)
`selection.ts:376`, `:383`.

### B29 — `matchFilterOrder` + `insensitive` ordering (unverified)

### Parked readability smells (not filed as items; for a later readability pass)
"scope" used for four things; `relationMap` names two maps; `typeName` string vs resolver;
policies in two shapes (`TablePolicies` / `ResolverPolicies`); dialect dispatch and relation
graph derived twice (`index.ts`, `selection.ts`); naming spread over five modules; "sync
driver" unnamed; module-global per-build registries; two `updateMany` batch runners;
`nested-writes.ts` (2115 lines) and `prepareBuild` crowded. Note: the after-hook of a
parent-side nested create fires before a savepoint may roll it back (external side effects
are not undone).
