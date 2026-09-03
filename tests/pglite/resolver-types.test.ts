import { describe, expectTypeOf, it } from 'vitest';
import type { InsertArrResolver, InsertResolver, UpsertArrResolver, UpsertResolver } from '@/index';
import type * as schema from '../schema/pg';
import type { DefaultEntities } from './common';

// Type-only: nothing here touches a database, so there is no setup/teardown.
type Entities = DefaultEntities;
type Users = typeof schema.Users;

type Returns<T extends (...args: any) => any> = Awaited<ReturnType<T>>;
type Values<T extends (...args: any) => any> = NonNullable<NonNullable<Parameters<T>[1]>['values']>;

describe('Mutation resolver types', () => {
  // These two were named the wrong way round: InsertResolver described the array mutation and
  // InsertArrResolver the single one, so anyone annotating a custom resolver with them got the
  // opposite shape from what the name promised.
  it('InsertResolver is the single-row resolver', () => {
    expectTypeOf<Values<InsertResolver<Users, false>>>().not.toBeArray();
    expectTypeOf<Returns<InsertResolver<Users, false>>>().not.toBeArray();
  });

  it('InsertArrResolver is the array resolver', () => {
    expectTypeOf<Values<InsertArrResolver<Users, false>>>().toBeArray();
    expectTypeOf<Returns<InsertArrResolver<Users, false>>>().toBeArray();
  });

  it('Upsert resolvers follow the same convention', () => {
    expectTypeOf<Values<UpsertResolver<Users, false>>>().not.toBeArray();
    expectTypeOf<Returns<UpsertResolver<Users, false>>>().not.toBeArray();
    expectTypeOf<Values<UpsertArrResolver<Users, false>>>().toBeArray();
    expectTypeOf<Returns<UpsertArrResolver<Users, false>>>().toBeArray();
  });

  it('Returnless dialects resolve to MutationReturn either way', () => {
    expectTypeOf<Returns<InsertResolver<Users, true>>>().toEqualTypeOf<{ isSuccess: boolean }>();
    expectTypeOf<Returns<InsertArrResolver<Users, true>>>().toEqualTypeOf<{ isSuccess: boolean }>();
  });
});

describe('Generated entities wire the right resolver to each mutation', () => {
  it('create<Table> returns an array and create<Table>Single returns one row', () => {
    expectTypeOf<Returns<Entities['mutations']['createUsers']['resolve']>>().toBeArray();
    expectTypeOf<Returns<Entities['mutations']['createUsersSingle']['resolve']>>().not.toBeArray();
  });

  it('upsert<Table> follows the same split', () => {
    type UpsertArr = NonNullable<Entities['mutations']['upsertUsers']>;
    type UpsertSingle = NonNullable<Entities['mutations']['upsertUsersSingle']>;

    expectTypeOf<Returns<UpsertArr['resolve']>>().toBeArray();
    expectTypeOf<Returns<UpsertSingle['resolve']>>().not.toBeArray();
  });
});
