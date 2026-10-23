# Descriptions on the generated SDL

Drizzle has no `.comment()` for tables or columns, and the library does not read database
comments (`COMMENT ON`). Descriptions come from hooks on `buildSchema`:

| Hook | Called with | Sets |
| --- | --- | --- |
| `describeColumn` | `(column, { tableName, columnName })` | column field description, everywhere the column appears: object type, create/update inputs, filter field, min/max aggregates, group keys |
| `describeTable` | `(tableName, table)` | object type description |
| `describeRelation` | `(tableName, relationName)` | relation field description (not the `<relation>Aggregate` field) |
| `deprecateColumn` | `(column, { tableName, columnName })` | `@deprecated` on output fields and optional input fields |

Each hook returns a string, or `undefined` for no description. `tableName` and
`columnName` are Drizzle schema keys. The `table` argument of `describeTable` exists in
releases after 15.0.0. On older versions, key table docs by `tableName`.

## Keep the text next to the schema

Because the hooks receive the Drizzle objects, you can store docs in a `WeakMap` keyed by
the table and its columns, and register them where the table is defined.

**Register on the built table, not on the column builders.** `text('email')` returns a
builder. `pgTable` / `mysqlTable` / `sqliteTable` create a new column object from it, so
the hook never sees the builder:

```ts
// WRONG: the hook receives users.email, which is not this builder object
const email = text('email');
docs.set(email, 'Primary login address');
export const users = pgTable('users', { email });
```

A helper that wraps the finished table:

```ts
// schema/docs.ts
import type { Table } from 'drizzle-orm';

const docs = new WeakMap<object, string>();

export const described = <T extends Table>(
  table: T,
  description: string,
  columns: Partial<Record<keyof T['_']['columns'], string>> = {},
): T => {
  docs.set(table, description);
  for (const [key, text] of Object.entries(columns)) {
    docs.set((table as any)[key], text as string);
  }
  return table;
};

export const describeFromSchema = {
  describeColumn: (column: object) => docs.get(column),
  describeTable: (_tableName: string, table: object) => docs.get(table),
};
```

```ts
// schema/users.ts
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { described } from './docs';

export const users = described(
  pgTable('users', {
    id: integer('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name'),
  }),
  'A person who can sign in.',
  {
    email: 'Primary login address. Unique, case-insensitive.',
    displayName: 'Name shown to other users. Falls back to the email local part.',
  },
);
```

```ts
// server.ts
import { buildSchema } from '@vantreeseba/drizzle-graphql';
import { describeFromSchema } from './schema/docs';

const { schema } = buildSchema(db, { ...describeFromSchema });
```

The SDL then reads:

```graphql
"""A person who can sign in."""
type User {
  id: Int!
  """Primary login address. Unique, case-insensitive."""
  email: String!
  ...
}
```

Notes:

- The `columns` keys are type-checked against the table's columns, so a typo or a renamed
  column fails to compile.
- `described` returns the same table object, so `export const users = described(...)` works
  with `buildRelations`, queries and migrations as before.
- Use a module-level `WeakMap`, not a property set on the Drizzle object. That avoids
  colliding with Drizzle's own fields and doesn't change the objects Drizzle reads.
- If one docs module serves several `buildSchema` calls, every build gets the same
  descriptions.

## Relations and deprecations

`describeRelation` gets names only. Keep a small map keyed by table and relation:

```ts
const relationDocs: Record<string, Record<string, string>> = {
  users: { posts: 'Posts this user authored, newest first.' },
};

buildSchema(db, {
  ...describeFromSchema,
  describeRelation: (table, relation) => relationDocs[table]?.[relation],
});
```

`deprecateColumn` uses the same signature as `describeColumn`, so a second `WeakMap`
registered alongside the descriptions works the same way. Required input fields are never
deprecated, because GraphQL forbids it. Filter and `orderBy` fields are never deprecated
either, so callers can still find rows that use the column.

## Checking it

```ts
import { printSchema } from 'graphql';
console.log(printSchema(schema));
```

Or assert in a test: `schema.getType('User')!.description` and
`(schema.getType('User') as GraphQLObjectType).getFields().email.description`.
