# Drizzle-GraphQL

Automatically create GraphQL schema or customizable schema config fields from Drizzle ORM schema

Site: [cubicecho.github.io/drizzle-graphql](https://cubicecho.github.io/drizzle-graphql/)

## Usage

-   Pass your drizzle database instance into the builder to generate a `{ schema, entities }` object. The tables are read from the `relations` you gave the drizzle constructor (`drizzle({ client, relations })`), so a table missing from your relations config is not part of the generated schema
-   Use `schema` if pre-built schema already satisfies all your needs. It's compatible with any server that consumes `GraphQLSchema` class instance

    Example: hosting schema using [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)

    ```Typescript
    import { createServer } from 'node:http'
    import { createYoga } from 'graphql-yoga'
    import { buildSchema } from '@vantreeseba/drizzle-graphql'

    // db - your drizzle instance
    import { db } from './database'

    const { schema } = buildSchema(db)

    const yoga = createYoga({ schema })
    const server = createServer(yoga)

    server.listen(4000, () => {
        console.info('Server is running on http://localhost:4000/graphql')
    })
    ```

-   If you want to customize your schema, you can use `entities` object to build your own new schema

    ```Typescript
    import { createServer } from 'node:http'
    import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from 'graphql'
    import { createYoga } from 'graphql-yoga'
    import { buildSchema } from '@vantreeseba/drizzle-graphql'

    // Schema contains 'Users' and 'Customers' tables
    import { db } from './database'
    import { users } from './schema'

    const { entities } = buildSchema(db)

    // You can customize which parts of queries or mutations you want
    const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
            name: 'Query',
            fields: {
                // Select only wanted queries out of all generated
                users: entities.queries.users,
                customer: entities.queries.customersSingle,

                // Create a custom one
                customUsers: {
                    // You can reuse and customize types from original schema
                    type: new GraphQLList(new GraphQLNonNull(entities.types.Users)),
                    args: {
                        // You can reuse inputs as well
                        where: {
                            type: entities.inputs.UsersFilters
                        }
                    },
                    resolve: async (source, args, context, info) => {
                        // Your custom logic goes here...
                        const result = await db.select().from(users).where(/* … */)

                        return result
                    }
                }
            }
        }),
        // Same rules apply to mutations
        mutation: new GraphQLObjectType({
            name: 'Mutation',
            fields: entities.mutations
        }),
        // In case you need types inside your schema
        types: [...Object.values(entities.types), ...Object.values(entities.inputs)]
    })

    const yoga = createYoga({
        schema
    })
    const server = createServer(yoga)

    server.listen(4000, () => {
        console.info('Server is running on http://localhost:4000/graphql')
    })
    ```

    The keys on `entities` follow the naming rules below: with the defaults, table `users`
    gives type `entities.types.Users`, inputs `entities.inputs.UsersFilters` /
    `UsersOrderBy` / `CreateUsersInput` / `UpdateUsersInput`, queries
    `entities.queries.users` / `usersSingle`, and mutations
    `entities.mutations.createUsers` / `updateUsers` / `deleteUsers`. A `typeNameMapper`
    changes these keys too, so a composed schema has to use the mapped names.

## Naming the generated types and fields

By default every name comes from the table's key in the Drizzle schema: `tasks` gives type
`Tasks`, queries `tasks` / `tasksSingle`, mutations `createTasks` / `createTasksSingle`.
Most schemas use plural table keys and want singular type names, so that pairing is shipped
as a preset:

```Typescript
const { schema } = buildSchema(db, { typeNameMapper: 'singularize' })
```

`tasks` then gives type `Task`, queries `tasks` (list) and `task` (single), and each write
as a pair named the same way: `createTasks` / `createTask`, `updateTasks` / `updateTask`,
`deleteTasks` / `deleteTask` — plural for the form that operates on a set of rows, singular
for the one that operates on exactly one. Irregular
plurals go through `pluralize`, so `people` gives `Person` / `people` / `person` and
`addresses` gives `Address` rather than the `addresss` a naive suffix would produce. A table
key that is already singular is pluralized for the list side, and a capitalized key is
uncapitalized for the field side, so `tasks`, `task` and `Tasks` all land on the same names.

For anything else, pass your own function — it is asked per table and may return `undefined`
to leave that table with the default naming. The preset is exported as `singularizeMapper`
so it can be wrapped:

```Typescript
import { buildSchema, singularizeMapper } from '@vantreeseba/drizzle-graphql'

const { schema } = buildSchema(db, {
    typeNameMapper: (table) => (table === 'auditLog' ? undefined : singularizeMapper(table)),
})
```

With a mapper in play the singular/plural forms are what keep the list and single fields
apart, so `suffixes` may be empty on both sides. Without one, they must still differ.

## Choosing what gets generated

Every generated operation is on by default. `features` turns individual ones off, which
keeps them out of the schema, out of `entities`, and out of the type map — a schema for a
read-only API, or one that never exposes aggregates, does not pay for types nobody can
reach:

```Typescript
const { schema } = buildSchema(db, {
    features: {
        aggregates: false,        // <plural>Aggregate root queries
        groupBy: false,           // <plural>GroupBy root queries
        relationAggregates: false, // <relation>Aggregate fields on object types
        distinct: false,          // the `distinct` argument on list queries
        insert: false,            // create<Table> / create<Table>Single mutations
        update: false,            // update<Table> / update<Table>Single mutations
        updateMany: false,        // update<Table>Many batch mutation (needs `update`)
        delete: false,            // delete<Table> / delete<Table>Single mutations
        upsert: true,             // upsert<Table> / upsert<Table>Single mutations (off by default)
        nestedWrites: true,       // relation fields on the create/update inputs (off by default)
        fieldUpdateOperations: true, // increment/push operations on the update input (off by default)
        countMutations: true,     // update<Table>Count / delete<Table>Count mutations (off by default)
        requireWhere: true,       // require a `where` on plural update/delete/updateMany (off by default)
        uniqueKeyFilters: true,   // a `where` field per compound unique constraint (off by default)
    },
})
```

-   Any flag left out keeps its default of `true`, so `{ features: { delete: false } }`
    changes nothing else
-   `upsert`, `nestedWrites`, `fieldUpdateOperations`, `countMutations`, `requireWhere` and
    `uniqueKeyFilters` are the exceptions: they default to `false`, so they only exist if you
    ask for them
-   `groupBy` needs `aggregates`: it reuses those output types, so turning `aggregates` off
    turns the group-by queries off with it
-   Turning off `insert` or `update` also drops the input type that only that mutation
    used (`Create<Type>Input` / `Update<Type>Input`)
-   Turning off every mutation feature omits the `Mutation` type entirely, the same as
    `mutations: false` — unless a table has `softDelete`, whose `restore` mutations are
    generated regardless
-   List and single queries are always generated, so `Query` is never empty

### Per-table operations

The choice is rarely build-wide: a schema usually has a handful of tables that must not be
deleted through the API, a handful whose writes belong to a hand-written resolver that
enforces something, and a majority that want everything. Any flag can be a predicate
instead of a boolean, asked once per table with the table's key in the Drizzle schema:

```Typescript
const { schema } = buildSchema(db, {
    features: {
        delete: (table) => table !== 'auditLog',
        update: (table) => !ownedByCustomResolver.has(table),
        upsert: (table) => table === 'settings',
    },
})
```

-   The table is still fully readable — this decides which operations it offers, not whether
    it is in the schema at all. For that, use `exclude` below
-   `nestedWrites` is the one flag that stays build-wide: its plans are computed once over
    the whole relation graph, and a nested write reaches a second table by definition. What
    it offers on each relation still follows the *target* table's flags — see
    [Nested writes](#nested-writes)
-   `Mutation` is omitted when *no* table generates a mutation, and kept when one still does
-   Some operations are built out of others, and the generator knows which. A table that
    asks for `upsert` while its `insert` or `update` is off — an upsert is a second write
    path past the operation you turned off — warns on the console at build time, naming the
    tables, rather than leaving that to be discovered later. So does asking for `updateMany`
    without `update`, `groupBy` without `aggregates`, or `countMutations` with neither plural
    write. `nestedWrites` notes the nested inputs it left out because their table's write is off

## Excluding tables and columns

`features` decides which *kinds* of operation exist. `exclude` decides which tables and
columns exist at all — for the table holding session tokens, or the column holding a
password hash:

```Typescript
const { schema } = buildSchema(db, {
    exclude: {
        tables: ['magicLinks', 'sessions'],
        columns: { apiKeys: ['keyHash'] },
    },
})
```

Both lists are keyed by the **Drizzle schema key**, not the database name and not the
generated GraphQL name.

An excluded **table** generates nothing: no object type, no queries, no mutations, no
aggregates, and no relation field on any other table that points at it. `Users.sessions`
is gone, and so is `users(where: { sessions: { … } })` — the table is unreachable, not
merely unnamed.

An excluded **column** disappears from every surface at once:

| Surface | Effect |
| --- | --- |
| `<Type>` object type | field removed |
| `Create<Type>Input` / `Update<Type>Input` | field removed (nested-write payloads too) |
| `<Type>Filters` | field removed |
| `<Type>OrderBy` | field removed |
| `<Type>MinAggregate` / `<Type>MaxAggregate` / … | field removed |
| `<Type>DistinctColumn` / `<Type>GroupByColumn` | value removed |
| `<Type>ConflictTarget` / `<Type>UpdateColumn` (upsert `onConflict`) | value removed |

Two details worth stating plainly:

-   **The exclusion is all-or-nothing on purpose.** A column you can filter on but not
    select is an oracle: `where: { keyHash: { eq: '…' } }` confirms a value without ever
    returning it. Ordering and grouping leak the same way, more slowly. There is no
    read-only or write-only variant of `exclude` for this reason.
-   **Nothing changes below the schema.** An excluded column is still written by its
    default, still read by the primary-key and cursor machinery, and still usable by your
    own resolvers. Only the generated schema stops mentioning it.
-   **A cursor carries the primary key in readable form.** A [cursor](#cursor-pagination)
    is base64url JSON of the row's ordering values, and the primary key is always one of
    them. Excluding the primary key removes the field, but anyone holding a cursor can still
    decode the key's value. If the key itself must stay secret, wrap the cursors in your own
    opaque or encrypted form. A `defaults.<table>.orderBy` that names an excluded column
    throws at build time, because its values would ride along in every cursor too.

Names that match nothing throw at build time, so renaming a column fails the build instead
of quietly un-hiding it. Excluding a `NOT NULL` column with no default is allowed — the
table becomes readable but not insertable — and warns on the console, since that is more
often a mistake than a plan.

> `exclude` is a static decision: the column is absent for every caller. Deciding per
> request *which fields* a caller may reach is a job for
> [`graphql-shield`](https://the-guild.dev/graphql/shield) or an equivalent layer above the
> schema. Deciding per request *which rows* a caller may reach is `scope`, below — that one a
> layer above cannot do, because a nested relation field never passes through a root resolver.

## Row scoping and multi-tenancy

`scope` attaches a predicate, derived from the request context, to every read and write of a
table:

```Typescript
import { and, eq } from 'drizzle-orm'

const { schema } = buildSchema(db, {
    scope: {
        posts: (ctx, table) => eq(table.orgId, ctx.orgId),
        // A filter object works too — same shape as the generated `where` argument:
        comments: (ctx) => ({ post: { orgId: { eq: ctx.orgId } } }),
    },
})
```

Keyed by the **Drizzle schema key**. `ctx` is your GraphQL context value; `table` is the table
the current statement runs against — for a relational read that is Drizzle's *aliased* copy, so
always build the predicate from that argument rather than from the imported table object.

The predicate is ANDed on **last**, after whatever the client sent, so a client filter can only
narrow the scope, never widen it. It reaches every path that touches the table:

| Path | Effect |
| --- | --- |
| `posts`, `postsSingle` | out-of-scope rows are not returned |
| `postsAggregate`, `postsGroupBy` | counted over in-scope rows only |
| `user.posts`, `user.postsAggregate` | scoped on both the batched and the eager (`with:`) path |
| cursor pages | the keyset page is taken within the scope |
| relation filters — `users(where: { posts: { some: … } })`, `none`, `every`, to-one, `.through()` | only in-scope posts can match, block `none` or fail `every` — on reads, aggregates, `groupBy`, and the `where` of updates and deletes |
| `orderBy` through a to-one — `comments(orderBy: { post: { title: … } })` | an out-of-scope post sorts as `NULL` |
| `updatePosts`, `updatePostsMany`, `deletePosts` | an out-of-scope row is simply not matched |
| `upsertPosts` (conflict branch) | a conflicting row outside the scope is left alone, not taken over |
| nested `connect` / `disconnect` / `set` | only in-scope rows can be attached or detached; a many-to-many `set` keeps the links to out-of-scope rows |

Two things it deliberately does not do:

-   **It does not refuse.** A scoped `deletePosts(where: { id: { eq: 4 } })` on another
    tenant's row returns `[]`, the same answer as a row that does not exist. Telling the caller
    "that row exists but is not yours" is the leak the scope is there to close.
-   **It does not apply to a plain insert.** There is no existing row to filter. `contextValues`
    is the write-side half.

A relation filter or an ordering through a relation sees exactly the rows the relation field
would return. Through a `.through()` relation, the junction table's own `scope` and soft delete
apply as well — to the relation field, its `<relation>Aggregate` and a relation filter alike,
so a link row the caller cannot read links nothing on any of them (see
[junction rows](#junction-rows)). A scope that returns a filter object is the server's own predicate, so the
relations it reaches through are read without their targets' scopes.

Returning `undefined` means *no restriction for this context*, so one hook can let an
administrator through:

```Typescript
scope: {
    posts: (ctx, table) => (ctx.isAdmin ? undefined : eq(table.orgId, ctx.orgId)),
}
```

A table with no entry is unscoped, and a build with no `scope` at all emits exactly the SQL it
did before.

### Columns the server owns

`contextValues` supplies a column's value from the request context instead of accepting it from
the client:

```Typescript
const { schema } = buildSchema(db, {
    contextValues: {
        posts: {
            orgId: (ctx) => ctx.orgId,
            authorId: (ctx) => ctx.userId,
        },
    },
})
```

-   The column is **removed from `CreatePostsInput` and `UpdatePostsInput`**, so a client cannot
    send it at all — the SDL itself says the column is server-owned. It stays readable on the
    object type.
-   Every insert stamps it, including rows created by a nested `create` and junction rows a
    many-to-many `connect` / `set` inserts.
-   Updates never write it, so an update cannot hand a row to another owner. Neither does the
    conflict branch of an upsert: it is left out of the default overwrite and of the columns
    `onConflict.update` can name.
-   A relation whose foreign key is such a column gets no
    [nested-write](#nested-writes) field from either side: every nested operation on it would
    write that column. The build notes which relations it left out.

Together the two close the loop: `contextValues` decides which tenant a new row belongs to, and
`scope` decides which rows a request can see and change afterwards.

> **MySQL caveat.** `ON DUPLICATE KEY UPDATE` takes no predicate, so a MySQL upsert's conflict
> branch cannot be scoped. Scope the table's `update` and rely on `contextValues` for the insert
> half.

Names that match nothing throw at build time, the same as `exclude` — a renamed column fails the
build instead of quietly ceasing to be scoped.

## Naming

Type and field names are derived from the Drizzle schema keys. Three options change them.

`prefixes` and `suffixes` rename operations without touching type names:

```Typescript
const { schema } = buildSchema(db, {
    prefixes: { insert: 'add', update: 'edit', delete: 'remove' }, // default: create / update / delete
    suffixes: { list: 'All', single: '' },                         // default: '' / 'Single'
})
```

Both suffixes reach every operation that comes in a list/single pair, mutations included:
the config above gives `usersAll` / `users` on the query side and `addUsersAll` / `addUsers`,
`editUsersAll` / `editUsers`, `removeUsersAll` / `removeUsers` on the mutation side. The
variants that carry their own disambiguator — `usersAggregate`, `usersGroupBy`,
`updateUsersMany`, `updateUsersCount`, `deleteUsersCount` — take neither suffix.

The list and single suffixes cannot be identical unless a `typeNameMapper` is also given —
`users` and `usersSingle` would otherwise collapse onto one field name, and `buildSchema`
throws rather than generating a schema that silently drops one of them. With a mapper the
plural and singular nouns keep every pair apart on their own, so both suffixes may be empty
and no operation carries a `Single` at all. A table the mapper returns `undefined` for is
back on the default naming and still needs the suffixes to differ.

That check compares the configured suffixes, which is only part of what a name is made of.
Every generated root field is also registered by name, and a build that puts two operations
on one field name throws naming the field rather than dropping whichever registered first —
whatever combination of prefixes, suffixes and mapper produced it.

`typeNameMapper` renames the table itself, which is what a plural-keyed schema usually wants:
`export const users = pgTable('users', …)` otherwise produces `type Users` and a
`usersSingle` query.

```Typescript
import pluralize from 'pluralize'

const { schema } = buildSchema(db, {
    typeNameMapper: (table) => ({ singular: pluralize.singular(table), plural: table }),
})
// type User; queries `users` / `user`; mutations `createUsers` / `createUser`,
// `updateUsers` / `updateUser`, `deleteUsers` / `deleteUser`
```

Return `undefined` for any table that should keep its default naming.

### Renaming the derived types

`typeNameMapper` names the table. Everything derived from it — `UsersFilters`, `UsersOrderBy`,
`CreateUsersInput`, `UsersAggregate`, and the shared inputs like `InnerOrder` and `StringFilter` —
follows the default template. Two schemas built from different databases therefore collide the
moment they are stitched into one gateway: both publish a `StringFilter`, and the two are not the
same type.

`typeNamePrefix` and `typeNameSuffix` move a whole build into its own namespace:

```Typescript
const { schema } = buildSchema(db, { typeNamePrefix: 'Shop' })
// type ShopUsers; input ShopUsersFilters, ShopCreateUsersInput, ShopInnerOrder, ShopStringFilter…
```

The prefix must be a valid GraphQL name start (`/^[_A-Za-z][_0-9A-Za-z]*$/`) and the suffix a valid
continuation (`/^[_0-9A-Za-z]+$/`); anything else throws at build time rather than producing a
schema graphql-js will reject.

For control over one kind of type rather than all of them, `derivedTypeNameMapper` is asked for
every type the build constructs:

```Typescript
const { schema } = buildSchema(db, {
    typeNamePrefix: 'Shop',
    derivedTypeNameMapper: ({ kind, defaultName, table }) =>
        kind === 'filter' ? `${table}Where` : undefined,
})
// input UsersWhere; everything it declined keeps the prefix — ShopUsers, ShopUsersOrderBy…
```

`kind` is one of `object`, `filter`, `listRelationFilter`, `orderBy`, `createInput`, `updateInput`,
`updateManyInput`, `nestedWriteInput`, `fieldUpdateInput`, `aggregate`, `having`, `groupBy`,
`groupKeys`, `onConflict`, `uniqueKey`, `columnEnum`, `columnFilter` and `shared`. `table` is the
Drizzle schema key the type belongs to, where it belongs to one, and `operation` further identifies
it (the aggregate's `avg`, the column filter's `String`, the unique key's field name). An answer is
used **verbatim** — the prefix and suffix are the fallback, not a wrapper around it. Return
`undefined` to fall back.

Custom scalars (`BigInt`, `Decimal`, …), PostgreSQL enum types and `PgGeometryObject` keep their own
names under all three options: their definition does not vary between builds, so a gateway merges
them rather than colliding on them.

The [`resolveSelection` and `selectionToWith` helpers](#writing-your-own-resolver-over-a-generated-type) match selections
against GraphQL type names, so an override in a renamed build passes the same three options back:

```Typescript
resolveSelection(info, { db, table: 'Users', typeNamePrefix: 'Shop' })
```

## Soft delete

`softDelete` turns a table's `delete` mutation into an UPDATE that marks the row, and hides
marked rows from every read:

```Typescript
const { schema } = buildSchema(db, {
    softDelete: {
        posts: 'deletedAt',
        // The NOT NULL form has to spell out both values:
        flags: { column: 'isArchived', deletedValue: true, restoredValue: false },
    },
})
```

Keyed by the **Drizzle schema key**, like `scope` and `exclude`. A function form is also
accepted, for a convention applied across the schema:

```Typescript
softDelete: (table, tableName) => ('deletedAt' in getColumns(table) ? 'deletedAt' : undefined)
```

What a declared table gets:

| Path | Effect |
| --- | --- |
| `deletePosts`, `deletePostsSingle` | UPDATE that writes the marker; returns the rows as they now stand — or a real DELETE under [`hard: true`](#purging-a-row), where the table opted in |
| `restorePosts`, `restorePostsSingle` | the inverse — matches **only** marked rows and clears the marker |
| `posts`, `postsSingle`, cursor pages | marked rows are not returned |
| `postsAggregate`, `postsGroupBy` | counted over unmarked rows only |
| `user.posts`, `user.postsAggregate` | hidden on both the batched and the eager (`with:`) path |
| relation filters — `users(where: { posts: { some: {} } })`, `none`, `every`, `.through()` junctions | a marked post neither matches nor blocks `none`, with the same default as the relation field (see below) |
| `orderBy` through a to-one | a marked target the relation field hides sorts as `NULL` |
| `updatePosts`, `updatePostsMany`, a second `deletePosts` | a marked row is simply not matched |
| nested `connect` / `disconnect` / `set` | a marked row cannot be attached or detached; a many-to-many `set` keeps the links to marked rows |
| `CreatePostsInput`, `UpdatePostsInput`, nested `create` payloads | the marker column is **removed** — only the mutations write it |
| every insert — root, upsert, nested `create`, a many-to-many link | a NOT NULL marker drizzle declares no default for is written as `restoredValue`; an upsert's conflict branch never overwrites it |

Every read path also gains a `deleted` argument for the cases the default hides:

```graphql
{
    live: posts { id }                      # the default — EXCLUDE
    trash: posts(deleted: ONLY) { id }      # the trash view, no second field needed
    all: posts(deleted: INCLUDE) { id }
}
```

The marker column stays **readable and filterable** — it is only the write inputs that lose it,
the same trade `contextValues` makes.

Defaults come from the column's type: `new Date()` for a timestamp, an ISO string for text (a
`'string'`-mode date or datetime column gets the column's own text form, as an ordinary write
of it would), `Date.now()` for a number, `true` for a boolean. A NOT NULL column has no "absent" state, so
the predicate has to compare against a constant: any NOT NULL column other than a boolean must
give `deletedValue` (a constant, not a function) and `restoredValue`, or the build throws.

**What counts as marked** follows the config, not the column's nullability. With no
`deletedValue`, a nullable column reads as "holding a value at all means deleted" — the
timestamp form, `deletedAt IS NOT NULL`. Name a constant and reads compare against it instead,
on a nullable column as much as a NOT NULL one:

```Typescript
// `is_deleted boolean DEFAULT false` — nullable, because it was added to an existing table
softDelete: { docs: { column: 'isDeleted', deletedValue: true, restoredValue: false } }
```

Here a row is deleted when the column holds `true`; `false` **and NULL** are both alive, so the
rows written before the column existed are not swept into the trash view.

### What a relation field sees

By default the scope covers the table's own query fields **and** every relation field that
points at it, with one exception: a *required* to-one relation (`optional: false`, so the
field is `Kind!`) reads marked rows. Hiding one there can only ever produce `Cannot return
null for non-nullable field Item.kind` and take the whole parent down with it — there is no
usable result to protect.

Marking a lookup row usually means *retired*: keep it off the pickers and the lists, keep
rendering it on the historical rows that reference it. `scope: 'root'` says exactly that:

```Typescript
softDelete: {
    kinds: { column: 'isRetired', deletedValue: true, restoredValue: false, scope: 'root' },
}
```

| | `scope: 'all'` (default) | `scope: 'root'` |
| --- | --- | --- |
| `kinds`, `kindsSingle`, `kindsAggregate` | marked rows hidden | marked rows hidden |
| `item.kind` (required to-one) | **shown** | shown |
| `item.altKind` (nullable to-one) | hidden (resolves `null`) | shown |
| `kind.items`, `kind.itemsAggregate` | hidden | shown |

The `deleted` argument is generated on relation fields either way, so a request can override
whichever default applies — `altKind(deleted: EXCLUDE)` under `'root'`, `altKind(deleted:
INCLUDE)` under `'all'`.

A relation filter (`items(where: { kind: { name: … } })`) and an `orderBy` through a to-one
use the same default as the relation field, so they match and sort over exactly the rows the
field shows. They take no `deleted` argument of their own.

`scope` changes reads only. A nested `connect` / `disconnect` / `set` still refuses to attach a
marked row under either setting, and the table's own writes are unaffected.

#### Junction rows

A `.through()` relation links only through the junction rows the junction table's own `scope`
and soft delete keep, on every path that reads it: the relation field (eager or batched,
paginated or `distinct`), `<relation>Aggregate`, and a relation filter. A marked junction row is
a removed link, so the junction is always read at `EXCLUDE`:

-   The relation's `deleted` argument is about the **target** rows. `tags(deleted: INCLUDE)`
    brings back marked tags that are still linked, never a tag whose link was marked.
-   The junction's own `softDelete.scope` only decides what the junction table's own fields
    return. `'root'` keeps a retired row rendering where a relation points *at* it; a relation
    passes *through* a junction row and never renders it, so there is nothing for `'root'` to
    keep, and a marked link stays hidden under either setting.

Drizzle's `with:` joins the junction itself and offers no way to add a condition to it, so a
relation whose junction has a `scope` or soft delete is loaded by its field resolver's batch
loader rather than with its parent — still one query per relation per request, not one per
parent. A junction joined on more than one column per side cannot be loaded that way, so
selecting such a relation while its junction has a policy fails with
`DRIZZLE_UNSUPPORTED_RELATION` instead of returning links the policy hides.

### Purging a row

Soft delete and purge are not alternatives — emptying the trash, reclaiming a unique key and
clearing a table in development all need the row actually gone. `hardDelete: true` puts a
`hard` argument on the table's delete mutations:

```Typescript
softDelete: { articles: { column: 'deletedAt', hardDelete: true } }
```

```graphql
mutation {
    trash: deleteArticles(where: { id: { eq: 1 } }) { id }             # UPDATE — marks the row
    purge: deleteArticles(where: { id: { eq: 3 } }, hard: true) { id } # DELETE — removes it
}
```

`hard: true` reads at `INCLUDE` rather than `EXCLUDE`, so it reaches rows that are **already
marked** — which is the case it mostly exists for; a `scope` still confines what it can reach,
exactly as it confines every other write. `deleteArticles(hard: true)` with no `where` empties
the table, marked rows included.

Opt-in per table, since it is destructive: no `hard` argument is generated where it was not
asked for, so the schema itself says which tables can be purged. `restore` never takes one.

One thing to weigh: an argument is harder to gate than a field — schema-level permission
middleware registers rules per field name, so `deleteArticles` with and without `hard: true`
is one rule that has to inspect arguments. The opted-in fields say so on their marker, so a
wrapper can find them without parsing the schema's arguments:

```Typescript
const meta = drizzleExtension(field) // { operation: 'delete', hardDelete: true, … }
```

Three things it deliberately does not do:

-   **It does not cascade.** Marking a post does not mark its comments. A comment whose post is
    marked is still returned by `comments`; its `post` field resolves to `null` (or to the
    marked row, when the field is non-null or the table is `scope: 'root'` — see above).
    Declare the child table too if that is not what you want.
-   **It does not free the row's unique keys.** A marked row still occupies its primary key and
    every unique index, so inserting a new row with the same natural key fails the constraint.
    A partial unique index (`WHERE deleted_at IS NULL`) is the usual answer; `hardDelete`
    (above) is the other one.
-   **It does not refuse.** Like `scope`, an unreachable row answers the same as a row that does
    not exist.

The soft-delete predicate is ANDed **before** a `scope` predicate, both after the client's
`where` — so a scope still confines what `deleted: INCLUDE` can reach.

> **MySQL caveat.** `ON DUPLICATE KEY UPDATE` takes no predicate, so an upsert whose conflict
> target hits a marked row updates it — reviving it — rather than leaving it alone. On
> PostgreSQL and SQLite the conflict branch carries the predicate and updates nothing.

A table with no declaration keeps a real `DELETE`, gets no `restore` mutation and no `deleted`
argument, and a build with no `softDelete` at all emits exactly the SQL it did before.


## Scalars

Columns whose values don't fit a built-in GraphQL scalar get a named custom scalar, so the
generated SDL says what a field actually holds instead of falling back to `String`:

| Drizzle column                             | GraphQL type | Transported as                       |
| ------------------------------------------ | ------------ | ------------------------------------ |
| `json` / `jsonb` (and `mode: 'json'`)       | `JSON`       | the parsed value                     |
| `bigint` (and `mode: 'bigint'`)             | `BigInt`     | a decimal string                     |
| `uuid`                                      | `UUID`       | a validated UUID string              |
| `timestamp` / `datetime` (either `mode`)    | `DateTime`   | an ISO-8601 string                   |
| SQLite `integer({ mode: 'timestamp' })` / `'timestamp_ms'` | `DateTime` | an ISO-8601 string       |
| `date` (either `mode`)                      | `Date`       | a `YYYY-MM-DD` string                |
| `numeric` / `decimal`                       | `Decimal`    | a decimal string                     |

```graphql
mutation {
    createDocumentSingle(values: { id: "11111111-1111-4111-8111-111111111111", payload: { tags: ["a"], views: 3 }, counter: "9007199254740993" }) {
        payload
        counter
    }
}
```

-   **`JSON`** carries the value itself — objects, arrays, numbers, strings, `true`/`false`.
    Reads return the parsed value, not a stringified one, and writes take a literal or a
    variable rather than a string of JSON
-   **`BigInt`** is always a decimal string in both directions, so values past
    `Number.MAX_SAFE_INTEGER` survive the round-trip. Integer literals are accepted on input;
    floats and non-numeric strings are rejected
-   **`UUID`** validates the format on the way in, including inside `where` filters
-   **`Decimal`** is a decimal string in both directions, so the precision the column declares
    is not lost to a JS float. Non-numeric and non-finite input is rejected
-   **`Date`** is a calendar day — no time, no offset — and is the same type in every position
    a `date` column appears in: the object field, the create and update inputs, the
    `DateFilter` operands, aggregate `min` / `max` and group keys. It takes and returns an
    RFC 3339 `full-date` (`2026-09-15`) whichever `mode` the column is declared with; a
    `mode: 'date'` column is read back from its JS `Date` as the UTC day, so no server timezone
    shifts it. Input must name a real day: `2026-02-30`, `2026-13-45` and datetime strings like
    `2026-09-15T10:00:00Z` are rejected. With `graphql-codegen`, map it as
    `scalars: { Date: 'string' }`
-   **`DateTime`** is an instant, and is likewise the same type in every position a Postgres
    `timestamp`, MySQL `timestamp` / `datetime` or SQLite integer timestamp column appears in, with `DateTimeFilter` in
    filters, whichever `mode` the column is declared with. It returns an ISO-8601 string in UTC.
    MySQL stores these columns without an offset; the value is written and read as UTC
    (`2026-09-15T10:00:00Z` is stored as `2026-09-15 10:00:00`) whatever the Node process's
    timezone, the way drizzle itself treats them. Postgres `timestamp` without time zone is
    treated the same way, in both modes; `timestamptz` stores the instant, and its text in
    `mode: 'string'` (`2026-09-15 04:00:00-06`) is returned as the same instant in UTC. The
    scalar carries milliseconds, so a `timestamp(6)` value's microseconds are truncated on read
    and on write. A SQLite `integer({ mode: 'timestamp' })` or `integer({ mode: 'timestamp_ms' })`
    column is `DateTime` too; it stores the instant as epoch seconds or milliseconds. Seconds
    mode cannot hold a fraction, so it is floored (never rounded) on write —
    `2026-09-15T10:00:00.999Z` is stored as `1789466400` and reads back as
    `2026-09-15T10:00:00.000Z` — and filter operands on such a column are floored the same way,
    so `eq` with the value you wrote finds the row you wrote it to

Some columns map to built-in GraphQL types rather than a custom scalar:

| Drizzle column | GraphQL type | Transported as |
| --- | --- | --- |
| SQLite `integer()` (number mode) | `Float` | a JS number, exact up to 2^53 |
| Postgres `bytea`, SQLite `blob({ mode: 'buffer' })` | `[Int!]` | the bytes, each 0–255 |
| Postgres `point` / `line` (tuple mode), PostGIS `geometry` (tuple mode), `vector`, `halfvec` | `[Float!]` | the tuple or vector |
| Postgres `point({ mode: 'xy' })`, `line({ mode: 'abc' })` | `JSON` | the object, `{ x, y }` / `{ a, b, c }` |

-   **SQLite `integer()`** holds any 64-bit integer, a rowid primary key included, so it is a
    `Float`: GraphQL's `Int` is 32-bit and cannot serialize anything past 2^31. Drizzle reads
    the column as a JS number, so values are exact up to `Number.MAX_SAFE_INTEGER`; declare it
    `blob({ mode: 'bigint' })` (a `BigInt`) for more. Its `'boolean'` and `'timestamp'` modes
    keep `Boolean` and `DateTime`
-   A **tuple** must have its type's length — 2 for a point, 3 for a line — or the write is
    rejected
-   An **array column** (`bigint().array()`, `timestamp().array()`, …) is a list of its element
    type, and each element is converted as a single value would be, in writes and in the `has` /
    `hasSome` / `hasEvery` operands alike

> **Upgrading — SQLite `integer()` columns.** A SQLite `integer()` column in number mode (the
> default) used to be `Int`, and reading a value past 2^31 failed with "Int cannot represent
> non 32-bit signed integer value". It is now `Float` in every position: the object field, the
> create / update inputs, primary-key and unique-key arguments, `FloatFilter` operands, aggregate
> `min` / `max` and group keys, and `FloatFieldUpdate`. Variables typed `Int` for these fields
> become `Float` (an `Int` variable is a validation error in a `Float` position); literals and
> the values themselves are unchanged. `integer({ mode: 'boolean' })` and the timestamp modes are
> not affected. A SQLite `blob({ mode: 'buffer' })` column, which used to be `JSON` and could
> not be written, is now `[Int!]`.

The scalars are exported if you need them in a hand-written schema:

```Typescript
import { GraphQLBigIntString, GraphQLDate, GraphQLDateTime, GraphQLDecimalString, GraphQLJSON, GraphQLUUID } from '@vantreeseba/drizzle-graphql'
```

`GraphQLBigIntString` is the `BigInt` scalar — named for what it does rather than what it is
called in SDL, to avoid clashing with the language's own `BigInt`. `GraphQLDate` is this
library's own `Date` scalar, not `graphql-scalars`' (whose `parseValue` returns a JS `Date`).

> **Upgrading — `date` columns.** A `date` column used to be typed differently depending on
> where it appeared and which `mode` it was declared with. Both modes are now `Date` everywhere:
>
> | Drizzle column | position | before | now |
> | --- | --- | --- | --- |
> | `date(…, { mode: 'string' })` | output | `Date` | `Date` |
> | | create / update input | `String` | `Date` |
> | | filter | `StringFilter` | `DateFilter` |
> | `date(…)` / `{ mode: 'date' }` (Postgres) | output, input, min/max, group keys | `DateTime` | `Date` |
> | | filter | `DateTimeFilter` | `DateFilter` |
> | `date(…, { mode: 'date' })` (MySQL) | output, input, min/max, group keys | `JSON` | `Date` |
> | | filter | `JSONFilter` | `DateFilter` |
> | `date(…, { mode: 'string' })` (MySQL) | output, input, min/max, group keys | `String` | `Date` |
> | | filter | `StringFilter` | `DateFilter` |
>
> What to change:
>
> -   Variables typed `String` or `DateTime` for a date field become `Date`; filters on it are
>     `DateFilter`, which has the `DateTimeFilter` operators (`eq` / `ne` / `lt` / `lte` / `gt` /
>     `gte` / `inArray` / `notInArray` / `isNull` / `isNotNull`) and none of the string ones
> -   Send `YYYY-MM-DD`. A datetime string such as `2026-09-15T00:00:00.000Z` used to be
>     truncated to its date and is now rejected
> -   A `mode: 'date'` column read `2026-09-15T00:00:00.000Z` and now reads `2026-09-15`
> -   In `graphql-codegen`, map `scalars: { Date: 'string' }` — the value is a string in both
>     directions
> -   If you passed `graphql-scalars`' `GraphQLDate` as a column override, pass this library's
>     exported `GraphQLDate` instead. They share the name `Date`, so a schema holding both
>     fails to build with graphql's "multiple types named Date" error

> **Upgrading — MySQL `timestamp` / `datetime` columns.** These used to fall through to
> `JSON` in `mode: 'date'` and to `String` in `mode: 'string'`. All four are now `DateTime`, as
> Postgres `timestamp` already was:
>
> | Drizzle column (MySQL) | position | before | now |
> | --- | --- | --- | --- |
> | `timestamp(…)` / `datetime(…)` (`mode: 'date'`) | output, input, min/max, group keys | `JSON` | `DateTime` |
> | | filter | `JSONFilter` | `DateTimeFilter` |
> | `timestamp(…)` / `datetime(…)` with `{ mode: 'string' }` | output, input, min/max, group keys | `String` | `DateTime` |
> | | filter | `StringFilter` | `DateTimeFilter` |
>
> Variables for these fields become `DateTime` and their filters `DateTimeFilter`, which has no
> `JSONFilter` / `StringFilter` operators such as `contains` or `like`. Input must be an ISO-8601
> date-time (`2026-09-15T10:00:00Z`, or with an offset). A `mode: 'string'` column used to read
> MySQL's own `2026-09-15 10:00:00` and now reads `2026-09-15T10:00:00.000Z`. In
> `graphql-codegen`, map `DateTime` the way you already do for Postgres timestamps.

> **Upgrading — SQLite integer timestamps.** `integer({ mode: 'timestamp' })` and
> `integer({ mode: 'timestamp_ms' })` used to fall through to `JSON`. Both are now `DateTime`:
>
> | Drizzle column (SQLite) | position | before | now |
> | --- | --- | --- | --- |
> | `integer(…, { mode: 'timestamp' })` / `{ mode: 'timestamp_ms' }` | output, input, min/max, group keys | `JSON` | `DateTime` |
> | | filter | `JSONFilter` | `DateTimeFilter` |
>
> Variables for these fields become `DateTime`, and their filters `DateTimeFilter`, which swaps
> the JSON `path` operator for `lt` / `lte` / `gt` / `gte` / `inArray` / `notInArray`. Input must
> be an ISO-8601 date-time; a JSON value such as a bare number is rejected. Reads are unchanged:
> they were already ISO-8601 strings in UTC. The stored integers are unchanged too.

### Overriding a column's scalar

Built-in detection is a default, not a ceiling. `scalars` overrides named columns, and
`mapColumnType` applies a rule across every column at build time — the tool for a convention
("every `numeric` column is `Money`") or for a custom column type detection does not know:

```Typescript
const { schema } = buildSchema(db, {
    scalars: {
        users: { email: EmailAddressScalar },              // by table key, then column key
    },
    mapColumnType: (column) => (column.columnType === 'PgNumeric' ? MoneyScalar : undefined),
})
```

Either may return a single scalar, or an `{ output, input }` pair when the read and write
types differ. `mapColumnType` returning `undefined` keeps the default, and a column matched
by both is decided by `scalars` alone.

## Enum types

A column declared with a database enum becomes a GraphQL enum named after **the enum**, not
after the column that happens to use it:

```Typescript
export const status = pgEnum('status', ['active', 'archived'])

export const Users = pgTable('users', { status: status('status') })
export const Posts = pgTable('posts', { status: status('status') })
```

```graphql
enum StatusEnum {
    active
    archived
}

type Users {
    status: StatusEnum!
}
type Posts {
    status: StatusEnum!
}
```

-   One type, one filter input (`StatusEnumFilter`), so a client variable typed `StatusEnum!`
    is passable to either table
-   The declared name is PascalCased and suffixed: `user_status` → `UserStatusEnum`. A name
    that would start with a digit gets a leading underscore: `2fa_mode` → `_2faModeEnum`
-   A column that lists its values inline (`text('tier', { enum: ['free', 'paid'] })`) has no
    declared name to share, so it keeps a per-column type — `UsersTierEnum`
-   Two different enums that would land on the same GraphQL name (`status` in two Postgres
    schemas) fail the build rather than silently sharing a type
-   Ordering by an enum column, its `min` / `max`, and cursor pages over it follow the
    database's own rule. PostgreSQL and MySQL sort an enum by declaration order (`active` before
    `archived` because it is declared first). SQLite has no enum type — the column is `text`
    with the values checked by Drizzle — so there it sorts alphabetically

`enumNameMapper` overrides the name. Returning `undefined` keeps the default, so a mapper
only has to handle the cases it cares about:

```Typescript
const { schema } = buildSchema(db, {
    // `schema` is the Postgres schema the enum was declared in, if any; `values` is its
    // value list. `enumName` and `schema` are undefined for an inline value list.
    enumNameMapper: ({ enumName, schema }) =>
        schema === 'reporting' ? `Reporting${enumName}Enum` : undefined,
})
```

Two columns the mapper sends to the same name share one type, as long as their values match —
which is also how inline enums can be unified. Sending the same name to two different value
lists is the build-time error above.

> **Upgrading:** before this, every enum column got its own `<Table><Column>Enum`. A column
> backed by a declared enum now reports the shared name instead (`UsersStatusEnum` →
> `StatusEnum`). To keep the old names, return them from the mapper:
>
> ```Typescript
> enumNameMapper: ({ tableName, columnName }) =>
>     `${tableName}${columnName[0]!.toUpperCase()}${columnName.slice(1)}Enum`
> ```

### Enum value names

A value's GraphQL name is the stored value itself, or `Option<index>` when the stored value
is not a usable GraphQL name — one with a character outside `[_a-zA-Z0-9]` (`hot-fix`), one
that starts with a digit (`2xl`), or `true` / `false` / `null`. `enumValueNameMapper` renames
the values — most often to follow GraphQL's SCREAMING_CASE convention while the database keeps
its lowercase values:

```Typescript
export const Runs = pgTable('runs', {
    status: text('status', { enum: ['running', 'ok', 'error', 'stopped'] }),
})

const { schema } = buildSchema(db, {
    // The built-in preset: `inProgress` / `in-progress` → `IN_PROGRESS`
    enumValueNameMapper: 'constant',
})
```

```graphql
enum RunsStatusEnum {
    RUNNING   # stored as 'running'
    OK
    ERROR
    STOPPED
}
```

-   Only the GraphQL name changes. Each value's internal `value` is still the stored string,
    so filters (`eq`, `inArray`, …), create/update inputs, outputs and your own resolvers keep
    sending and receiving exactly what the database stores. The generated TypeScript types
    keep the stored values too
-   The function form receives the stored `value`, its `index`, the enum's GraphQL `typeName`
    (after `enumNameMapper`) and everything `enumNameMapper` receives. Returning `undefined`
    keeps the default name for that value:

    ```Typescript
    enumValueNameMapper: ({ value, typeName }) =>
        typeName === 'RunsStatusEnum' ? value.toUpperCase() : undefined,
    ```

-   The build fails, rather than producing an invalid or lossy schema, when a returned name is
    not a valid GraphQL enum value name, when two values of one enum map to the same name, or
    when columns that share one enum type (the columns of one `pgEnum`) would name its values
    differently — give those columns separate types with `enumNameMapper` if they really
    should differ

## Documenting the schema

Four hooks put descriptions and deprecations on the generated types. Each is called per
column (or per table / per relation) and returns `undefined` to say nothing:

```Typescript
const { schema } = buildSchema(db, {
    describeColumn: (column, { tableName, columnName }) => docs[tableName]?.[columnName],
    describeTable: (tableName) => docs[tableName]?._table,
    describeRelation: (tableName, relationName) => `The ${relationName} of this ${tableName}`,
    deprecateColumn: (column, { columnName }) => (columnName === 'legacyId' ? 'Use `id`' : undefined),
})
```

-   `describeColumn` reaches every place the column appears: the object type, the create and
    update inputs, the filter input's field, `Min`/`Max` aggregates and `GroupKeys`
-   `describeColumn` receives the drizzle column itself and `describeTable` the drizzle table
    itself, so a project that keeps its documentation in the schema (a `WeakMap` keyed by
    column/table, a custom property, a comment table) can read it straight off:

    ```Typescript
    import type { Table } from 'drizzle-orm';

    const docs = new WeakMap<object, string>();

    // Register docs on the *built* table and its columns. `text('email')` is only a builder:
    // pgTable creates a new column object from it, so keying on the builder never matches.
    const described = <T extends Table>(
        table: T,
        description: string,
        columns: Partial<Record<keyof T['_']['columns'], string>> = {},
    ): T => {
        docs.set(table, description);
        for (const [key, columnText] of Object.entries(columns)) {
            docs.set((table as any)[key], columnText as string);
        }
        return table;
    };

    export const users = described(
        pgTable('users', { id: integer('id').primaryKey(), email: text('email').notNull() }),
        'A person who can sign in',
        { email: 'Primary login address' },
    );

    buildSchema(db, {
        describeColumn: (column) => docs.get(column),
        describeTable: (_tableName, table) => docs.get(table),
    });
    ```
-   `deprecateColumn` marks output fields and *optional* input fields. A required input field
    is skipped: GraphQL forbids deprecating one, and emitting it would make the schema invalid
-   Filter and `orderBy` fields are never deprecated — filtering on a deprecated column is how
    a caller finds the rows still using it

## Relation filters

A table's `where` input also exposes its relations, so you can filter rows by what they're
related to instead of pulling everything and filtering client-side.

A **to-one** relation takes the target table's filter input directly:

```graphql
{
    posts(where: { author: { name: { eq: "FifthUser" } } }) {
        id
    }
}
```

A **to-many** relation takes a `some` / `none` / `every` wrapper
(`<Target>ListRelationFilter`):

```graphql
{
    # users who wrote at least one post containing "drizzle"
    users(where: { posts: { some: { content: { like: "%drizzle%" } } } }) {
        id
    }

    # users with no posts at all
    users(where: { posts: { none: {} } }) {
        id
    }

    # users all of whose posts are published (users with no posts match vacuously)
    users(where: { posts: { every: { isPublished: { eq: true } } } }) {
        id
    }
}
```

-   Relation filters compile to correlated `EXISTS` subqueries — the related rows are never
    fetched, and no join duplicates the parent rows
-   They nest arbitrarily (`users(where: { posts: { some: { author: { … } } } })`) and combine
    freely with column filters (implicit `AND`) and with `OR`
-   They're accepted anywhere a filter is — list and single queries, aggregate queries,
    `update`/`delete` mutations, and the `where` argument on a relation field
-   `some: {}` means "at least one related row exists"; `none: {}` means "none exist"
-   Several modes may be given at once and are `AND`ed together
-   A relation whose name collides with a column name is skipped — the column keeps the field
-   Many-to-many relations declared with `.through()` are filterable too: the `EXISTS`
    subquery joins the junction table to the target, so
    `users(where: { roles: { some: { name: { eq: "admin" } } } })` works the same as a direct
    to-many relation

## Lookup by a unique key

A row with a two-column natural key — a stock line identified by item and location, a
membership identified by user and team — has to be spelled as two ordinary filters that
happen to match one row. Nothing says they belong together, and the query stays valid when
half of it goes missing. `features: { uniqueKeyFilters: true }` adds one `where` field per
compound unique constraint, named after its columns:

```graphql
{
    stockSingle(where: { itemId_locationId: { itemId: "widget", locationId: "eu" } }) {
        quantity
    }
}
```

```graphql
input StockItemIdLocationIdKey {
    itemId: String!
    locationId: String!
}
```

-   Every member is non-null, so a half-supplied key is a query-validation error rather than
    a filter that quietly matches more rows than you meant
-   The field lives on the table's `Filters` input, so it is accepted anywhere a filter is —
    list and single queries, aggregates, `update<Table>Single` / `delete<Table>Single` — and
    composes with column filters, relation filters, `OR` / `AND` / `NOT`
-   Composite primary keys get a field like any other unique constraint
-   Single-column constraints do not: `eq` on the column already names the row
-   Partial unique indexes (`uniqueIndex().on(…).where(…)`) do not either: they are unique
    only among the rows the predicate matches, so with soft-deleted rows included
    (`deleted: INCLUDE`) the key can match more than one
-   A field name a column or relation already holds is skipped, the same way a relation
    yields to a same-named column
-   It compiles to exactly the equalities you would have written by hand; the guarantee is in
    the input type, not in the SQL

## Case-insensitive matching

Every filter on a string column carries an `insensitive` flag alongside its operators. Set it
and each comparison in that object compares `lower(column)` against `lower(operand)`:

```graphql
{
    users(where: { email: { eq: "Dan@Example.com", insensitive: true } }) {
        id
    }

    users(where: { username: { inArray: ["dan", "SAM", "Alex"], insensitive: true } }) {
        id
    }
}
```

This is what a natural key — an email, a username, a slug, an account code, a SKU — actually
wants, and `ilike` is the wrong tool for it: `%`, `_` and `\` in an `ilike` operand are
wildcards, so `100%_off` would silently match rows it should not unless the caller escapes them
by hand. Under `insensitive` the operand stays a literal and stays a bound parameter.

-   It covers every operator beside it: `eq` / `ne`, the ordering comparisons, `inArray` /
        `notInArray`, `like` / `notLike`, and the safe `startsWith` / `endsWith` / `contains`
        (the `i`-prefixed forms are already case-insensitive and are unaffected)
-   It applies to the operators in its own object only. A nested `AND` / `OR` / `NOT` branch is
        a separate object and sets its own flag
-   `lower()` is the same function the case-insensitive LIKE operators already fall back to on
        the dialects without a native `ILIKE`, so the behaviour is identical on all three. Because
        the left side is a plain `lower(column)`, a `lower(column)` expression index can serve the
        lookup — which `ilike '%…%'` never can
-   The flag appears only on filters whose column can take string operators, so it is absent
        from the numeric, uuid, boolean, timestamp and enum filters (see
        [Which operators a column gets](#which-operators-a-column-gets))

**On MySQL, plain comparisons may already ignore case.** MySQL compares strings under the
column's collation, and its default (`utf8mb4_0900_ai_ci`, like every `*_ai_ci` collation) is
case- **and** accent-insensitive. So without `insensitive`, `eq: "dan"` matches `Dan` and `dän`
there, and the same holds for `ne`, the ordering comparisons, `inArray`, `orderBy`, `min` /
`max`, `distinct`, `groupBy` and the `like` / `startsWith` / `endsWith` / `contains` operators.
PostgreSQL compares exactly. That is the database's configured behaviour, not something this
library adds: give a column a binary or `*_as_cs` collation (`varchar(…) COLLATE utf8mb4_bin`)
where it has to compare exactly.

### Case sensitivity of the pattern operators on SQLite

`like` / `notLike` and the safe `startsWith` / `endsWith` / `contains` are case-sensitive, as
they are on PostgreSQL: `contains: "App"` matches `Apple` and not `apple`. SQLite's own `LIKE`
folds ASCII case, so on SQLite they compile to `GLOB` instead, with `%` / `_` translated to its
`*` / `?` and every other wildcard in the operand matched literally. The `i`-prefixed operators
and `insensitive: true` fold case on SQLite as everywhere else.

> **Upgrading — SQLite.** These operators used to compile to `LIKE` on SQLite and so matched
> case-insensitively. Queries that relied on that should use the `i`-prefixed operator or
> `insensitive: true`.

## Which operators a column gets

A filter input carries the operators that can express a question about that column type, and
no others. The set follows the column's data type, never its name:

| column type | `eq` `ne` `inArray` `notInArray` `isNull` `isNotNull` | `lt` `lte` `gt` `gte` | pattern operators + `insensitive` |
| --- | --- | --- | --- |
| text / varchar | yes | yes | yes |
| timestamp (`DateTimeFilter`), date (`DateFilter`) | yes | yes | — |
| int, float, bigint, decimal | yes | yes | — |
| uuid | yes | yes | — |
| boolean | yes | — | — |
| enum | yes | — | — |

The pattern operators are `like` / `notLike` / `ilike` / `notIlike`, the safe
`startsWith` / `endsWith` / `contains` and their `i`-prefixed forms, plus the `insensitive`
flag that modifies them. MySQL and SQLite have no `ILIKE`, so there `ilike` / `notIlike`
compile to `lower(column) LIKE lower(pattern)`, the same form `insensitive` uses.

An operand of `null` leaves its operator out, as though it had not been sent. `false` is an
ordinary value: `active: { eq: false }` matches the rows that are false, `ne: false` the rows
that are true, and `has: false` the arrays holding a `false`. Only the flag operators —
`isNull`, `isNotNull` and `isEmpty` — read `false` as "add no condition".

The omissions are the cases where the operator cannot ask anything a caller means:

-   **Pattern matching a timestamp, a boolean or an enum member** compares whatever the value
        is rendered as rather than anything in the row, and the answer depends on session
        formatting. On a numeric column it is invalid SQL outright.
-   **Ordering two booleans** is equality spelled as a puzzle — `gt: false` is `eq: true`.
-   **Ordering enum members** compares their declaration order, which is an artefact of how the
        column was written rather than a fact about the domain. `inArray` says the same thing
        exactly.

Timestamps keep the ordering operators — ranges are the point of having them — and `json` /
`jsonb` and array columns have their own sets entirely (structural containment and membership;
see [Filtering inside JSON documents](#filtering-inside-json-documents)).

A column given a custom scalar through `scalarOverrides` keeps the pattern operators only when
a `LIKE` against the underlying database column would be valid — string-typed and not
numeric — and keeps the ordering operators either way, since a custom scalar says nothing about
whether its column is orderable.

> **Upgrading:** `BooleanFilter` and the generated `*EnumFilter`s used to carry the full
> 24-operator string set, and `DateTimeFilter` the pattern half of it. Queries that sent one of
> the removed operators are now validation errors; `eq` / `ne` / `inArray` / `notInArray` /
> `isNull` / `isNotNull` and the boolean branches `AND` / `OR` / `NOT` are unchanged, as is
> ordering on timestamps.

## Matching lists of values

`inArray` / `notInArray` take a list of candidate values and compile to SQL `IN` / `NOT IN`.
Two things about them are worth stating explicitly.

**An empty list is answered, not rejected.** A caller building a filter from a variable often
ends up with an empty list, and that list has a well-defined meaning: nothing is `IN ()` and
everything is `NOT IN ()`.

```graphql
{
    # no rows
    posts(where: { id: { inArray: [] } }) {
        id
    }

    # every row
    posts(where: { id: { notInArray: [] } }) {
        id
    }
}
```

The same rule applies to the Postgres array-column operators: `hasSome: []` matches nothing
(overlapping with no elements is never true) and `hasEvery: []` matches everything (every
array contains all zero of them).

**The list's own order can be the sort order.** SQL returns `IN` matches in whatever order it
likes, so a caller that fetches rows by a ranked list of ids normally has to re-sort them
client-side. Setting `matchFilterOrder` on an `orderBy` entry sorts by the row's position in
that column's `inArray` list instead of by the column's value:

```graphql
{
    posts(
        where: { id: { inArray: [7, 3, 12] } }
        orderBy: { id: { direction: asc, priority: 1, matchFilterOrder: true } }
    ) {
        id # → 7, 3, 12
    }
}
```

-   `direction: asc` keeps the list's order; `desc` reverses it
-   It needs an `inArray` filter on the same column, at the top level of `where` — an
        `inArray` buried inside an `OR` branch raises an error rather than being guessed at
-   It interleaves with the other `orderBy` entries by `priority` like any ordering key, and
        works on relation fields as well as root lists
-   It compiles to a `CASE` ladder over the list values, so it behaves identically on all
        three dialects and every value stays a bound parameter
-   It cannot be combined with `after` or `distinct`: a row's position in the request's own
        filter list is not a value of the row, so it cannot be encoded into a cursor or rebuilt
        against a subquery. Selecting `cursor` under it yields `null` rather than an error

## Filtering inside JSON documents

`json` / `jsonb` columns get a `path` filter that compares the value at one path inside the
document, alongside the whole-document `eq` / `ne` operators and, on PostgreSQL and MySQL,
structural `contains` (SQLite stores JSON as text and has no containment operator):

```graphql
{
    users(where: { meta: { path: { path: ["profile", "level"], gt: 2 } } }) {
        id
    }
}
```

`path` walks the document key by key from the root; an all-digits key indexes an array
(`["tags", "0"]`). Several predicates may be given at once and are `AND`ed:

```graphql
{
    users(
        where: {
            meta: {
                path: [
                    { path: ["profile", "role"], eq: "admin" }
                    { path: ["profile", "level"], gte: 3 }
                ]
            }
        }
    ) {
        id
    }
}
```

Available operators are `eq` / `ne` / `lt` / `lte` / `gt` / `gte`, the safe string matchers
`startsWith` / `endsWith` / `contains` (plus their case-insensitive `i`-prefixed forms), and
`isNull` / `isNotNull`. A missing key and a JSON `null` both read as null.

**How the value is compared** is decided by the operand: a GraphQL number compares
numerically, a boolean as a boolean, and anything else as text. Pass `as: TEXT | NUMBER |
BOOLEAN` when the operand's type doesn't match the document's — comparing a numeric field
against a `String` variable, say:

```graphql
{
    users(where: { meta: { path: { path: ["profile", "level"], as: NUMBER, eq: "3" } } }) {
        id
    }
}
```

A value of the wrong shape never matches rather than failing the query: `gt: 0` against a
document whose path holds `"admin"` returns no rows on every dialect. That takes a guard on
each one — Postgres errors outright on a bad `::numeric`, MySQL quietly casts a non-numeric
string to `0`, and SQLite's cross-type ordering would otherwise sort every string above every
number.

SQLite has no boolean type, and its `json_extract` hands a JSON `true` / `false` back as `1` /
`0`, so its path reads check `json_type` as well: `eq: true` matches only a JSON `true`, never
the number `1`, a number operand never matches a boolean, and a text read sees `"true"` /
`"false"`, as PostgreSQL's does.

**Whole-document `eq` / `ne`** compare documents, not their text. Object key order and
whitespace do not matter; array order does, and so does the difference between `1` and `true`.
PostgreSQL compares as `jsonb` (so a plain `json` column, which has no `=` of its own, works
too), MySQL against `CAST(? AS JSON)`, and SQLite by matching the two documents' nodes both ways.
Like `=` / `<>` on any column, neither matches a row whose column is SQL `NULL`.

**JSON columns cannot be ordered.** A JSON document has no meaningful order — PostgreSQL's
`json` has none at all, and MySQL's JSON ordering is not one a cursor can resume from — so
JSON columns are left out of `<Type>OrderBy` (and so out of cursor pagination and every relation
`orderBy`) and out of `<Type>DistinctColumn`, and naming one in `defaults.<table>.orderBy` fails
the build. Order by a generated column or a path you extract yourself instead.

Note that `contains` means different things at the two levels, because a path names a scalar:
on the column it is structural JSON containment (Postgres `@>` / MySQL `JSON_CONTAINS`),
inside a `path` filter it is substring matching on the extracted value.

Path filters combine with `AND` / `OR` / `NOT` like any other operator, and are accepted
everywhere a filter is — list, single and aggregate queries, `update` / `delete`, and the
`where` argument on a relation field.

## Aggregate queries

Every table also gets an aggregate query field — `<tableName>Aggregate` (e.g. `usersAggregate`),
following the same naming rules as the other generated queries:

```graphql
{
    postsAggregate(where: { authorId: { eq: 1 } }) {
        count
        avg {
            views
        }
        sum {
            views
        }
        min {
            createdAt
        }
        max {
            createdAt
            title
        }
        countNonNull {
            publishedAt
        }
        countDistinct {
            authorId
        }
    }
}
```

-   `count` — number of matching rows (`Int!`)
-   `avg` / `sum` — one nullable `Float` field per numeric column. On MySQL `avg` is computed
    as a `DOUBLE`, since MySQL's own `AVG` over an integer column is a `DECIMAL` rounded to four
    places
-   `min` / `max` — one field per orderable column (numbers, strings, enums, dates, bigints),
    typed exactly like that column is in the table's own type. PostgreSQL `uuid`, `macaddr`,
    `macaddr8` and `bit` columns are left out, because PostgreSQL has no `min` / `max` for them,
    and so is a SQLite `blob({ mode: 'bigint' })` column, whose bytes compare as text (`9` above
    `10`)
-   `countNonNull` — `Int!` per column: how many matching rows have a non-null value there.
    Every column qualifies, since `count(col)` is valid whatever the type
-   `countDistinct` — `Int!` per column: how many distinct non-null values there are. Limited to
    the columns with an equality operator: the `min` / `max` columns plus the ones listed above
    that compare but have no `min` / `max`

Columns that have no meaningful ordering — booleans, arrays, JSON, buffers, and geometry —
are left out of these types, and the `avg` / `sum` / `min` / `max` fields themselves are
omitted when no column qualifies.

The optional `where` argument takes the same filter input as the table's list query, and is
applied to every aggregate in the selection. All requested aggregates are computed in a
single `SELECT`, and on an empty result set `count` is `0` while the other values are `null`.

Add `groupBy` to get the same numbers one row per group — see [Group by](#group-by).

## Group by

Every table with aggregates also gets a `<tableName>GroupBy` query (e.g. `postsGroupBy`): the
same aggregates as `<tableName>Aggregate`, computed once per distinct combination of the
columns you group by.

```graphql
{
    postsGroupBy(
        groupBy: [authorId, published]
        where: { createdAt: { gte: "2024-01-01T00:00:00Z" } }
        having: { count: { gte: 5 } }
    ) {
        group {
            authorId
            published
        }
        count
        avg {
            views
        }
        max {
            createdAt
        }
    }
}
```

-   `groupBy` is required and takes one or more values of the table's `<Type>GroupByColumn`
    enum. It holds the `countDistinct` columns plus booleans — anything the database can group on.
    An empty list is an error, and repeated columns are ignored
-   `group` is a `<Type>GroupKeys!` object with one nullable field per groupable column, typed
    like the table's own column. Columns the query did not group by come back as `null`, which
    a column whose grouped value really is `NULL` is indistinguishable from
-   Every other field is the same one `<tableName>Aggregate` returns — `count`, `avg`, `sum`,
    `min`, `max`, `countNonNull`, `countDistinct` — with the identical types and rules
-   `where` filters rows before grouping; `having` filters groups after aggregating
-   The result is `[<Type>GroupBy!]!`, one row per group, in whatever order the database
    returns them. Add your own ordering client-side if you need it

`having` mirrors the aggregate selection, with an `AggregateNumberFilter` (`eq`, `ne`, `gt`,
`gte`, `lt`, `lte`, all `Float`) in place of each value:

```graphql
{
    postsGroupBy(groupBy: [authorId], having: { count: { gt: 3 }, avg: { views: { gte: 100 } } }) {
        group {
            authorId
        }
        count
    }
}
```

-   `having: { count: … }` filters on the row count; `avg` / `sum` / `min` / `max` take one
    filter per numeric column (the comparison is numeric, so a `max` over a text or date
    column has no `having` entry even though the aggregate type returns it),
    `countNonNull` one per column, and `countDistinct` one per column `countDistinct` exposes
-   The operand is a `Float` whatever the aggregate's own type, so `count: { gt: 1.5 }` works:
    on PostgreSQL, where an integer aggregate would otherwise give the parameter its integer
    type, the aggregate is compared as `numeric`
-   Every entry in a `having` is ANDed together
-   A group filter does not need to be in the selection — `having: { count: { gt: 3 } }` works
    whether or not you asked for `count`

The whole thing is one `SELECT … GROUP BY … HAVING …`. Set `features: { groupBy: false }` to
leave these queries (and their `<Type>GroupBy`, `<Type>GroupKeys`, `<Type>GroupByColumn` and
`<Type>Having` types) out of the schema; turning off `aggregates` removes them too.

## Relation aggregates

Every to-many relation also gets an `<relationName>Aggregate` field on the parent type, so you
can count or summarise related rows without fetching them:

```graphql
{
    users {
        id
        postsAggregate {
            count
        }
        publishedPosts: postsAggregate(where: { published: { eq: true } }) {
            count
            max {
                createdAt
            }
        }
    }
}
```

-   The field returns the target table's own `<Type>Aggregate` type — the same one the root
    `<tableName>Aggregate` query returns, so `count` / `avg` / `sum` / `min` / `max` behave
    identically
-   `where` takes the target table's filter input, including [relation filters](#relation-filters),
    and applies only to the related rows
-   A parent with no related rows gets `count: 0` and `null` for every other aggregate
-   To-one relations get no aggregate field — there is nothing to aggregate over
-   A relation joined on several columns (`from: [a, b], to: [x, y]`) is grouped by all of
    them, so each parent counts only the rows that match it on every column. A many-to-many
    (`.through()`) relation whose junction has a composite key gets no aggregate field
-   The field is skipped if its name would collide with a column or another relation
-   Set `features: { relationAggregates: false }` (globally or per table) to leave these
    fields out

All parents in a selection are aggregated with a single
`SELECT <fk>, … WHERE <fk> IN (…) GROUP BY <fk>` per request, so `postsAggregate` on a list of
users is one extra query, not one per user. Differently-aliased selections with different
`where` arguments are batched separately. A batch whose parent keys would bind more than
10,000 parameters (10,000 parents on a single-column key, 5,000 on a two-column one) is split
into several such queries, which keeps it within SQLite's 32,766- and Postgres/MySQL's
65,535-parameter limits; the batched relation fields split the same way.

## Distinct

List queries take a `distinct` argument — a list of columns from the `<Type>DistinctColumn`
enum. Rows sharing the same combination of those columns collapse to one:

```graphql
{
    # the first post of each author
    posts(distinct: [authorId], orderBy: { createdAt: { direction: asc, priority: 1 } }) {
        id
        authorId
        createdAt
    }
}
```

-   Which row survives each group is decided by `orderBy` — the first one wins. With no
    `orderBy`, the table's [default ordering](#default-ordering) decides, and failing that the
    lowest primary key
-   `where` is applied **before** rows are collapsed; `limit` and `offset` are applied
    **after**, so `limit: 10` returns ten distinct rows
-   Several columns are treated as one combined key, not as independent ones
-   `distinct` is also available on to-many relation fields, where it means one row per
    distinct value **per parent** — the window is partitioned by the foreign key as well as
    the requested columns
-   `distinct` is not on single queries — those return one row either way
-   JSON columns are not in `<Type>DistinctColumn` (see
    [Filtering inside JSON documents](#filtering-inside-json-documents))

It runs as an extra `row_number() over (partition by …)` query that picks the surviving
rows' primary keys, after which the main query is narrowed to them — so it needs the same
window-function support as per-parent paginated relations (**PostgreSQL**, **MySQL 8.0+**,
or **SQLite 3.25+**), and a table with no primary key cannot use it.

## Pagination ordering

SQL gives no ordering guarantee for a query that has no `ORDER BY`, so paging through an
unordered result can return the same row twice or skip one entirely. To keep pages stable,
a query that returns only part of a table is ordered by its primary key when the request
supplies no `orderBy` and the table has no [default ordering](#default-ordering):

-   list queries with `limit` and/or `offset`
-   `<tableName>Single` queries, which are an implicit `limit 1`
-   to-many relation fields with `limit` and/or `offset` (as a tiebreak appended to any
    `orderBy` you do supply or [default ordering](#default-ordering) the target has — and under
    `orderBy: {}` too — so per-parent slices are deterministic and the eager and lazy paths
    return the same slice)

An explicit `orderBy` always takes precedence, composite primary keys are ordered by every
key column, and an unpaginated list query of a table with no `defaults` entry is left
unordered so no sort is paid for.

`offset` works without `limit` on every dialect. SQLite and MySQL only accept `OFFSET` after a
`LIMIT`, so there an offset-only page is sent with a limit meaning "no limit" (`-1` on SQLite,
2^53 - 1 on MySQL).

`<Type>OrderBy` offers every column that has a meaningful order. JSON columns (see
[Filtering inside JSON documents](#filtering-inside-json-documents)) and SQLite
`blob({ mode: 'bigint' })` columns, whose bytes sort as text, are left out. A table left with
nothing to order by — no such column, and no to-one relation to a table that has one — gets no
`<Type>OrderBy` and no `orderBy` argument, on its lists or on relation fields pointing at it, and
likewise no `<Type>DistinctColumn` or `distinct` argument when no column qualifies for that.

## Default ordering

A table usually has one ordering that is right nearly every time it is read — newest first,
priority first, name alphabetical. `defaults` names that ordering once, and every query that
does not ask for its own gets it:

```ts
buildSchema(db, {
  defaults: {
    Todos: { orderBy: { priority: 'desc', createdAt: 'desc' } },
    Users: { orderBy: { name: 'asc' } },
  },
});
```

```graphql
# ordered by priority desc, then createdAt desc — nothing in the query says so
{ todos { id title } }
```

Keys are the table's key in your Drizzle schema and the column's property name, so a typo in
either fails at `buildSchema` time rather than silently doing nothing. Each column takes
`'asc'`, `'desc'`, or a `{ direction, priority? }` object mirroring the `orderBy` argument.
Columns sort highest `priority` first, and the shorthand leaves it unset, so the shorthand
falls back to the order the keys are written in — the object form is there for when you would
rather state the precedence than depend on that:

```ts
defaults: {
  Todos: { orderBy: { createdAt: { direction: 'desc', priority: 1 }, priority: { direction: 'desc', priority: 2 } } },
}
```

It applies to list queries, `<tableName>Single` queries, and to-many relation fields on both
the eager and the lazy relation paths — a relation takes the default of the table it *reads*,
not its parent's. To-one relation fields are a single row and take no ordering.

Two details worth stating plainly:

-   **Any `orderBy` in the request wins outright.** The default is a fallback for a missing
    argument, not a base that client ordering is appended to. To ask for *no* ordering, pass
    `orderBy: {}` — an empty object is still an argument, so it suppresses the default.
-   **A default ordering makes an unpaginated list query pay for a sort.** That is the point,
    but it is a cost a table with no `defaults` entry does not pay; a build with no `defaults`
    behaves exactly as before.

Cursor pagination composes with it: a default-ordered page is ordered by those columns plus
the primary key tiebreak, and its `cursor` values encode that same total order, so paging works
without the client restating the ordering.

## Cursor pagination

`OFFSET` pagination degrades linearly and shifts under concurrent writes. List queries also
support keyset pagination: every row returned by a list query exposes an opaque `cursor`
field, and passing it back as `after` resumes strictly after that row.

```graphql
{
    posts(orderBy: { createdAt: { direction: desc, priority: 1 } }, limit: 10) {
        id
        createdAt
        cursor
    }
}

# next page — same orderBy, plus the last row's cursor
{
    posts(
        orderBy: { createdAt: { direction: desc, priority: 1 } }
        limit: 10
        after: "eyJvIjogW1siY3JlYXRlZEF0IiwgImRlc2MiXSwgWyJpZCIsICJhc2MiXV0sIC4uLn0"
    ) {
        id
        createdAt
        cursor
    }
}
```

-   The cursor encodes the row's position in the query's **total order** — your `orderBy`
    columns plus the primary key as an ascending tiebreak — so pages are stable even when
    the ordered columns aren't unique, and inserts or deletes mid-scroll don't shift the
    window
-   `after` compiles to a keyset predicate built from drizzle's `and`/`or`/`gt`/`lt`
    comparisons (not SQL row-value syntax), so mixed-direction `orderBy` works
-   `NULL`s in ordered columns sort where the entry's `nulls: first | last` says or, without
    it, at each dialect's native `ORDER BY` placement — PostgreSQL sorts them largest (last
    in `asc`), MySQL and SQLite smallest (first in `asc`). The predicate matches either way,
    so rows with `NULL` in an ordered column are paged through, not skipped, and `nulls` is
    part of the ordering a cursor is tied to
-   Dates and bigints round-trip losslessly through the cursor, at the column's own precision:
    a PostgreSQL `timestamp` / `timestamptz` (microseconds unless declared `precision: 3` or
    less) or a MySQL `datetime` / `timestamp` with `fsp` above 3 holds more than the
    millisecond JS `Date` that `mode: 'date'` reads it into, so the cursor carries the
    database's own text of the value instead, and rows a microsecond apart are still distinct
    pages
-   A cursor is opaque by convention only. It is base64url-encoded JSON of the row's
    ordering values, primary key included, so a client can decode it and read those values,
    even for a primary key hidden by [`exclude`](#excluding-tables-and-columns). It is not
    signed or encrypted. If the ordering values must stay private, wrap the cursor in your
    own opaque or encrypted token before it leaves the server, and unwrap it on the way back
    in
-   A cursor is only valid under the ordering it was issued for — reusing it with a
    different `orderBy` (or a malformed/corrupted cursor) returns a `GraphQLError`
-   `after` cannot be combined with `distinct`, with `matchFilterOrder`, or with an `orderBy`
    that orders through a relation (`cursor` resolves to `null` there), and a table with
    no primary key cannot use cursor pagination (its `cursor` field resolves to `null`)
-   If a table has a real column named `cursor`, the column wins and the meta field is
    skipped

To-many relation fields take `after` and `distinct` too, with the same meaning they have on
a root list of the same table — a relation field is a list of the target table, so it gets
that table's whole pagination surface:

```graphql
{
    users {
        id
        posts(orderBy: { createdAt: { direction: desc, priority: 1 } }, limit: 10, after: "…") {
            id
            cursor
        }
    }
}
```

Drizzle's `with:` clause cannot express either one — keyset needs a predicate over the
request's own total order, `distinct` needs a window pass, and a `cursor` has to be computed
from the raw row. So a relation field that is passed `after` or `distinct`, or that selects
`cursor`, drops out of the eager fetch and resolves through the request-scoped batch loader
instead, which implements all three. That is still **one query per relation** across every
parent in the batch (`distinct` adds its key-selection pass, as on a root list) — never one
per parent. Nothing about the arguments changes; only how many round-trips the request
costs.


## Upsert

`features.upsert` adds a pair of mutations per table that insert rows, or update the ones
that already exist:

```graphql
mutation {
    upsertUsersSingle(values: { id: 1, name: "Dan", email: "dan@example.com" }) {
        id
        name
    }
}
```

With no `onConflict`, a conflict on the **primary key** overwrites every column the request
supplied. `onConflict` changes that:

```graphql
mutation {
    upsertUsers(
        values: [
            { email: "dan@example.com", name: "Dan", visits: 1 }
            { email: "sam@example.com", name: "Sam", visits: 1 }
        ]
        onConflict: {
            target: [email] # must be a unique constraint; defaults to the primary key
            action: UPDATE # or NOTHING, to keep the existing row
            update: [name] # columns to overwrite; defaults to every supplied column
            where: { isConfirmed: { eq: true } } # only overwrite rows that match
        }
    ) {
        id
        name
    }
}
```

-   A batch upsert updates each row with **its own** values (`excluded.<column>`), not with
    the last row's
-   Columns the request did not supply are never overwritten — a partial upsert does not null
    out the rest of the row. Listing an unsupplied column in `update` is an error rather than
    a silent no-op
-   That holds per row: a batch whose rows supply different columns is split into one
    statement per run of consecutive rows that write the same columns, run in one transaction
    (on a synchronous SQLite driver such as better-sqlite3 too), so a row that left a column out
    keeps it. The rows come back in the order they were sent
-   `target` must match one of the table's unique constraints exactly; anything else is
    rejected with the list of valid targets, instead of the database's opaque "no unique or
    exclusion constraint matching" error
-   `target` can be a partial unique index — the `WHERE deleted_at IS NULL` companion of
    [soft delete](#soft-delete), say. Its predicate goes into `ON CONFLICT (…) WHERE …`, so a
    conflict is detected only against the rows the index covers. On SQLite the predicate is
    written with its values inline (SQLite matches it to the index as written, so
    `status = 'active'` works), and `action: NOTHING` on such a target is spelled as an update
    that matches no row, since SQLite cannot parse the predicate before `DO NOTHING`
-   `contextValues` columns are never overwritten on conflict — see
    [columns the server owns](#columns-the-server-owns)
-   `action: NOTHING` inserts nothing and returns nothing for the conflicting row. An `UPDATE`
    with no columns left to write degrades to the same thing
-   `values` is the same `Create<Type>Input` the insert mutations take, so turning `insert`
    off does not remove it

### A null key is an absent key

Which half of an upsert runs is decided by the key the request supplies, but a GraphQL client
cannot leave an input field out based on a variable's value. So one document carries both
halves with one nullable variable:

```graphql
mutation Save($id: Int, $name: String!) {
    upsertUsersSingle(values: { id: $id, name: $name }) {
        id
    }
}
```

`$id: null` inserts a new row; `$id: 1` overwrites row 1. An explicit `null` for a NOT NULL
column is treated as if the field had been left out, so the column's default fills it in —
the column cannot store null, so null cannot have been meant as the value to write. It works
the same for a database default (`serial`, `defaultRandom()`), a drizzle-side one
(`$defaultFn`), the plain `create*` mutations, and a batch where only some rows carry a key.

The key has to have *something* to fill it in: a primary key declared with no default at all
stays non-null on the create input, so a nullable variable in that position is a validation
error at query time rather than a NOT NULL violation from the database.

Dialect differences:

-   **PostgreSQL** and **SQLite** — the full surface above. A table with no primary key and no
    unique constraint has nothing to conflict on, so it gets no upsert mutations at all
-   **MySQL** — `ON DUPLICATE KEY UPDATE` fires on whichever unique key was violated and takes
    no predicate, so `<Type>OnConflict` there has only `action` and `update`. Because the
    conflict can be on any unique key, the default overwrite leaves out the primary key as well
    — copying a new row's key over the conflicting row's would move it. `action: NOTHING`
    becomes a no-op `ON DUPLICATE KEY UPDATE <key> = <key>` rather than `INSERT IGNORE`, so
    only a duplicate key is skipped: a value too long for its column or a foreign-key violation
    still fails the write. The mutations return `MutationReturn` like every other MySQL
    mutation

The build-wide `conflictDoNothing` option is deprecated in favour of this: it applies to every
`create*` mutation with no way for a request to opt out. `onConflict: { action: NOTHING }` is
the per-request replacement.

## Nested writes

`features.nestedWrites` adds a field per writable relation to every create and update input,
so a row and the rows it is related to can be written in one mutation:

```graphql
mutation {
    createPostsSingle(
        values: {
            title: "Hello"
            author: { connect: { email: { eq: "dan@example.com" } } }
            comments: { create: [{ body: "First" }, { body: "Second" }] }
        }
    ) {
        id
        author {
            name
        }
    }
}
```

Every relation field offers `create` and `connect`; on the update input, a relation whose
foreign key is nullable also offers `disconnect` and — for a to-many relation — `set`:

```graphql
mutation {
    updateUsersSingle(
        where: { id: { eq: 1 } }
        set: { posts: { set: [{ isPublished: { eq: true } }], create: [{ title: "New" }] } }
    ) {
        id
    }
}
```

-   `connect`, `disconnect` and `set` take the target's own `Filters` input — a list of them
    on a to-many relation, a single one that must match exactly one row on a to-one — so they
    select rows the same way a query does. A to-one `connect` that matches no row, or several,
    fails with `DRIZZLE_NESTED_WRITE_INVALID` before anything is detached. A to-one
    `disconnect` is just `disconnect: true`, since there is only one row to detach. A filter
    that matches everything is rejected rather than attaching the whole table
-   `set` replaces the relation wholesale — everything attached is detached first, then the
    filters attach. It runs before `create`, so a row created in the same write survives it
-   A to-one relation takes one operation at a time (`connect` **or** `disconnect` **or**
    `create`), and attaching to it detaches whatever was there
-   `disconnect` and `set` only exist where the foreign key is nullable; there is no way to
    detach a row whose key is `NOT NULL`
-   A column the relation fills in becomes nullable on the create input — with
    `author: { create: … }` available, `authorId` is one of two ways to supply it
-   Nesting is one level deep: the row a nested `create` inserts takes columns only, and the
    join column is left off, since the write it is part of sets it
-   The generated input types are `<Type><Relation>NestedCreateInput` and
    `<Type><Relation>NestedUpdateInput` for the operations, and
    `<Type><Relation>NestedCreatePayloadInput` for the row a `create` inserts — all named
    outside the root input namespace, so a relation whose name spells a sibling table's
    (`item.type` beside a table named `itemType`) is not a collision
-   Many-to-many (`.through()`) relations are written through their junction table — see
    below
-   The whole tree runs in one transaction — a savepoint when the request already carries one
    — so a failure anywhere leaves nothing behind
-   A `set` that carries only relation fields is a valid update: it changes what the row is
    attached to without rewriting the row
-   When the parent write produces no row — an update whose `where` matched nothing, an
    insert or upsert a conflict turned into a no-op — whatever a parent-side `create` inserted
    for it is rolled back too, so no orphan is left. In a batch only that entry is undone
-   An upsert whose conflict branch does not write the parent's join column (an
    `onConflict.update` that leaves it out) would update the existing row without attaching
    what a parent-side `create` or `connect` produced. That fails with
    `DRIZZLE_NESTED_WRITE_INVALID` and rolls the write back; list the column in
    `onConflict.update`, or leave `update` unset so every supplied column is written
-   The returned rows reflect the nested write: on a self-referencing relation
    (`reports: { connect: … }` on the row itself), where a child-side statement rewrites the
    parent row, the parent rows are read back after it
-   A relation joining on more than one column per side gets no nested-write field: setting
    one key would leave the rest of the join (a tenant column, say) unmatched and unwritten

### A relation's own `where`

A relation declared with a `where` (`publishedPosts: r.many.posts({ …, where: { published: true } })`)
is written through the same way it is read: only the rows it shows.

-   `disconnect`, `set`, and the detaching a to-one attach does, reach only rows that satisfy
    the `where` — `publishedPosts: { set: [] }` leaves the drafts attached. On a to-one whose
    key is on the parent, `disconnect` leaves a key that points at a row the `where` hides,
    and a `connect` that would replace such a key fails with `DRIZZLE_NESTED_WRITE_INVALID`
-   `connect` and `set` attach only rows that satisfy it, so the relation shows what was
    attached. A to-one `connect` must match exactly one such row
-   There is no `create`: the inserted row is attached whether or not it satisfies the
    `where`, and the relation could come back without it. Create it with its own mutation, or
    through a relation with no `where`
-   A many-to-many `set` unlinks only the links to rows the `where` shows
-   A relation that inherits its `where` from the other side (declared without `from` / `to`)
    filters the parent rather than the target. Writing through it on a parent row it is
    hidden for fails with `DRIZZLE_NESTED_WRITE_INVALID`. When the key is on the parent
    (`connect`, `create` or `disconnect` on a to-one), the row is judged as the write leaves
    it, so a write that also makes the row visible goes through

### The target table's own rules

A nested write is a write to another table, so it follows that table's rules, not just the
root field's:

-   **`scope`** and **`softDelete`** narrow the rows `connect` / `disconnect` / `set` can
    reach — a many-to-many `set` keeps the links to rows it cannot reach — and
    **`contextValues`** stamp the rows a nested `create` inserts. A relation keyed on a
    `contextValues` column is not offered at all, and the payload of a nested `create` leaves
    out the context columns and the soft-delete marker, as the target's own create input does
-   **`features`**: each nested input is generated only when the table it writes has that
    write turned on. Whatever is left out is noted on the console at build time, and a
    relation with nothing left loses its field altogether

    | Input | Needs, on the table it writes |
    | --- | --- |
    | `create` | the target's `insert` (and its `update` too on a to-one whose nullable key lives on the target, since attaching detaches the previous row) |
    | `connect` / `disconnect` / `set`, key on the target | the target's `update` |
    | `connect` / `disconnect`, key on the parent | nothing — only the parent's own row changes |
    | many-to-many `connect` | the junction's `insert` |
    | many-to-many `disconnect` | the junction's `delete` |
    | many-to-many `set` | the junction's `insert` and `delete` |

    An excluded junction table takes its relation's inputs with it. A table whose writes are
    reserved for a hand-written mutation (`insert: false`) can therefore no longer be written
    by another table's nested `create` either
-   **`onWrite`**: the hooks of the table a nested statement writes run too — see
    [Nested writes and hooks](#nested-writes-and-hooks)

### Many-to-many relations

A relation declared with `.through()` is written by inserting and deleting rows of its
junction table, so nothing about the two rows being linked changes:

```graphql
mutation {
    updatePostsSingle(
        where: { id: { eq: 1 } }
        set: { tags: { set: [{ name: { inArray: ["news", "release"] } }] } }
    ) {
        id
    }
}
```

-   It offers `connect` on the create input, and `connect`, `disconnect` and `set` on the
    update input. All three take the target's `Filters`, exactly as on a foreign-key relation
-   `disconnect` and `set` are offered unconditionally here: unlinking deletes a junction row
    rather than writing `NULL` into a column that might be `NOT NULL`
-   `connect` links every row its filters match and leaves already-linked rows alone, so
    re-connecting is a no-op rather than a unique-constraint error
-   `disconnect` deletes only the links, never the rows they pointed at
-   The junction's own `scope` and [soft delete](#soft-delete) apply to its link rows, as they
    do when the relation is read (see [junction rows](#junction-rows)): `disconnect` and `set`
    never unlink a row the request's junction scope hides, and `connect` does not count a
    hidden or marked link as already linked. On a soft-deleting junction, unlinking marks the
    link row rather than deleting it, as a delete of that table does, and linking a pair whose
    row is marked restores it rather than inserting a second one
-   `set: []` unlinks everything and links nothing back, which is how a many-to-many relation
    is cleared. "Everything" is everything the request could have unlinked: links to rows
    outside the target's `scope`, soft-deleted, or hidden by the relation's own `where` stay
-   There is no `create`: inserting a row *and* linking it is a write to two tables, and the
    link is what the relation field is for. Create the row with its own mutation, then
    `connect` it
-   A relation is left out when its junction carries a further `NOT NULL` column with no
    default — a filter alone could not supply a value for it — unless every insert stamps that
    column anyway (a `contextValues` column, or a soft-delete marker); and when it is declared as a
    to-one, whose "exactly one" guarantee lives in the junction's constraints rather than in
    the relation

Dialect support: **PostgreSQL**, and **SQLite** on an asynchronous driver (libsql, D1). A
nested write reads back the key of the row it just wrote, which MySQL has no `RETURNING` for,
and interleaves awaited statements inside a transaction, which a synchronous SQLite driver
cannot do — `buildSchema` rejects both combinations rather than generating something that
half-works.

## Atomic column updates

`Update<Table>Input` sets columns to values, so "increment the view count" is a read followed
by a write of the number the read returned — two round-trips, and a lost update whenever two
clients read the same number. `features.fieldUpdateOperations` replaces qualifying columns'
update fields with an operations input, so the arithmetic happens in the database:

```graphql
mutation {
    updatePostsSingle(where: { id: { eq: 1 } }, set: { views: { increment: 1 } }) {
        views
    }
}
```

compiles to `SET views = views + 1`. The flag changes the update inputs only; insert inputs
are untouched.

-   **Numeric columns** (`Int`, `Float`, `BigInt`, `Decimal`) take
    `set` / `increment` / `decrement` / `multiply` / `divide`
-   **Array columns** take `set` / `push`, where `push` appends to the existing array
-   Exactly one operation per column. Passing two, or `{}`, is a `GraphQLError` naming the
    column — graphql-js has no `@oneOf` on the version range this library supports, so it is
    enforced at resolve time rather than by the type
-   `set` is the explicit spelling of the plain assignment the field had before the flag, so
    every existing update has a one-key rewrite: `{ views: 5 }` → `{ views: { set: 5 } }`
-   The input types are named for the **scalar**, not the column — every `Int` column in the
    schema shares one `IntFieldUpdate` — and a column claimed by a `scalarOverrides` entry
    keeps its plain field, since the override decides what that column accepts

Two things follow the database's own semantics rather than being guarded:

-   `increment`/`multiply` on an integer column can overflow, and `divide` on one **rounds**
    the way the dialect rounds (PostgreSQL truncates toward zero; use a `Float` or `Decimal`
    column if you need the fraction)
-   `divide: 0` raises the driver's division-by-zero error, surfaced as a `GraphQLError`

## Row counts instead of rows

The plural `update<Table>` / `delete<Table>` mutations always `RETURNING *`, which is wasted
work — and wasted bandwidth — when a client only wants to know how many rows were touched.
`features.countMutations` adds a count-returning variant of each:

```graphql
mutation {
    deletePostsCount(where: { status: { eq: "spam" } })
    updatePostsCount(where: { draft: { eq: true } }, set: { draft: false })
}
```

-   Both return `Int!` — the number of rows the write affected — and add no new output type
    to the schema
-   Arguments are exactly the plural mutation's, so a client swaps one field name for the
    other; `features.requireWhere` applies to them the same way, and on a soft-deleting
    table that opted into `hardDelete` the delete takes `hard` too
-   They follow the feature switch of the write they mirror: `updateCount` needs
    `features.update`, `deleteCount` needs `features.delete`
-   They obey the same row policies as the plural write — only the answer differs:
    -   [`scope`](#row-scoping-and-multi-tenancy) is ANDed into the `where`, so they reach,
        and count, only in-scope rows
    -   on a [soft-deleting](#soft-delete) table `delete<Table>Count` marks the rows rather
        than removing them, and neither mutation reaches a row that is already marked
    -   a [`contextValues`](#row-scoping-and-multi-tenancy) column is never reassigned by the
        update
    -   [`onWrite`](#write-hooks) hooks run `before` and `after`, in a transaction, with the
        plural write's payload (`operation: 'update'` / `'delete'`, `single: false`). An
        `after` hook is handed rows, so a table with one gives up the returnless write: the
        statement `RETURNING`s the hook's `columns`, or just the primary key when it names
        none (every column, on a table without a key), and the count is the number of rows
        returned. Without an `after` hook there is no `RETURNING` at all. On MySQL the hook
        gets `rows: []`, as it does on every MySQL mutation
-   Their [`extensions.drizzle`](#identifying-generated-fields) is the plural write's
    (`operation: 'update'` / `'delete'`, `targetArg: 'where'`) plus `count: true`, so a
    wrapper that gates writes on `operation` covers them too
-   **MySQL** gets them too, and they are arguably most useful there: MySQL's other mutations
    return only `MutationReturn { isSuccess }`, so a row count is strictly more information
-   `update<Table>Count` **rejects** nested writes with a `GraphQLError` — a nested write
    needs the parent rows this mutation deliberately does not read back. Use the plural
    mutation for those
-   The count is read from whichever field the driver reports it in (`rowCount`,
    `affectedRows`, `rowsAffected`, `changes`, `count`); a driver that reports none is a
    `GraphQLError` rather than a silent `0`

## Single-row update & delete

Alongside the plural `update<Table>` / `delete<Table>` mutations, every table gets an
`update<Table>Single` / `delete<Table>Single` variant that targets exactly one row. (Under a
[`typeNameMapper`](#naming) the pair is separated by the noun instead — `updateUsers` /
`updateUser` — and there is no `Single`.)

```graphql
mutation {
    updateUsersSingle(where: { id: { eq: 1 } }, set: { name: "Dan" }) {
        id
        name
    }
}
```

-   `where` is **non-null** and must contain at least one filter — `where: {}` is rejected at
    resolve time, so a Single write can never become an unbounded one
-   The return type is the single (nullable) row type, not a list: the affected row comes back
    directly, and **no match returns `null`** instead of an empty list
-   If `where` matches **more than one row**, the mutation throws a `GraphQLError` and writes
    nothing — the match is checked (`LIMIT 2`) before the write runs
-   **MySQL** cannot return the affected row (no `RETURNING`), so its Single variants keep the
    single-match and non-empty-`where` guarantees but return `MutationReturn` like every other
    MySQL mutation
-   The variants are generated under `features.update` / `features.delete`, share the plural
    mutations' input types, and appear in `entities.mutations` for custom schemas

### Mutation return shapes

Every mutation that returns rows returns them non-null, with two exceptions that are
deliberate rather than accidental:

| Mutation | Returns | Why |
| --- | --- | --- |
| `create<Table>Single` | `Table!`, or `Table` under `conflictDoNothing` | An insert of one row returns that row. It can only fail to produce one when the `conflictDoNothing` build option swallows a conflict, so it is nullable exactly when that option is set |
| `update<Table>Many` | `[Table]!` | Each entry's updated rows **in entry order**. An entry whose `where` matched nothing contributes `null` in its slot, so the response lines up with the request positionally — the nullable element is the whole point |
| everything else | `[Table!]!` / `Table!` / `Table` | — |

The plural mutations still accept a missing `where` (a full-table write) by default. To rule
that out at the type level, `features: { requireWhere: true }` makes `where` non-null on
`update<Table>` / `delete<Table>` and rejects a `where` with no filters, exactly like the
Single variants. It also covers `update<Table>Many`: an entry without a `where`, or with one
that has no filters, rejects the whole batch with `DRIZZLE_WHERE_REQUIRED` before any entry
runs. It defaults to `false` for backwards compatibility.

## Bounding page size

Nothing stops a client asking a list query for every row it has. `limits` sets a page size for
a request that names none, a ceiling for one that does, or both:

```ts
buildSchema(db, {
  limits: {
    defaultLimit: 25,
    maxLimit: 100,
    tables: {
      Posts: { defaultLimit: 50 },
      AuditLog: { maxLimit: 10, clampToMax: true },
    },
  },
});
```

| Key | Effect |
| --- | --- |
| `defaultLimit` | The `limit` applied when the request passes none |
| `maxLimit` | The largest `limit` a request may ask for |
| `clampToMax` | `false` (default) rejects a `limit` above `maxLimit`; `true` reduces it |
| `tables` | Per-table overrides, keyed by the table's key in your Drizzle schema |

A per-table policy overrides the global one key by key, so `AuditLog` above still inherits
`defaultLimit: 25`. Everything is optional; a build with no `limits` behaves exactly as before.

Two details worth stating plainly:

-   **`maxLimit` alone also bounds a request that passes no `limit`.** No limit means every
    row, which is above any maximum, so such a request runs at `maxLimit`.
-   **A rejection is the default because truncation lies.** Silently cutting a page down to
    `maxLimit` tells a paginating client it has reached the end when it has not. `clampToMax:
    true` opts into that when you would rather never fail a query.
-   **A negative `limit` or `offset` is always rejected** with `DRIZZLE_INVALID_INPUT_VALUE`,
    whether or not `limits` is configured — on root lists, single queries, relation fields and
    `resolveSelection`. SQLite reads `LIMIT -1` as "no limit", so a negative value would
    otherwise walk straight past `maxLimit`; `0` stays valid and returns no rows.

The policy applies to root list queries and to to-many relation fields, on both the eager and
the lazy relation paths. A relation takes the policy of the table it *reads*, not its parent's:
with `tables: { Posts: { maxLimit: 10 } }`, `users { posts(limit: 50) }` is rejected. Cursor
pagination inherits it — a page defaults to `defaultLimit` and the `cursor` values stay usable.

What it does not touch: `<tableName>Single` queries, which are already one row; aggregate,
group-by and `<relation>Aggregate` fields, which count over the whole table rather than
returning rows; and to-one relation fields, which take no `limit` at all.

## Query cost

Generated fields carry a `complexity` hint in their GraphQL extensions, ready for
[`graphql-query-complexity`](https://github.com/slicknode/graphql-query-complexity)'s
`fieldExtensionsEstimator`. The generator knows which fields are paginated and which are
aggregates, so the cost tracks the rows a query can actually pull rather than the number of
fields it mentions:

| Field | Cost |
| --- | --- |
| List query, to-many relation | `(limit ?? defaultListSize) * childComplexity` |
| Aggregate query, group-by query, `<relation>Aggregate` | `aggregateCost + childComplexity` |
| Everything else | no hint — your estimator's default applies |

So `users(limit: 20) { id posts(limit: 5) { id } }` costs `20 * (1 + 5 * 1)` = 120, while the
same query without limits costs `10 * (1 + 10 * 1)` = 110.

A [limit policy](#bounding-page-size) feeds into the hint: a field with no `limit` is priced at
its `defaultLimit` (or at `maxLimit` when the policy sets only that) rather than `defaultListSize`,
and nothing is priced above `maxLimit`, so the cost matches the rows the query can actually pull.

The hints do nothing until you install a complexity rule, so they are generated by default:

```ts
import { createComplexityRule, fieldExtensionsEstimator, simpleEstimator } from 'graphql-query-complexity';

const rule = createComplexityRule({
  maximumComplexity: 1000,
  estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
});
```

Tune the two assumptions, or turn the hints off entirely:

```ts
buildSchema(db, {
  complexity: { defaultListSize: 25, aggregateCost: 50 },
});

buildSchema(db, { complexity: false });
```

### Depth

Cost is not a depth bound. A cyclic relation graph (`user -> posts -> author -> posts -> …`)
lets a client nest as deep as it likes, and a deep query over cheap fields can stay under any
complexity ceiling. Set `relationsDepthLimit: 0` to generate no relation fields at all, or —
more usefully — bound depth at the edge, along with the rest of the document-shape defences
below.

### Hardening a public endpoint

A generated schema is wide by construction: every table is reachable, every relation is
traversable, and the relation graph is usually cyclic. The `complexity` hints price that
surface, but only for the shapes the generator knows about, and nothing in this library
inspects the incoming document. For a schema exposed to untrusted clients, put
[GraphQL Armor](https://github.com/Escape-Technologies/graphql-armor) in front of it — it
bundles the document-level defences this library deliberately does not generate:

| Protection | What it bounds |
| --- | --- |
| `maxDepth` | nesting through a cyclic relation graph |
| `maxAliases` | the same expensive list requested many times under many aliases |
| `maxDirectives` | directive-count amplification |
| `maxTokens` | parser blow-up, rejected before validation runs |
| `costLimit` | a static per-document cost ceiling |
| `blockFieldSuggestion` | `Did you mean "keyHash"?` leaking field names on a typo |

```ts
import { EnvelopArmor } from '@escape.tech/graphql-armor';
import { createYoga } from 'graphql-yoga';

const { schema } = buildSchema(db);
const armor = new EnvelopArmor({
  maxDepth: { n: 8 }, // roughly three relation hops into the generated graph
  maxAliases: { n: 15 },
  costLimit: { maxCost: 5000 },
});

const yoga = createYoga({ schema, plugins: armor.protect().plugins });
```

`ApolloArmor` is the Apollo Server equivalent — its `protect()` returns `plugins` plus
`validationRules`.

Armor's `costLimit` is its own document-shape estimate and does not read the `complexity`
extensions above; the two compose, if you want a cheap static ceiling alongside row-count
aware pricing. Neither one bounds an individual `limit` argument — a list query with no
`limit` is still a full table scan unless you set a [`limits`](#bounding-page-size) policy.

## Authorization

`buildSchema` is handed a Drizzle instance, not a request. It has no notion of who is asking,
so it generates no authorization: every table it knows about is queryable and writable by
anyone who can reach the endpoint. Auth belongs to a layer above the schema, where the
request context actually lives.

-   **[graphql-shield](https://github.com/maticzav/graphql-shield)** — permission rules
    mapped onto fields and applied with
    [`graphql-middleware`](https://github.com/maticzav/graphql-middleware). Rules attach to
    root fields *and* to fields of a generated object type, which is what makes it an answer
    to "this column must never leave the server" and not just "this query is blocked":

    ```ts
    import { applyMiddleware } from 'graphql-middleware';
    import { allow, deny, rule, shield } from 'graphql-shield';

    const isAuthenticated = rule()((parent, args, ctx) => Boolean(ctx.userId));

    const { schema } = buildSchema(db);
    const guarded = applyMiddleware(
      schema,
      shield(
        {
          Query: { users: isAuthenticated, usersSingle: isAuthenticated },
          Mutation: { '*': isAuthenticated },
          ApiKeys: { keyHash: deny }, // field stays in the schema, never resolves
        },
        { fallbackRule: allow },
      ),
    );
    ```

-   **[CASL](https://casl.js.org)** (`@casl/ability`) — one ability definition, conditions and
    field lists included (`can('read', 'Posts', ['title', 'body'])`), shared between the
    GraphQL layer and the rest of the app instead of a permission model that exists only in
    the API. CASL is not GraphQL middleware itself: wire it in through the shield rules above
    or through your own resolver wrapper, and let the ability answer the questions.

What neither can do is **narrow** a query. They permit or deny a field; they do not append
`WHERE org_id = …` to the SQL a generated resolver runs, so a permitted `posts` query still
returns every tenant's rows. That is what [`scope`](#row-scoping-and-multi-tenancy) is for: a
per-table predicate built from the request context and ANDed onto every read and write of
that table, nested relation fields included. Pair it with
[`contextValues`](#columns-the-server-owns) so new rows are stamped with the caller's tenant.
The usual split is shield (or CASL) to decide who may reach a field, and `scope` to decide
which rows they see through it.

None of this removes anything from introspection either — `deny` hides the data, not the
shape. If the schema must not so much as mention a table or column, leave it out with
[`exclude`](#excluding-tables-and-columns).

Nor is it a row bound: a complexity ceiling prices the `limit` a client asks for, it does not
cap it. Use [`limits`](#bounding-page-size) for that.

## Error handling

Database drivers put a lot into an error message. Drizzle rethrows them with the full SQL
statement and its bound parameters attached, and Postgres itself names the table, the column
and the constraint that was violated. None of that belongs in a GraphQL response, so by
default every error a generated resolver throws is passed through a sanitizer:

-   errors drizzle-graphql raises itself (`Unable to update with no values specified!`,
    `Field 'x' is not a valid date!`, filter misuse, …) are written for the client and pass
    through unchanged
-   anything else becomes `Internal server error` with `extensions.code:
    "INTERNAL_SERVER_ERROR"`, and the original is kept on the error's `originalError` so a
    server-side logger can still see it

`onError` overrides this. Return an error to surface that one, or return nothing to let the
default apply — which makes it a pure logging hook:

```Typescript
const { schema } = buildSchema(db, {
    onError: (error) => {
        logger.error({ err: error }, 'drizzle-graphql resolver failed')
        // no return value — the default sanitizing still applies
    },
})
```

```Typescript
// Surface raw database errors, e.g. in development
buildSchema(db, { onError: (error) => error as Error })

// Or map them yourself
buildSchema(db, {
    onError: (error) =>
        isUniqueViolation(error)
            ? new GraphQLError('That record already exists', { extensions: { code: 'CONFLICT' } })
            : undefined,
})
```

The hook covers root queries and mutations, relation and aggregate fields, and the
standalone `entities.fieldResolvers`. The default is exported as `defaultErrorMapper` if you
want to fall back to it explicitly.

### What an error carries

Every error the library raises itself carries its context as data, so nothing downstream has
to match on prose:

```json
{
    "message": "'where' matched more than one row — nothing was written!",
    "path": ["updateUsersSingle"],
    "extensions": {
        "code": "DRIZZLE_MULTI_ROW_MATCH",
        "drizzle": { "table": "Users", "operation": "update", "field": "updateUsersSingle" }
    }
}
```

-   `code` classifies the failure — `DRIZZLE_MULTI_ROW_MATCH`, `DRIZZLE_WHERE_REQUIRED`,
    `DRIZZLE_LIMIT_EXCEEDED`, `DRIZZLE_NO_VALUES`, `DRIZZLE_INVALID_FILTER`,
    `DRIZZLE_INVALID_CURSOR`, `DRIZZLE_INVALID_INPUT_VALUE`, and so on. The full union is
    exported as `DrizzleErrorCode`.
-   `drizzle` says what it was about: the Drizzle schema key of the `table`, the `operation`,
    the generated `field`, and the `relation` for a relation field. The type is exported as
    `DrizzleErrorContext`.

A value the request could not supply is `DRIZZLE_INVALID_INPUT_VALUE` — a date that does not
parse, a `BigInt` argument that is not an integer, a malformed JSON column value, a negative
`limit` or `offset` — and a write
naming something that is not a column of its table is `DRIZZLE_UNKNOWN_COLUMN`. The mirror
image, a stored value the scalar transporting it cannot represent, is
`DRIZZLE_UNREPRESENTABLE_VALUE`; it says the data is out of range, not that the request was
wrong.

An `update`'s `set` giving a `NOT NULL` column an explicit `null` is `DRIZZLE_NOT_NULL`, and the
error names the column. Every field of an update input is nullable — that is what makes a partial
`set` possible — so the nullability says nothing about the column, and an update has no default to
fall back on: `null` there can only mean "write null". Nothing is written, including the rest of
the `set`. To leave a column alone, omit it.

An **insert** reads the same `null` the other way, and is unchanged. A `NOT NULL` column's field
on a create input is non-null unless the database, drizzle, or a nested `create` can fill it in,
so the only nulls that reach a resolver are ones the schema offered as "I am not supplying this" —
and they let the default apply, which is what makes `id: $id` with a null variable insert a new
row. A `NOT NULL` column with nothing to fill it is rejected while GraphQL coerces the request.
Upserts take the create input, so they follow the insert rule.

The `drizzle` block is only on errors raised from inside a field. An argument rejected while
GraphQL coerces the request — a `BigInt` variable that is not an integer, say — is rejected
before any resolver runs, so it carries its `code` but no `drizzle` and no `path`.

The **generated** field name is in `extensions.drizzle.field` rather than in the message on
purpose. A schema that republishes these fields under other names — `RenameRootFields`, a
stitched gateway, a hand-written façade — renames the schema, not the inside of a message, so
a message naming `updateUsersSingle` would be telling a client about a field it has never
heard of. The name the client asked for is in `path`, already correct under any rename.

Driver errors are not classified: they are sanitized as above and keep
`code: "INTERNAL_SERVER_ERROR"` with no `drizzle` block, which is also how `onError` can tell
the two apart without inspecting messages.

## Transactions

Each resolver runs its statements on the database the schema was built from, so by default a
request that fires several mutations commits each one separately and a failure halfway leaves
the earlier ones in place. There are two ways to make a request atomic.

### Letting the library open one

`transactions: 'auto'` opens `db.transaction()` once per request whose document selects more
than one root mutation field, and runs every mutation field — plus the reads nested under
them — inside it:

```Typescript
const { schema } = buildSchema(db, { transactions: 'auto' })

// or, to change the safety timeout:
const { schema } = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: 10_000 } })
```

The transaction commits when the last mutation field completes and rolls back if any of them
fails; mutation fields after a failure fail fast instead of running against a rolled-back
transaction. A document with one mutation field or none opens nothing, so ordinary requests
are untouched.

-   The driver must support `db.transaction()` — `neon-http` does not. For SQLite only an
    asynchronous driver can hold a transaction open across resolvers, and `buildSchema`
    throws for a synchronous one rather than failing at request time
-   The GraphQL context value must be a fresh object per request (every mainstream server
    does this) — it keys the per-request transaction state
-   `timeoutMs` (default `30000`) rolls back an abandoned transaction, e.g. when the host
    server stopped calling resolvers because of a non-null completion error, instead of
    leaking the connection. It must be a positive integer up to `2147483647` (the longest
    delay `setTimeout` honours), or `Infinity` to turn the timer off; `buildSchema` throws for
    anything else. With the timer off an abandoned transaction keeps its connection, so prefer
    a finite value. Fields after a timeout fail with `DRIZZLE_TRANSACTION_ABORTED`, naming the
    timeout as the cause
-   A root field whose arguments fail to coerce is answered with an error without its resolver
    running, so it is not waited for: the transaction commits once the other fields complete
-   A document that mixes in mutation fields this build did not generate is left alone: their
    completion cannot be tracked, so no transaction is opened
-   It never nests — an executor supplied on the context wins, as below
-   A single mutation field can still run in a transaction of its own when it carries a
    nested write or its table has an `onWrite` hook — those open one regardless of this
    setting

### Supplying your own executor

To control the boundary yourself, open a transaction and put it on the GraphQL context under
the exported `drizzleExecutorKey`:

```Typescript
import { buildSchema, drizzleExecutorKey } from '@vantreeseba/drizzle-graphql'

const { schema } = buildSchema(db)

await db.transaction(async (tx) => {
    const result = await graphql({
        schema,
        source: request.query,
        variableValues: request.variables,
        contextValue: { [drizzleExecutorKey]: tx },
    })

    if (result.errors?.length) throw new Error('rolling back')
    return result
})
```

Every generated resolver reads the key at resolve time, so queries, mutations, aggregates
and relation field resolvers all run on the executor you supply and see its uncommitted
rows. With no key on the context, everything falls back to the build-time database, which
is what an ordinary request does.

The value does not have to be a transaction — any object with the same interface works, for
example a pooled connection bound to a tenant, or a logging proxy around `db`. Because the
key is created with `Symbol.for`, the ESM and CJS builds of this package agree on it when
both end up loaded in one process.

## Write hooks

`onWrite` runs a hook **inside the mutation's transaction**, so its writes commit or roll back
with the mutation itself. That is the position an audit row, an outbox row or a denormalized
counter needs, and the one a `graphql-middleware` wrapper cannot occupy — a wrapper sits
outside the resolver, so its after-position is after the commit.

```Typescript
const { schema } = buildSchema(db, {
    onWrite: {
        posts: {
            after: async ({ table, operation, rows, tx }) => {
                await tx.insert(auditLog).values(rows.map((row) => ({ table, operation, rowId: row.id })))
            },
            // Every row carries `id`, even when the client's mutation did not select it.
            columns: ['id'],
        },
    },
})
```

A bare function is the **`after`** hook — the position that has rows. `{ before, after }` names
them explicitly:

```Typescript
onWrite: {
    posts: {
        // Reads inside the same snapshot the write will use.
        before: async ({ args, tx }) => {
            const [parent] = await tx.select().from(orgs).where(eq(orgs.id, args.values[0].orgId))
            if (!parent) throw new Error('org went away')
        },
        after: async ({ rows, tx }) => { /* … */ },
    },
}
```

Registering a bare function (or a positions object) at the top level applies it to every table;
anything else is read as a table map keyed by the **Drizzle schema key**, and a name that
matches nothing throws at build time.

### Which columns `rows` holds

The statement's `RETURNING` list is built from the client's selection, so by default a row
holds only the columns the mutation's document asked for (plus any key a selected relation or a
nested write needed). A hook that reads a column the client may not select — `row.id` above, or
the `personId` an `addresses` hook needs to bump its person's revision — names it in `columns`:

```Typescript
onWrite: {
    addresses: {
        after: async ({ rows, tx }) => { /* every row has `id` and `personId` */ },
        columns: ['id', 'personId'],
    },
    contactInfos: {
        after: async ({ rows, tx }) => { /* every row has every column */ },
        columns: 'all',
    },
}
```

-   The names are **column keys** — the property names on the Drizzle table object, which is
    what `rows` is keyed by. An unknown name throws at build time, and so does `columns` on a
    registration with no `after` hook (only `after` is handed rows).
-   On a top-level registration, a named column must exist on **every** table; `'all'` always
    works.
-   The columns are added to `RETURNING` for every write the hook is attached to: insert, upsert,
    update, `updateMany`, delete and restore. A delete's rows are the rows it removed.
-   The [count mutations](#row-counts-instead-of-rows) fire the hooks as `update` / `delete`.
    The client selects nothing there, so an `after` hook's rows hold exactly its `columns`, or
    just the primary key when it names none — the one `RETURNING` those mutations pay for.
-   **The client's response is unchanged.** Columns the hook asked for but the client did not
    select are taken back off before the rows are mapped, so they reach neither the response nor
    a custom resolver calling the generated one. The hook gets its own copy of the rows.
-   **MySQL** has no `RETURNING`, so its mutations return no rows and `columns` has nothing to
    add to: `rows` stays empty there. The names are still checked at build time.

The payload:

| Field | |
| --- | --- |
| `table` | Drizzle schema key of the table being written |
| `operation` | `'insert' \| 'update' \| 'updateMany' \| 'upsert' \| 'delete' \| 'restore'` |
| `position` | `'before'` or `'after'` |
| `single` | whether the field writes one row or a list |
| `args` | the field's GraphQL arguments, as the resolver received them |
| `rows` | the post-write rows **as the database returned them**, before the output mapper — the selected columns plus the hook's [`columns`](#which-columns-rows-holds) |
| `context`, `info` | the GraphQL context value and resolve info |
| `tx` | the executor the mutation ran on |
| `nested` | `{ parentTable, relation, op }` when a [nested write](#nested-writes-and-hooks) wrote the rows; `undefined` at the mutation field's own table |

-   **`tx` is the executor the mutation itself used** — one you supplied under
    `drizzleExecutorKey`, the request's auto-transaction, or, for a field that would otherwise
    have run unwrapped, a transaction opened for it *because* the hook is there. The hook does
    not have to know which.
-   **Throwing rolls the mutation back.** A hook that can only log is what a logging plugin
    already does.
-   **SQLite needs an asynchronous driver** (libsql, D1). A synchronous one (better-sqlite3,
    `node:sqlite`) commits before an awaited hook runs, so a throw could not roll anything
    back; `buildSchema` throws for `onWrite` on one, as it does for `nestedWrites` and
    `transactions: 'auto'`.
-   **`rows` is empty** at the `before` position, and on MySQL, whose mutations return no rows.
    The `before` position and `args` still work there.
-   With `nestedWrites`, the hooks of **every table a nested write reaches** fire too —
    below.

A build with no `onWrite` opens exactly the transactions it did before.

### Nested writes and hooks

A nested `create` / `connect` / `disconnect` / `set` runs the `before` and `after` hooks of the
table its statement writes, on the same `tx`, with `payload.nested` saying where it came from:

```Typescript
onWrite: {
    todos: {
        before: async ({ nested, args, tx }) => { /* runs ahead of the nested statement too */ },
        after: async ({ operation, rows, nested, tx }) => {
            // createProjectsSingle(values: { …, todos: { create: [ … ] } }) arrives here as
            // operation: 'insert', nested: { parentTable: 'projects', relation: 'todos', op: 'create' }
            for (const row of rows) await assertOwnsProject(tx, row.projectId)
        },
        columns: ['projectId'],
    },
}
```

| Nested input | `table` | `operation` |
| --- | --- | --- |
| `create` | the target | `insert` |
| `connect` / `disconnect` / `set`, key on the target | the target | `update` (the foreign key moved; nothing is deleted) |
| `connect` / `disconnect`, key on the parent | — | no target hook: only the parent's row changes, and its own hook sees that |
| many-to-many `connect` | the junction | `restore` (marked links, on a soft-deleting junction), then `insert` |
| many-to-many `disconnect` | the junction | `delete` (a soft-deleting junction's rows are marked) |
| many-to-many `set` | the junction | `delete` (the old links), then `restore` and `insert` (the new ones) |

-   **`nested`** is `{ parentTable, relation, op }` — the Drizzle schema key of the table whose
    input carried the relation field, the relation's name, and which of its inputs this is.
    It is `undefined` at the mutation field's own table, so a hook that only cares about root
    writes starts with `if (payload.nested) return`
-   **One call per input and operation**, not per row: a nested `create` of three rows is one
    `insert` call with three rows, and an update whose `where` matched several parents hands
    the hook every child it wrote across all of them. A to-one `connect` that also detaches
    the row attached before is one `update` call holding both rows; a detached row's key is
    `null`
-   **`rows`** hold the table's primary key and the join column(s) the statement changed — a
    nested write has no client selection of its own — plus whatever the hook names in
    `columns`
-   **`args`, `context` and `info`** are the root mutation field's; **`single`** says whether the
    relation is a to-one
-   **`before`** runs ahead of that input's first statement, **`after`** once its last has
    returned, and both inside the transaction every nested write opens — so a hook on a child
    table can roll the whole tree back, the parent row included, even when the root field has
    no hook of its own


## Relations & N+1 handling

Generated schemas resolve nested relations without N+1 query explosions:

-   **Queries** — root queries (`entities.queries.*`) eagerly load every requested
    relation in a single round-trip using Drizzle's relational query builder
    (`with:`), including nested relations and per-relation `where` / `orderBy` /
    `limit` / `offset` arguments.
-   **Mutations (PostgreSQL & SQLite)** — after an insert, upsert, update or `updateMany`, if the selection set
    includes relation fields, the affected rows are re-fetched by primary key through one
    relational query so their relations are eagerly loaded (single- and composite-column
    primary keys are supported). `delete` and `restore` mutations keep using the
    request-scoped batch loader. MySQL mutations return only a success flag (no row
    payload), so this step does not apply there.
-   **Custom schemas** — each relation field also has a standalone resolver, exported as
    `entities.fieldResolvers[TableName][relationName]`. When you wire generated types
    into your own schema and your root resolver does **not** pre-fetch relations, these
    resolvers batch all sibling loads in a request into a single `IN (…)` query
    (request-scoped, keyed on the GraphQL `context`), preventing N+1. Per-parent
    `limit` / `offset` on a to-many relation is applied across the whole batch using a
    `ROW_NUMBER() OVER (PARTITION BY …)` window function — still one query, not one per
    parent. A relation joined on several columns (`from: [a, b], to: [x, y]`) is batched,
    grouped and partitioned by all of them, matching the parents with
    `(a = … AND b = …) OR …` instead of `IN (…)`, nested as a balanced tree so a batch of
    thousands of parents stays within SQLite's expression-depth limit. A batch over 10,000 key
    parameters runs as several queries, each parent read whole by one of them. The parent's join values are bound as the
    column holds them, not in their GraphQL output form, so a relation joined on a timestamp,
    `date`, `bigint` or decimal column works on this path and in `<relation>Aggregate` too. A
    parent row this library remapped keeps its original values for that; a parent your own
    resolver built in GraphQL form (an ISO string for a timestamp, say) has them mapped back the
    way an input value would be, which cuts a `'string'`-mode microsecond timestamp to
    milliseconds — return the row as drizzle read it to keep the full precision.

    ```Typescript
    // entities.fieldResolvers is keyed by table name, then relation name
    const usersPostsResolver = entities.fieldResolvers.Users.posts
    ```

> [!IMPORTANT]
> Per-parent paginated relations (a to-many relation field with `limit` or `offset`)
> and the `distinct` argument rely on SQL window functions. These require **PostgreSQL**,
> **MySQL 8.0+**, or **SQLite 3.25+**. Everything else has no such requirement.

### Relation nullability

A **to-many** relation field is always `[Target!]!`. A **to-one** relation field is
nullable by default, but honors the relation's declared optionality: declaring
`optional: false` on a Drizzle `one` relation — the assertion that the related row always
exists, i.e. a `NOT NULL` foreign key — emits the field as `Target!`:

```Typescript
const relations = buildRelations({ Users, Posts }, {
    Posts: {
        // posts.author_id is NOT NULL → author: Users!
        author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id, optional: false }),
    },
})
```

Only the explicit `optional: false` declaration is honored — required-ness is never
inferred from column nullability, since a `NOT NULL` `from` column does not guarantee a
related row exists when the constraint lives on the other side of the join. Note that on a
required relation, a `where` argument that filters out the related row (or a dangling
foreign key) resolves to `null` and therefore surfaces as a GraphQL non-null error.

### Overriding a relation's resolver without overfetching

By default the eager `with:` pre-fetch is driven purely by the GraphQL selection set:
any selected relation is fetched from the database, even if you intend to resolve it
yourself (from a cache, another service, a dataloader, …). To override a relation's
resolver, first opt it out of eager loading with `eagerLoadRelations` so the parent
query stops fetching it, then supply your resolver with the standard
[`@graphql-tools/schema`](https://the-guild.dev/graphql/tools) utilities:

```Typescript
import { addResolversToSchema } from '@graphql-tools/schema'

const { schema } = buildSchema(db, {
    // Exclude Users.posts from the parent query's `with:` clause.
    // Other relations keep eager-loading as usual.
    eagerLoadRelations: (table, relation) => !(table === 'Users' && relation === 'posts'),
})

const finalSchema = addResolversToSchema({
    schema,
    resolvers: {
        Users: {
            posts: (parent, args, context) => context.postsLoader.load(parent.id),
        },
    },
})
```

`eagerLoadRelations` accepts:

-   `true` (default) — eager-load every relation.
-   `false` — never eager-load; every relation resolves lazily through its
    (request-batched) field resolver.
-   `(tableName, relationName) => boolean` — decide per relation. Returning `false`
    excludes that relation from `with:` (and from the mutation eager re-fetch).

Opting a relation out does **not** remove its field — it keeps resolving lazily via the
request-scoped batch loader, so the field still works even before you override it — in a
mutation payload as well, where the write returns the join column the relation correlates on
even though the selection never named it. A
many-to-many (`.through()`) relation whose junction has a composite key cannot be loaded
lazily (`DRIZZLE_UNSUPPORTED_RELATION`); leave it eager-loaded. Table
and relation names are the Drizzle schema keys (e.g. `Users`, `posts`), matching the keys
of `entities.fieldResolvers`.

## Writing your own resolver over a generated type

When you replace or wrap a generated resolver — to add a permission check that needs the
row, to run a write inside your own transaction, to enforce a rule the schema cannot
express — you become responsible for returning a row shaped like the type you replaced.
That means translating the GraphQL selection set into the relational query builder's
`with:` tree: relation field resolvers only fill in relations the parent did not already
provide.

Two exports do that for you, alongside the already-exported `extractFilters` and
`extractOrderBy`:

```Typescript
import { resolveSelection, selectionToWith } from '@vantreeseba/drizzle-graphql'

// The whole read: selected columns, relation arguments, eager loading, cursor
// pagination, and the transport remapping of the result — against any executor.
const rows = await resolveSelection(info, {
    db,
    table: 'Users',
    context, // the resolver's context — required when the build configures `scope`
    where: { id: { eq: userId } },
    executor: tx, // defaults to `db`; pass a transaction to see its own writes
})

// Or just the `with:` tree, if you are building the query yourself.
const withTree = selectionToWith(info, { db, table: 'Users', context })
const row = await tx.query.Users.findFirst({ where: { id: userId }, with: withTree })
```

`selectionToWith` resolves fragments and inline fragments against `info.fragments`,
intersects the selection against the relations config (so scalars and any fields you added
yourself drop out instead of becoming invalid `with:` keys), follows aliases back to the
relation they select, compiles each relation's `where` / `orderBy` / `limit` / `offset`
into its nested entry, and leaves `<relation>Aggregate` selections out — they are not
`with:` entries. It returns `undefined` when the selection asks for no relations.

`resolveSelection` additionally accepts `single`, `orderBy`, `limit`, `offset`, `after` and
`deleted`, and returns the rows already remapped to their GraphQL transport forms.

Both apply the build's row policies the way the generated fields do, so an override is not a
way around them. `resolveSelection` scopes and soft-delete-filters the root table, applies the
table's `limits` and `defaults.orderBy` to the root list, and applies all four to every nested
relation. `selectionToWith` applies them to the nested relations in the tree it returns. The
root query you run with it is yours to scope.

They find the build through the resolve info: the field's return type, the root table's type in
the executing schema, or the parent type, whichever the build generated. That works for a schema
assembled from `entities.types`, and for one a tool such as `mapSchema` rebuilt, because the
build is found through each type's `extensions.drizzle`. Two things follow:

-   **Pass `context`.** Scope hooks take the request context, which resolve info does not
    carry. When the build configures `scope`, a call without `context` throws instead of
    reading unscoped. Soft delete, limits and default ordering need no context.
-   **Pass `info`, not a parsed tree, when one database has several builds.** A parsed
    selection tree carries no type to find the build by. Over a database with exactly one
    build, that build's policies apply. With several builds, the call throws if any of them
    has policies, since picking one could apply the wrong policies.

Both take the naming options the build used — `typeNameMapper`, `derivedTypeNameMapper`,
`typeNamePrefix` and `typeNameSuffix`. The translation matches selections against the
published GraphQL type names, so a build that renames its types has to say so here too. If
the build used `typeNameMapper: 'singularize'`, pass the exported `singularizeMapper`.

## Identifying generated fields

Every generated field and object type publishes what it is under `extensions.drizzle`, so
wrappers — `graphql-middleware`, envelop, `graphql-shield`, an audit log, a cache
invalidator — can ask the schema instead of parsing field names. Names are configurable
(`prefixes`, `suffixes`, `typeNameMapper`), which makes name parsing ambiguous by
construction; this is not.

```Typescript
import { drizzleExtension, identifyRows } from '@vantreeseba/drizzle-graphql'

const field = info.parentType.getFields()[info.fieldName]
const meta = drizzleExtension(field)
// {
//   table: 'Users',        // the Drizzle schema key
//   kind: 'mutation',      // 'query' | 'mutation' | 'relation' | 'aggregate' | 'type'
//   operation: 'update',   // 'select' | 'insert' | 'update' | 'updateMany' | 'upsert'
//                          // | 'delete' | 'restore' | 'aggregate' | 'groupBy'
//                          // | 'relation'
//                          // | 'relationAggregate'
//   single: true,          // one row, or a list
//   targetArg: 'where',    // 'where' | 'values' | 'updates' — where the rows live
//   primaryKey: ['id'],    // key columns of `table`, in schema order
// }

if (meta?.kind === 'mutation') await audit(meta.table, meta.operation, args[meta.targetArg])
```

`drizzleExtension` returns `undefined` for anything this library did not generate, which is
the check to make before treating a field as one of ours. Relation fields (and
`<relation>Aggregate` fields) additionally carry `relation` and `parentTable`, with `table`
naming the relation's **target** — so `Users.posts` reads as
`{ table: 'Posts', parentTable: 'Users', relation: 'posts' }`. Object types carry
`{ table, kind: 'type', primaryKey }`, which is what a stitching layer needs to map a type
back to its source. The [count mutations](#row-counts-instead-of-rows) carry their plural
write's `operation` plus `count: true` — they write the same rows but resolve to an `Int!`, so
a wrapper that reads the result as rows should check `count` first.

Because the row identity of a mutation lives in a different argument for every operation,
`identifyRows` reads whichever one applies and hands back primary-key values:

```Typescript
const target = identifyRows(field, args)
// { table: 'Users', primaryKey: ['id'], rows: [{ id: 3 }], complete: true }

if (target?.complete) await invalidate(target.table, target.rows)
```

It understands `values` (one object or a list), `where` (`eq` for one row, `inArray` for
many, an equality on every column of a composite key), and the per-entry `where` inside a
batch update's `updates`. Check `complete` before treating `rows` as the affected set: it
is `false` when the arguments do not pin the rows down — an insert whose key the database
generates, a filter on something other than the primary key, a key operand that is `null`
(which filters nothing, so the write reaches every row), a second operator beside a key
column's `eq`, an unbounded update, a
table with no primary key at all, or an upsert whose `onConflict` targets another unique key
or can skip a conflicting row (`action: NOTHING`, a `where`). On MySQL, where an upsert has
no `target` and conflicts on whichever unique key it hits, `complete` assumes the primary
key: do not rely on it for a table with other unique keys.

> [!NOTE]
> `extensions.drizzle` is stable API. The point of publishing it is that consumers stop
> parsing names, which only holds if the shape does not move: fields are added to it, never
> removed or repurposed.
## Configuration reference

Every key of the second argument to `buildSchema(db, config?)`. Each links to the section
that explains it, where there is one.

| Key | Default | What it does |
| --- | --- | --- |
| `mutations` | `true` | `false` omits the `Mutation` type entirely |
| `features` | see [Choosing what gets generated](#choosing-what-gets-generated) | which operations are generated, per operation |
| `exclude` | none | [tables and columns left out](#excluding-tables-and-columns) of the generated schema entirely |
| `relationsDepthLimit` | unlimited | `0` generates no relation fields (a flat, columns-only schema); any other value currently behaves like the default |
| `prefixes` / `suffixes` / `typeNameMapper` | see [Naming](#naming) | operation and type names |
| `typeNamePrefix` / `typeNameSuffix` / `derivedTypeNameMapper` | none | [names of the derived types](#renaming-the-derived-types) — filters, inputs, aggregates, shared inputs |
| `scalars` / `mapColumnType` | built-in detection | [override a column's GraphQL type](#overriding-a-columns-scalar), by name or by rule |
| `enumNameMapper` | shared `<EnumName>Enum` per database enum | [names the enum a column maps to](#enum-types) |
| `enumValueNameMapper` | the stored value | [names the enum's values](#enum-value-names); `'constant'` for CONSTANT_CASE |
| `describeColumn` / `describeTable` / `describeRelation` | none | [GraphQL descriptions](#documenting-the-schema) |
| `deprecateColumn` | none | `@deprecated` on a column's output and optional input fields |
| `conflictDoNothing` | `false` | **Deprecated** — use [`onConflict: { action: NOTHING }`](#upsert) per request. PostgreSQL and SQLite: `ON CONFLICT DO NOTHING` on every insert, which makes `create<Table>Single` nullable; ignored on MySQL |
| `complexity` | on | [cost hints](#query-cost) in field extensions; `false` turns them off |
| `transactions` | `'none'` | `'auto'` wraps a multi-mutation request in one [transaction](#transactions) |
| `limits` | unbounded | [default and maximum page size](#bounding-page-size), globally or per table |
| `defaults` | none | [per-table default `orderBy`](#default-ordering) for requests that omit one |
| `scope` | none | [row-level predicate](#row-scoping-and-multi-tenancy) every read and write of a table is confined to |
| `contextValues` | none | [columns the server stamps from context](#columns-the-server-owns) instead of accepting from the client |
| `softDelete` | none | [tables that mark rows deleted](#soft-delete) instead of removing them |
| `onWrite` | none | [hook that runs inside the mutation's own transaction](#write-hooks) |
| `onError` | replaces driver errors | [error handling](#error-handling) hook — log, or surface a different error |
| `eagerLoadRelations` | `true` | [which relations are pre-fetched](#overriding-a-relations-resolver-without-overfetching) with the parent query |
