import { createClient } from '@libsql/client';
import { buildRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `db.query` is keyed by the relations config, while SQLite and MySQL take the schema
// separately — so these two can disagree. A table in one but not the other used to fail with
// "Did you forget to pass schema to drizzle constructor?", which is the one thing the caller
// did do.

const Users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

const Loner = sqliteTable('loner', {
  id: integer('id').primaryKey(),
  note: text('note'),
});

const dbWith = (relationTables: Record<string, any>) =>
  drizzle({
    client: createClient({ url: ':memory:' }),
    schema: { Users, Loner },
    relations: buildRelations(relationTables, () => ({})),
  } as any);

describe('a schema table missing from the relations config', () => {
  it('names the real cause', () => {
    expect(() => buildSchema(dbWith({ Users }) as any)).toThrow(
      /Table 'Loner' was passed to the drizzle constructor's schema but is missing from its relations config/,
    );
  });

  it('builds once the table is in the relations config, even with no relations of its own', () => {
    expect(() => buildSchema(dbWith({ Users, Loner }) as any)).not.toThrow();
  });

  it('builds when the table is excluded instead', () => {
    expect(() => buildSchema(dbWith({ Users }) as any, { exclude: { tables: ['Loner'] } })).not.toThrow();
  });
});
