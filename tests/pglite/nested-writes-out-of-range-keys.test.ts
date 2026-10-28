// A `mode: 'date'` key column can hold values a JS Date cannot (a BC date, a year past 275760,
// an infinity), and drizzle reads every one of them as the same invalid Date. Nested writes
// match rows by key, so such keys are indistinguishable there — and none of them can be bound
// back into a statement either. A nested write that has to match on one is refused with a
// coded error, rather than collapsing two rows into one or failing with `Invalid time value`.
// Keys like that elsewhere in the data, which the write never has to match, do not stop it.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `timestamptz`: drizzle reads a plain `timestamp` infinity as an ordinary instant (issue #235).
const at = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const Events = pgTable('events', { at: at('at').primaryKey(), name: text('name').notNull() });
const Notes = pgTable('notes', { id: integer('id').primaryKey(), eventAt: at('event_at').notNull() });
const Posts = pgTable('posts', { id: integer('id').primaryKey() });
const PostEvents = pgTable(
  'post_events',
  { postId: integer('post_id').notNull(), eventAt: at('event_at').notNull() },
  (t) => [primaryKey({ columns: [t.postId, t.eventAt] })],
);
const tables = { Events, Notes, Posts, PostEvents };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Events: { notes: r.many.Notes({ from: r.Events.at, to: r.Notes.eventAt }) },
  Posts: {
    events: r.many.Events({
      from: r.Posts.id.through(r.PostEvents.postId),
      to: r.Events.at.through(r.PostEvents.eventAt),
    }),
  },
});

let pglite: PGlite;
let db: any;
let schema: GraphQLSchema;

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const texts = async (query: string) => ((await db.execute(sql.raw(query))).rows as { t: string }[]).map((row) => row.t);

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`SET TIME ZONE 'UTC'`);
  await db.execute(sql`CREATE TABLE events (at timestamptz(3) PRIMARY KEY, name text NOT NULL)`);
  await db.execute(sql`CREATE TABLE notes (id integer PRIMARY KEY, event_at timestamptz(3) NOT NULL)`);
  await db.execute(sql`CREATE TABLE posts (id integer PRIMARY KEY)`);
  await db.execute(
    sql`CREATE TABLE post_events (post_id integer NOT NULL, event_at timestamptz(3) NOT NULL, PRIMARY KEY (post_id, event_at))`,
  );
  schema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE events, notes, posts, post_events`);
  await db.execute(sql`INSERT INTO events VALUES
    ('0044-03-15 12:00:00+00 BC', 'ides'),
    ('0100-01-01 00:00:00+00 BC', 'ides'),
    ('2024-01-01 00:00:00+00', 'new year')`);
  await db.execute(sql`INSERT INTO posts VALUES (1)`);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('pglite: nested writes keyed by values a JS Date cannot hold', () => {
  it('refuses to attach children to parents it cannot tell apart, and writes nothing', async () => {
    const res: any = await run(
      'mutation { updateEvents(where: { name: { eq: "ides" } }, set: { notes: { create: [{ id: 1 }] } }) { name } }',
    );
    expect(res.errors?.map((error: any) => error.extensions?.code)).toEqual(['DRIZZLE_UNREPRESENTABLE_VALUE']);
    expect(res.errors[0].message).toMatch(/cannot match rows by a key a JS Date cannot hold/);
    expect(await texts('SELECT id::text AS t FROM notes')).toEqual([]);
  });

  it('refuses to link a target it cannot tell apart from another', async () => {
    const res: any = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { events: { connect: [{ name: { eq: "ides" } }] } }) { id } }',
    );
    expect(res.errors?.map((error: any) => error.extensions?.code)).toEqual(['DRIZZLE_UNREPRESENTABLE_VALUE']);
    expect(await texts('SELECT event_at::text AS t FROM post_events')).toEqual([]);
  });

  it('still links a representable target next to an existing link it cannot represent', async () => {
    await db.execute(sql`INSERT INTO post_events VALUES (1, '0044-03-15 12:00:00+00 BC')`);
    const res: any = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { events: { connect: [{ name: { eq: "new year" } }] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    expect(await texts('SELECT event_at::text AS t FROM post_events ORDER BY event_at')).toEqual([
      '0044-03-15 12:00:00+00 BC',
      '2024-01-01 00:00:00+00',
    ]);
  });
});
