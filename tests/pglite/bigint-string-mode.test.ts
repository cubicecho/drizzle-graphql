// `bigint({ mode: 'string' })` used to be typed `String` with a `StringFilter`, whose `like`
// PostgreSQL rejects on a bigint. It is now the `BigInt` scalar with the number-style
// `BigIntFilter`, like the other bigint modes.
import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { bigint as myBigint, int as myInt, mysqlTable } from 'drizzle-orm/mysql-core';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { bigint, integer, pgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  type GraphQLSchema,
  getNamedType,
  graphql,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Past 2^53, so a value that went through a JS number would come back changed.
const BIG = '9007199254740993';
const BIGGER = '9007199254740995';

const Nums = pgTable('nums', {
  id: integer('id').primaryKey(),
  bigStr: bigint('big_str', { mode: 'string' }),
  bigStrs: bigint('big_strs', { mode: 'string' }).array(),
});

const namedTypeOf = (schema: GraphQLSchema, typeName: string, field: string) =>
  getNamedType((schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType).getFields()[field]!.type).name;

describe.sequential("pg bigint({ mode: 'string' })", () => {
  let pglite: PGlite;
  let schema: GraphQLSchema;

  const run = async (source: string) => {
    const res = await graphql({ schema, source, contextValue: {} });
    expect(res.errors?.map((e) => e.message)).toBeUndefined();
    return res.data as any;
  };

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.exec('CREATE TABLE nums (id integer PRIMARY KEY, big_str bigint, big_strs bigint[])');
    await pglite.exec(`INSERT INTO nums VALUES (1, ${BIG}, '{${BIG},1}'), (2, ${BIGGER}, NULL), (3, 5, NULL)`);
    const db = (drizzle as any)({ client: pglite, relations: defineRelations({ Nums }) });
    schema = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
  });
  afterAll(async () => {
    await pglite.close();
  });

  it('is typed BigInt with the BigInt filter, in every position', () => {
    expect(namedTypeOf(schema, 'Nums', 'bigStr')).toBe('BigInt');
    expect(namedTypeOf(schema, 'Nums', 'bigStrs')).toBe('BigInt');
    expect(namedTypeOf(schema, 'CreateNumsInput', 'bigStr')).toBe('BigInt');
    expect(namedTypeOf(schema, 'NumsFilters', 'bigStr')).toBe('BigIntFilter');
    expect(namedTypeOf(schema, 'UpdateNumsInput', 'bigStr')).toBe('BigIntFieldUpdate');
    const filterFields = Object.keys((schema.getType('BigIntFilter') as GraphQLInputObjectType).getFields());
    expect(filterFields).toContain('gt');
    expect(filterFields).not.toContain('like');
  });

  it('reads, filters and orders values past 2^53 exactly', async () => {
    const data = await run(`{ nums(where: { bigStr: { gt: "${BIG}" } }) { id bigStr } }`);
    expect(data.nums).toEqual([{ id: 2, bigStr: BIGGER }]);
    const all = await run('{ nums(orderBy: { bigStr: { priority: 1, direction: desc } }) { id bigStrs } }');
    expect(all.nums).toEqual([
      { id: 2, bigStrs: null },
      { id: 1, bigStrs: [BIG, '1'] },
      { id: 3, bigStrs: null },
    ]);
  });

  it('pages by cursor over the column', async () => {
    const ids: number[] = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const data = await run(
        `{ nums(${after}limit: 1, orderBy: { bigStr: { priority: 1, direction: asc } }) { id cursor } }`,
      );
      if (!data.nums.length) {
        break;
      }
      ids.push(data.nums[0].id);
      after = `after: "${data.nums[0].cursor}", `;
    }
    expect(ids).toEqual([3, 1, 2]);
  });

  it('aggregates min and max as BigInt', async () => {
    const data = await run('{ numsAggregate { min { bigStr } max { bigStr } } }');
    expect(data.numsAggregate).toEqual({ min: { bigStr: '5' }, max: { bigStr: BIGGER } });
  });

  it('writes and increments exactly', async () => {
    await run(`mutation { createNumsSingle(values: { id: 4, bigStr: "${BIG}" }) { id } }`);
    const data = await run(
      'mutation { updateNums(where: { id: { eq: 4 } }, set: { bigStr: { increment: "2" } }) { bigStr } }',
    );
    expect(data.updateNums).toEqual([{ bigStr: BIGGER }]);
  });
});

describe("mysql bigint({ mode: 'string' })", () => {
  const Rows = mysqlTable('rows', {
    id: myInt('id').primaryKey(),
    big: myBigint('big', { mode: 'string' }),
    ubig: myBigint('ubig', { mode: 'string', unsigned: true }),
  });

  it('is typed BigInt, signed or unsigned', () => {
    // Building the schema runs no query, so the client is never used.
    const db = (mysqlDrizzle as any)({ client: { config: {} }, relations: defineRelations({ Rows }) });
    const { schema } = buildSchema(db);
    for (const field of ['big', 'ubig']) {
      expect(namedTypeOf(schema, 'Rows', field)).toBe('BigInt');
      expect(namedTypeOf(schema, 'RowsFilters', field)).toBe('BigIntFilter');
    }
  });
});
