import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A nested write on a plural update applies to every row the update matched. Its statements
// cover all of those parent rows at once: an operand is resolved once, links and detaches are
// one statement per chunk of parent keys, and only an attach — which writes one parent's key —
// runs per parent. These pin that the batch reaches the same rows the per-parent writes did,
// under the junction's scope and soft delete, the relation's inherited `where`, and the
// `onWrite` hooks, and that a batch past the bound-parameter limits is split.

const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
});
const Tags = pgTable('tags', { id: integer('id').primaryKey(), name: text('name').notNull() });
const PostTags = pgTable(
  'post_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
    orgId: integer('org_id'),
    deletedAt: text('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);
const tables = { Users, Posts, Tags, PostTags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }),
    // No `where` of its own: it inherits shownAuthor's, which then filters the user.
    shownPosts: r.many.Posts({ alias: 'shown' }),
  },
  Posts: {
    author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id }),
    shownAuthor: r.one.Users({
      from: r.Posts.authorId,
      to: r.Users.id,
      where: { name: { ne: 'hidden' } },
      alias: 'shown',
    }),
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
});

let db: any;
let statements = 0;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations, logger: { logQuery: () => statements++ } });
  await db.execute(sql`create table users (id integer primary key, name text not null)`);
  await db.execute(sql`create table posts (id integer primary key, title text not null, author_id integer)`);
  await db.execute(sql`create table tags (id integer primary key, name text not null)`);
  await db.execute(
    sql`create table post_tags (post_id integer not null, tag_id integer not null, org_id integer, deleted_at text, primary key (post_id, tag_id))`,
  );
});
afterAll(async () => {
  await db.$client.close();
});
beforeEach(async () => {
  await db.execute(sql`truncate users, posts, tags, post_tags`);
  await db.execute(sql`insert into users select g, 'u' || g from generate_series(1, 30) g`);
  await db.execute(sql`insert into posts select g, 'p' || g, null from generate_series(1, 30) g`);
  await db.execute(sql`insert into tags select g, 't' || g from generate_series(1, 5) g`);
});

const policies = {
  softDelete: { PostTags: 'deletedAt' },
  scope: { PostTags: (ctx: any, t: any) => eq(t.orgId, ctx.orgId) },
  contextValues: { PostTags: { orgId: (ctx: any) => ctx.orgId } },
};

const run = async (config: Record<string, any>, source: string, contextValue: any = { orgId: 1 }) => {
  const schema = buildSchema(db, { features: { nestedWrites: true, upsert: true }, ...config }).schema;
  statements = 0;
  return graphql({ schema, source, contextValue });
};

const links = async () =>
  (await db.select().from(PostTags).orderBy(PostTags.postId, PostTags.tagId)).map(
    (l: any) => `${l.postId}:${l.tagId}:${l.orgId}:${l.deletedAt ? 'marked' : 'live'}`,
  );
const authors = async () =>
  Object.fromEntries((await db.select().from(Posts).orderBy(Posts.id)).map((p: any) => [p.id, p.authorId]));

describe.sequential('nested writes over several parent rows', () => {
  it('links every parent in a number of statements that does not grow with the parents', async () => {
    await db.insert(PostTags).values({ postId: 2, tagId: 1 });
    const connect = (last: number) =>
      `mutation { updatePosts(where: { id: { lte: ${last} } }, set: { tags: { connect: [{ id: { eq: 1 } }, { id: { inArray: [2, 1] } }] } }) { id } }`;

    const few = await run({}, connect(3));
    expect(few.errors).toBeUndefined();
    const fewStatements = statements;
    const many = await run({}, connect(20));
    expect(many.errors).toBeUndefined();
    expect(statements).toBe(fewStatements);

    const all = await links();
    expect(all).toHaveLength(40);
    for (let post = 1; post <= 20; post++) {
      expect(all).toContain(`${post}:1:null:live`);
      expect(all).toContain(`${post}:2:null:live`);
    }
  });

  it('applies set, then disconnect, then connect to every parent', async () => {
    await db.insert(PostTags).values([
      { postId: 1, tagId: 1 },
      { postId: 2, tagId: 3 },
      { postId: 3, tagId: 5 },
      { postId: 4, tagId: 1 },
    ]);
    const res = await run(
      {},
      `mutation { updatePosts(where: { id: { lte: 3 } }, set: { tags: { set: [{ id: { eq: 2 } }, { id: { eq: 3 } }], disconnect: [{ id: { eq: 3 } }], connect: [{ id: { eq: 4 } }] } }) { id tags { id } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(await links()).toEqual([
      '1:2:null:live',
      '1:4:null:live',
      '2:2:null:live',
      '2:4:null:live',
      '3:2:null:live',
      '3:4:null:live',
      '4:1:null:live',
    ]);
  });

  it('honours the junction scope and soft delete for every parent', async () => {
    await db.insert(PostTags).values([
      { postId: 1, tagId: 1, orgId: 1, deletedAt: 'gone' },
      { postId: 2, tagId: 2, orgId: 2 },
      { postId: 3, tagId: 1, orgId: 1 },
    ]);
    const connect = await run(
      policies,
      'mutation { updatePosts(where: { id: { lte: 3 } }, set: { tags: { connect: [{ id: { eq: 1 } }] } }) { id } }',
    );
    expect(connect.errors).toBeUndefined();
    // Post 1's marked link is restored, post 2 gets a new link stamped with the caller's org,
    // post 3's link is left alone, and the other tenant's link is untouched.
    expect(await links()).toEqual(['1:1:1:live', '2:1:1:live', '2:2:2:live', '3:1:1:live']);

    const cleared = await run(
      policies,
      'mutation { updatePosts(where: { id: { lte: 3 } }, set: { tags: { set: [] } }) { id } }',
    );
    expect(cleared.errors).toBeUndefined();
    expect(await links()).toEqual(['1:1:1:marked', '2:1:1:marked', '2:2:2:live', '3:1:1:marked']);
  });

  it('hands each hook step every row once, before and after all its statements', async () => {
    await db.insert(PostTags).values({ postId: 1, tagId: 1, orgId: 1, deletedAt: 'gone' });
    const calls: string[] = [];
    const record = (table: string) => ({
      before: (p: any) => {
        calls.push(`${table}.${p.operation}.${p.nested?.op}:before`);
      },
      after: (p: any) => {
        const rows = p.rows.map((row: any) => Object.values(row).join(':')).sort();
        calls.push(`${table}.${p.operation}.${p.nested?.op}:after:${rows.join(',')}`);
      },
    });
    const res = await run(
      { ...policies, onWrite: { PostTags: record('PostTags') } },
      'mutation { updatePosts(where: { id: { lte: 3 } }, set: { tags: { connect: [{ id: { inArray: [1, 2] } }] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    expect(calls).toEqual([
      'PostTags.restore.connect:before',
      'PostTags.insert.connect:before',
      'PostTags.restore.connect:after:1:1',
      'PostTags.insert.connect:after:1:2,2:1,2:2,3:1,3:2',
    ]);

    calls.length = 0;
    await db.execute(sql`update posts set author_id = id where id <= 3`);
    const detach = await run(
      { onWrite: { Posts: record('Posts') } },
      'mutation { updateUsers(where: { id: { lte: 3 } }, set: { posts: { set: [{ id: { eq: 7 } }] } }) { id } }',
    );
    expect(detach.errors).toBeUndefined();
    // One detach for all three users, then one attach per user — the last one holds.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('Posts.update.set:before');
    expect(calls[1]!.split(':after:')[1]!.split(',').sort()).toEqual(['1:', '2:', '3:', '7:1', '7:2', '7:3']);
    expect(Object.values(await authors()).filter((author) => author !== null)).toHaveLength(1);
  });

  it('refuses the whole write when any parent hides the relation', async () => {
    await db.execute(sql`update users set name = 'hidden' where id = 2`);
    const res = await run(
      {},
      'mutation { updateUsers(where: { id: { lte: 3 } }, set: { shownPosts: { connect: [{ id: { eq: 5 } }] } }) { id } }',
    );
    expect(res.errors?.[0]?.message).toMatch(/hides the relation/);
    expect((await authors())[5]).toBeNull();

    const shown = await run(
      {},
      'mutation { updateUsers(where: { id: { inArray: [1, 3] } }, set: { shownPosts: { connect: [{ id: { eq: 5 } }] } }) { id } }',
    );
    expect(shown.errors).toBeUndefined();
    expect([1, 3]).toContain((await authors())[5]);
  });

  it('detaches and disconnects across every parent', async () => {
    await db.execute(sql`update posts set author_id = id where id <= 10`);
    const res = await run(
      {},
      'mutation { updateUsers(where: { id: { lte: 5 } }, set: { posts: { disconnect: [{ id: { gte: 3 } }] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    const after = await authors();
    expect([after[1], after[2], after[3], after[5], after[6]]).toEqual([1, 2, null, null, 6]);
  });

  it('reads existing links on a create too, so a leftover link is left alone', async () => {
    // A link row left behind for a key the create is about to use: connecting it is a no-op.
    await db.insert(PostTags).values({ postId: 101, tagId: 1 });
    const queries: string[] = [];
    const logged = (drizzle as any)({
      client: db.$client,
      relations,
      logger: { logQuery: (query: string) => queries.push(query) },
    });
    const schema = buildSchema(logged, { features: { nestedWrites: true } }).schema;
    const created = await graphql({
      schema,
      contextValue: {},
      source:
        'mutation { createPosts(values: [{ id: 100, title: "a", tags: { connect: [{ id: { eq: 1 } }] } }, { id: 101, title: "b", tags: { connect: [{ id: { inArray: [1, 2] } }] } }]) { id } }',
    });
    expect(created.errors).toBeUndefined();
    // One read of the links per created entry.
    expect(queries.filter((q) => q.startsWith('select') && q.includes('"post_tags"'))).toHaveLength(2);
    expect(await links()).toEqual(['100:1:null:live', '101:1:null:live', '101:2:null:live']);
  });
});

describe.sequential('nested writes over more parent rows than one statement binds', () => {
  const PARENTS = 2_500;
  beforeEach(async () => {
    await db.execute(sql`truncate users, posts, post_tags`);
    await db.execute(sql`insert into users select g, 'u' || g from generate_series(1, ${PARENTS}) g`);
    await db.execute(sql`insert into posts select g, 'p' || g, g from generate_series(1, ${PARENTS}) g`);
  });

  it('links, unlinks and restores through the junction in chunks', async () => {
    const connect = await run(
      policies,
      `mutation { updatePosts(where: { id: { gte: 1 } }, set: { tags: { connect: [{ id: { lte: 5 } }] } }) { id } }`,
    );
    expect(connect.errors).toBeUndefined();
    expect((await db.execute(sql`select count(*)::int as n from post_tags where deleted_at is null`)).rows[0].n).toBe(
      PARENTS * 5,
    );

    const set = await run(
      policies,
      `mutation { updatePosts(where: { id: { gte: 1 } }, set: { tags: { set: [{ id: { eq: 2 } }], disconnect: [{ id: { eq: 2 } }], connect: [{ id: { eq: 3 } }] } }) { id } }`,
    );
    expect(set.errors).toBeUndefined();
    const counts = (
      await db.execute(
        sql`select tag_id, count(*)::int as n from post_tags where deleted_at is null group by tag_id order by tag_id`,
      )
    ).rows;
    // `set` restored tag 2's link, `disconnect` marked it again, `connect` restored tag 3's.
    expect(counts).toEqual([{ tag_id: 3, n: PARENTS }]);
  });

  it('detaches and attaches through a foreign key in chunks', async () => {
    const res = await run(
      {},
      `mutation { updateUsers(where: { id: { gte: 1 } }, set: { posts: { set: [{ id: { eq: 1 } }] } }) { id } }`,
    );
    expect(res.errors).toBeUndefined();
    const attached = (await db.execute(sql`select id from posts where author_id is not null`)).rows;
    expect(attached).toEqual([{ id: 1 }]);
  });

  it('detaches past one chunk of parent keys through a foreign key', async () => {
    // More parents than one statement's 10,000 key parameters.
    const many = 10_500;
    await db.execute(
      sql`insert into users select g, 'u' || g from generate_series(${PARENTS + 1}::int, ${many}::int) g`,
    );
    await db.execute(
      sql`insert into posts select g, 'p' || g, g from generate_series(${PARENTS + 1}::int, ${many}::int) g`,
    );
    const attached = async () =>
      (await db.execute(sql`select count(*)::int as n from posts where author_id is not null`)).rows[0].n;

    const disconnected = await run(
      {},
      `mutation { updateUsers(where: { id: { gte: 1 } }, set: { posts: { disconnect: [{ title: { like: "p%" } }] } }) { id } }`,
    );
    expect(disconnected.errors).toBeUndefined();
    expect(await attached()).toBe(0);

    await db.execute(sql`update posts set author_id = id`);
    const cleared = await run(
      {},
      `mutation { updateUsers(where: { id: { gte: 1 } }, set: { posts: { set: [] } }) { id } }`,
    );
    expect(cleared.errors).toBeUndefined();
    expect(await attached()).toBe(0);
  });
});
