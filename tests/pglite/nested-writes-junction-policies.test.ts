import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, serial, text, unique } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, graphql } from 'graphql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A `.through()` relation reads only the junction rows the junction's own `scope` and soft
// delete keep. Its nested writes have to agree: `set` / `disconnect` never reach a link row the
// request cannot see, `connect` does not count a hidden or marked row as "already linked", and
// on a soft-deleting junction an unlink marks the row and a re-link restores it.

// A shared catalogue with per-tenant tagging: each org keeps its own links.
const Posts = pgTable('posts', { id: serial('id').primaryKey(), title: text('title').notNull() });
const Tags = pgTable('tags', { id: serial('id').primaryKey(), name: text('name').notNull() });
const OrgTags = pgTable(
  'org_tags',
  {
    id: serial('id').primaryKey(),
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
    orgId: integer('org_id'),
  },
  (t) => [unique().on(t.postId, t.tagId, t.orgId)],
);
// A junction keyed on its two columns, with both a tenant column and a soft-delete marker.
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
const tables = { Posts, Tags, OrgTags, PostTags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Posts: {
    orgTags: r.many.Tags({ from: r.Posts.id.through(r.OrgTags.postId), to: r.Tags.id.through(r.OrgTags.tagId) }),
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
});

let db: any;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table posts (id serial primary key, title text not null)`);
  await db.execute(sql`create table tags (id serial primary key, name text not null)`);
  await db.execute(
    sql`create table org_tags (id serial primary key, post_id int not null, tag_id int not null, org_id int, unique (post_id, tag_id, org_id))`,
  );
  await db.execute(
    sql`create table post_tags (post_id int not null, tag_id int not null, org_id int, deleted_at text, primary key (post_id, tag_id))`,
  );
});
beforeEach(async () => {
  await db.execute(sql`truncate posts, tags, org_tags, post_tags restart identity`);
  await db.execute(sql`insert into posts (title) values ('p1')`);
  await db.execute(sql`insert into tags (name) values ('red'), ('green'), ('blue')`);
});

const tenancy = {
  scope: {
    OrgTags: (ctx: any, t: any) => eq(t.orgId, ctx.orgId),
    PostTags: (ctx: any, t: any) => eq(t.orgId, ctx.orgId),
  },
  contextValues: {
    OrgTags: { orgId: (ctx: any) => ctx.orgId },
    PostTags: { orgId: (ctx: any) => ctx.orgId },
  },
};

const run = async (config: Record<string, any>, source: string, contextValue: any = { orgId: 1 }) => {
  const res = await graphql({
    schema: buildSchema(db, { features: { nestedWrites: true }, ...config }).schema,
    source,
    contextValue,
  });
  expect(res.errors).toBeUndefined();
  return res.data as any;
};

const orgLinks = async () =>
  (await db.select().from(OrgTags).orderBy(OrgTags.id)).map((l: any) => `${l.postId}:${l.tagId}:${l.orgId}`);
const postLinks = async () =>
  (await db.select().from(PostTags).orderBy(PostTags.postId, PostTags.tagId)).map(
    (l: any) => `${l.postId}:${l.tagId}:${l.orgId}:${l.deletedAt ? 'marked' : 'live'}`,
  );

describe("many-to-many nested writes and the junction's own scope", () => {
  beforeEach(async () => {
    // Org 2's link — invisible to org 1 on every read path.
    await db.execute(sql`insert into org_tags (post_id, tag_id, org_id) values (1, 1, 2)`);
  });

  it('`set: []` leaves the links another tenant owns', async () => {
    await run(
      tenancy,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { orgTags: { set: [] } }) { id } }',
    );
    expect(await orgLinks()).toEqual(['1:1:2']);
  });

  it('`disconnect` leaves the links another tenant owns', async () => {
    await run(
      tenancy,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { orgTags: { disconnect: [{ name: { eq: "red" } }] } }) { id } }',
    );
    expect(await orgLinks()).toEqual(['1:1:2']);
  });

  it("`connect` links the tag for this tenant, although another tenant's link exists", async () => {
    const data = await run(
      tenancy,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { orgTags: { connect: [{ name: { eq: "red" } }] } }) { orgTags { name } } }',
    );
    expect(data.updatePostsSingle.orgTags).toEqual([{ name: 'red' }]);
    expect(await orgLinks()).toEqual(['1:1:2', '1:1:1']);
  });

  it("removes this tenant's own links", async () => {
    await db.execute(sql`insert into org_tags (post_id, tag_id, org_id) values (1, 2, 1)`);
    await run(
      tenancy,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { orgTags: { set: [] } }) { id } }',
    );
    expect(await orgLinks()).toEqual(['1:1:2']);
  });
});

describe('many-to-many nested writes through a soft-deleting junction', () => {
  const softDelete = { softDelete: { PostTags: 'deletedAt' } };

  it('`disconnect` marks the link instead of deleting it', async () => {
    await db.execute(sql`insert into post_tags (post_id, tag_id) values (1, 1), (1, 2)`);
    const data = await run(
      softDelete,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { disconnect: [{ name: { eq: "red" } }] } }) { tags { name } } }',
    );
    expect(data.updatePostsSingle.tags).toEqual([{ name: 'green' }]);
    expect(await postLinks()).toEqual(['1:1:null:marked', '1:2:null:live']);
  });

  it('`set` marks the links it removes, and restores a marked one it links again', async () => {
    await db.execute(
      sql`insert into post_tags (post_id, tag_id, deleted_at) values (1, 1, '2024-01-01'), (1, 2, null)`,
    );
    const data = await run(
      softDelete,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [{ name: { inArray: ["red", "blue"] } }] } }) { tags(orderBy: { id: { direction: asc, priority: 0 } }) { name } } }',
    );
    expect(data.updatePostsSingle.tags).toEqual([{ name: 'red' }, { name: 'blue' }]);
    expect(await postLinks()).toEqual(['1:1:null:live', '1:2:null:marked', '1:3:null:live']);
  });

  it('`connect` restores a soft-deleted link rather than skipping it', async () => {
    await db.execute(sql`insert into post_tags (post_id, tag_id, deleted_at) values (1, 2, '2024-01-01')`);
    const data = await run(
      softDelete,
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ id: { eq: 2 } }] } }) { tags { id } } }',
    );
    expect(data.updatePostsSingle.tags).toEqual([{ id: 2 }]);
    expect(await postLinks()).toEqual(['1:2:null:live']);
  });

  it("with a scope too, neither restores nor marks another tenant's link", async () => {
    await db.execute(
      sql`insert into post_tags (post_id, tag_id, org_id, deleted_at) values (1, 1, 1, null), (1, 2, 1, '2024-01-01'), (1, 3, 2, null)`,
    );
    const data = await run(
      { ...softDelete, ...tenancy },
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [{ id: { eq: 2 } }] } }) { tags { id } } }',
    );
    expect(data.updatePostsSingle.tags).toEqual([{ id: 2 }]);
    expect(await postLinks()).toEqual(['1:1:1:marked', '1:2:1:live', '1:3:2:live']);
  });

  it("offers `connect` and `set` only when the junction's update is on, since they can restore", () => {
    const inputsOf = (config: Record<string, any>) =>
      Object.keys(
        (
          buildSchema(db, {
            ...config,
            features: { nestedWrites: true, update: (t) => t !== 'PostTags' },
          }).schema.getType('PostsTagsNestedUpdateInput') as GraphQLInputObjectType
        ).getFields(),
      ).sort();
    expect(inputsOf(softDelete)).toEqual(['disconnect']);
    // A junction without a marker only ever inserts and deletes its rows.
    expect(inputsOf({})).toEqual(['connect', 'disconnect', 'set']);
  });
});
