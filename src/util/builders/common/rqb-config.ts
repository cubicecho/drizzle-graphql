// Shaping of the config objects handed to drizzle's relational query builder
// (`findMany` / `findFirst` and each entry of a `with:` tree).

/**
 * A copy of a relational query config with every key whose value is `undefined` left out.
 *
 * drizzle-orm rc.5 snapshots test `"where" in params` rather than its value, and throw
 * `Unexpected 'undefined' in filter value` for `{ where: undefined }`; rc.4 read the value and
 * treated both the same. The library builds its configs with conditional keys
 * (`where: cond ? … : undefined`), so every config goes through here before it reaches drizzle.
 * Only `where` is checked that way today, but leaving out every undefined key costs nothing
 * and keeps the next key that gets the same treatment from breaking queries.
 *
 * Shallow on purpose: nested `with:` entries are built (and passed through here) one level at
 * a time, and the values of the other keys are drizzle's own (column maps, callbacks, RAW).
 */
export const omitUndefinedKeys = <T extends Record<string, unknown>>(config: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
};
