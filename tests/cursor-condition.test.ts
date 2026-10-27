// The SQL shape of the keyset predicate behind `after`. Correctness is covered by the page
// walks (tests/util/cursor-walk.ts); these pin the shape, because the shape is what decides
// whether the database can seek an index to the cursor. `id > $1 OR id IS NULL` on a NOT NULL
// key, or the expanded `a > $1 OR (a = $2 AND b > $3)` on PostgreSQL, still returns the right
// rows — it just makes the database read and discard every row before the cursor.
import {
  MySqlDialect,
  datetime as mysqlDatetime,
  mysqlEnum,
  int as mysqlInt,
  mysqlTable,
} from 'drizzle-orm/mysql-core';
import { PgDialect, integer as pgInteger, pgTable, timestamp as pgTimestamp } from 'drizzle-orm/pg-core';
import { SQLiteDialect, integer as sqliteInteger, sqliteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import type { CursorOrderEntry, NullOrdering } from '@/util/builders/common';
import { buildCursorCondition } from '@/util/builders/common';

const Pg = pgTable('t', {
  id: pgInteger('id').primaryKey(),
  created: pgTimestamp('created').notNull(),
  score: pgInteger('score'),
});
const MySql = mysqlTable('t', {
  id: mysqlInt('id').primaryKey(),
  created: mysqlDatetime('created').notNull(),
  score: mysqlInt('score'),
  role: mysqlEnum('role', ['admin', 'member', 'guest']).notNull(),
});
const Sqlite = sqliteTable('t', {
  id: sqliteInteger('id').primaryKey(),
  created: sqliteInteger('created', { mode: 'timestamp' }).notNull(),
  score: sqliteInteger('score'),
});

const DAY = new Date('2025-06-01T00:00:00Z');

const dialects = {
  pg: { dialect: new PgDialect(), table: Pg, nulls: 'nulls-largest' as NullOrdering },
  mysql: { dialect: new MySqlDialect(), table: MySql, nulls: 'nulls-smallest' as NullOrdering },
  sqlite: { dialect: new SQLiteDialect(), table: Sqlite, nulls: 'nulls-smallest' as NullOrdering },
};

/**
 * The predicate's SQL and parameters. Parentheses are stripped from the SQL: drizzle wraps every
 * `and` / `or` operand in its own pair, which these tests have no reason to pin. A row value
 * still reads unambiguously without them — `"a", "b" > $1, $2`.
 */
const predicate = (name: keyof typeof dialects, entries: CursorOrderEntry[], values: unknown[]) => {
  const { dialect, table, nulls } = dialects[name];
  const query = (dialect as any).sqlToQuery(buildCursorCondition(table, entries, values, nulls));
  return { sql: (query.sql as string).replace(/[()]/g, ''), params: query.params as unknown[] };
};

describe('keyset predicate shape', () => {
  it('leaves IS NULL out for a NOT NULL key, on whichever side its NULLs would sort', () => {
    // PostgreSQL sorts NULLs last ascending; MySQL and SQLite last descending.
    expect(predicate('pg', [['id', 'asc']], [5]).sql).toBe('"t"."id" > $1');
    expect(predicate('mysql', [['id', 'desc']], [5]).sql).toBe('`t`.`id` < ?');
    expect(predicate('sqlite', [['id', 'desc']], [5]).sql).toBe('"t"."id" < ?');
    // A `nulls: last` override on a NOT NULL key changes nothing either.
    expect(predicate('pg', [['id', 'desc', 'last']], [5]).sql).toBe('"t"."id" < $1');
  });

  it('keeps IS NULL for a nullable key', () => {
    expect(
      predicate(
        'pg',
        [
          ['score', 'asc'],
          ['id', 'asc'],
        ],
        [7, 5],
      ).sql,
    ).toBe('"t"."score" > $1 or "t"."score" is null or "t"."score" = $2 and "t"."id" > $3');
  });

  it('compares NOT NULL keys sorted one way as a row value on PostgreSQL and SQLite', () => {
    const asc: CursorOrderEntry[] = [
      ['created', 'asc'],
      ['id', 'asc'],
    ];
    const desc: CursorOrderEntry[] = [
      ['created', 'desc'],
      ['id', 'desc'],
    ];
    expect(predicate('pg', asc, [DAY, 5])).toMatchObject({
      sql: '"t"."created", "t"."id" > $1, $2',
      params: ['2025-06-01T00:00:00.000Z', 5],
    });
    expect(predicate('pg', desc, [DAY, 5]).sql).toBe('"t"."created", "t"."id" < $1, $2');
    // The integer timestamp binds as the column stores it — seconds — exactly as `gt` would.
    expect(predicate('sqlite', asc, [DAY, 5])).toMatchObject({
      sql: '"t"."created", "t"."id" > ?, ?',
      params: [DAY.getTime() / 1000, 5],
    });
    expect(predicate('sqlite', desc, [DAY, 5]).sql).toBe('"t"."created", "t"."id" < ?, ?');
  });

  it('keeps the expanded form for mixed directions', () => {
    expect(
      predicate(
        'pg',
        [
          ['created', 'desc'],
          ['id', 'asc'],
        ],
        [DAY, 5],
      ).sql,
    ).toBe('"t"."created" < $1 or "t"."created" = $2 and "t"."id" > $3');
  });

  it('keeps the expanded form on MySQL, whose range optimizer only seeks an index for that one', () => {
    expect(
      predicate(
        'mysql',
        [
          ['created', 'desc'],
          ['id', 'desc'],
        ],
        [DAY, 5],
      ).sql,
    ).toBe('`t`.`created` < ? or `t`.`created` = ? and `t`.`id` < ?');
    // An ENUM compares by its declaration index, as it sorts.
    expect(
      predicate(
        'mysql',
        [
          ['role', 'asc'],
          ['id', 'asc'],
        ],
        ['member', 5],
      ),
    ).toMatchObject({
      sql: '`t`.`role` + 0 > ? or `t`.`role` = ? and `t`.`id` > ?',
      params: [2, 'member', 5],
    });
  });

  it('keeps the expanded form when a cursor value is NULL', () => {
    expect(
      predicate(
        'sqlite',
        [
          ['score', 'asc'],
          ['id', 'asc'],
        ],
        [null, 5],
      ).sql,
    ).toBe('"t"."score" is not null or "t"."score" is null and "t"."id" > ?');
  });

  it('refuses a NULL cursor value for a NOT NULL column, which no row holds', () => {
    const entries: CursorOrderEntry[] = [
      ['created', 'asc'],
      ['id', 'asc'],
    ];
    expect(() => predicate('sqlite', entries, [null, 5])).toThrow(/value for 'created'/);
  });
});
