/**
 * A table the drizzle instance has no relational query builder for.
 *
 * Both the generated schema and `db.query` are keyed by the relations config, so under
 * drizzle-orm v1 the two agree by construction and this should never fire — a table left out
 * of the relations config is simply never generated for. It stays as a guard because the
 * alternative is a `TypeError` on `undefined` deep inside a resolver, and because earlier v1
 * release candidates *could* disagree: they took the schema as a separate constructor
 * argument, so a table passed there but left out of `buildRelations`/`defineRelations` was
 * generated for and then had nothing to read through.
 */
export const missingQueryBuilderError = (tableName: string): Error =>
  new Error(
    `Drizzle-GraphQL Error: Table '${tableName}' has no query builder on the drizzle instance, so there is nothing for its resolvers to read through. Include it in the relations you pass to buildRelations/defineRelations, or drop it from the generated schema with config.exclude.tables.`,
  );
