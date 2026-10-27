// A dialect-neutral check that cursor pagination visits every row exactly once, in order.
//
// Each dialect's test file declares three tables in its own column types — `walk_groups`,
// `walk_items` (keyed `WalkGroups` / `WalkItems`, related as `items`) and the composite-key
// `walk_pairs` (`WalkPairs`) — fills them with the rows below, and calls `defineCursorWalkTests`.
// The suite then walks each ordering page by page, feeding every page's last cursor back as
// `after`, and compares the ids it saw with the order computed here from the same rows and the
// dialect's NULL placement. The orderings cover the keyset predicate's two shapes: all-NOT-NULL
// keys sorted one way (a row-value comparison where the dialect takes one) and everything else
// (the expanded OR form) — mixed directions, a nullable key holding NULLs, `nulls` overrides —
// with ties on the leading key throughout, so pages break inside a run of equal values.
import { describe, expect, it } from 'vitest';
import type { NullOrdering } from '@/util/builders/common';

export interface WalkItem {
  id: number;
  groupId: number;
  at: Date;
  rank: number;
  score: number | null;
  code: string;
}

const AT = (day: number) => new Date(Date.UTC(2024, 0, day, 12, 0, 0));

export const WALK_GROUPS = [{ id: 1 }, { id: 2 }];

/** Ids run against every ordering, so no walk can pass by falling back to primary-key order. */
export const WALK_ITEMS: WalkItem[] = [
  { id: 7, groupId: 1, at: AT(3), rank: 2, score: 5, code: 'b' },
  { id: 2, groupId: 1, at: AT(1), rank: 1, score: null, code: 'a' },
  { id: 11, groupId: 2, at: AT(3), rank: 2, score: 5, code: 'c' },
  { id: 4, groupId: 1, at: AT(2), rank: 3, score: 1, code: 'a' },
  { id: 9, groupId: 2, at: AT(1), rank: 1, score: null, code: 'b' },
  { id: 1, groupId: 1, at: AT(3), rank: 1, score: 9, code: 'c' },
  { id: 13, groupId: 2, at: AT(2), rank: 3, score: 1, code: 'a' },
  { id: 5, groupId: 2, at: AT(4), rank: 2, score: null, code: 'b' },
  { id: 8, groupId: 1, at: AT(2), rank: 2, score: 5, code: 'c' },
  { id: 3, groupId: 2, at: AT(1), rank: 3, score: 9, code: 'a' },
  { id: 12, groupId: 1, at: AT(4), rank: 1, score: null, code: 'b' },
  { id: 6, groupId: 2, at: AT(3), rank: 3, score: 1, code: 'c' },
];

export const WALK_PAIRS = [
  { a: 2, b: 1 },
  { a: 1, b: 3 },
  { a: 3, b: 2 },
  { a: 1, b: 1 },
  { a: 2, b: 3 },
  { a: 3, b: 1 },
  { a: 1, b: 2 },
  { a: 2, b: 2 },
];

type Key<T> = [keyof T & string, 'asc' | 'desc', ('first' | 'last')?];

/** An `orderBy` argument for the keys, highest priority first. */
const orderByArg = <T>(keys: Key<T>[]): string =>
  `{ ${keys
    .map(
      ([column, direction, nulls], i) =>
        `${column}: { direction: ${direction}, priority: ${keys.length - i}${nulls ? `, nulls: ${nulls}` : ''} }`,
    )
    .join(', ')} }`;

/**
 * The order the database should return the rows in: the keys, then the primary key ascending
 * as the tiebreak a cursor ordering always ends with — each key's NULLs placed by its `nulls`
 * override, or by the dialect's own rule.
 */
const expectedOrder = <T extends Record<string, any>>(
  rows: T[],
  keys: Key<T>[],
  pk: (keyof T & string)[],
  nullOrdering: NullOrdering,
): T[] => {
  const all: Key<T>[] = [
    ...keys,
    ...pk.filter((column) => !keys.some(([k]) => k === column)).map((c) => [c, 'asc'] as Key<T>),
  ];
  const plain = (value: any) => (value instanceof Date ? value.getTime() : value);
  return [...rows].sort((x, y) => {
    for (const [column, direction, nulls] of all) {
      const a = plain(x[column]);
      const b = plain(y[column]);
      if (a === b) {
        continue;
      }
      const sign = direction === 'asc' ? 1 : -1;
      if (a === null || b === null) {
        const nullsLast = nulls ? nulls === 'last' : (direction === 'asc') === (nullOrdering === 'nulls-largest');
        return (a === null ? 1 : -1) * (nullsLast ? 1 : -1);
      }
      return (a < b ? -1 : 1) * sign;
    }
    return 0;
  });
};

export const ITEM_ORDERINGS: Key<WalkItem>[][] = [
  [],
  [['id', 'desc']],
  [['at', 'asc']],
  [
    ['at', 'desc'],
    ['id', 'desc'],
  ],
  [['at', 'desc']],
  [
    ['rank', 'desc'],
    ['at', 'asc'],
  ],
  [
    ['code', 'asc'],
    ['rank', 'asc'],
  ],
  [
    ['code', 'desc'],
    ['rank', 'desc'],
    ['at', 'desc'],
  ],
  [['score', 'asc']],
  [['score', 'desc']],
  [['score', 'asc', 'first']],
  [['score', 'asc', 'last']],
  [['score', 'desc', 'first']],
  [['score', 'desc', 'last']],
  [
    ['rank', 'asc'],
    ['score', 'desc'],
  ],
];

const PAIR_ORDERINGS: Key<(typeof WALK_PAIRS)[number]>[][] = [
  [],
  [
    ['a', 'desc'],
    ['b', 'desc'],
  ],
  [['b', 'asc']],
  [['b', 'desc']],
];

const label = (keys: Key<any>[]) =>
  keys.length ? keys.map(([c, d, n]) => `${c} ${d}${n ? ` nulls ${n}` : ''}`).join(', ') : 'default order';

/**
 * Pages a list through `page` (given the `after` argument text, or '') until it comes back
 * empty, returning the rows in the order seen. A cursor that failed to advance would repeat a
 * page forever, so the walk is capped.
 */
const walk = async (page: (after: string) => Promise<any[]>): Promise<any[]> => {
  const seen: any[] = [];
  let after: string | null = null;
  for (let i = 0; i < 40; i++) {
    const rows = await page(after === null ? '' : `, after: "${after}"`);
    if (!rows.length) {
      return seen;
    }
    seen.push(...rows);
    after = rows[rows.length - 1].cursor;
    expect(typeof after).toBe('string');
  }
  throw new Error('cursor pagination did not terminate');
};

export const defineCursorWalkTests = (run: (source: string) => Promise<any>, nullOrdering: NullOrdering): void => {
  describe('cursor walk: every row once, in order', () => {
    for (const keys of ITEM_ORDERINGS) {
      const expected = expectedOrder(WALK_ITEMS, keys, ['id'], nullOrdering).map((row) => row.id);
      const orderBy = keys.length ? `orderBy: ${orderByArg(keys)}, ` : '';

      for (const limit of [1, 5]) {
        it(`root list, ${label(keys)}, limit ${limit}`, async () => {
          const seen = await walk(
            async (after) => (await run(`{ walkItems(${orderBy}limit: ${limit}${after}) { id cursor } }`)).walkItems,
          );
          expect(seen.map((row) => row.id)).toEqual(expected);
        });
      }

      // With a limit the relation pages through the batched window query; without one the first
      // page is the whole list and the second, after its last row, must come back empty.
      for (const limit of [2, null]) {
        it(`relation list, ${label(keys)}, ${limit ? `limit ${limit}` : 'no limit'}`, async () => {
          for (const { id } of WALK_GROUPS) {
            const own = expectedOrder(
              WALK_ITEMS.filter((row) => row.groupId === id),
              keys,
              ['id'],
              nullOrdering,
            ).map((row) => row.id);
            const seen = await walk(async (after) => {
              const args = `${orderBy}${limit ? `limit: ${limit}` : ''}${after}`.replace(/^, |, $/g, '');
              const items = args ? `items(${args})` : 'items';
              const data = await run(`{ walkGroups(where: { id: { eq: ${id} } }) { ${items} { id cursor } } }`);
              return data.walkGroups[0].items;
            });
            expect(seen.map((row) => row.id)).toEqual(own);
          }
        });
      }
    }

    for (const keys of PAIR_ORDERINGS) {
      const expected = expectedOrder(WALK_PAIRS, keys, ['a', 'b'], nullOrdering).map(({ a, b }) => `${a}:${b}`);
      const orderBy = keys.length ? `orderBy: ${orderByArg(keys)}, ` : '';
      it(`composite primary key, ${label(keys)}`, async () => {
        const seen = await walk(
          async (after) => (await run(`{ walkPairs(${orderBy}limit: 3${after}) { a b cursor } }`)).walkPairs,
        );
        expect(seen.map(({ a, b }) => `${a}:${b}`)).toEqual(expected);
      });
    }
  });
};
