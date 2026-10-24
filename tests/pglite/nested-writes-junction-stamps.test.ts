import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { boolean, integer, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, graphql } from 'graphql';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/index';

// A many-to-many relation is left out of the nested-write inputs when its junction has a
// further NOT NULL column with no default, since no `connect` operand can supply it. A column
// every insert stamps anyway — a `contextValues` tenant column, a NOT NULL soft-delete marker —
// is not such a column: the relation keeps its field and the junction rows get the stamp.

const Posts = pgTable('posts', { id: serial('id').primaryKey(), title: text('title').notNull() });
const Tags = pgTable('tags', { id: serial('id').primaryKey(), name: text('name').notNull() });
const PostTags = pgTable(
  'post_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
    orgId: integer('org_id').notNull(),
    isDeleted: boolean('is_deleted').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);
const tables = { Posts, Tags, PostTags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Posts: {
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
});

let db: any;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table posts (id serial primary key, title text not null)`);
  await db.execute(sql`create table tags (id serial primary key, name text not null)`);
  await db.execute(
    sql`create table post_tags (post_id int not null, tag_id int not null, org_id int not null, is_deleted boolean not null, primary key (post_id, tag_id))`,
  );
});
beforeEach(async () => {
  await db.execute(sql`truncate posts, tags, post_tags restart identity`);
  await db.execute(sql`insert into posts (title) values ('p')`);
  await db.execute(sql`insert into tags (name) values ('x')`);
});

const build = (config: Record<string, any>) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return buildSchema(db, { features: { nestedWrites: true }, ...config }).schema;
  } finally {
    warn.mockRestore();
  }
};

describe('a junction whose NOT NULL columns every insert stamps', () => {
  it('keeps the many-to-many field and stamps a contextValues column and the marker', async () => {
    const schema = build({
      contextValues: { PostTags: { orgId: (ctx: any) => ctx.orgId } },
      scope: { PostTags: (ctx: any, t: any) => eq(t.orgId, ctx.orgId) },
      softDelete: { PostTags: { column: 'isDeleted', deletedValue: true, restoredValue: false } },
    });
    const updateInput = schema.getType('UpdatePostsInput') as GraphQLInputObjectType;
    expect(Object.keys(updateInput.getFields())).toContain('tags');

    const res = await graphql({
      schema,
      source:
        'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ name: { eq: "x" } }] } }) { tags { name } } }',
      contextValue: { orgId: 7 },
    });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updatePostsSingle.tags).toEqual([{ name: 'x' }]);
    expect(await db.select().from(PostTags)).toEqual([{ postId: 1, tagId: 1, orgId: 7, isDeleted: false }]);
  });

  it('still leaves the field out when a NOT NULL junction column has no source at all', () => {
    const schema = build({ contextValues: { PostTags: { orgId: () => 1 } } });
    const updateInput = schema.getType('UpdatePostsInput') as GraphQLInputObjectType | undefined;
    expect(Object.keys(updateInput?.getFields() ?? {})).not.toContain('tags');
  });
});
