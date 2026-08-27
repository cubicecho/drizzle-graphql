/**
 * A table the drizzle instance has no relational query builder for.
 *
 * `db.query` is keyed by the *relations* config, while SQLite and MySQL take the schema
 * separately — so a table passed as `schema` but left out of `buildRelations`/`defineRelations`
 * is generated for, then has nothing to read through. (A table with no relations of its own is
 * fine; it only has to appear in the relations config.) PostgreSQL cannot reach this: its
 * schema is derived from the relations config, so the two can never disagree.
 *
 * The old message blamed a missing `schema`, which is the one thing the caller did do.
 */
export const missingQueryBuilderError = (tableName: string): Error =>
  new Error(
    `Drizzle-GraphQL Error: Table '${tableName}' was passed to the drizzle constructor's schema but is missing from its relations config, so drizzle-orm exposes no query builder for it. Include it in the relations you pass to buildRelations/defineRelations, or drop it from the generated schema with config.exclude.tables.`,
  );
