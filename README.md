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
-   Many-to-many relations declared with `.through()` are not filterable yet and are left out
    of the filter input

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

Grouping (`groupBy`) is not supported yet.

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
