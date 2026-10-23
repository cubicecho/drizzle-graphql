// `resolveSelection` and `selectionToWith` run the generated read path for a resolver the
// consumer writes. They have to apply the build's row policies — `scope`, `softDelete`,
// `limits` and `defaults.orderBy` — the way the generated field does, or an override would be
// the way around them.
import { PGlite } from '@electric-sql/pglite';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  type GraphQLFieldConfig,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  graphql,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, resolveSelection, selectionToWith } from '@/index';

const Orgs = pgTable('orgs', { id: integer('id').primaryKey(), name: text('name') });
const Items = pgTable('items', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  deletedAt: text('deleted_at'),
});
const relations = defineRelations({ Orgs, Items }, (r) => ({
  Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) },
  Items: { org: r.one.Orgs({ from: r.Items.orgId, to: r.Orgs.id }) },
}));

let pglite: PGlite;
let db: any;

const orgScope = (ctx: any, table: any) => eq(table.orgId, ctx.orgId);

/**
 * A schema with the generated `orgs` field next to two overrides of it: one built on
 * `resolveSelection`, one on `selectionToWith`. Both pass the resolver's context.
 */
const overrideSchema = (config: BuildSchemaConfig) => {
  const { entities } = buildSchema(db, config);
  const list = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(entities.types['Orgs'] as GraphQLObjectType)));
  const fields: Record<string, GraphQLFieldConfig<any, any>> = {
    ...(entities.queries as any),
    resolved: {
      type: list,
      resolve: (_src, _args, context, info) =>
        resolveSelection(info, { db, table: 'Orgs', context, orderBy: { id: { direction: 'asc', priority: 0 } } }),
    },
    withTree: {
      type: list,
      resolve: (_src, _args, context, info) =>
        db.query.Orgs.findMany({
          with: selectionToWith(info, { db, table: 'Orgs', context }),
          orderBy: { id: 'asc' },
        }),
    },
  };
  return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields }) });
};

const run = async (schema: GraphQLSchema, source: string, contextValue: any = {}) => {
  const res = await graphql({ schema, source, contextValue });
  expect(res.errors).toBeUndefined();
  return res.data as any;
};

/** The generated field and both overrides, over the same selection. */
const allThree = async (schema: GraphQLSchema, selection: string, contextValue: any = {}) => {
  const data = await run(
    schema,
    `{
      generated: orgs(orderBy: { id: { direction: asc, priority: 0 } }) ${selection}
      resolved ${selection}
      withTree ${selection}
    }`,
    contextValue,
  );
  return data;
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`create table orgs (id integer primary key, name text)`);
  await db.execute(sql`create table items (id integer primary key, org_id integer not null, deleted_at text)`);
  await db.execute(sql`insert into orgs values (1, 'a'), (2, 'b')`);
  await db.execute(
    sql`insert into items values (1, 1, null), (2, 2, null), (3, 1, null), (4, 1, '2024-01-01'), (5, 2, '2024-01-01')`,
  );
});

afterAll(async () => {
  await pglite.close();
});

describe.sequential('resolveSelection and selectionToWith apply the build policies', () => {
  it('scope nested relations the way the generated field does', async () => {
    const schema = overrideSchema({ scope: { Items: orgScope } });
    const data = await allThree(schema, '{ id items(orderBy: { id: { direction: asc, priority: 0 } }) { id } }', {
      orgId: 1,
    });
    expect(data.generated).toEqual([
      { id: 1, items: [{ id: 1 }, { id: 3 }, { id: 4 }] },
      { id: 2, items: [] },
    ]);
    expect(data.resolved).toEqual(data.generated);
    expect(data.withTree).toEqual(data.generated);
  });

  it('scope the root table of resolveSelection', async () => {
    const schema = overrideSchema({ scope: { Orgs: (ctx: any, table: any) => eq(table.id, ctx.orgId) } });
    const data = await allThree(schema, '{ id }', { orgId: 2 });
    expect(data.generated).toEqual([{ id: 2 }]);
    expect(data.resolved).toEqual([{ id: 2 }]);
  });

  it('hide soft-deleted rows in nested relations', async () => {
    const schema = overrideSchema({ softDelete: { Items: 'deletedAt' } });
    const data = await allThree(schema, '{ id items(orderBy: { id: { direction: asc, priority: 0 } }) { id } }');
    expect(data.generated).toEqual([
      { id: 1, items: [{ id: 1 }, { id: 3 }] },
      { id: 2, items: [{ id: 2 }] },
    ]);
    expect(data.resolved).toEqual(data.generated);
    expect(data.withTree).toEqual(data.generated);
  });

  it('apply the limit policy and the default ordering to nested relations', async () => {
    const schema = overrideSchema({
      limits: { tables: { Items: { defaultLimit: 1 } } },
      defaults: { Items: { orderBy: { id: 'desc' } } },
    });
    const data = await allThree(schema, '{ id items { id } }');
    expect(data.generated).toEqual([
      { id: 1, items: [{ id: 4 }] },
      { id: 2, items: [{ id: 5 }] },
    ]);
    expect(data.resolved).toEqual(data.generated);
    expect(data.withTree).toEqual(data.generated);
  });

  it('refuse to run a scoped read without the request context', async () => {
    const { entities } = buildSchema(db, { scope: { Items: orgScope } });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          noContext: {
            type: new GraphQLList(entities.types['Orgs'] as GraphQLObjectType),
            resolve: (_src, _args, _ctx, info) => resolveSelection(info, { db, table: 'Orgs' }),
          },
        },
      }),
    });
    const res = await graphql({ schema, source: '{ noContext { id items { id } } }', contextValue: { orgId: 1 } });
    expect(res.errors?.[0]?.message).toMatch(/context/);
  });

  it('refuse a parsed tree when several builds of the instance could apply different policies', async () => {
    // Every test above built its own schema over `db`, and a parsed tree carries no type to
    // tell them apart by.
    const tree = { name: 'orgs', alias: 'orgs', args: {}, fieldsByTypeName: { Orgs: {} } };
    await expect(resolveSelection(tree as any, { db, table: 'Orgs', context: {} })).rejects.toThrow(
      /cannot tell which/,
    );
  });
});
