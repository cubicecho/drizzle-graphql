import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { boolean, date, pgEnum, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { unknownInputField } from '../util/validation-messages';

// ── Which operators a column type is worth offering ───────────────────────────
// A pattern match against a boolean, a timestamp or an enum member asks a question
// nobody means: it compares whatever the session renders the value as, not anything
// in the row. Ordering is the same for booleans (`gt: false` is `eq: true` spelled as
// a puzzle) and for enums, where the order is the accident of how the column was
// declared. Timestamps keep ordering — ranges are the point of having one.
const kindEnum = pgEnum('kind', ['cron', 'event']);

const Triggers = pgTable('triggers', {
  id: serial('id').primaryKey(),
  name: text('name'),
  kind: kindEnum('kind'),
  enabled: boolean('enabled'),
  firedAt: timestamp('fired_at'),
  onDay: date('on_day', { mode: 'date' }),
});
const relations = buildRelations({ Triggers }, {});
const schema = { Triggers, relations };

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const filterFieldsFor = (columnName: string) => {
  const tableFilters = gqlSchema.getType('TriggersFilters') as GraphQLInputObjectType;
  const columnFilter = tableFilters.getFields()[columnName]!.type as GraphQLInputObjectType;
  return { name: columnFilter.name, fields: Object.keys(columnFilter.getFields()) };
};

const PATTERN_OPS = [
  'like',
  'notLike',
  'ilike',
  'notIlike',
  'startsWith',
  'endsWith',
  'contains',
  'iStartsWith',
  'iEndsWith',
  'iContains',
  'insensitive',
];
const ORDERING_OPS = ['lt', 'lte', 'gt', 'gte'];

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TYPE "kind" AS ENUM ('cron', 'event');`);
  await db.execute(sql`CREATE TABLE "triggers" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" text,
    "kind" "kind",
    "enabled" boolean,
    "fired_at" timestamp,
    "on_day" date
  );`);

  await db.insert(Triggers).values([
    { id: 1, name: 'nightly', kind: 'cron', enabled: true, firedAt: new Date('2024-01-01T00:00:00Z') },
    { id: 2, name: 'signup', kind: 'event', enabled: false, firedAt: new Date('2024-06-01T00:00:00Z') },
    { id: 3, name: 'weekly', kind: 'cron', enabled: true, firedAt: new Date('2024-12-01T00:00:00Z') },
  ]);

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe.sequential('operator sets follow the column type', () => {
  it('leaves a boolean column equality and membership only', () => {
    const { name, fields } = filterFieldsFor('enabled');
    expect(name).toBe('BooleanFilter');
    for (const op of [...PATTERN_OPS, ...ORDERING_OPS]) {
      expect(fields).not.toContain(op);
    }
    expect(fields).toEqual(
      expect.arrayContaining(['eq', 'ne', 'inArray', 'notInArray', 'isNull', 'isNotNull', 'OR', 'AND', 'NOT']),
    );
  });

  it('leaves an enum column equality and membership only', () => {
    const { name, fields } = filterFieldsFor('kind');
    expect(name).toBe('KindEnumFilter');
    for (const op of [...PATTERN_OPS, ...ORDERING_OPS]) {
      expect(fields).not.toContain(op);
    }
    expect(fields).toEqual(expect.arrayContaining(['eq', 'ne', 'inArray', 'notInArray', 'isNull', 'isNotNull']));
  });

  it('keeps ordering on a timestamp column but drops the pattern operators', () => {
    const { name, fields } = filterFieldsFor('firedAt');
    expect(name).toBe('DateTimeFilter');
    for (const op of PATTERN_OPS) {
      expect(fields).not.toContain(op);
    }
    expect(fields).toEqual(expect.arrayContaining(['eq', 'ne', ...ORDERING_OPS, 'inArray', 'isNull', 'isNotNull']));
  });

  it('treats a date column the same as a timestamp', () => {
    const { name, fields } = filterFieldsFor('onDay');
    expect(name).toBe('DateTimeFilter');
    for (const op of PATTERN_OPS) {
      expect(fields).not.toContain(op);
    }
    expect(fields).toEqual(expect.arrayContaining(ORDERING_OPS));
  });

  it('leaves a text column the full set', () => {
    const { name, fields } = filterFieldsFor('name');
    expect(name).toBe('StringFilter');
    expect(fields).toEqual(expect.arrayContaining([...PATTERN_OPS, ...ORDERING_OPS]));
  });
});

describe.sequential('the operators that stay still run', () => {
  const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

  it('filters a boolean column by equality', async () => {
    const result = await run(
      `{ triggers(where: { enabled: { eq: true } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    expect((result.data as any).triggers).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('filters an enum column by membership', async () => {
    const result = await run(
      `{ triggers(where: { kind: { inArray: [event] } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    expect((result.data as any).triggers).toEqual([{ id: 2 }]);
  });

  it('filters a timestamp column by range', async () => {
    const result = await run(
      `{ triggers(where: { firedAt: { gte: "2024-06-01T00:00:00.000Z" } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    expect((result.data as any).triggers).toEqual([{ id: 2 }, { id: 3 }]);
  });
});

describe.sequential('the operators that went away are validation errors', () => {
  const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

  it('rejects gt on a boolean column', async () => {
    const result = await run(`{ triggers(where: { enabled: { gt: false } }) { id } }`);

    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(unknownInputField('gt'));
  });

  it('rejects contains on a boolean column', async () => {
    const result = await run(`{ triggers(where: { enabled: { contains: "tr" } }) { id } }`);

    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(unknownInputField('contains'));
  });

  it('rejects lt on an enum column', async () => {
    const result = await run(`{ triggers(where: { kind: { lt: event } }) { id } }`);

    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(unknownInputField('lt'));
  });

  it('rejects startsWith on a timestamp column', async () => {
    const result = await run(`{ triggers(where: { firedAt: { startsWith: "2024" } }) { id } }`);

    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(unknownInputField('startsWith'));
  });

  it('rejects insensitive on a timestamp column', async () => {
    const result = await run(`{ triggers(where: { firedAt: { insensitive: true } }) { id } }`);

    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(unknownInputField('insensitive'));
  });
});
