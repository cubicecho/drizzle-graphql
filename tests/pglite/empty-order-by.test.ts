// A table with nothing to order by — only JSON columns, here also without a primary key —
// must still build: an input object with no fields, and an enum with no values, are invalid
// GraphQL, so the `<Type>OrderBy` / `<Type>DistinctColumn` types and the arguments they type
// are left out instead.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, jsonb, pgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, getNamedType, graphql, validateSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Lonely = pgTable('lonely', { doc: jsonb('doc') });
const Children = pgTable('children', { id: integer('id').primaryKey(), doc: jsonb('doc') });
const Parents = pgTable('parents', { id: integer('id').primaryKey(), childId: integer('child_id') });

const tables = { Lonely, Children, Parents };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Parents: {
    child: r.one.Children({ from: r.Parents.childId, to: r.Children.id }),
    kids: r.many.Children({ from: r.Parents.id, to: r.Children.id }),
  },
  Children: { parents: r.many.Parents({ from: r.Children.id, to: r.Parents.childId }) },
});

let client: PGlite;
let db: any;

beforeAll(async () => {
  client = new PGlite();
  db = (drizzle as any)({ client, relations });
  await db.execute(sql`CREATE TABLE lonely (doc jsonb)`);
  await db.execute(sql`CREATE TABLE children (id integer PRIMARY KEY, doc jsonb)`);
  await db.execute(sql`CREATE TABLE parents (id integer PRIMARY KEY, child_id integer)`);
  await db.insert(Lonely).values([{ doc: { a: 1 } }]);
});
afterAll(async () => client.close());

const queryArgs = (schema: any, field: string) =>
  (schema.getQueryType() as GraphQLObjectType).getFields()[field]!.args.map((arg) => arg.name);

describe('a table with nothing to order by', () => {
  it('builds a valid schema without OrderBy or DistinctColumn for it', async () => {
    const { schema } = buildSchema(db);
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType('LonelyOrderBy')).toBeUndefined();
    expect(schema.getType('LonelyDistinctColumn')).toBeUndefined();
    expect(queryArgs(schema, 'lonely')).not.toContain('orderBy');
    expect(queryArgs(schema, 'lonely')).not.toContain('distinct');
    expect(queryArgs(schema, 'lonelySingle')).not.toContain('orderBy');

    const res = await graphql({ schema, source: '{ lonely(offset: 0, limit: 5) { doc } }', contextValue: {} });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ lonely: [{ doc: { a: 1 } }] });
  });

  it('leaves a to-one relation to such a table out of the parent OrderBy and the orderBy argument off the relation', () => {
    // With `id` hidden, Children has nothing left to order by.
    const { schema } = buildSchema(db, { exclude: { columns: { Children: ['id'] } } } as any);
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType('ChildrenOrderBy')).toBeUndefined();
    expect(Object.keys((schema.getType('ParentsOrderBy') as GraphQLInputObjectType).getFields())).toEqual([
      'id',
      'childId',
    ]);
    expect(queryArgs(schema, 'children')).not.toContain('orderBy');
    const parentType = getNamedType((schema.getQueryType() as GraphQLObjectType).getFields()['parents']!.type);
    const kids = (parentType as GraphQLObjectType).getFields()['kids']!;
    expect(kids.args.map((arg) => arg.name)).not.toContain('orderBy');
  });

  it('keeps the relation order field while the target can still be ordered', () => {
    const { schema } = buildSchema(db);
    expect(Object.keys((schema.getType('ParentsOrderBy') as GraphQLInputObjectType).getFields())).toEqual([
      'id',
      'childId',
      'child',
    ]);
  });
});
