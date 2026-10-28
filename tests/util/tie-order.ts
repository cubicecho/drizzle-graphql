// A dialect-neutral check that a list ordered by a column with ties returns the tied rows in
// primary-key order — the same order cursor pagination uses — whether or not `cursor` is
// selected and whether or not the list is paginated (issue #236).
//
// Each dialect's test file declares `tie_parents` (`TieParents`, related as `items`),
// `tie_items` (`TieItems`) and the key-less `tie_logs` (`TieLogs`) in its own column types,
// fills them with the rows below — inserted in the reverse of key order, with an index on
// `(grp, id desc)` where the dialect will use it — so a database left to break ties itself
// returns them out of key order. It then calls `defineTieOrderTests` with a runner that builds
// a schema from a config and executes a document on it.
import { describe, expect, it } from 'vitest';

export const TIE_PARENTS = [{ id: 1 }];

/** Ids 6..1, so the heap holds them in the reverse of key order. */
export const TIE_ITEMS = [6, 5, 4, 3, 2, 1].map((id) => ({ id, parentId: 1, grp: id % 2 === 0 ? 2 : 1 }));

export const TIE_LOGS = [
  { grp: 2, note: 'b' },
  { grp: 1, note: 'a' },
  { grp: 2, note: 'c' },
];

/** grp ascending, ties by id ascending. */
const GRP_ASC = [1, 3, 5, 2, 4, 6];
/** grp descending, ties still by id ascending — the cursor's tiebreak is always ascending. */
const GRP_DESC = [2, 4, 6, 1, 3, 5];

export type TieRun = (source: string, config?: Record<string, unknown>) => Promise<any>;

const ids = (rows: any[]) => rows.map((row) => row.id);

const BY_GRP = (direction: 'asc' | 'desc') => `orderBy: { grp: { direction: ${direction}, priority: 0 } }`;

export const defineTieOrderTests = (run: TieRun) => {
  describe('ties in an ordered list come back in primary-key order (#236)', () => {
    it.each([
      ['asc', GRP_ASC],
      ['desc', GRP_DESC],
    ] as const)('root list, %s, with and without cursor', async (direction, expected) => {
      const plain = await run(`{ tieItems(${BY_GRP(direction)}) { id } }`);
      const withCursor = await run(`{ tieItems(${BY_GRP(direction)}) { id cursor } }`);
      expect(ids(plain.tieItems)).toEqual(expected);
      expect(ids(withCursor.tieItems)).toEqual(expected);
    });

    it('root list under a default ordering', async () => {
      const config = { defaults: { TieItems: { orderBy: { grp: 'desc' } } } };
      expect(ids((await run('{ tieItems { id } }', config)).tieItems)).toEqual(GRP_DESC);
    });

    it('root list ordered by the primary key itself is not tiebroken again', async () => {
      const data = await run('{ tieItems(orderBy: { id: { direction: desc, priority: 0 } }) { id } }');
      expect(ids(data.tieItems)).toEqual([6, 5, 4, 3, 2, 1]);
    });

    it('root list under matchFilterOrder', async () => {
      const data = await run(
        '{ tieItems(where: { grp: { inArray: [2, 1] } }, orderBy: { grp: { direction: asc, priority: 0, matchFilterOrder: true } }) { id } }',
      );
      expect(ids(data.tieItems)).toEqual(GRP_DESC);
    });

    it('root list under distinct keeps its order', async () => {
      const data = await run(`{ tieItems(distinct: [grp], ${BY_GRP('desc')}) { id } }`);
      expect(ids(data.tieItems)).toEqual([2, 1]);
    });

    it('a table without a primary key still orders', async () => {
      const data = await run(`{ tieLogs(${BY_GRP('asc')}) { grp } }`);
      expect(data.tieLogs.map((row: any) => row.grp)).toEqual([1, 2, 2]);
    });

    describe.each([true, false])('relation list (eagerLoadRelations: %s)', (eagerLoadRelations) => {
      it.each([
        ['asc', GRP_ASC],
        ['desc', GRP_DESC],
      ] as const)('%s, with and without cursor', async (direction, expected) => {
        const config = { eagerLoadRelations };
        const plain = await run(`{ tieParents { items(${BY_GRP(direction)}) { id } } }`, config);
        const withCursor = await run(`{ tieParents { items(${BY_GRP(direction)}) { id cursor } } }`, config);
        expect(ids(plain.tieParents[0].items)).toEqual(expected);
        expect(ids(withCursor.tieParents[0].items)).toEqual(expected);
      });

      it('under a default ordering', async () => {
        const config = { eagerLoadRelations, defaults: { TieItems: { orderBy: { grp: 'desc' } } } };
        expect(ids((await run('{ tieParents { items { id } } }', config)).tieParents[0].items)).toEqual(GRP_DESC);
      });
    });
  });
};
