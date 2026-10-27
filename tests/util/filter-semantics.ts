// Rows and expected results shared by the per-dialect filter-semantics tests, so every dialect
// is held to the same answer.

/** JSON documents whose `n` / `b` keys hold a number or boolean, or the same value as a string. */
export const JSON_DOCS: { id: number; meta: Record<string, unknown> }[] = [
  { id: 1, meta: { n: 3, b: true } },
  { id: 2, meta: { n: '3', b: 'true' } },
  { id: 3, meta: { n: 4.5, b: false } },
  { id: 4, meta: { n: 'abc', b: 1 } },
  { id: 5, meta: {} },
];

/** `path` filters over {@link JSON_DOCS} and the ids each must return. */
export const JSON_PATH_CASES: [filter: string, ids: number[]][] = [
  ['{ path: ["n"], as: NUMBER, eq: 3 }', [1]],
  ['{ path: ["n"], eq: 3 }', [1]],
  ['{ path: ["n"], as: NUMBER, eq: "3" }', [1]],
  ['{ path: ["n"], gt: 0 }', [1, 3]],
  ['{ path: ["n"], as: NUMBER, ne: 3 }', [3]],
  ['{ path: ["b"], as: BOOLEAN, eq: true }', [1]],
  ['{ path: ["b"], eq: true }', [1]],
  ['{ path: ["b"], as: BOOLEAN, ne: true }', [3]],
  ['{ path: ["b"], eq: 1 }', [4]],
  // A text read sees any scalar's text, so a JSON number and a string with its digits both match.
  ['{ path: ["n"], eq: "3" }', [1, 2]],
];

/** Labels in mixed case, for `matchFilterOrder` under `insensitive`. */
export const TAGS: { id: number; label: string }[] = [
  { id: 1, label: 'Alpha' },
  { id: 2, label: 'beta' },
  { id: 3, label: 'GAMMA' },
  { id: 4, label: 'delta' },
];

/** Orders {@link TAGS} by their position in a list that matches them only case-insensitively. */
export const INSENSITIVE_FILTER_ORDER_QUERY = `{ tags(
  where: { label: { inArray: ["gamma", "ALPHA", "Beta"], insensitive: true } }
  orderBy: { label: { direction: asc, priority: 1, matchFilterOrder: true } }
) { id } }`;

/** The ids {@link INSENSITIVE_FILTER_ORDER_QUERY} returns, in list order. */
export const INSENSITIVE_FILTER_ORDER_IDS = [3, 1, 2];
