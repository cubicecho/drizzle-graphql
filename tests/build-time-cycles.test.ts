import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Schema build time used to be exponential in the number of relation cycles: generating a
// table's relation fields recursed into every relation target, guarded only by the tables on
// the current path, so each table's build walked every simple path through the relation graph.
// On this ring (every table has two to-one relations and one to-many) that was ~1 s at 16
// tables, ~4 s at 18 and ~2 minutes at 25; 40 never finished. It is linear now.
//
// No query runs, so the PGlite client is never opened — it is only there to give `buildSchema`
// a PostgreSQL drizzle instance.

const ring = (size: number) => {
  const tables: Record<string, any> = {};
  for (let i = 0; i < size; i++) {
    tables[`T${i}`] = pgTable(`t${i}`, {
      id: integer('id').primaryKey(),
      name: text('name').notNull(),
      parentId: integer('parent_id'),
      otherId: integer('other_id'),
    });
  }
  const r: any = createRelationsHelper(tables);
  const config: Record<string, any> = {};
  for (let i = 0; i < size; i++) {
    const parent = `T${(i + 1) % size}`;
    const other = `T${(i + 7) % size}`;
    const child = `T${(i + size - 1) % size}`;
    config[`T${i}`] = {
      parent: r.one[parent]({ from: r[`T${i}`].parentId, to: r[parent].id }),
      other: r.one[other]({ from: r[`T${i}`].otherId, to: r[other].id }),
      children: r.many[child]({ from: r[`T${i}`].id, to: r[child].parentId }),
    };
  }
  return drizzle({ client: new PGlite(), relations: buildRelations(tables as any, config) } as any);
};

const timedBuild = (db: any, config?: Parameters<typeof buildSchema>[1]) => {
  const started = performance.now();
  const { schema } = buildSchema(db, config);
  return { schema, ms: performance.now() - started };
};

describe('schema build on a cyclic relation graph', () => {
  it('stays fast as the number of cycles grows', () => {
    // The build is synchronous, so a regression cannot be cut short by the test timeout. The
    // 20-table ring is checked first because the exponential build still finishes there (in
    // tens of seconds) and fails this assertion, rather than hanging on the 40-table one.
    const small = timedBuild(ring(20));
    expect(small.ms).toBeLessThan(3000);

    const large = timedBuild(ring(40), { features: { nestedWrites: true, upsert: true } });
    expect(large.ms).toBeLessThan(5000);
    const t0 = large.schema.getType('T0');
    expect(t0).toBeDefined();
    expect(Object.keys((t0 as any).getFields())).toEqual(
      expect.arrayContaining(['parent', 'other', 'children', 'childrenAggregate']),
    );
  });

  it('builds the same schema for every relationsDepthLimit above 0', () => {
    const db = ring(12);
    const unlimited = printSchema(buildSchema(db).schema);
    for (const relationsDepthLimit of [1, 2, 5]) {
      expect(printSchema(buildSchema(db, { relationsDepthLimit }).schema)).toBe(unlimited);
    }
    const flat = buildSchema(db, { relationsDepthLimit: 0 }).schema;
    const flatFields = Object.keys((flat.getType('T0') as any).getFields());
    expect(flatFields).toContain('name');
    expect(flatFields).not.toContain('parent');
    expect(flatFields).not.toContain('children');
  });
});
