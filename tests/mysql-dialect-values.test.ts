// MySQL column types whose values the library used to read, compare or compute differently from
// the database:
// - `fieldUpdateOperations` arithmetic on BIGINT / DECIMAL bound the operand as a string, so
//   MySQL computed `big + '1'` in DOUBLE and lost precision;
// - cursor pages over a `date` column bound the decoded cursor `Date`, which mysql2 renders in
//   the process timezone, so outside UTC the cursor row sorted after itself and paging looped;
// - relation keys equal only under the column's collation (the default `utf8mb4_0900_ai_ci` is
//   case-insensitive) were fetched by the SQL and then dropped when JS regrouped rows by parent;
// - MIN()/MAX() over an ENUM, and ordering through a to-one relation by one, compared the label
//   text instead of the declaration order ORDER BY uses;
// - the raw `ilike` / `notIlike` pattern's `\` escapes stay escapes.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { defineRelations } from 'drizzle-orm';
import { bigint, date, decimal, int, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Nums = mysqlTable('nums', {
  id: int('id').primaryKey(),
  big: bigint('big', { mode: 'bigint' }),
  dec: decimal('dec', { precision: 30, scale: 10 }),
  small: decimal('small', { precision: 10, scale: 0 }),
});
const Events = mysqlTable('events', { id: int('id').primaryKey(), day: date('day') });
// Default collation (case- and accent-insensitive); the drizzle column declares none.
const Codes = mysqlTable('codes', { code: varchar('code', { length: 20 }).primaryKey() });
const Items = mysqlTable('items', { id: int('id').primaryKey(), code: varchar('code', { length: 20 }) });
// A binary collation, declared on the drizzle columns too.
const BinCodes = mysqlTable('bin_codes', {
  code: varchar('code', { length: 20 }).collate('utf8mb4_bin').primaryKey(),
});
const BinItems = mysqlTable('bin_items', {
  id: int('id').primaryKey(),
  code: varchar('code', { length: 20 }).collate('utf8mb4_bin'),
});
// declaration order: sad < ok < happy; alphabetical: happy < ok < sad
const Owners = mysqlTable('owners', { id: int('id').primaryKey() });
const Pets = mysqlTable('pets', {
  id: int('id').primaryKey(),
  ownerId: int('owner_id').notNull(),
  mood: mysqlEnum('mood', ['sad', 'ok', 'happy']).notNull(),
  buddyId: int('buddy_id'),
});
const Words = mysqlTable('words', { id: int('id').primaryKey(), w: text('w') });

const relations = defineRelations({ Nums, Events, Codes, Items, BinCodes, BinItems, Owners, Pets, Words }, (r) => ({
  Codes: { items: r.many.Items({ from: r.Codes.code, to: r.Items.code }) },
  Items: { codeRow: r.one.Codes({ from: r.Items.code, to: r.Codes.code }) },
  BinCodes: { items: r.many.BinItems({ from: r.BinCodes.code, to: r.BinItems.code }) },
  BinItems: { codeRow: r.one.BinCodes({ from: r.BinItems.code, to: r.BinCodes.code }) },
  Owners: { pets: r.many.Pets({ from: r.Owners.id, to: r.Pets.ownerId }) },
  Pets: { buddy: r.one.Pets({ from: r.Pets.buddyId, to: r.Pets.id }) },
}));

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let db: any;
const schemas: { eager?: GraphQLSchema; batched?: GraphQLSchema } = {};
const previousTz = process.env['TZ'];

const tunnel = (name: string) => () => {
  const child = spawn('docker', [
    'exec',
    '-i',
    name,
    'bash',
    '-c',
    'exec 3<>/dev/tcp/127.0.0.1/3306; cat <&3 & exec cat >&3',
  ]);
  const stream: any = Duplex.from({ readable: child.stdout, writable: child.stdin } as any);
  stream.setNoDelay = () => stream;
  stream.setKeepAlive = () => stream;
  stream.setTimeout = () => stream;
  stream.on('close', () => child.kill());
  return stream;
};

const connect = async (name: string, database?: string) => {
  let last: unknown;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const conn = await mysql.createConnection({
        stream: tunnel(name),
        user: 'root',
        password: 'mysql',
        ...(database ? { database } : {}),
      } as any);
      await conn.query('select 1');
      return conn;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last;
};

const run = async (source: string, variableValues?: Record<string, any>, eager = true) => {
  const res = await graphql({
    schema: eager ? schemas.eager! : schemas.batched!,
    source,
    contextValue: {},
    variableValues,
  });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};

beforeAll(async () => {
  // mysql2 renders a bound JS Date in the process timezone; west of UTC is where the date
  // cursor used to loop. The session runs off UTC too.
  process.env['TZ'] = 'America/Chicago';

  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-values-${randomUUID().slice(0, 8)}`;
    const started = spawnSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-e',
      'MYSQL_ROOT_PASSWORD=mysql',
      'mysql:8',
    ]);
    if (started.status !== 0) {
      throw new Error(`docker run failed: ${started.stderr}`);
    }
    ownContainer = true;
  }
  const database = `values_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  await connection.query("SET time_zone = '-06:00'");
  db = (drizzle as any)({ client: connection, relations });

  await connection.query(
    'CREATE TABLE nums (id int PRIMARY KEY, big bigint, `dec` decimal(30,10), small decimal(10,0))',
  );
  await connection.query('CREATE TABLE events (id int PRIMARY KEY, day date)');
  await connection.query('CREATE TABLE codes (code varchar(20) PRIMARY KEY)');
  await connection.query('CREATE TABLE items (id int PRIMARY KEY, code varchar(20))');
  await connection.query('CREATE TABLE bin_codes (code varchar(20) COLLATE utf8mb4_bin PRIMARY KEY)');
  await connection.query('CREATE TABLE bin_items (id int PRIMARY KEY, code varchar(20) COLLATE utf8mb4_bin)');
  await connection.query('CREATE TABLE owners (id int PRIMARY KEY)');
  await connection.query(
    "CREATE TABLE pets (id int PRIMARY KEY, owner_id int NOT NULL, mood enum('sad','ok','happy') NOT NULL, buddy_id int)",
  );
  await connection.query('CREATE TABLE words (id int PRIMARY KEY, w text)');

  await db.insert(Events).values([
    { id: 1, day: new Date('2026-01-01T00:00:00Z') },
    { id: 2, day: new Date('2026-01-02T00:00:00Z') },
    { id: 3, day: new Date('2025-12-31T00:00:00Z') },
  ]);
  await db.insert(Codes).values([{ code: 'abc' }, { code: 'xyz' }]);
  await db.insert(Items).values([
    { id: 1, code: 'ABC' },
    { id: 2, code: 'abc' },
    { id: 3, code: 'Ábc' },
    { id: 4, code: 'xyz' },
  ]);
  await db.insert(BinCodes).values([{ code: 'abc' }, { code: 'ABC' }]);
  await db.insert(BinItems).values([
    { id: 1, code: 'ABC' },
    { id: 2, code: 'abc' },
    { id: 3, code: 'abc' },
  ]);
  await db.insert(Owners).values([{ id: 1 }]);
  await db.insert(Pets).values([
    { id: 1, ownerId: 1, mood: 'sad', buddyId: 3 },
    { id: 2, ownerId: 1, mood: 'ok', buddyId: 1 },
    { id: 3, ownerId: 1, mood: 'happy', buddyId: 2 },
  ]);
  await db.insert(Words).values(['a%b', 'a_b', 'axb', 'a\\b', 'a\\xb'].map((w, i) => ({ id: i + 1, w })));

  schemas.eager = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
  schemas.batched = buildSchema(db, { eagerLoadRelations: false }).schema;
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
  if (previousTz === undefined) {
    delete process.env['TZ'];
  } else {
    process.env['TZ'] = previousTz;
  }
});

describe('mysql: exact arithmetic on BIGINT / DECIMAL', () => {
  beforeEach(async () => {
    await connection!.query('DELETE FROM nums');
    await db
      .insert(Nums)
      .values([{ id: 1, big: 9007199254740993n, dec: '12345678901234567890.1234567890', small: '10' }]);
  });

  // MySQL has no RETURNING, so the update reports success and the row is read back.
  const update = async (set: string) => {
    await run(`mutation { updateNums(where: { id: { eq: 1 } }, set: { ${set} }) { isSuccess } }`);
    return (await run('{ numsSingle(where: { id: { eq: 1 } }) { big dec small } }')).numsSingle;
  };

  it('bigint increment, decrement, multiply and divide past 2^53', async () => {
    expect((await update('big: { increment: "1" }')).big).toBe('9007199254740994');
    expect((await update('big: { decrement: "2" }')).big).toBe('9007199254740992');
    expect((await update('big: { multiply: "3" }')).big).toBe('27021597764222976');
    expect((await update('big: { divide: "3" }')).big).toBe('9007199254740992');
    expect((await update('big: { increment: 1 }')).big).toBe('9007199254740993');
  });

  it('decimal arithmetic keeps every digit', async () => {
    expect((await update('dec: { increment: "0.0000000001" }')).dec).toBe('12345678901234567890.1234567891');
    expect((await update('dec: { multiply: "2" }')).dec).toBe('24691357802469135780.2469135782');
    expect((await update('dec: { decrement: "2.469135780246913578e19" }')).dec).toBe('0.2469135782');
  });

  it('the operand keeps its own fraction on a scale-0 decimal', async () => {
    expect((await update('small: { multiply: "1.5" }')).small).toBe('15');
    expect((await update('small: { increment: "0.4" }')).small).toBe('15');
  });
});

describe('mysql: cursor pages over a date column outside UTC', () => {
  const pageAll = async (direction: 'asc' | 'desc') => {
    const ids: number[] = [];
    let after: string | null = null;
    for (let i = 0; i < 6; i++) {
      const data: any = await run(
        `query($a: String) { events(limit: 1, after: $a, orderBy: { day: { direction: ${direction}, priority: 1 } }) { id cursor } }`,
        { a: after },
      );
      if (!data.events.length) {
        break;
      }
      ids.push(data.events[0].id);
      after = data.events[0].cursor;
    }
    return ids;
  };

  it('asc visits each row once', async () => {
    expect(await pageAll('asc')).toEqual([3, 1, 2]);
  });

  it('desc visits each row once', async () => {
    expect(await pageAll('desc')).toEqual([2, 1, 3]);
  });
});

describe('mysql: relation keys equal under the column collation', () => {
  for (const eager of [true, false]) {
    it(`default collation: to-many, to-one and aggregate agree with SQL (eager: ${eager})`, async () => {
      const parents = await run(
        `{ codes(orderBy: { code: { direction: asc, priority: 1 } }) { code items(orderBy: { id: { direction: asc, priority: 1 } }) { id } itemsAggregate { count } } }`,
        undefined,
        eager,
      );
      expect(parents.codes).toEqual([
        { code: 'abc', items: [{ id: 1 }, { id: 2 }, { id: 3 }], itemsAggregate: { count: 3 } },
        { code: 'xyz', items: [{ id: 4 }], itemsAggregate: { count: 1 } },
      ]);

      const children = await run(
        '{ items(orderBy: { id: { direction: asc, priority: 1 } }) { id codeRow { code } } }',
        undefined,
        eager,
      );
      expect(children.items.map((item: any) => item.codeRow?.code)).toEqual(['abc', 'abc', 'abc', 'xyz']);
    });

    it(`declared binary collation keeps keys exact (eager: ${eager})`, async () => {
      const parents = await run(
        `{ binCodes(orderBy: { code: { direction: asc, priority: 1 } }) { code items(orderBy: { id: { direction: asc, priority: 1 } }) { id } itemsAggregate { count } } }`,
        undefined,
        eager,
      );
      expect(parents.binCodes).toEqual([
        { code: 'ABC', items: [{ id: 1 }], itemsAggregate: { count: 1 } },
        { code: 'abc', items: [{ id: 2 }, { id: 3 }], itemsAggregate: { count: 2 } },
      ]);
      const children = await run(
        '{ binItems(orderBy: { id: { direction: asc, priority: 1 } }) { id codeRow { code } } }',
        undefined,
        eager,
      );
      expect(children.binItems.map((item: any) => item.codeRow?.code)).toEqual(['ABC', 'abc', 'abc']);
    });
  }
});

describe('mysql: an ENUM follows declaration order through expressions', () => {
  it('orderBy on the column (control)', async () => {
    const data = await run('{ pets(orderBy: { mood: { direction: desc, priority: 1 } }, limit: 1) { mood } }');
    expect(data.pets[0].mood).toBe('happy');
  });

  it('root aggregate min/max', async () => {
    const data = await run('{ petsAggregate { min { mood } max { mood } } }');
    expect(data.petsAggregate).toEqual({ min: { mood: 'sad' }, max: { mood: 'happy' } });
  });

  it('relation aggregate min/max, eager and batched', async () => {
    for (const eager of [true, false]) {
      const data = await run('{ owners { petsAggregate { min { mood } max { mood } } } }', undefined, eager);
      expect(data.owners[0].petsAggregate).toEqual({ min: { mood: 'sad' }, max: { mood: 'happy' } });
    }
  });

  it('groupBy min/max', async () => {
    const data = await run('{ petsGroupBy(groupBy: [ownerId]) { group { ownerId } min { mood } max { mood } } }');
    expect(data.petsGroupBy).toEqual([{ group: { ownerId: 1 }, min: { mood: 'sad' }, max: { mood: 'happy' } }]);
  });

  it('orderBy through a to-one relation', async () => {
    const data = await run('{ pets(orderBy: { buddy: { mood: { direction: asc, priority: 1 } } }) { id } }');
    // buddies: pet 2 -> sad, pet 3 -> ok, pet 1 -> happy
    expect(data.pets.map((pet: any) => pet.id)).toEqual([2, 3, 1]);
  });
});

describe('mysql: a backslash in an ilike pattern escapes', () => {
  const words = async (op: string, pattern: string) =>
    (
      await run(
        `query($p: String) { words(where: { w: { ${op}: $p } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
        { p: pattern },
      )
    ).words.map((row: any) => row.id);

  it('matches the same rows as on PostgreSQL', async () => {
    expect(await words('ilike', 'A\\%B')).toEqual([1]);
    expect(await words('ilike', 'a\\_b')).toEqual([2]);
    expect(await words('ilike', 'a\\\\b')).toEqual([4]);
    expect(await words('notIlike', 'a\\%b')).toEqual([2, 3, 4, 5]);
    expect(await words('like', 'a\\%b')).toEqual([1]);
  });
});
