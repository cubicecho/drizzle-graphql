/**
 * The identity a generated field publishes about itself, under `extensions.drizzle`.
 *
 * Every field this library generates carries one, so a wrapper — `graphql-middleware`,
 * envelop, `graphql-shield`, an audit log, a cache invalidator — can ask the schema what a
 * field is instead of reverse-engineering its name. Names are configurable (`prefixes`,
 * `suffixes`, `typeNameMapper`), so name parsing is ambiguous by construction; this is not.
 *
 * This shape is stable API: fields are only ever added to it, never removed or repurposed.
 */

/** What family of field this is. */
export type DrizzleFieldKind = 'query' | 'mutation' | 'relation' | 'aggregate' | 'type';

/**
 * What the field does. Arity is carried separately by `single`, so `select` covers both
 * the list query and its `…Single` sibling rather than being spelled twice.
 */
export type DrizzleFieldOperation =
  | 'select'
  | 'insert'
  | 'update'
  | 'updateMany'
  | 'upsert'
  | 'delete'
  | 'restore'
  | 'aggregate'
  | 'groupBy'
  | 'relation'
  | 'relationAggregate';

/** The argument holding the rows a field is about, when it has one. */
export type DrizzleTargetArg = 'where' | 'values' | 'updates';

/** `extensions.drizzle` on a generated field. */
export type DrizzleFieldExtension = {
  /** The Drizzle schema key of the table the field reads or writes. */
  table: string;
  kind: Exclude<DrizzleFieldKind, 'type'>;
  operation: DrizzleFieldOperation;
  /** Whether the field resolves to one row (or one aggregate) rather than a list. */
  single: boolean;
  /**
   * Which argument names the rows: `where` for select/update/delete/aggregate, `values`
   * for insert and upsert, `updates` for the batch update's per-entry `{ where, set }`.
   * Absent when the field takes no such argument.
   */
  targetArg?: DrizzleTargetArg;
  /**
   * Primary-key property names of `table`, in schema order. Empty when the table declares
   * no primary key. Carried here so {@link identifyRows} works from the field alone.
   */
  primaryKey: readonly string[];
  /** For `kind: 'relation'` and `operation: 'relationAggregate'`: the relation's name. */
  relation?: string;
  /** For `kind: 'relation'` and `operation: 'relationAggregate'`: the table it hangs off. */
  parentTable?: string;
};

/** `extensions.drizzle` on a generated object type. */
export type DrizzleTypeExtension = {
  /** The Drizzle schema key this type was generated from. */
  table: string;
  kind: 'type';
  /** Primary-key property names of `table`, in schema order. Empty when there is none. */
  primaryKey: readonly string[];
};

export type DrizzleExtension = DrizzleFieldExtension | DrizzleTypeExtension;

/** Anything carrying GraphQL `extensions` — a field config, a field, or a named type. */
type WithExtensions = { extensions?: { drizzle?: unknown } | null } | null | undefined;

/**
 * Reads the `drizzle` extension off a field or type, typed. Returns `undefined` for
 * anything this library did not generate, which is the check a wrapper wants before it
 * treats a field as one of ours.
 */
export const drizzleExtension = (target: WithExtensions): DrizzleExtension | undefined => {
  const value = target?.extensions?.drizzle;
  return value && typeof value === 'object' ? (value as DrizzleExtension) : undefined;
};

/** Narrows to the field form — object types carry `kind: 'type'` and no operation. */
export const isDrizzleFieldExtension = (value: DrizzleExtension | undefined): value is DrizzleFieldExtension =>
  !!value && value.kind !== 'type';

/**
 * Builds the extension for one table's fields. Dialect builders make one per table so each
 * call site only states what differs.
 */
export const tableFieldExtensions =
  (table: string, primaryKey: readonly string[]) =>
  (meta: Omit<DrizzleFieldExtension, 'table' | 'primaryKey'>): DrizzleFieldExtension => ({
    table,
    primaryKey,
    ...meta,
  });

/**
 * The parts of a mutation's identity that differ between mutations. Dialect builders that
 * assign every mutation in one loop pair each generated mutation with one of these.
 */
export type DrizzleMutationMeta = Pick<DrizzleFieldExtension, 'operation' | 'single' | 'targetArg'>;

/** Builds the extension a generated object type carries. */
export const tableTypeExtension = (table: string, primaryKey: readonly string[]): DrizzleTypeExtension => ({
  table,
  kind: 'type',
  primaryKey,
});

/**
 * Builds the extension a relation field carries. `table` is the relation's *target* — the
 * table the field resolves rows of — while `parentTable` is the type the field hangs off,
 * so a wrapper can tell `Users.posts` from `Customers.posts`.
 */
export const relationFieldExtension = (params: {
  targetTable: string;
  parentTable: string;
  relation: string;
  single: boolean;
  primaryKey: readonly string[];
  aggregate?: boolean;
}): DrizzleFieldExtension => ({
  table: params.targetTable,
  kind: params.aggregate ? 'aggregate' : 'relation',
  operation: params.aggregate ? 'relationAggregate' : 'relation',
  // An aggregate over a to-many relation still resolves to a single aggregate object.
  single: params.aggregate ? true : params.single,
  targetArg: 'where',
  primaryKey: params.primaryKey,
  relation: params.relation,
  parentTable: params.parentTable,
});

/** The rows a field's arguments name. */
export type IdentifiedRows = {
  /** The Drizzle schema key of the table being read or written. */
  table: string;
  /** Primary-key property names, in schema order. */
  primaryKey: readonly string[];
  /** One entry per identified row: the primary-key values, keyed by property name. */
  rows: Record<string, unknown>[];
  /**
   * Whether `rows` is exactly the set the operation affects.
   *
   * `false` means the arguments do not pin the rows down — an insert whose key the
   * database generates, a `where` that filters on something other than the primary key,
   * a plural update with no filter at all, or a table with no primary key. `rows` is then
   * a best-effort subset-free superset: every entry in it is a row the key values name,
   * but other filters may narrow the real set further, and it may be empty.
   */
  complete: boolean;
};

/** Pulls the primary-key values out of one `values` entry; `undefined` if any are missing. */
const keyFromValues = (entry: unknown, primaryKey: readonly string[]): Record<string, unknown> | undefined => {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const row: Record<string, unknown> = {};
  for (const column of primaryKey) {
    const value = (entry as Record<string, unknown>)[column];
    if (value === undefined || value === null) {
      return undefined;
    }
    row[column] = value;
  }
  return row;
};

/**
 * Pulls primary-key values out of a filter argument.
 *
 * Only top-level equality counts: `{ id: { eq } }` names one row, `{ id: { inArray } }`
 * names a list, and a composite key needs `eq` on every one of its columns. A boolean
 * group (`OR` / `AND` / `NOT`) or any other operator on a key column means the filter is
 * not a key lookup, and the rows are reported as not identified.
 */
const keysFromWhere = (
  where: unknown,
  primaryKey: readonly string[],
): { rows: Record<string, unknown>[]; complete: boolean } => {
  const none = { rows: [], complete: false };
  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    return none;
  }
  const filters = where as { OR?: unknown; AND?: unknown; NOT?: unknown; [column: string]: any };
  if (filters.OR || filters.AND || filters.NOT) {
    return none;
  }

  // A composite key is only pinned by an equality on each of its columns — one column
  // carrying a list would describe a rectangle of key tuples, not the rows written.
  if (primaryKey.length > 1) {
    const row: Record<string, unknown> = {};
    for (const column of primaryKey) {
      const operators = filters[column];
      if (!operators || typeof operators !== 'object' || operators.eq === undefined) {
        return none;
      }
      row[column] = operators.eq;
    }
    // Filters beyond the key can only narrow further, so the key alone is not the answer.
    return { rows: [row], complete: Object.keys(filters).length === primaryKey.length };
  }

  const column = primaryKey[0];
  if (!column) {
    return none;
  }
  const operators = filters[column];
  if (!operators || typeof operators !== 'object') {
    return none;
  }

  const exact = Object.keys(filters).length === 1 && Object.keys(operators).length === 1;
  if (operators.eq !== undefined) {
    return { rows: [{ [column]: operators.eq }], complete: exact };
  }
  if (Array.isArray(operators.inArray)) {
    return { rows: operators.inArray.map((value: unknown) => ({ [column]: value })), complete: exact };
  }
  return none;
};

/**
 * The rows a generated field's arguments are about, as primary-key values.
 *
 * The row identity of a mutation lives in a different argument for every operation —
 * `where` for update and delete, `values` for insert and upsert, a per-entry `where` inside
 * `updates` for the batch update — and each of those has both a one-row and a many-row
 * spelling. This reads whichever one applies:
 *
 * ```ts
 * const field = info.parentType.getFields()[info.fieldName];
 * const target = identifyRows(field, args);
 * if (target?.complete) await invalidate(target.table, target.rows);
 * ```
 *
 * Returns `undefined` for a field this library did not generate, or an object type. Check
 * `complete` before treating `rows` as the affected set — see {@link IdentifiedRows}.
 */
export const identifyRows = (
  field: WithExtensions,
  args: Record<string, unknown> | undefined,
): IdentifiedRows | undefined => {
  const meta = drizzleExtension(field);
  if (!isDrizzleFieldExtension(meta)) {
    return undefined;
  }

  const { table, primaryKey, targetArg } = meta;
  const empty: IdentifiedRows = { table, primaryKey, rows: [], complete: false };
  if (!primaryKey.length || !targetArg) {
    return empty;
  }

  const target = args?.[targetArg];

  if (targetArg === 'values') {
    // Both spellings of insert/upsert land here: the single variant takes one object.
    const entries = Array.isArray(target) ? target : target === undefined ? [] : [target];
    const rows = entries.map((entry) => keyFromValues(entry, primaryKey));
    return {
      table,
      primaryKey,
      rows: rows.filter((row): row is Record<string, unknown> => !!row),
      // A row whose key the database generates is not identifiable before the write.
      complete: entries.length > 0 && rows.every(Boolean),
    };
  }

  if (targetArg === 'updates') {
    if (!Array.isArray(target)) {
      return empty;
    }
    const perEntry = target.map((entry) =>
      keysFromWhere((entry as { where?: unknown } | undefined)?.where, primaryKey),
    );
    return {
      table,
      primaryKey,
      rows: perEntry.flatMap((entry) => entry.rows),
      complete: target.length > 0 && perEntry.every((entry) => entry.complete),
    };
  }

  return { table, primaryKey, ...keysFromWhere(target, primaryKey) };
};
