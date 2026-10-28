// A cursor value of the right kind can still be one its column cannot hold: text that is no
// uuid, numeric or inet, a label outside an enum, an integer past its column's range, a NUL in
// text. PostgreSQL refused those as an Internal server error. They are now DRIZZLE_INVALID_CURSOR,
// while every cursor a page issues from real rows, edge values included, still pages.
import { PGlite } from '@electric-sql/pglite';
import { defineRelations, sql } from 'drizzle-orm';
import {
  bigint,
  cidr,
  inet,
  integer,
  macaddr,
  macaddr8,
  numeric,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const MOODS = ['plain', "it's", 'a b', 'with,comma', '"quoted"', 'ünï', 'UPPER'] as const;
const mood = pgEnum('mood', MOODS);

const Things = pgTable('things', {
  id: integer('id').primaryKey(),
  u: uuid('u'),
  n: numeric('n'),
  big: bigint('big', { mode: 'string' }),
  b64: bigint('b64', { mode: 'bigint' }),
  b53: bigint('b53', { mode: 'number' }),
  small: smallint('small'),
  i: integer('i'),
  r: real('r'),
  mood: mood('mood'),
  ip: inet('ip'),
  net: cidr('net'),
  mac: macaddr('mac'),
  mac8: macaddr8('mac8'),
  label: text('label'),
});
const relations = defineRelations({ Things });

// One row per line: id, then each column in declaration order. NULLs ride along so the walk
// crosses them too.
const ROWS = [
  `1, '{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}', 'NaN', '-9223372036854775808', -9223372036854775808, -9007199254740991, -32768, -2147483648, 'NaN', 'plain', '::ffff:1.2.3.4', '10.0.0.0/8', '08:00:2B:01:02:03', '08:00:2b:01:02:03:04:05', 'a'`,
  `2, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'Infinity', '9223372036854775807', 9223372036854775807, 9007199254740991, 32767, 2147483647, 'Infinity', 'it''s', '10.0.0.1', '::/0', '0800.2b01.0204', '08002b:0102030406', 'b'`,
  `3, '00000000-0000-0000-0000-000000000000', '-Infinity', '0', 0, 0, 0, 0, '-Infinity', 'a b', '1.2.3.4/24', '2001:db8::/32', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff:ff:ff', 'c'`,
  `4, 'A0EEBC999C0B4EF8BB6D6BB9BD380A12', '-123456789012345678901234567890.123456789', '-1', -1, -1, -1, -1, '3.4028235e38', 'with,comma', '::1', '192.168.1.0/24', 'ff:ff:ff:ff:ff:ff', '08:00:2b:01:02:03', 'd'`,
  `5, 'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a13', '1e-20', '1', 1, 1, 1, 1, '1e-45', '"quoted"', 'fe80::1/64', '1.2.3.4/32', '08-00-2b-01-02-05', '0800.2b01.0203.0407', 'e'`,
  `6, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14', '1e20', '2', 2, 2, 2, 2, '-3.4028235e38', 'ünï', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2:3:4:5:6/128', '08002b010206', '08002b0102030408', 'f'`,
  `7, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15', '-0.000000000000000000000000000001', '3', 3, 3, 3, 3, '-1e-45', 'UPPER', '2001:db8::', '::ffff:0.0.0.0/96', 'AA:BB:CC:DD:EE:FF', 'AA:BB:CC:DD:EE:FF:00:11', ''`,
  `8, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
  `9, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16', '${'9'.repeat(1000)}.${'1'.repeat(500)}', '4', 4, 4, 4, 4, '0', 'plain', '255.255.255.255', '0.0.0.0/0', '01:02:03:04:05:06', '01:02:03:04:05:06:07:08', 'g'`,
];
const COLUMNS = Object.keys(Things).filter((key) => key !== 'id' && key !== 'enableRLS');

let pglite: PGlite;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await db.execute(
    sql.raw(`CREATE TYPE mood AS ENUM (${MOODS.map((label) => `'${label.replace(/'/g, "''")}'`).join(', ')})`),
  );
  await db.execute(sql`CREATE TABLE things (
    id integer primary key, u uuid, n numeric, big bigint, b64 bigint, b53 bigint, small smallint, i integer,
    r real, mood mood, ip inet, net cidr, mac macaddr, mac8 macaddr8, label text)`);
  await db.execute(sql.raw(`INSERT INTO things VALUES ${ROWS.map((row) => `(${row})`).join(', ')}`));
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const codes = (res: Awaited<ReturnType<typeof run>>) => res.errors?.map((error) => error.extensions?.['code']);
const orderBy = (column: string, direction: 'asc' | 'desc') =>
  `{ ${column}: { direction: ${direction}, priority: 1 } }`;
const ids = (res: any): number[] => res.data.things.map((row: { id: number }) => row.id);

describe('pglite: cursor values whose format their column cannot hold', () => {
  it.each<[string, string, unknown]>([
    ['text that is no uuid', 'u', 'not-a-uuid'],
    ['a uuid one digit short', 'u', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1'],
    ['a uuid with a non-hex digit', 'u', 'g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
    ['a uuid with surrounding spaces', 'u', ' a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 '],
    ['text that is no numeric', 'n', 'abc'],
    ['an empty numeric', 'n', ''],
    ['a numeric past its range', 'n', `${'9'.repeat(131073)}`],
    ['text that is no bigint', 'big', '12abc'],
    ['a string bigint past int64', 'big', '9223372036854775808'],
    ['a tagged bigint past int64', 'b64', { $type: 'bigint', value: '-9223372036854775809' }],
    ['a number past int64', 'b53', 1e20],
    ['a number past smallint', 'small', 40000],
    ['a number past integer', 'i', 3000000000],
    ['a number past real', 'r', 1e300],
    ['a number real underflows', 'r', 1e-50],
    ['a label outside the enum', 'mood', 'nope'],
    ['a label in the wrong case', 'mood', 'upper'],
    ['text that is no inet', 'ip', 'nope'],
    ['an inet octet past 255', 'ip', '1.2.3.256'],
    ['an inet prefix past 32', 'ip', '1.2.3.4/33'],
    ['an inet zone id', 'ip', 'fe80::1%eth0'],
    ['an inet with two ::', 'ip', '1::2::3'],
    ['text that is no cidr', 'net', '10.0.0.0/8/8'],
    ['text that is no macaddr', 'mac', 'nope'],
    ['a macaddr one byte short', 'mac', '08:00:2b:01:02'],
    ['text that is no macaddr8', 'mac8', '08:00:2b:01:02:03:04'],
    ['a NUL in text', 'label', 'a\u0000b'],
    ['a NUL in a uuid', 'u', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11\u0000'],
  ])('%s is DRIZZLE_INVALID_CURSOR', async (_name, column, value) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 1],
    });
    const res = await run(`{ things(orderBy: ${orderBy(column, 'asc')}, after: "${after}") { id } }`);
    expect(res.errors?.map((error) => error.message)).toEqual([expect.stringMatching(new RegExp(`'${column}'`))]);
    expect(codes(res)).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it.each<[string, string, unknown]>([
    ['an uppercase braced uuid', 'u', '{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}'],
    ['a uuid without hyphens', 'u', 'a0eebc999c0b4ef8bb6d6bb9bd380a11'],
    ['a numeric NaN', 'n', 'NaN'],
    ['a long negative numeric', 'n', '-123456789012345678901234567890.123456789'],
    ['the smallest bigint', 'big', '-9223372036854775808'],
    ['an enum label with a quote', 'mood', "it's"],
    ['an inet without its /32', 'ip', '10.0.0.1'],
    ['an inet with its /128', 'ip', '::ffff:1.2.3.4/128'],
    ['an uppercase macaddr', 'mac', '08:00:2B:01:02:03'],
    ['a cidr written as PostgreSQL prints it', 'net', '10.0.0.0/8'],
  ])('%s still pages', async (_name, column, value) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 1],
    });
    const res = await run(`{ things(orderBy: ${orderBy(column, 'asc')}, after: "${after}") { id } }`);
    expect(res.errors).toBeUndefined();
  });

  it.each(COLUMNS.flatMap((column) => [`${column} asc`, `${column} desc`]))(
    'genuine cursors walk every row ordered by %s',
    async (spec) => {
      const [column, direction] = spec.split(' ') as [string, 'asc' | 'desc'];
      // `cursor` is selected so the order carries the same id tiebreak the walk pages by.
      const all = await run(`{ things(orderBy: ${orderBy(column, direction)}) { id cursor } }`);
      expect(all.errors).toBeUndefined();

      const walked: number[] = [];
      let after: string | undefined;
      for (let page = 0; page < ROWS.length + 1; page++) {
        const res: any = await run(
          `{ things(orderBy: ${orderBy(column, direction)}, limit: 2${after ? `, after: "${after}"` : ''}) { id cursor } }`,
        );
        expect(res.errors).toBeUndefined();
        if (!res.data.things.length) {
          break;
        }
        walked.push(...ids(res));
        after = res.data.things.at(-1).cursor;
      }
      expect(walked).toEqual(ids(all));
      expect(walked).toHaveLength(ROWS.length);
    },
  );
});
