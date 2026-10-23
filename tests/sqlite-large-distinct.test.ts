import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `distinct` runs a key pass first and then narrows the read to the keys it kept. For a
// composite primary key, and for (parent, row) pairs through a junction, that narrowing is an
// `OR` with one term per key. SQLite refuses an expression more than 1,000 levels deep, which a
// flat `OR` over that many keys is, so it has to be nested as a balanced tree.

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

const tables = { Batches, Students, Courses, Enrollments, Owners, Parts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Students: {
    courses: r.many.Courses({
      from: r.Students.id.through(r.Enrollments.studentId),
      to: r.Courses.id.through(r.Enrollments.courseId),
    }),
  },
  Owners: { parts: r.many.Parts({ from: r.Owners.id, to: r.Parts.ownerId }) },
});

// Over the 1,000-level expression limit.
const COUNT = 1_500;

let db: any;

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

const series = (insert: string) =>
  db.run(sql.raw(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${COUNT}) ${insert}`));

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
  // Every batch row has its own label, so the distinct pass keeps all of them.
  await series(`INSERT INTO batches SELECT i, 1, 'l' || i FROM n`);
  // Each student takes one course of their own.
  await series(`INSERT INTO students SELECT i FROM n`);
  await series(`INSERT INTO courses SELECT i, 'c' || i FROM n`);
  await series(`INSERT INTO enrollments SELECT i, i FROM n`);
  // Each owner has two parts of one kind, which distinct folds into one.
  await series(`INSERT INTO owners SELECT i FROM n`);
  await series(`INSERT INTO parts SELECT i, 1, 'k' FROM n UNION ALL SELECT i, 2, 'k' FROM n`);
});

describe('distinct over a large set of kept keys', () => {
  it('a root list with a composite primary key', async () => {
    const data = await run(buildSchema(db).schema, '{ batches(distinct: [label]) { a } }');
    expect(data.batches).toHaveLength(COUNT);
  });

  it('a relation whose target has a composite primary key', async () => {
    const data = await run(buildSchema(db).schema, '{ owners { id parts(distinct: [kind]) { n } } }');
    expect(data.owners).toHaveLength(COUNT);
    for (const owner of data.owners) {
      expect(owner.parts).toEqual([{ n: 1 }]);
    }
  });

  it('a many-to-many relation, narrowed by (parent, row) pairs', async () => {
    const data = await run(buildSchema(db).schema, '{ students { id courses(distinct: [name]) { id } } }');
    expect(data.students).toHaveLength(COUNT);
    for (const student of data.students) {
      expect(student.courses).toEqual([{ id: student.id }]);
    }
  });
});
