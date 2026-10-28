// MySQL `int({ unsigned: true })` (uint32) and `serial()` (BIGINT UNSIGNED, uint53) used to be
// typed GraphQL `Int`, which cannot carry the values past 2^31 - 1 these columns hold
// routinely. They are `Float` now, like every other integer kind wider than int32.
import Docker from 'dockerode';
import { defineRelations } from 'drizzle-orm';
import { int, mediumint, mysqlTable, serial, smallint, tinyint } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import getPort from 'get-port';
import { GraphQLFloat, GraphQLInt, type GraphQLObjectType, type GraphQLSchema, getNamedType, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Counters = mysqlTable('counters', {
  id: serial('id').primaryKey(),
  hits: int('hits', { unsigned: true }).notNull(),
  signed: int('signed'),
  tiny: tinyint('tiny', { unsigned: true }),
  small: smallint('small', { unsigned: true }),
  medium: mediumint('medium', { unsigned: true }),
});
const relations = defineRelations({ Counters });

const ABOVE_INT32 = 3_000_000_000;
const UINT32_MAX = 4_294_967_295;

let docker: Docker;
let container: Docker.Container | undefined;
let client: mysql.Connection | undefined;
let schema: GraphQLSchema;

const run = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};

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
    name: `drizzle-graphql-mysql-unsigned-${uuid()}`,
    HostConfig: { AutoRemove: true, PortBindings: { '3306/tcp': [{ HostPort: `${port}` }] } },
  });
  await container.start();

  const connectionString = `mysql://root:mysql@127.0.0.1:${port}/drizzle`;
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

  await client.query(
    'CREATE TABLE counters (id serial PRIMARY KEY, hits int unsigned NOT NULL, signed int, tiny tinyint unsigned, small smallint unsigned, medium mediumint unsigned)',
  );
  await client.query(`INSERT INTO counters (id, hits) VALUES (${ABOVE_INT32}, ${UINT32_MAX})`);
  schema = buildSchema((drizzle as any)({ client, relations })).schema;
}, 180_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  await container?.stop().catch(() => {});
});

describe('mysql unsigned integers', () => {
  it('types uint32 and serial as Float and the narrower kinds as Int', () => {
    const fields = (schema.getType('Counters') as GraphQLObjectType).getFields();
    const typeOf = (name: string) => getNamedType(fields[name]!.type);
    expect(typeOf('id')).toBe(GraphQLFloat);
    expect(typeOf('hits')).toBe(GraphQLFloat);
    for (const name of ['signed', 'tiny', 'small', 'medium']) {
      expect(typeOf(name)).toBe(GraphQLInt);
    }
  });

  it('reads values above 2^31', async () => {
    const data = await run('{ counters { id hits } }');
    expect(data.counters).toEqual([{ id: ABOVE_INT32, hits: UINT32_MAX }]);
  });

  it('writes and filters values above 2^31', async () => {
    await run(`mutation { createCountersSingle(values: { id: ${ABOVE_INT32 + 1}, hits: 3500000000 }) { isSuccess } }`);
    const data = await run('{ counters(where: { hits: { eq: 3500000000 } }) { id hits } }');
    expect(data.counters).toEqual([{ id: ABOVE_INT32 + 1, hits: 3_500_000_000 }]);
  });
});
