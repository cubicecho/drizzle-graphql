// A relation resolver runs once per parent row, so the plan it derives from its own field — the
// loader key included — would otherwise be rebuilt for every row of a batch. These pin that the
// cache hands the first value back, that it separates fields, nodes and requests, and that it
// stays correct when there is no context to cache on.

import { describe, expect, it } from 'vitest';
import { getOrCreateRequestValue } from '@/util/batch-loader/index.ts';

const node = () => ({ kind: 'Field' as const });

describe('getOrCreateRequestValue', () => {
  it('computes once per node and key', () => {
    const context: any = {};
    const field = node();
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
    const field = node();
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
    const field = node();

    const posts = getOrCreateRequestValue(context, field, 'relation:Users::posts', () => ({ of: 'posts' }));
    const comments = getOrCreateRequestValue(context, field, 'relation:Users::comments', () => ({ of: 'comments' }));

    expect(comments).not.toBe(posts);
    expect(comments.of).toBe('comments');
  });

  it('keeps separate nodes apart', () => {
    const context: any = {};

    const first = getOrCreateRequestValue(context, node(), 'k', () => ({}));
    const second = getOrCreateRequestValue(context, node(), 'k', () => ({}));

    expect(second).not.toBe(first);
  });

  it('never carries a value between requests sharing a parsed document', () => {
    const field = node();

    const first = getOrCreateRequestValue({} as any, field, 'k', () => ({}));
    const second = getOrCreateRequestValue({} as any, field, 'k', () => ({}));

    expect(second).not.toBe(first);
  });

  it('computes every time when there is nothing request-scoped to cache on', () => {
    const field = node();
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
    const field = node();
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
