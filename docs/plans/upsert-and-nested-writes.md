# Plan: upsert and nested writes

Status: **not started** — this is a design document, no code has been written.

Two features that Prisma, Hasura and pg_graphql all expose and this library does not:

1. **Upsert** — insert a row, or update it if a conflicting one already exists.
2. **Nested writes** — create or connect related rows in the same mutation as their parent.

They are planned together because nested writes need upsert's conflict handling to be
useful, and both need the same transaction wrapper.

## Where we are today

- `create<Table>` / `create<Table>Single` insert and return the rows. PostgreSQL and SQLite
  use `.returning()`; MySQL returns only `{ isSuccess }`.
- `config.conflictDoNothing` is a **build-wide** boolean that adds `onConflictDoNothing()` to
  PostgreSQL inserts. SQLite hardcodes `onConflictDoNothing()` on every insert, which is a
  separate bug worth fixing under this work — it silently swallows conflicts with no way to
  opt out.
- Insert inputs (`Create<Table>Input`) contain columns only. Relations are output-only.
- Nothing is wrapped in a transaction. A multi-row insert is one statement, so it is atomic
  by accident, not by design.

## Part 1 — upsert

### Surface

A new mutation per table, named with a configurable prefix (default `upsert`), mirroring the
existing array/single pair:

```graphql
upsertUsers(values: [UpsertUsersInput!]!, onConflict: UsersOnConflict): [User!]!
upsertUsersSingle(values: UpsertUsersInput!, onConflict: UsersOnConflict): User
```

`UpsertUsersInput` is the insert input — every column, required where the column is
`notNull` without a default.

`UsersOnConflict` controls what happens when a row already exists:

```graphql
input UsersOnConflict {
  target: [UsersConflictTarget!]   # defaults to the primary key
  action: ConflictAction!          # UPDATE (default) | NOTHING
  update: [UsersColumn!]           # which columns to overwrite; defaults to every supplied column
  where: UsersFilters              # optional guard on the update branch
}
```

`UsersConflictTarget` is an enum of the columns covered by a unique constraint or unique
index, plus the primary key. Drizzle exposes these through the table's extra config
(`uniqueIndex()` / `unique()`), so the enum can be derived rather than guessed — a target
that is not actually unique produces a runtime database error, so it must not be offerable.

`UsersColumn` is an enum of updatable columns. `distinct` already generates a very similar
`<Type>DistinctColumn` enum, so `generateDistinctEnum` should be generalized into a shared
`generateColumnEnum(table, typeName, suffix, predicate)` rather than duplicated.

### Dialect mapping

| Dialect    | Mechanism                                                                              |
| ---------- | -------------------------------------------------------------------------------------- |
| PostgreSQL | `.onConflictDoUpdate({ target, set, setWhere })` / `.onConflictDoNothing({ target })`   |
| SQLite     | same API as PostgreSQL                                                                  |
| MySQL      | `.onDuplicateKeyUpdate({ set })` — **no conflict target, no `where`**                   |

MySQL's `ON DUPLICATE KEY UPDATE` fires on any unique key, so `target` and `where` cannot be
honoured. Two options, in order of preference:

1. Omit `target` and `where` from `UsersOnConflict` when the dialect is MySQL, so the schema
   itself says what is supported. This matches how MySQL already gets a different mutation
   return type.
2. Accept and ignore them. Rejected — silently ignoring a `where` on an upsert is a data
   correctness hazard.

MySQL also cannot return the affected rows, so `upsertUsers` there returns
`MutationReturn` like its other mutations.

### `set` construction

`onConflictDoUpdate` needs an explicit `set`. Building it from the supplied values means
`sql`-excluded references so that a batch upsert updates each row with its own values:

```ts
set = Object.fromEntries(updateColumns.map((c) => [c, sql`excluded.${sql.identifier(c)}`]))
```

MySQL uses `values(col)` rather than `excluded.col`; drizzle's `onDuplicateKeyUpdate` takes
the same shape, so this is a per-dialect helper.

Columns the caller did not supply must be left out of `set`, otherwise an upsert of a
partial row nulls out everything it omitted.

### Interaction with `conflictDoNothing`

Once `onConflict` exists as a per-request argument, the build-wide `config.conflictDoNothing`
is redundant and confusing (a request cannot opt out of it). Deprecate it: keep it working
as the default for `create*` mutations, document the replacement, and remove it in a later
major. SQLite's unconditional `onConflictDoNothing()` should start honouring the same flag,
which is a breaking change and needs to ship in the same release.

## Part 2 — nested writes

### Surface

Relation fields appear on the insert input, each taking a per-relation input:

```graphql
input CreateUserInput {
  name: String!
  email: String
  posts: UserPostsNestedInput      # to-many
  customer: UserCustomerNestedInput # to-one
}

input UserPostsNestedInput {
  create: [CreatePostNestedInput!]  # rows to insert, parent FK filled in automatically
  connect: [PostWhereUnique!]       # existing rows to point at the new parent
}
```

`CreatePostNestedInput` is `CreatePostInput` **minus the foreign key columns that this
relation supplies** — otherwise the caller can set `authorId` to something other than the
parent being created. That subtraction is per (table, relation) pair, so it needs its own
cache keyed on the relation, alongside the existing `filterTypeCache` / `orderTypeCache`.

`PostWhereUnique` is a filter restricted to unique columns — the same derivation the upsert
conflict target needs. Sharing it is the main reason to build upsert first.

Scope for a first pass, deliberately narrow:

- `create` and `connect` only. No `connectOrCreate`, no nested `update`/`delete`/`upsert`,
  no `disconnect`. Prisma's full nested-write surface is very large and most of it is
  reachable today with two round-trips.
- One level of nesting to start (`create` inputs contain relation fields; those nested
  create inputs do not). Deeper nesting is a cache/recursion problem identical to the one
  `relationsDepthLimit` already solves, so it can be lifted later without an API change.
- To-one relations: `create` and `connect`, both single-valued.

### Execution order

For a to-many relation where the child holds the FK (the common case):

1. Insert the parent, returning its primary key.
2. Insert the children with the FK set to that key.
3. `UPDATE child SET fk = <parent pk> WHERE <unique filter>` for each `connect`.

For a to-one relation where the **parent** holds the FK, that inverts: the related row must
be inserted first, and its key folded into the parent's values. So the resolver has to
partition relations by which side owns the FK before it does anything. `extractRelationJoinColumns`
in `common.ts` already computes this and can be reused.

Many-to-many (`.through()`) relations are out of scope, the same as they are for relation
filters.

### Transactions

Every nested write is at least two statements and must be atomic. `db.transaction(async (tx) => …)`
exists on all three dialects, but every resolver currently closes over `db` directly. The
resolvers would need to take the executor as a parameter instead, which is the same
refactor [TODO #7 (multi-mutation transactions)](../../TODO.md) needs — worth doing once, for
both.

Note that a transaction changes the eager relation re-fetch too: the re-fetch after an insert
has to run on `tx`, not `db`, or it will not see the uncommitted rows.

MySQL cannot `.returning()`, so step 1 needs `insertId` from the result header plus a
follow-up select — and that only works for a single auto-increment key, not a composite or
client-supplied one. MySQL nested writes may have to be restricted to tables with a single
auto-increment primary key, or left unsupported in the first pass.

## Suggested order

1. Extract `generateColumnEnum` and a `WhereUnique` derivation from the table's unique
   constraints. Both features need them; neither is user-visible on its own.
2. Thread an executor parameter through the mutation resolvers (shared with TODO #7).
3. Upsert, PostgreSQL and SQLite first, then MySQL with the reduced input.
4. Fix SQLite's unconditional `onConflictDoNothing()` and deprecate `config.conflictDoNothing`.
5. Nested `create` for to-many relations, then to-one, then `connect`.

Steps 1–4 are each independently shippable. Step 5 is the only one that needs all of the
preceding work.
