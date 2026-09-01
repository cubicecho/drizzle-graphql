// Unit tests for the vendored resolve-info parser. These run entirely on graphql — no
// database — because the shape they pin down (aliases, fragments, directives, argument
// coercion, abstract types) is the contract every generated resolver reads its column and
// relation selection out of. The integration suites exercise the happy path; a fragment or
// directive edge that quietly drops a field would still return data, just the wrong columns.

import type { GraphQLResolveInfo, GraphQLSchema } from 'graphql';
import { buildSchema, execute, graphql, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { ResolveTree } from '@/util/parse-resolve-info';
import { parseResolveInfo } from '@/util/parse-resolve-info';

const SDL = /* GraphQL */ `
  enum Colour {
    RED
    BLUE
  }

  input Filter {
    name: String
    tags: [String!]
    nested: Filter
  }

  interface Node {
    id: Int!
  }

  type Post implements Node {
    id: Int!
    title: String
    author: User
  }

  type Comment implements Node {
    id: Int!
    body: String
  }

  union Feed = Post | Comment

  type User implements Node {
    id: Int!
    name: String
    colour: Colour
    posts(limit: Int = 3, filter: Filter, ids: [Int!]!, colour: Colour): [Post!]!
    feed: [Feed!]!
  }

  type Query {
    users(limit: Int = 10): [User!]!
    nodes: [Node!]!
    feed: [Feed!]!
  }
`;

const schemaFor = (): GraphQLSchema => buildSchema(SDL);

/**
 * Runs `source` against the SDL above with a resolver on `field` that parses its own resolve
 * info, and hands back the tree. The resolver returns `[]`, so nothing below the root is ever
 * resolved — the parse is the whole point.
 */
const parseAt = async (
  source: string,
  options: { field?: string; variables?: Record<string, unknown>; deep?: boolean; validate?: boolean } = {},
): Promise<ResolveTree | undefined> => {
  const { field = 'users', variables, deep, validate = true } = options;
  const schema = schemaFor();
  let captured: ResolveTree | undefined;
  const queryField = schema.getQueryType()!.getFields()[field]!;
  queryField.resolve = (_source: unknown, _args: unknown, _context: unknown, info: GraphQLResolveInfo) => {
    captured = parseResolveInfo(info, deep === undefined ? { deep: true } : { deep });
    return [];
  };

  const result = validate
    ? await graphql({ schema, source, variableValues: variables })
    : await execute({ schema, document: parse(source), variableValues: variables });
  if ('errors' in result && result.errors?.length) {
    throw result.errors[0];
  }
  return captured;
};

/** The response keys selected on `typeName`, which is what the column extractors iterate. */
const keysOn = (tree: ResolveTree | undefined, typeName: string): string[] =>
  Object.keys(tree?.fieldsByTypeName[typeName] ?? {});

describe('parseResolveInfo', () => {
  it('reads the root field with its name, alias and coerced arguments', async () => {
    const tree = await parseAt('{ users(limit: 5) { id } }');
    expect(tree?.name).toBe('users');
    expect(tree?.alias).toBe('users');
    expect(tree?.args).toEqual({ limit: 5 });
    expect(keysOn(tree, 'User')).toEqual(['id']);
  });

  it('applies a schema default for an omitted argument', async () => {
    const tree = await parseAt('{ users { id } }');
    expect(tree?.args).toEqual({ limit: 10 });
  });

  it('walks nested selections to arbitrary depth', async () => {
    const tree = await parseAt('{ users { posts(ids: [1]) { author { posts(ids: [2]) { title } } } } }');
    const posts = tree!.fieldsByTypeName['User']!['posts']!;
    const author = posts.fieldsByTypeName['Post']!['author']!;
    const innerPosts = author.fieldsByTypeName['User']!['posts']!;
    expect(Object.keys(innerPosts.fieldsByTypeName['Post']!)).toEqual(['title']);
  });

  it('keys entries by response key and keeps the schema name separately', async () => {
    const tree = await parseAt('{ users { handle: name } }');
    const entry = tree!.fieldsByTypeName['User']!['handle']!;
    expect(entry.alias).toBe('handle');
    expect(entry.name).toBe('name');
    expect(tree!.fieldsByTypeName['User']!['name']).toBeUndefined();
  });

  it('keeps one entry per alias when the same field is selected twice', async () => {
    const tree = await parseAt('{ users { a: posts(ids: [1]) { id } b: posts(ids: [2]) { title } } }');
    const fields = tree!.fieldsByTypeName['User']!;
    expect(Object.keys(fields).sort()).toEqual(['a', 'b']);
    expect(fields['a']!.args).toEqual({ ids: [1], limit: 3 });
    expect(fields['b']!.args).toEqual({ ids: [2], limit: 3 });
    expect(Object.keys(fields['a']!.fieldsByTypeName['Post']!)).toEqual(['id']);
    expect(Object.keys(fields['b']!.fieldsByTypeName['Post']!)).toEqual(['title']);
  });

  it('merges the sub-selections of two selections that share a response key', async () => {
    const tree = await parseAt('{ users { posts(ids: [1]) { id } posts(ids: [1]) { title } } }');
    const posts = tree!.fieldsByTypeName['User']!['posts']!;
    expect(Object.keys(posts.fieldsByTypeName['Post']!).sort()).toEqual(['id', 'title']);
  });

  it('resolves named fragment spreads into the level they were spread at', async () => {
    const tree = await parseAt(`
      { users { ...UserFields } }
      fragment UserFields on User { id name }
    `);
    expect(keysOn(tree, 'User').sort()).toEqual(['id', 'name']);
  });

  it('resolves fragments spread inside other fragments', async () => {
    const tree = await parseAt(`
      { users { ...Outer } }
      fragment Outer on User { id ...Inner }
      fragment Inner on User { name posts(ids: [1]) { ...PostFields } }
      fragment PostFields on Post { title }
    `);
    expect(keysOn(tree, 'User').sort()).toEqual(['id', 'name', 'posts']);
    const posts = tree!.fieldsByTypeName['User']!['posts']!;
    expect(Object.keys(posts.fieldsByTypeName['Post']!)).toEqual(['title']);
  });

  it('resolves inline fragments on the same type', async () => {
    const tree = await parseAt('{ users { id ... on User { name } } }');
    expect(keysOn(tree, 'User').sort()).toEqual(['id', 'name']);
  });

  it('resolves an inline fragment with no type condition against the enclosing type', async () => {
    const tree = await parseAt('{ users { id ... @include(if: true) { name } } }');
    expect(keysOn(tree, 'User').sort()).toEqual(['id', 'name']);
  });

  it('keys a selection over an interface by every type condition it was written against', async () => {
    const tree = await parseAt('{ nodes { id ... on Post { title } ... on Comment { body } } }', { field: 'nodes' });
    expect(keysOn(tree, 'Node')).toEqual(['id']);
    expect(keysOn(tree, 'Post')).toEqual(['title']);
    expect(keysOn(tree, 'Comment')).toEqual(['body']);
  });

  it('keys a union selection by its concrete members', async () => {
    const tree = await parseAt('{ feed { __typename ... on Post { title } ... on Comment { body } } }', {
      field: 'feed',
    });
    // The union itself declares no fields, so its own entry stays empty.
    expect(keysOn(tree, 'Feed')).toEqual([]);
    expect(keysOn(tree, 'Post')).toEqual(['title']);
    expect(keysOn(tree, 'Comment')).toEqual(['body']);
  });

  it('drops __typename and other meta fields', async () => {
    const tree = await parseAt('{ users { __typename id } }');
    expect(keysOn(tree, 'User')).toEqual(['id']);
  });

  it('seeds an empty entry for a composite field whose selection contributed nothing', async () => {
    const tree = await parseAt('{ users { __typename } }');
    expect(tree?.fieldsByTypeName).toEqual({ User: {} });
  });

  describe('directives', () => {
    it('honours a literal @skip and @include on a field', async () => {
      const tree = await parseAt('{ users { id name @skip(if: true) colour @include(if: false) } }');
      expect(keysOn(tree, 'User')).toEqual(['id']);
    });

    it('honours a variable-driven @skip on a field', async () => {
      const tree = await parseAt('query ($s: Boolean!) { users { id name @skip(if: $s) } }', {
        variables: { s: true },
      });
      expect(keysOn(tree, 'User')).toEqual(['id']);
      const kept = await parseAt('query ($s: Boolean!) { users { id name @skip(if: $s) } }', {
        variables: { s: false },
      });
      expect(keysOn(kept, 'User').sort()).toEqual(['id', 'name']);
    });

    it('honours a variable-driven @include on a field', async () => {
      const tree = await parseAt('query ($i: Boolean!) { users { id name @include(if: $i) } }', {
        variables: { i: false },
      });
      expect(keysOn(tree, 'User')).toEqual(['id']);
    });

    it('honours directives on a fragment spread', async () => {
      const source = `
        query ($i: Boolean!) { users { id ...UserFields @include(if: $i) } }
        fragment UserFields on User { name }
      `;
      expect(keysOn(await parseAt(source, { variables: { i: false } }), 'User')).toEqual(['id']);
      expect(keysOn(await parseAt(source, { variables: { i: true } }), 'User').sort()).toEqual(['id', 'name']);
    });

    it('honours directives on an inline fragment', async () => {
      const source = 'query ($s: Boolean!) { users { id ... on User @skip(if: $s) { name } } }';
      expect(keysOn(await parseAt(source, { variables: { s: true } }), 'User')).toEqual(['id']);
      expect(keysOn(await parseAt(source, { variables: { s: false } }), 'User').sort()).toEqual(['id', 'name']);
    });
  });

  describe('argument coercion', () => {
    it('coerces variables, enums, input objects, lists and defaults', async () => {
      const tree = await parseAt(
        `query ($limit: Int!, $name: String) {
           users { posts(limit: $limit, ids: [1, 2], colour: RED, filter: { name: $name, tags: ["a"] }) { id } }
         }`,
        { variables: { limit: 7, name: 'ada' } },
      );
      const posts = tree!.fieldsByTypeName['User']!['posts']!;
      expect(posts.args).toEqual({
        limit: 7,
        ids: [1, 2],
        colour: 'RED',
        filter: { name: 'ada', tags: ['a'] },
      });
    });

    it('coerces a single value into a list argument, as the spec requires', async () => {
      const tree = await parseAt('{ users { posts(ids: 1) { id } } }');
      expect(tree!.fieldsByTypeName['User']!['posts']!.args['ids']).toEqual([1]);
    });

    it('coerces a nested input object through a variable', async () => {
      const tree = await parseAt('query ($f: Filter) { users { posts(ids: [1], filter: $f) { id } } }', {
        variables: { f: { name: 'x', nested: { name: 'y' } } },
      });
      expect(tree!.fieldsByTypeName['User']!['posts']!.args['filter']).toEqual({
        name: 'x',
        nested: { name: 'y' },
      });
    });

    it('returns plain objects, not null-prototype ones', async () => {
      const tree = await parseAt('{ users(limit: 1) { id } }');
      expect(Object.getPrototypeOf(tree!.args)).toBe(Object.prototype);
    });
  });

  describe('deep: false', () => {
    it('reads the root field only', async () => {
      const tree = await parseAt('{ users(limit: 2) { id posts(ids: [1]) { title } } }', { deep: false });
      expect(tree?.args).toEqual({ limit: 2 });
      // The composite entry is still seeded; nothing under it is walked.
      expect(tree?.fieldsByTypeName).toEqual({ User: {} });
    });
  });

  describe('malformed documents', () => {
    it('throws on a fragment spread with no definition', async () => {
      await expect(
        parseAt(
          `{ users { ...Missing } }
           fragment Unused on User { id }`,
          { validate: false },
        ),
      ).rejects.toThrow(/unknown fragment 'Missing'/);
    });

    it('terminates on a self-referential fragment instead of recursing forever', async () => {
      const tree = await parseAt(
        `{ users { ...Loop } }
         fragment Loop on User { id ...Loop }`,
        { validate: false },
      );
      expect(keysOn(tree, 'User')).toEqual(['id']);
    });
  });
});
