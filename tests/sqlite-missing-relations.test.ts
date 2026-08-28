import { createClient } from '@libsql/client';
import { buildRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// The relations config is the whole table map: drizzle-orm v1 dropped the separate `schema`
// constructor argument, so a table that is not in `buildRelations` is not in the generated
// schema either. Earlier release candidates took both and could disagree, which is what
// `missingQueryBuilderError` was written for; these tests pin the behaviour that replaced it.

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
    relations: buildRelations(relationTables, {}),
  } as any);

describe('a table missing from the relations config', () => {
  it('is left out of the generated schema rather than failing the build', () => {
    const { schema } = buildSchema(dbWith({ Users }) as any);

    expect(schema.getQueryType()?.getFields()).toHaveProperty('users');
    expect(schema.getQueryType()?.getFields()).not.toHaveProperty('loner');
  });

  it('is generated once it is in the relations config, even with no relations of its own', () => {
    const { schema } = buildSchema(dbWith({ Users, Loner }) as any);

    expect(schema.getQueryType()?.getFields()).toHaveProperty('loner');
  });

  it('fails the build when nothing at all is in the relations config', () => {
    expect(() => buildSchema(dbWith({}) as any)).toThrow(/Schema not found in drizzle instance/);
  });
});
