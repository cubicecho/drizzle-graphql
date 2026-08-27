import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, type DrizzleFieldExtension, drizzleExtension, identifyRows } from '@/index';
import * as schema from '../schema/pg';

// buildSchema only reads drizzle metadata, so these tests never touch the database.
let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;
let gqlSchema: GraphQLSchema;

const queryField = (name: string) => gqlSchema.getQueryType()!.getFields()[name]!;
const mutationField = (name: string) => gqlSchema.getMutationType()!.getFields()[name]!;
const meta = (field: unknown) => drizzleExtension(field as any) as DrizzleFieldExtension;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle({ client: pglite, schema, relations: schema.relations });
  gqlSchema = buildSchema(db, { features: { upsert: true } }).schema;
});

afterAll(async () => {
  await pglite.close().catch(console.error);
});

describe('extensions.drizzle: queries', () => {
  it('names the table, kind and arity of a list query', () => {
    expect(meta(queryField('users'))).toMatchObject({
      table: 'Users',
      kind: 'query',
      operation: 'select',
      single: false,
      targetArg: 'where',
      primaryKey: ['id'],
    });
  });

  it('distinguishes the single query only by arity', () => {
    const list = meta(queryField('users'));
    const single = meta(queryField('usersSingle'));

    expect(single.operation).toBe(list.operation);
    expect(single.single).toBe(true);
    expect(list.single).toBe(false);
  });

  it('marks aggregate and groupBy queries as aggregates', () => {
    expect(meta(queryField('usersAggregate'))).toMatchObject({
      table: 'Users',
      kind: 'aggregate',
      operation: 'aggregate',
      single: true,
    });
    expect(meta(queryField('usersGroupBy'))).toMatchObject({
      kind: 'aggregate',
      operation: 'groupBy',
      single: false,
    });
  });

  it('keeps the complexity hint alongside the identity', () => {
    expect(queryField('users').extensions['complexity']).toBeDefined();
    expect(queryField('users').extensions['drizzle']).toBeDefined();
  });
});

describe('extensions.drizzle: mutations', () => {
  it('tells insert, update, upsert and delete apart without reading the name', () => {
    expect(meta(mutationField('createUsers'))).toMatchObject({
      operation: 'insert',
      single: false,
      targetArg: 'values',
    });
    expect(meta(mutationField('createUsersSingle'))).toMatchObject({ operation: 'insert', single: true });
    expect(meta(mutationField('upsertUsers'))).toMatchObject({ operation: 'upsert', targetArg: 'values' });
    expect(meta(mutationField('updateUsers'))).toMatchObject({ operation: 'update', targetArg: 'where' });
    expect(meta(mutationField('updateUsersMany'))).toMatchObject({
      operation: 'updateMany',
      targetArg: 'updates',
    });
    expect(meta(mutationField('deleteUsers'))).toMatchObject({ operation: 'delete', targetArg: 'where' });
    expect(meta(mutationField('deleteUsersSingle'))).toMatchObject({ operation: 'delete', single: true });
  });

  it("names the argument each mutation's rows actually live in", () => {
    for (const name of Object.keys(gqlSchema.getMutationType()!.getFields())) {
      const field = mutationField(name);
      const drizzle = meta(field);
      expect(drizzle.kind).toBe('mutation');
      // The published argument is one the field really takes — the point of publishing it.
      expect(field.args.map((arg) => arg.name)).toContain(drizzle.targetArg);
    }
  });

  it('survives renamed prefixes and suffixes, which is what name parsing cannot', () => {
    const renamed = buildSchema(db, {
      prefixes: { insert: 'add', update: 'edit', delete: 'drop' },
      suffixes: { single: 'One', list: 'All' },
    }).schema;
    const field = renamed.getMutationType()!.getFields()['addUsersOne']!;

    expect(meta(field)).toMatchObject({ table: 'Users', operation: 'insert', single: true });
  });
});

describe('extensions.drizzle: relations and types', () => {
  it('names the target table, the parent it hangs off, and the relation', () => {
    const userFields = (gqlSchema.getType('Users') as GraphQLObjectType).getFields();

    expect(meta(userFields['posts'])).toMatchObject({
      table: 'Posts',
      kind: 'relation',
      operation: 'relation',
      single: false,
      parentTable: 'Users',
      relation: 'posts',
      primaryKey: ['id'],
    });
    expect(meta(userFields['customer'])).toMatchObject({
      table: 'Customers',
      kind: 'relation',
      single: true,
      relation: 'customer',
    });
    expect(meta(userFields['postsAggregate'])).toMatchObject({
      table: 'Posts',
      kind: 'aggregate',
      operation: 'relationAggregate',
      single: true,
      parentTable: 'Users',
    });
  });

  it('names the table an object type came from', () => {
    expect(drizzleExtension(gqlSchema.getType('Users') as GraphQLObjectType)).toEqual({
      table: 'Users',
      kind: 'type',
      primaryKey: ['id'],
    });
  });

  it('returns undefined for anything the library did not generate', () => {
    expect(drizzleExtension(undefined)).toBeUndefined();
    expect(drizzleExtension({ extensions: {} })).toBeUndefined();
  });
});

describe('identifyRows', () => {
  it('reads the key out of insert values, one row or many', () => {
    expect(identifyRows(mutationField('createUsersSingle'), { values: { id: 7, name: 'a' } })).toEqual({
      table: 'Users',
      primaryKey: ['id'],
      rows: [{ id: 7 }],
      complete: true,
    });
    expect(identifyRows(mutationField('createUsers'), { values: [{ id: 1 }, { id: 2 }] })?.rows).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it('reports an insert whose key the database generates as not identified', () => {
    const target = identifyRows(mutationField('createUsers'), { values: [{ name: 'no id' }] });

    expect(target).toMatchObject({ rows: [], complete: false });
  });

  it('reads both the equality and the list spelling of a where', () => {
    expect(identifyRows(mutationField('deleteUsers'), { where: { id: { eq: 3 } } })).toMatchObject({
      rows: [{ id: 3 }],
      complete: true,
    });
    expect(identifyRows(mutationField('deleteUsers'), { where: { id: { inArray: [3, 4] } } })).toMatchObject({
      rows: [{ id: 3 }, { id: 4 }],
      complete: true,
    });
  });

  it('reads the per-entry where of a batch update', () => {
    const target = identifyRows(mutationField('updateUsersMany'), {
      updates: [
        { where: { id: { eq: 1 } }, set: { name: 'a' } },
        { where: { id: { inArray: [2, 3] } }, set: { name: 'b' } },
      ],
    });

    expect(target).toMatchObject({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], complete: true });
  });

  it('refuses to claim rows a non-key filter selects', () => {
    expect(identifyRows(mutationField('deleteUsers'), { where: { name: { eq: 'x' } } })).toMatchObject({
      rows: [],
      complete: false,
    });
    // The key is there, but something else narrows further — the rows are a superset.
    expect(
      identifyRows(mutationField('deleteUsers'), { where: { id: { inArray: [1, 2] }, name: { eq: 'x' } } }),
    ).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], complete: false });
    // A boolean group is not a key lookup at all.
    expect(
      identifyRows(mutationField('deleteUsers'), { where: { OR: [{ id: { eq: 1 } }, { id: { eq: 2 } }] } }),
    ).toMatchObject({ rows: [], complete: false });
    // An unbounded write names no rows.
    expect(identifyRows(mutationField('updateUsers'), {})).toMatchObject({ rows: [], complete: false });
  });

  it('returns undefined for a field the library did not generate', () => {
    expect(identifyRows({ extensions: {} }, { where: { id: { eq: 1 } } })).toBeUndefined();
  });
});

describe('identifyRows: composite primary keys', () => {
  const Orgs = pgTable('orgs', { id: integer('id').primaryKey(), name: text('name') });
  const Memberships = pgTable(
    'memberships',
    { orgId: integer('org_id').notNull(), userId: integer('user_id').notNull(), role: text('role') },
    (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
  );
  const r = createRelationsHelper({ Orgs, Memberships });
  const compositeSchema = {
    Orgs,
    Memberships,
    relations: buildRelations(
      { Orgs, Memberships },
      { Orgs: { members: r.many.Memberships({ from: r.Orgs.id, to: r.Memberships.orgId }) } },
    ),
  };

  let compositeGql: GraphQLSchema;

  beforeAll(() => {
    const compositeDb = drizzle({ client: pglite, schema: compositeSchema, relations: compositeSchema.relations });
    compositeGql = buildSchema(compositeDb as any).schema;
  });

  it('publishes every key column, in schema order', () => {
    const field = compositeGql.getMutationType()!.getFields()['deleteMemberships']!;

    expect(meta(field).primaryKey).toEqual(['orgId', 'userId']);
  });

  it('needs an equality on each key column before it claims a row', () => {
    const field = compositeGql.getMutationType()!.getFields()['deleteMemberships']!;

    expect(identifyRows(field, { where: { orgId: { eq: 1 }, userId: { eq: 2 } } })).toMatchObject({
      rows: [{ orgId: 1, userId: 2 }],
      complete: true,
    });
    // One column pinned and the other listed describes a rectangle of key tuples, not rows.
    expect(identifyRows(field, { where: { orgId: { eq: 1 }, userId: { inArray: [2, 3] } } })).toMatchObject({
      rows: [],
      complete: false,
    });
  });
});
