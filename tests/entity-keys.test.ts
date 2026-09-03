/**
 * What the `typeNameMapper` config does to the *keys* of `entities`.
 *
 * `buildSchema` is generic over the config it is handed, so the three naming modes each key
 * the entity maps differently: no mapper leaves every key the table key itself, the
 * `'singularize'` preset splits the plural and singular nouns apart, and a mapper *function*
 * renames types in a way no type can predict, so the maps fall back to an index signature
 * rather than naming fields the build does not publish.
 *
 * Everything here is compile-time; `npm run typecheck` is what enforces it.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { describe, expectTypeOf, it } from 'vitest';
import { buildSchema, type NamingOf } from '@/index';
import type * as schema from './schema/pg';

declare const db: PgliteDatabase<typeof schema.relations>;

// Never called. The calls exist so the assertions run through `buildSchema`'s own inference,
// the way a consumer's would, instead of naming the naming mode by hand.
const defaulted = () => buildSchema(db);
const singularized = () => buildSchema(db, { typeNameMapper: 'singularize' });
const mapped = () => buildSchema(db, { typeNameMapper: (name) => ({ singular: name, plural: name }) });

type Defaulted = ReturnType<typeof defaulted>['entities'];
type Singularized = ReturnType<typeof singularized>['entities'];
type Mapped = ReturnType<typeof mapped>['entities'];

/** The write mutations for one prefix, across the four tables in the pg fixture. */
type Writes<TEntities, TPrefix extends string> = Extract<keyof TEntities & string, `${TPrefix}${string}`>;

describe('Generated entity keys', () => {
  it('reads the naming mode off the config it is handed', () => {
    expectTypeOf<NamingOf<{ typeNameMapper: 'singularize' }>>().toEqualTypeOf<'singularize'>();
    expectTypeOf<
      NamingOf<{ typeNameMapper: (name: string) => { singular: string; plural: string } }>
    >().toEqualTypeOf<'loose'>();
    expectTypeOf<NamingOf<{ prefixes: { insert: 'add' } }>>().toEqualTypeOf<false>();
  });

  it('leaves every key the table key when there is no mapper', () => {
    expectTypeOf<keyof Defaulted['queries']>().toEqualTypeOf<
      | 'users'
      | 'usersSingle'
      | 'usersAggregate'
      | 'posts'
      | 'postsSingle'
      | 'postsAggregate'
      | 'customers'
      | 'customersSingle'
      | 'customersAggregate'
      | 'tags'
      | 'tagsSingle'
      | 'tagsAggregate'
    >();
  });

  it('splits the two nouns under the singularize preset', () => {
    expectTypeOf<keyof Singularized['queries']>().toEqualTypeOf<
      | 'users'
      | 'user'
      | 'usersAggregate'
      | 'posts'
      | 'post'
      | 'postsAggregate'
      | 'customers'
      | 'customer'
      | 'customersAggregate'
      | 'tags'
      | 'tag'
      | 'tagsAggregate'
    >();
  });

  // The bug this whole change is about: `updateUsers` used to be the mass update and the
  // one-row form had no name but `updateUsersSingle`, even under a mapper that had already
  // separated every other operation into a plural/singular pair.
  it('gives the set updates the plural noun and the one-row update the singular', () => {
    expectTypeOf<Writes<Singularized['mutations'], 'update'>>().toEqualTypeOf<
      | 'updateUsers'
      | 'updateUsersMany'
      | 'updateUser'
      | 'updatePosts'
      | 'updatePostsMany'
      | 'updatePost'
      | 'updateCustomers'
      | 'updateCustomersMany'
      | 'updateCustomer'
      | 'updateTags'
      | 'updateTagsMany'
      | 'updateTag'
    >();
    expectTypeOf<Writes<Singularized['mutations'], 'delete'>>().toEqualTypeOf<
      | 'deleteUsers'
      | 'deleteUser'
      | 'deletePosts'
      | 'deletePost'
      | 'deleteCustomers'
      | 'deleteCustomer'
      | 'deleteTags'
      | 'deleteTag'
    >();
  });

  it('keeps the Single suffix when there is no mapper to separate the pair', () => {
    expectTypeOf<Writes<Defaulted['mutations'], 'update'>>().toEqualTypeOf<
      | 'updateUsers'
      | 'updateUsersMany'
      | 'updateUsersSingle'
      | 'updatePosts'
      | 'updatePostsMany'
      | 'updatePostsSingle'
      | 'updateCustomers'
      | 'updateCustomersMany'
      | 'updateCustomersSingle'
      | 'updateTags'
      | 'updateTagsMany'
      | 'updateTagsSingle'
    >();
  });

  it('names the derived types from the singular noun', () => {
    expectTypeOf<keyof Singularized['types']>().toEqualTypeOf<
      'User' | 'UserAggregate' | 'Post' | 'PostAggregate' | 'Customer' | 'CustomerAggregate' | 'Tag' | 'TagAggregate'
    >();
    expectTypeOf<keyof Singularized['inputs']>().toEqualTypeOf<
      | 'CreateUserInput'
      | 'UpdateUserInput'
      | 'UpdateUserManyInput'
      | 'UserOrderBy'
      | 'UserFilters'
      | 'CreatePostInput'
      | 'UpdatePostInput'
      | 'UpdatePostManyInput'
      | 'PostOrderBy'
      | 'PostFilters'
      | 'CreateCustomerInput'
      | 'UpdateCustomerInput'
      | 'UpdateCustomerManyInput'
      | 'CustomerOrderBy'
      | 'CustomerFilters'
      | 'CreateTagInput'
      | 'UpdateTagInput'
      | 'UpdateTagManyInput'
      | 'TagOrderBy'
      | 'TagFilters'
    >();
  });

  // A mapper function renames types at runtime, so no key here is knowable. What survives is
  // the shape around the noun: the maps become index signatures, and the ones whose keys carry
  // a fixed prefix or suffix keep it as a pattern, so a name of the right shape still resolves.
  it('falls back to an index signature under a mapper function', () => {
    expectTypeOf<keyof Mapped['queries']>().toEqualTypeOf<string | number>();
    expectTypeOf<keyof Mapped['types']>().toEqualTypeOf<string | number>();
    expectTypeOf<
      Extract<'createWhateverTheMapperSaid', keyof Mapped['mutations']>
    >().toEqualTypeOf<'createWhateverTheMapperSaid'>();
    expectTypeOf<
      Extract<'CreateWhateverTheMapperSaidInput', keyof Mapped['inputs']>
    >().toEqualTypeOf<'CreateWhateverTheMapperSaidInput'>();
    // ...and a name of the wrong shape still does not.
    expectTypeOf<Extract<'NotAnInputName', keyof Mapped['inputs']>>().toEqualTypeOf<never>();
  });
});
