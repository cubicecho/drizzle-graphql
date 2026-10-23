// A relation resolver runs once per parent row, so the plan it derives from its own field — the
// loader key included — would otherwise be rebuilt for every row of a batch. These pin that the
// cache hands the first value back, that it separates fields, nodes and requests, and that it
// stays correct when there is no context to cache on.

import { describe, expect, it } from 'vitest';
import { getOrCreateRequestValue } from '@/util/batch-loader/index.ts';

const node = () => ({ kind: 'Field' as const });
// `info.fieldNodes`: one node, unless graphql merged several selections into the field.
const fieldNodes = () => [node()];

describe('getOrCreateRequestValue', () => {
  it('computes once per node and key', () => {
    const context: any = {};
    const field = fieldNodes();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { calls };
    };

    const first = getOrCreateRequestValue(context, field, 'relation:Users::posts', compute);

    expect(getOrCreateRequestValue(context, field, 'relation:Users::posts', compute)).toBe(first);
    expect(calls).toBe(1);
  });

  it('caches a falsy value rather than recomputing it', () => {
    const context: any = {};
    const field = fieldNodes();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return undefined;
    };

    getOrCreateRequestValue(context, field, 'k', compute);
    getOrCreateRequestValue(context, field, 'k', compute);

    expect(calls).toBe(1);
  });

  it('keeps separate keys on one node apart', () => {
    const context: any = {};
    const field = fieldNodes();

    const posts = getOrCreateRequestValue(context, field, 'relation:Users::posts', () => ({ of: 'posts' }));
    const comments = getOrCreateRequestValue(context, field, 'relation:Users::comments', () => ({ of: 'comments' }));

    expect(comments).not.toBe(posts);
    expect(comments.of).toBe('comments');
  });

  it('keeps separate nodes apart', () => {
    const context: any = {};

    const first = getOrCreateRequestValue(context, fieldNodes(), 'k', () => ({}));
    const second = getOrCreateRequestValue(context, fieldNodes(), 'k', () => ({}));

    expect(second).not.toBe(first);
  });

  it('never carries a value between requests sharing a parsed document', () => {
    const field = fieldNodes();

    const first = getOrCreateRequestValue({} as any, field, 'k', () => ({}));
    const second = getOrCreateRequestValue({} as any, field, 'k', () => ({}));

    expect(second).not.toBe(first);
  });

  it('keeps merged selections that share their first node apart', () => {
    // `{ a: users { ...F } b: users { ...F posts { title } } }`: F's `posts` node is first at both
    // sites, but the second site merges a sibling selection into it.
    const context: any = {};
    const fragmentNode = node();

    const first = getOrCreateRequestValue(context, [fragmentNode], 'k', () => ({ site: 'a' }));
    const second = getOrCreateRequestValue(context, [fragmentNode, node()], 'k', () => ({ site: 'b' }));

    expect(second).not.toBe(first);
    expect(second.site).toBe('b');
  });

  it('matches the same nodes even when the array holding them is rebuilt', () => {
    const context: any = {};
    const a = node();
    const b = node();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return calls;
    };

    getOrCreateRequestValue(context, [a, b], 'k', compute);
    getOrCreateRequestValue(context, [a, b], 'k', compute);
    getOrCreateRequestValue(context, [b, a], 'k', compute);

    expect(calls).toBe(2);
  });

  it('computes every time when there is nothing request-scoped to cache on', () => {
    const field = fieldNodes();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return calls;
    };

    expect(getOrCreateRequestValue(undefined, field, 'k', compute)).toBe(1);
    expect(getOrCreateRequestValue({} as any, undefined, 'k', compute)).toBe(2);
  });

  it('does not cache a throw', () => {
    const context: any = {};
    const field = fieldNodes();
    let calls = 0;
    const compute = () => {
      calls += 1;
      throw new Error('nope');
    };

    expect(() => getOrCreateRequestValue(context, field, 'k', compute)).toThrow('nope');
    expect(() => getOrCreateRequestValue(context, field, 'k', compute)).toThrow('nope');
    expect(calls).toBe(2);
  });
});
