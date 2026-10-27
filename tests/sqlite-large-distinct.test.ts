import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `distinct` used to return every primary key it kept to JS and bind them back into the read: as
// an `IN (…)` list, or, for a composite key or through a junction, as an `OR` with one term per
// key. Past SQLite's 32,766 bound parameters that read could not run at all. The pass is now a
// subquery of the read, so the number of rows it keeps binds nothing. The 1,500-row cases guarded
// the old `OR`, which had to be nested as a balanced tree to stay within SQLite's 1,000-level
// expression depth; they still cover those shapes.

const Batches = sqliteTable(
  'batches',
  { a: integer('a').notNull(), b: integer('b').notNull(), label: text('label').notNull() },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
);
const Students = sqliteTable('students', { id: integer('id').primaryKey() });
const Courses = sqliteTable('courses', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Enrollments = sqliteTable(
  'enrollments',
  { studentId: integer('student_id').notNull(), courseId: integer('course_id').notNull() },
  (t) => [primaryKey({ columns: [t.studentId, t.courseId] })],
);
const Owners = sqliteTable('owners', { id: integer('id').primaryKey() });
const Parts = sqliteTable(
  'parts',
  { ownerId: integer('owner_id').notNull(), n: integer('n').notNull(), kind: text('kind').notNull() },
  (t) => [primaryKey({ columns: [t.ownerId, t.n] })],
);
const Groups = sqliteTable('groups', { id: integer('id').primaryKey() });
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  title: text('title').notNull(),
});
const Links = sqliteTable(
  'links',
  { groupId: integer('group_id').notNull(), itemId: integer('item_id').notNull() },
  (t) => [primaryKey({ columns: [t.groupId, t.itemId] })],
);

const tables = { Batches, Students, Courses, Enrollments, Owners, Parts, Groups, Items, Links };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Students: {
    courses: r.many.Courses({
      from: r.Students.id.through(r.Enrollments.studentId),
      to: r.Courses.id.through(r.Enrollments.courseId),
    }),
  },
  Owners: { parts: r.many.Parts({ from: r.Owners.id, to: r.Parts.ownerId }) },
  Groups: {
    items: r.many.Items({ from: r.Groups.id, to: r.Items.groupId }),
    linked: r.many.Items({ from: r.Groups.id.through(r.Links.groupId), to: r.Items.id.through(r.Links.itemId) }),
  },
});

// Over the 1,000-level expression limit.
const COUNT = 1_500;
// Past the 65,535 parameters any of the dialects binds in one statement.
const DISTINCT = 70_000;
// Items 1…DUPLICATED share their title with item i + DISTINCT, so a distinct pass has a choice.
const DUPLICATED = 10_000;
const ROWS = DISTINCT + DUPLICATED;

let db: any;
let schema: GraphQLSchema;

const run = async (source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

const series = (count: number, insert: string) =>
  db.run(sql.raw(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) ${insert}`));

const range = (from: number, to: number, step = 1) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

beforeAll(async () => {
  db = (drizzle as any)({ client: createClient({ url: ':memory:' }), relations });
  await db.run(
    sql`CREATE TABLE batches (a integer NOT NULL, b integer NOT NULL, label text NOT NULL, PRIMARY KEY (a, b))`,
  );
  await db.run(sql`CREATE TABLE students (id integer PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE courses (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.run(
    sql`CREATE TABLE enrollments (student_id integer NOT NULL, course_id integer NOT NULL, PRIMARY KEY (student_id, course_id))`,
  );
  await db.run(sql`CREATE TABLE owners (id integer PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE parts (owner_id integer NOT NULL, n integer NOT NULL, kind text NOT NULL, PRIMARY KEY (owner_id, n))`,
  );
  await db.run(sql`CREATE TABLE groups (id integer PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE items (id integer PRIMARY KEY, group_id integer NOT NULL, title text NOT NULL)`);
  await db.run(
    sql`CREATE TABLE links (group_id integer NOT NULL, item_id integer NOT NULL, PRIMARY KEY (group_id, item_id))`,
  );
  // Every batch row has its own label, so the distinct pass keeps all of them.
  await series(COUNT, `INSERT INTO batches SELECT i, 1, 'l' || i FROM n`);
  // Each student takes one course of their own.
  await series(COUNT, `INSERT INTO students SELECT i FROM n`);
  await series(COUNT, `INSERT INTO courses SELECT i, 'c' || i FROM n`);
  await series(COUNT, `INSERT INTO enrollments SELECT i, i FROM n`);
  // Each owner has two parts of one kind, which distinct folds into one.
  await series(COUNT, `INSERT INTO owners SELECT i FROM n`);
  await series(COUNT, `INSERT INTO parts SELECT i, 1, 'k' FROM n UNION ALL SELECT i, 2, 'k' FROM n`);
  // One group holding every item, directly and through the junction.
  await db.run(sql`INSERT INTO groups VALUES (1)`);
  await series(ROWS, `INSERT INTO items SELECT i, 1, 't' || ((i - 1) % ${DISTINCT}) FROM n`);
  await series(ROWS, `INSERT INTO links SELECT 1, i FROM n`);
  schema = buildSchema(db).schema;
});

describe('distinct over a large set of kept keys', () => {
  it('a root list with a composite primary key', async () => {
    const data = await run('{ batches(distinct: [label]) { a } }');
    expect(data.batches).toHaveLength(COUNT);
  });

  it('a relation whose target has a composite primary key', async () => {
    const data = await run('{ owners { id parts(distinct: [kind]) { n } } }');
    expect(data.owners).toHaveLength(COUNT);
    for (const owner of data.owners) {
      expect(owner.parts).toEqual([{ n: 1 }]);
    }
  });

  it('a many-to-many relation, narrowed by (parent, row) pairs', async () => {
    const data = await run('{ students { id courses(distinct: [name]) { id } } }');
    expect(data.students).toHaveLength(COUNT);
    for (const student of data.students) {
      expect(student.courses).toEqual([{ id: student.id }]);
    }
  });
});

describe('distinct keeping more rows than a statement can bind', () => {
  it('a root list keeps the first row of each group, in order', async () => {
    const data = await run('{ items(distinct: [title]) { id } }');
    expect(data.items.map((row: any) => row.id)).toEqual(range(1, DISTINCT));
  });

  it('a root list follows orderBy in choosing the row it keeps', async () => {
    const data = await run('{ items(distinct: [title], orderBy: { id: { direction: desc, priority: 1 } }) { id } }');
    expect(data.items.map((row: any) => row.id)).toEqual(range(ROWS, DUPLICATED + 1, -1));
  });

  it('a root page is cut from the kept rows', async () => {
    const data = await run(`{ items(distinct: [title], limit: 3, offset: ${DISTINCT - 2}) { id } }`);
    expect(data.items.map((row: any) => row.id)).toEqual([DISTINCT - 1, DISTINCT]);
  });

  it('a relation', async () => {
    const data = await run('{ groups { items(distinct: [title]) { id } } }');
    expect(data.groups[0].items.map((row: any) => row.id)).toEqual(range(1, DISTINCT));
  });

  it('a relation page', async () => {
    const data = await run(`{ groups { items(distinct: [title], limit: 3, offset: ${DISTINCT - 2}) { id } } }`);
    expect(data.groups[0].items.map((row: any) => row.id)).toEqual([DISTINCT - 1, DISTINCT]);
  });

  it('a many-to-many relation', async () => {
    const data = await run('{ groups { linked(distinct: [title]) { id } } }');
    expect(data.groups[0].linked.map((row: any) => row.id)).toEqual(range(1, DISTINCT));
  });
});
