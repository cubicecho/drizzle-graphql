// A cursor value of the right kind can still be one its column cannot hold: text that is no
// decimal or integer, a label outside an ENUM, an integer past its column's range. MySQL
// compared those without complaint, as a string cast to 0 or an enum label by text, and served
// pages from the wrong position. They are now DRIZZLE_INVALID_CURSOR, while every cursor a page
// issues from real rows, edge values included, still pages — among them a `bigint({ mode:
// 'string' })` value small enough that mysql2 reads it as a number, which used to be refused.
import Docker from 'dockerode';
import { defineRelations } from 'drizzle-orm';
import { bigint, decimal, int, mysqlEnum, mysqlTable, tinyint } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import getPort from 'get-port';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const MOODS = ['plain', "it's", 'a b', 'with,comma', '"quoted"', 'ünï', 'zzz'] as const;

const Things = mysqlTable('things', {
  id: int('id').primaryKey(),
  d: decimal('d', { precision: 65, scale: 30 }),
  whole: decimal('whole', { precision: 65, scale: 0, unsigned: true }),
  big: bigint('big', { mode: 'string' }),
  ubig: bigint('ubig', { mode: 'string', unsigned: true }),
  tiny: tinyint('tiny'),
  mood: mysqlEnum('mood', MOODS),
  b53: bigint('b53', { mode: 'number' }),
  b64: bigint('b64', { mode: 'bigint' }),
});
const relations = defineRelations({ Things });

const ROWS = [
  `1, '-99999999999999999999999999999999999.999999999999999999999999999999', '0', '-9223372036854775808', '0', -128, 'plain', -9007199254740991, -9223372036854775808`,
  `2, '99999999999999999999999999999999999.999999999999999999999999999999', '${'9'.repeat(65)}', '9223372036854775807', '18446744073709551615', 127, 'it''s', 9007199254740991, 9223372036854775807`,
  `3, '-0.000000000000000000000000000001', '1', '0', '1', 0, 'a b', 0, 0`,
  `4, '0', '2', '-1', '2', -1, 'with,comma', -1, -1`,
  `5, '1.5', '3', '1', '3', 1, '"quoted"', 1, 1`,
  `6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
  `7, '2', '4', '2', '4', 2, 'ünï', 4503599627370496, 9007199254740993`,
  `8, '3', '5', '3', '5', 3, 'zzz', 3, 3`,
];
const COLUMNS = ['d', 'whole', 'big', 'ubig', 'tiny', 'mood', 'b53', 'b64'];

let docker: Docker;
let container: Docker.Container | undefined;
let client: mysql.Connection | undefined;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  docker = new Docker();
  const port = await getPort({ port: 3306 });
  const image = 'mysql:8';
  const pullStream = await docker.pull(image);
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve(err))),
  );
  container = await docker.createContainer({
    Image: image,
    Env: ['MYSQL_ROOT_PASSWORD=mysql', 'MYSQL_DATABASE=drizzle'],
    name: `drizzle-graphql-mysql-cursor-format-${uuid()}`,
    HostConfig: { AutoRemove: true, PortBindings: { '3306/tcp': [{ HostPort: `${port}` }] } },
  });
  await container.start();

  const connectionString = `mysql://root:mysql@127.0.0.1:${port}/drizzle?charset=utf8mb4`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 90 && !client; attempt++) {
    try {
      client = await mysql.createConnection(connectionString);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!client) {
    throw lastError;
  }

  const labels = MOODS.map((label) => `'${label.replace(/'/g, "''")}'`).join(', ');
  await client.query(`CREATE TABLE things (
    id int PRIMARY KEY, d decimal(65,30), whole decimal(65,0) unsigned, big bigint, ubig bigint unsigned,
    tiny tinyint, mood enum(${labels}), b53 bigint, b64 bigint) CHARACTER SET utf8mb4`);
  await client.query(`INSERT INTO things VALUES ${ROWS.map((row) => `(${row})`).join(', ')}`);
  // Outside strict mode MySQL stores a label the ENUM lacks as '' (index 0), a value real rows can hold.
  await client.query(`SET SESSION sql_mode = ''`);
  await client.query(`INSERT INTO things VALUES (9, '4', '6', '4', '6', 4, 'not a label', 4, 4)`);
  await client.query(`SET SESSION sql_mode = DEFAULT`);
  schema = buildSchema((drizzle as any)({ client, relations })).schema;
}, 180_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  await container?.stop().catch(() => {});
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const orderBy = (column: string, direction: 'asc' | 'desc') =>
  `{ ${column}: { direction: ${direction}, priority: 1 } }`;
const ids = (res: any): number[] => res.data.things.map((row: { id: number }) => row.id);
const TOTAL_ROWS = ROWS.length + 1;

describe('mysql: cursor values whose format their column cannot hold', () => {
  it('stores the off-label ENUM value as the empty string', async () => {
    const [rows] = await client!.query('SELECT mood FROM things WHERE id = 9');
    expect(rows).toEqual([{ mood: '' }]);
  });

  it.each<[string, string, unknown]>([
    ['text that is no decimal', 'd', 'abc'],
    ['a decimal in exponent form', 'd', '1e5'],
    ['an empty decimal', 'whole', ''],
    ['text that is no bigint', 'big', '12abc'],
    ['a string bigint past int64', 'big', '9223372036854775808'],
    ['a negative unsigned bigint', 'ubig', '-1'],
    ['a string bigint past uint64', 'ubig', '18446744073709551616'],
    ['a number past tinyint', 'tiny', 300],
    ['a label outside the enum', 'mood', 'nope'],
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
    expect(res.errors?.map((error) => error.extensions?.['code'])).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it.each(COLUMNS.flatMap((column) => [`${column} asc`, `${column} desc`]))(
    'genuine cursors walk every row ordered by %s',
    async (spec) => {
      const [column, direction] = spec.split(' ') as [string, 'asc' | 'desc'];
      const all = await run(`{ things(orderBy: ${orderBy(column, direction)}) { id cursor } }`);
      expect(all.errors).toBeUndefined();

      const walked: number[] = [];
      let after: string | undefined;
      for (let page = 0; page < TOTAL_ROWS + 1; page++) {
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
      expect(walked).toHaveLength(TOTAL_ROWS);
    },
  );
});
