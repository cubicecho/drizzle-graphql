# Drizzle-GraphQL

Automatically create GraphQL schema or customizable schema config fields from Drizzle ORM schema

## Usage

-   Pass your drizzle database instance and schema into builder to generate `{ schema, entities }` object
-   Use `schema` if pre-built schema already satisfies all your neeeds. It's compatible witn any server that consumes `GraphQLSchema` class instance

    Example: hosting schema using [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)

    ```Typescript
    import { createServer } from 'node:http'
    import { createYoga } from 'graphql-yoga'
    import { buildSchema } from 'drizzle-graphql'

    // db - your drizzle instance
    import { db } from './database'

    const { schema } = buildSchema(db)

    const yoga = createYoga({ schema })

    server.listen(4000, () => {
        console.info('Server is running on http://localhost:4000/graphql')
    })
    ```

-   If you want to customize your schema, you can use `entities` object to build your own new schema

    ```Typescript
    import { createServer } from 'node:http'
    import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from 'graphql'
    import { createYoga } from 'graphql-yoga'
    import { buildSchema } from 'drizzle-graphql'

    // Schema contains 'Users' and 'Customers' tables
    import { db } from './database'

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
                    type: new GraphQLList(new GraphQLNonNull(entities.types.UsersItem)),
                    args: {
                        // You can reuse inputs as well
                        where: {
                            type: entities.inputs.UsersFilters
                        }
                    },
                    resolve: async (source, args, context, info) => {
                        // Your custom logic goes here...
                        const result = await db.select(schema.Users).where()...

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

    server.listen(4000, () => {
        console.info('Server is running on http://localhost:4000/graphql')
    })
    ```

## Naming the generated types and fields

By default every name comes from the table's key in the Drizzle schema: `tasks` gives type
`Tasks`, queries `tasks` / `tasksSingle`, mutations `createTasks` / `createTasksSingle`.
Most schemas use plural table keys and want singular type names, so that pairing is shipped
as a preset:

```Typescript
const { schema } = buildSchema(db, { typeNameMapper: 'singularize' })
```

`tasks` then gives type `Task`, queries `tasks` (list) and `task` (single), mutations
`createTasks` (array) and `createTask` (single), `updateTask`, `deleteTask`. Irregular
plurals go through `pluralize`, so `people` gives `Person` / `people` / `person` and
`addresses` gives `Address` rather than the `addresss` a naive suffix would produce. A table
key that is already singular is pluralized for the list side, and a capitalized key is
uncapitalized for the field side, so `tasks`, `task` and `Tasks` all land on the same names.

For anything else, pass your own function — it is asked per table and may return `undefined`
to leave that table with the default naming. The preset is exported as `singularizeMapper`
so it can be wrapped:

```Typescript
import { buildSchema, singularizeMapper } from 'drizzle-graphql'

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
        delete: false,            // delete<Table> / delete<Table>Single mutations
        upsert: true,             // upsert<Table> / upsert<Table>Single mutations (off by default)
        nestedWrites: true,       // relation fields on the create/update inputs (off by default)
        requireWhere: true,       // make `where` non-null on plural update/delete (off by default)
    },
})
```

-   Any flag left out keeps its default of `true`, so `{ features: { delete: false } }`
    changes nothing else
-   `upsert` and `nestedWrites` are the exceptions: both default to `false`, so the upsert
    mutations and the relation fields on the write inputs only exist if you ask for them
-   `groupBy` needs `aggregates`: it reuses those output types, so turning `aggregates` off
    turns the group-by queries off with it
-   Turning off `insert` or `update` also drops the input type that only that mutation
    used (`Create<Type>Input` / `Update<Type>Input`)
-   Turning off all three mutation features omits the `Mutation` type entirely, the same as
    `mutations: false`
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
    the whole relation graph, and a nested write reaches a second table by definition
-   `Mutation` is omitted when *no* table generates a mutation, and kept when one still does
-   Some operations are built out of others, and the generator knows which. A table that
    asks for `upsert` while its `insert` or `update` is off — an upsert is a second write
    path past the operation you turned off — warns on the console at build time, naming the
    tables, rather than leaving that to be discovered later. So does asking for `updateMany`
    without `update`, `groupBy` without `aggregates`, or `nestedWrites` alongside a table
    whose own writes are off

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
| `<Type>ConflictColumn` (upsert targets) | value removed |

Two details worth stating plainly:

-   **The exclusion is all-or-nothing on purpose.** A column you can filter on but not
    select is an oracle: `where: { keyHash: { eq: '…' } }` confirms a value without ever
    returning it. Ordering and grouping leak the same way, more slowly. There is no
    read-only or write-only variant of `exclude` for this reason.
-   **Nothing changes below the schema.** An excluded column is still written by its
    default, still read by the primary-key and cursor machinery, and still usable by your
    own resolvers. Only the generated schema stops mentioning it.

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
| `updatePosts`, `updatePostsMany`, `deletePosts` | an out-of-scope row is simply not matched |
| `upsertPosts` (conflict branch) | a conflicting row outside the scope is left alone, not taken over |
| nested `connect` / `disconnect` / `set` | only in-scope rows can be attached or detached |

Two things it deliberately does not do:

-   **It does not refuse.** A scoped `deletePosts(where: { id: { eq: 4 } })` on another
    tenant's row returns `[]`, the same answer as a row that does not exist. Telling the caller
    "that row exists but is not yours" is the leak the scope is there to close.
-   **It does not apply to a plain insert.** There is no existing row to filter. `contextValues`
    is the write-side half.

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
-   Every insert stamps it, including rows created by a nested `create`.
-   Updates never write it, so an update cannot hand a row to another owner.

Together the two close the loop: `contextValues` decides which tenant a new row belongs to, and
`scope` decides which rows a request can see and change afterwards.

> **MySQL caveat.** `ON DUPLICATE KEY UPDATE` takes no predicate, so a MySQL upsert's conflict
> branch cannot be scoped. Scope the table's `update` and rely on `contextValues` for the insert
> half.

Names that match nothing throw at build time, the same as `exclude` — a renamed column fails the
build instead of quietly ceasing to be scoped.

## Scalars

Columns whose values don't fit a built-in GraphQL scalar get a named custom scalar, so the
generated SDL says what a field actually holds instead of falling back to `String`:

| Drizzle column                             | GraphQL type | Transported as                       |
| ------------------------------------------ | ------------ | ------------------------------------ |
| `json` / `jsonb` (and `mode: 'json'`)       | `JSON`       | the parsed value                     |
| `bigint` (and `mode: 'bigint'`)             | `BigInt`     | a decimal string                     |
| `uuid`                                      | `UUID`       | a validated UUID string              |
| `timestamp` / `datetime`                    | `DateTime`   | an ISO-8601 string                   |
| `date`                                      | `Date`       | a `YYYY-MM-DD` string                |

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

The scalars are exported if you need them in a hand-written schema:

```Typescript
import { GraphQLBigIntString, GraphQLDate, GraphQLDateTime, GraphQLJSON, GraphQLUUID } from 'drizzle-graphql'
```

`GraphQLBigIntString` is the `BigInt` scalar — named for what it does rather than what it is
called in SDL, to avoid clashing with the language's own `BigInt`.

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
-   The declared name is PascalCased and suffixed: `user_status` → `UserStatusEnum`
-   A column that lists its values inline (`text('tier', { enum: ['free', 'paid'] })`) has no
    declared name to share, so it keeps a per-column type — `UsersTierEnum`
-   Two different enums that would land on the same GraphQL name (`status` in two Postgres
    schemas) fail the build rather than silently sharing a type

`enumNameMapper` overrides the name. Returning `undefined` keeps the default, so a mapper
only has to handle the cases it cares about:

```Typescript
const { schema } = buildSchema(db, {
    // `schema` is the Postgres schema the enum was declared in, if any; `values` is its
    // value list. Everything but `enumName` is always present.
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
-   The hook receives the drizzle column itself, so a project that keeps its documentation in
    the schema (a `.$type()` brand, a custom column property, a comment table) can read it
    straight off
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
document, alongside the whole-document `eq` / `ne` / `contains` operators:

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
-   `avg` / `sum` — one nullable `Float` field per numeric column
-   `min` / `max` — one field per orderable column (numbers, strings, enums, dates, bigints),
    typed exactly like that column is in the table's own type
-   `countNonNull` — `Int!` per column: how many matching rows have a non-null value there.
    Every column qualifies, since `count(col)` is valid whatever the type
-   `countDistinct` — `Int!` per column: how many distinct non-null values there are. Limited to
    the same columns as `min` / `max`, because counting distinct values needs an equality operator

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
    enum. It holds the orderable columns plus booleans — anything the database can group on.
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

-   `having: { count: … }` filters on the row count; `avg` / `sum` / `min` / `max` /
    `countNonNull` / `countDistinct` take one filter per column, over the same columns the
    matching aggregate type exposes
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
-   The field is skipped if its name would collide with a column or another relation

All parents in a selection are aggregated with a single
`SELECT <fk>, … WHERE <fk> IN (…) GROUP BY <fk>` per request, so `postsAggregate` on a list of
users is one extra query, not one per user. Differently-aliased selections with different
`where` arguments are batched separately.

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
    `orderBy`, that's the lowest primary key
-   `where` is applied **before** rows are collapsed; `limit` and `offset` are applied
    **after**, so `limit: 10` returns ten distinct rows
-   Several columns are treated as one combined key, not as independent ones
-   `distinct` is available on list queries only — a single query returns one row either way

It runs as an extra `row_number() over (partition by …)` query that picks the surviving
rows' primary keys, after which the main query is narrowed to them — so it needs the same
window-function support as per-parent paginated relations (**PostgreSQL**, **MySQL 8.0+**,
or **SQLite 3.25+**), and a table with no primary key cannot use it.

## Pagination ordering

SQL gives no ordering guarantee for a query that has no `ORDER BY`, so paging through an
unordered result can return the same row twice or skip one entirely. To keep pages stable,
a query that returns only part of a table is ordered by its primary key when the request
supplies no `orderBy`:

-   list queries with `limit` and/or `offset`
-   `<tableName>Single` queries, which are an implicit `limit 1`
-   to-many relation fields with `limit` and/or `offset` (as a tiebreak appended to any
    `orderBy` you do supply, so per-parent slices are deterministic)

An explicit `orderBy` always takes precedence, composite primary keys are ordered by every
key column, and an unpaginated list query is left unordered so no sort is paid for.

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
-   `NULL`s in ordered columns follow each dialect's native `ORDER BY` placement —
    PostgreSQL sorts them largest (last in `asc`), MySQL and SQLite smallest (first in
    `asc`) — and the predicate matches, so rows with `NULL` in an ordered column are paged
    through, not skipped
-   Dates and bigints round-trip losslessly through the cursor
-   A cursor is only valid under the ordering it was issued for — reusing it with a
    different `orderBy` (or a malformed/corrupted cursor) returns a `GraphQLError`
-   `after` cannot be combined with `distinct` or with `matchFilterOrder`, and a table with
    no primary key cannot use cursor pagination (its `cursor` field resolves to `null`)
-   If a table has a real column named `cursor`, the column wins and the meta field is
    skipped

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
-   `target` must match one of the table's unique constraints exactly; anything else is
    rejected with the list of valid targets, instead of the database's opaque "no unique or
    exclusion constraint matching" error
-   `action: NOTHING` inserts nothing and returns nothing for the conflicting row. An `UPDATE`
    with no columns left to write degrades to the same thing
-   `values` is the same `Create<Type>Input` the insert mutations take, so turning `insert`
    off does not remove it

Dialect differences:

-   **PostgreSQL** and **SQLite** — the full surface above. A table with no primary key and no
    unique constraint has nothing to conflict on, so it gets no upsert mutations at all
-   **MySQL** — `ON DUPLICATE KEY UPDATE` fires on whichever unique key was violated and takes
    no predicate, so `<Type>OnConflict` there has only `action` and `update`. `action: NOTHING`
    becomes `INSERT IGNORE`, and the mutations return `MutationReturn` like every other MySQL
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

-   `connect`, `disconnect` and `set` take the target's own `Filters` input, so they select
    rows the same way a query does. A filter that matches everything is rejected rather than
    attaching the whole table
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
-   Many-to-many (`.through()`) relations are not written through
-   The whole tree runs in one transaction — a savepoint when the request already carries one
    — so a failure anywhere leaves nothing behind
-   A `set` that carries only relation fields is a valid update: it changes what the row is
    attached to without rewriting the row

Dialect support: **PostgreSQL**, and **SQLite** on an asynchronous driver (libsql, D1). A
nested write reads back the key of the row it just wrote, which MySQL has no `RETURNING` for,
and interleaves awaited statements inside a transaction, which a synchronous SQLite driver
cannot do — `buildSchema` rejects both combinations rather than generating something that
half-works.

## Single-row update & delete

Alongside the plural `update<Table>` / `delete<Table>` mutations, every table gets an
`update<Table>Single` / `delete<Table>Single` variant that targets exactly one row:

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

The plural mutations still accept a missing `where` (a full-table write) by default. To rule
that out at the type level, `features: { requireWhere: true }` makes `where` non-null on
`update<Table>` / `delete<Table>` and rejects a `where` with no filters, exactly like the
Single variants. It defaults to `false` for backwards compatibility.

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
its `defaultLimit` rather than `defaultListSize`, and nothing is priced above `maxLimit`, so the
cost matches the rows the query can actually pull.

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
complexity ceiling. Put a depth limit in front of a publicly exposed schema as well — e.g.
[`graphql-depth-limit`](https://github.com/stems/graphql-depth-limit) — or set
`relationsDepthLimit: 0` to generate no relation fields at all.

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

## Transactions

Each resolver runs its statements on the database the schema was built from. A request that
fires several mutations therefore commits each one separately, and a failure halfway leaves
the earlier ones in place. To run a whole request as one unit, open a transaction yourself
and put it on the GraphQL context under the exported `drizzleExecutorKey`:

```Typescript
import { buildSchema, drizzleExecutorKey } from 'drizzle-graphql'

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

## Relations & N+1 handling

Generated schemas resolve nested relations without N+1 query explosions:

-   **Queries** — root queries (`entities.queries.*`) eagerly load every requested
    relation in a single round-trip using Drizzle's relational query builder
    (`with:`), including nested relations and per-relation `where` / `orderBy` /
    `limit` / `offset` arguments.
-   **Mutations (PostgreSQL & SQLite)** — after an insert or update, if the selection set
    includes relation fields, the affected rows are re-fetched by primary key through one
    relational query so their relations are eagerly loaded (single- and composite-column
    primary keys are supported). `delete` mutations keep using the request-scoped batch
    loader, since the rows no longer exist to re-fetch. MySQL mutations return only a
    success flag (no row payload), so this step does not apply there.
-   **Custom schemas** — each relation field also has a standalone resolver, exported as
    `entities.fieldResolvers[TableName][relationName]`. When you wire generated types
    into your own schema and your root resolver does **not** pre-fetch relations, these
    resolvers batch all sibling loads in a request into a single `IN (…)` query
    (request-scoped, keyed on the GraphQL `context`), preventing N+1. Per-parent
    `limit` / `offset` on a to-many relation is applied across the whole batch using a
    `ROW_NUMBER() OVER (PARTITION BY …)` window function — still one query, not one per
    parent.

    ```Typescript
    // entities.fieldResolvers is keyed by table name, then relation name
    const usersPostsResolver = entities.fieldResolvers.Users.posts
    ```

> [!IMPORTANT]
> Per-parent paginated relations (a to-many relation field with `limit` or `offset`)
> rely on SQL window functions. These require **PostgreSQL**, **MySQL 8.0+**, or
> **SQLite 3.25+**. Relations without pagination, and all other query/mutation paths,
> have no such requirement.

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
request-scoped batch loader, so the field still works even before you override it. Table
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
    where: { id: { eq: userId } },
    executor: tx, // defaults to `db`; pass a transaction to see its own writes
})

// Or just the `with:` tree, if you are building the query yourself.
const withTree = selectionToWith(info, { db, table: 'Users' })
const row = await tx.query.Users.findFirst({ where: { id: userId }, with: withTree })
```

`selectionToWith` resolves fragments and inline fragments against `info.fragments`,
intersects the selection against the relations config (so scalars and any fields you added
yourself drop out instead of becoming invalid `with:` keys), follows aliases back to the
relation they select, compiles each relation's `where` / `orderBy` / `limit` / `offset`
into its nested entry, and leaves `<relation>Aggregate` selections out — they are not
`with:` entries. It returns `undefined` when the selection asks for no relations.

`resolveSelection` additionally accepts `single`, `orderBy`, `limit`, `offset` and `after`,
and returns the rows already remapped to their GraphQL transport forms.

Both take a `typeNameMapper` option. If the schema was built with one, pass the same
function here — the translation matches selections against GraphQL type names, so a build
that renames its types has to say so.

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
//                          // | 'delete' | 'aggregate' | 'groupBy' | 'relation'
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
back to its source.

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
generates, a filter on something other than the primary key, an unbounded update, or a
table with no primary key at all.

> [!NOTE]
> `extensions.drizzle` is stable API. The point of publishing it is that consumers stop
> parsing names, which only holds if the shape does not move: fields are added to it, never
> removed or repurposed.
