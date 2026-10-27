// Which nested operations each relation offers, decided once at build time from which side holds
// the foreign key and whether that column is nullable.

import {
  and,
  type Column,
  getColumns,
  inArray,
  is,
  One,
  relationsFilterToSQL,
  type SQL,
  type Table,
} from 'drizzle-orm';
import { drizzleError } from '../common/errors.ts';
import { parentKeyChunks, parentKeyCondition, relationOwnWhere } from '../common/relations.ts';
import type { NestedWriteOp } from '../common/write-hooks.ts';
import {
  isRelationFilterReversed,
  relationColumns,
  relationOwnCondition,
  unwrapRelationColumn,
  warnUnresolvedJoin,
} from '../common.ts';
import type { TableNamedRelations } from '../types.ts';

const ALL_OPS: readonly NestedWriteOp[] = ['create', 'connect', 'disconnect', 'set'];

/**
 * How one relation can be written through, resolved once at build time.
 *
 * `fkSide` is the whole point: a relation is stored as a value in exactly one of the two
 * tables, and which one decides both what operations make sense and in what order the
 * statements have to run. When the child holds it (`Authors.posts` — `posts.author_id`),
 * the parent has to exist first and the children are attached afterwards. When the parent
 * holds it (`Posts.author` — `posts.author_id` again, seen from the other end), the target
 * row has to exist first so its key can go into the parent's own INSERT.
 */
export type NestedRelationPlan = {
  relationName: string;
  targetTableName: string;
  targetTable: Table;
  /** Property name of the join column on the table the input belongs to. */
  localColPropName: string;
  /** Property name of the join column on the relation's target table. */
  foreignColPropName: string;
  foreignCol: Column;
  localCol: Column;
  isOne: boolean;
  /** Which table stores the value that has to change for a row to be attached or detached. */
  fkSide: 'child' | 'parent';
  /** Whether the foreign key is nullable, and so whether a row can be detached at all. */
  canDetach: boolean;
  /** Set when the relation goes through a junction table, which is then what gets written. */
  through?: NestedThroughPlan;
  /**
   * The target's primary-key columns and the join column, keyed by property name — what a
   * nested statement on the target returns to that table's `onWrite` hook when it has one.
   */
  targetKeyColumns: Record<string, Column>;
  /**
   * The target's primary-key property names. Used when the target is the parent's own table,
   * to read the parent rows back after the child-side statements may have rewritten them.
   */
  targetPrimaryKey?: string[];
  /**
   * The relation's own `where`, compiled against the target: the rows the relation shows.
   * Every statement that selects rows to attach or detach is narrowed by it, so a write
   * through the relation reaches only what a read through it returns.
   */
  ownCondition?: () => SQL;
  /**
   * For a relation whose `where` is inherited from its reverse and so filters the *parent*:
   * whether any of the parent rows keyed `keys` does not show the relation at all. A child-side
   * write through a relation that shows nothing for one of its parents is refused, whole.
   */
  parentKeysHidden?: (executor: any, keys: any[]) => Promise<boolean>;
  /**
   * The same check for a parent-side relation, whose join column on the parent is not a key:
   * whether any of the written parent rows (identified by {@link parentKeyColumns}) fails the
   * inherited `where`. Run after the parent write, so a write that also makes the row visible
   * passes.
   */
  parentHidden?: (executor: any, rows: Record<string, any>[]) => Promise<boolean>;
  /** The parent's primary-key columns, which the parent write returns for {@link parentHidden}. */
  parentKeyColumns?: Record<string, Column>;
  /**
   * The relation field's inputs the relation's shape allows (no `create` through a junction,
   * no `disconnect` / `set` on a NOT NULL key), narrowed by {@link gateNestedWritePlans} to
   * the ones whose write the table it lands on has turned on.
   */
  allowed: Set<NestedWriteOp>;
};

/**
 * The junction table of a `.through()` relation, and the two of its columns this relation
 * joins on. A many-to-many is attached and detached by inserting and deleting junction rows,
 * so neither the parent row nor the target row is written at all.
 */
export type NestedThroughPlan = {
  table: Table;
  /** The junction's Drizzle schema key — what its `features` and `onWrite` are keyed by. */
  tableName: string | undefined;
  /** Property name of the junction column holding the parent's key. */
  sourceColPropName: string;
  /** Property name of the junction column holding the target's key. */
  targetColPropName: string;
  sourceCol: Column;
  targetCol: Column;
};

/** Every writable relation of every table: table name → relation name → plan. */
export type NestedWritePlans = Record<string, Record<string, NestedRelationPlan>>;

/**
 * Whether a column can be left out of an INSERT — either the database fills it in or it
 * accepts NULL.
 */
export const isOptionalOnInsert = (column: Column): boolean =>
  !column.notNull || !!column.hasDefault || !!(column as any).defaultFn;

/**
 * The plan fields that carry a relation's own `where` (see {@link relationOwnCondition}).
 *
 * A `where` on the target narrows every row selection the write makes, and takes `create`
 * away: the row it inserts is attached whether or not it satisfies the `where`, so the
 * relation could come back without it. A `where` inherited from the reverse relation filters
 * the parent instead, and becomes a per-parent check.
 */
const ownWherePlan = (
  relEntry: TableNamedRelations,
  parentTable: Table,
  targetTable: Table,
  localCol: Column,
  parentPrimaryKey: string[],
): Pick<NestedRelationPlan, 'ownCondition' | 'parentKeysHidden' | 'parentHidden' | 'parentKeyColumns'> => {
  const condition = () => relationOwnCondition(relEntry, parentTable, targetTable, [localCol], [localCol]);
  if (!condition()) {
    return {};
  }
  const relation = (relEntry as any).relation ?? relEntry;
  if (!isRelationFilterReversed(relation)) {
    return { ownCondition: () => condition()! };
  }
  const parentColumns = getColumns(parentTable) as Record<string, Column>;
  const parentKeyColumns = Object.fromEntries(
    parentPrimaryKey.filter((name) => parentColumns[name]).map((name) => [name, parentColumns[name]!]),
  );
  const keyNames = Object.keys(parentKeyColumns);
  // The reversed condition reads `localCol in (select localCol from parent where …)`, so
  // matching it against the parent rows answers which of them pass the filter. One read for
  // the whole batch, chunked like every other parent-key read.
  return {
    parentKeysHidden: async (executor, keys) => {
      const shown = new Set<string>();
      for (const chunk of parentKeyChunks(keys, 1)) {
        const found = (await executor
          .select({ key: localCol })
          .from(parentTable)
          .where(and(inArray(localCol, chunk), condition()))) as { key: unknown }[];
        for (const row of found) {
          shown.add(keyString(row.key));
        }
      }
      return keys.some((key) => !shown.has(keyString(key)));
    },
    // A parent-side relation's join column is the parent's foreign key, which many rows can
    // share, so the written rows are matched by primary key against the filter itself.
    parentHidden: async (executor, rows) => {
      if (!rows.length) {
        return false;
      }
      if (!keyNames.length || !rows.every((row) => keyNames.every((name) => name in row))) {
        throw drizzleError(
          `Drizzle-GraphQL Error: cannot check the \`where\` of this relation: the written row cannot be identified by a primary key.`,
          { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
        );
      }
      const keyOf = (row: Record<string, any>) => keyNames.map((name) => keyString(row[name])).join('\u0000');
      const keyCols = keyNames.map((name) => parentColumns[name]!);
      // Chunked, and a composite key ORed as a balanced tree: a plural update can return
      // thousands of rows, past both the bound-parameter limits and SQLite's expression depth.
      const shown = new Set<string>();
      for (const chunk of parentKeyChunks(rows, keyNames.length)) {
        const match = parentKeyCondition(
          keyCols,
          chunk.map((row) => keyNames.map((name) => row[name])),
        );
        const found = (await executor
          .select(parentKeyColumns)
          .from(parentTable)
          .where(and(match, relationsFilterToSQL(parentTable, relationOwnWhere(relation) as any)))) as Record<
          string,
          any
        >[];
        for (const row of found) {
          shown.add(keyOf(row));
        }
      }
      return rows.some((row) => !shown.has(keyOf(row)));
    },
    parentKeyColumns,
  };
};

/**
 * A key value in a form that compares equal across the two reads of it — the driver may hand
 * back a `Date` or a `bigint` that is a different object each time.
 */
export const keyString = (value: unknown): string =>
  value instanceof Date ? `d${value.getTime()}` : value === null || value === undefined ? '' : `v${String(value)}`;

/** The property name a column is stored under on its table, matched by identity. */
const propNameOf = (table: Table, column: Column | undefined): string | undefined => {
  if (!column) {
    return undefined;
  }
  for (const [propName, candidate] of Object.entries(getColumns(table))) {
    if (candidate === column) {
      return propName;
    }
  }
  return undefined;
};

/**
 * A `.through()` relation's plan: the junction table plus the two columns it joins on.
 *
 * Nothing about the parent or the target row changes when a many-to-many link is made or
 * broken — only junction rows are inserted and deleted — so `canDetach` is unconditional
 * here, and there is no nullable-foreign-key question to ask.
 *
 * Left unplanned, and so absent from the inputs: a to-one `.through()`, whose "exactly one
 * row" guarantee lives in the junction's constraints rather than in the relation; a relation
 * joining on more than one column per side; and a junction carrying a further NOT NULL column
 * with no default, which no `connect` operand could supply a value for — unless every insert
 * stamps it anyway (`stampedOf`: a `contextValues` column, or a soft-delete marker).
 *
 * `onUnresolved` is called when the relation's columns are of a supported shape but cannot be
 * matched to the three tables — a drizzle-orm mismatch rather than an unsupported relation.
 */
const buildThroughPlan = (
  relationName: string,
  relEntry: TableNamedRelations,
  relation: any,
  table: Table,
  targetTableName: string,
  targetTable: Table,
  tableNameOf: (table: Table) => string | undefined,
  stampedOf: (tableName: string) => Record<string, unknown> | undefined,
  onUnresolved: () => void,
): NestedRelationPlan | undefined => {
  if (is(relation, One)) {
    return undefined;
  }

  const junction = relation.throughTable as Table | undefined;
  const sourceEntries = relation.through?.source;
  const targetEntries = relation.through?.target;
  if (!junction || sourceEntries?.length !== 1 || targetEntries?.length !== 1) {
    return undefined;
  }
  if (relation.sourceColumns?.length !== 1 || relation.targetColumns?.length !== 1) {
    return undefined;
  }

  // Drizzle normalizes the two ends before it stores them, so `source` is the parent's side
  // even on the relation declared from the other table. Each column is looked up on the table
  // it is supposed to belong to, which is also the check that the normalization held.
  const localCol = unwrapRelationColumn(relation.sourceColumns[0]);
  const foreignCol = unwrapRelationColumn(relation.targetColumns[0]);
  const localColPropName = propNameOf(table, localCol);
  const foreignColPropName = propNameOf(targetTable, foreignCol);
  const sourceColPropName = propNameOf(junction, unwrapRelationColumn(sourceEntries[0]));
  const targetColPropName = propNameOf(junction, unwrapRelationColumn(targetEntries[0]));
  if (
    !localCol ||
    !foreignCol ||
    !localColPropName ||
    !foreignColPropName ||
    !sourceColPropName ||
    !targetColPropName
  ) {
    onUnresolved();
    return undefined;
  }

  const junctionColumns = getColumns(junction);
  const sourceCol = junctionColumns[sourceColPropName] as Column;
  const targetCol = junctionColumns[targetColPropName] as Column;
  const junctionName = tableNameOf(junction);
  const stamped = junctionName ? stampedOf(junctionName) : undefined;
  const unsuppliable = Object.entries(junctionColumns).some(
    ([propName, column]) =>
      propName !== sourceColPropName &&
      propName !== targetColPropName &&
      !stamped?.[propName] &&
      !isOptionalOnInsert(column as Column),
  );
  if (unsuppliable) {
    return undefined;
  }

  return {
    relationName,
    targetTableName,
    targetTable,
    localColPropName,
    foreignColPropName,
    foreignCol,
    localCol,
    isOne: false,
    // The link is written after the parent row exists, exactly like a child-side foreign key.
    fkSide: 'child',
    canDetach: true,
    through: {
      table: junction,
      tableName: junctionName,
      sourceColPropName,
      targetColPropName,
      sourceCol,
      targetCol,
    },
    targetKeyColumns: { [foreignColPropName]: foreignCol },
    ...ownWherePlan(relEntry, table, targetTable, localCol, []),
    allowed: new Set(['connect', 'disconnect', 'set']),
  };
};

/**
 * Which relations of which tables can be written through.
 *
 * A `.through()` (many-to-many) relation is planned too, but as a junction-table write
 * rather than a foreign-key one — see {@link buildThroughPlan}.
 *
 * Skipped, and so absent from the generated inputs rather than failing at runtime:
 * relations whose join columns cannot be read off the drizzle relation; relations joining on
 * more than one column per side; and relations where neither join column is unique, which
 * leaves no way to tell which side stores the key.
 */
export const buildNestedWritePlans = (
  tables: Record<string, Table>,
  namedRelations: Record<string, Record<string, TableNamedRelations>>,
  resolveUniqueSets: (table: Table) => string[][],
  resolvePrimaryKeys: (table: Table) => string[],
  extractJoinColumns: (
    relEntry: TableNamedRelations,
    parentTable: Table,
    targetTable: Table,
  ) => { localColPropName: string; foreignCol: Column; foreignColPropName: string } | undefined,
  /**
   * The schema key of any table in the Drizzle schema, excluded ones included — a junction
   * table is written without being a relation target, so it is looked up here.
   */
  tableNameOf: (table: Table) => string | undefined = () => undefined,
  /**
   * The columns every insert into a table stamps whatever the input says — its `contextValues`
   * and a NOT NULL soft-delete marker (see {@link insertStamps}). A junction column among them
   * needs no value from a `connect`.
   */
  stampedOf: (tableName: string) => Record<string, unknown> | undefined = () => undefined,
): NestedWritePlans => {
  const uniqueCache = new Map<string, Set<string>>();
  // Only single-column unique keys matter here: a relation joins on one column, so a
  // composite key says nothing about whether that column identifies a row on its own.
  const singleColumnUniques = (tableName: string, table: Table): Set<string> => {
    let cached = uniqueCache.get(tableName);
    if (!cached) {
      cached = new Set(
        resolveUniqueSets(table)
          .filter((set) => set.length === 1)
          .map((set) => set[0]!),
      );
      uniqueCache.set(tableName, cached);
    }
    return cached;
  };

  const pkCache = new Map<string, string | undefined>();
  // Only a single-column primary key identifies a row by one join column, which is the only
  // shape a relation can be written through.
  const singleColumnPk = (tableName: string, table: Table): string | undefined => {
    if (!pkCache.has(tableName)) {
      const pk = resolvePrimaryKeys(table);
      pkCache.set(tableName, pk.length === 1 ? pk[0] : undefined);
    }
    return pkCache.get(tableName);
  };

  const plans: NestedWritePlans = {};

  for (const [tableName, relations] of Object.entries(namedRelations)) {
    const table = tables[tableName];
    if (!table) {
      continue;
    }

    const tablePlans: Record<string, NestedRelationPlan> = {};

    for (const [relationName, relEntry] of Object.entries(relations)) {
      const relation = (relEntry as any).relation;
      const targetTableName = relEntry.targetTableName;
      const targetTable = tables[targetTableName];
      if (!targetTable) {
        continue;
      }

      const omitted = `the '${relationName}' field of its nested-write create and update inputs`;
      if ((relation as any).through) {
        const throughPlan = buildThroughPlan(
          relationName,
          relEntry,
          relation,
          table,
          targetTableName,
          targetTable,
          tableNameOf,
          stampedOf,
          () => warnUnresolvedJoin(relEntry, tableName, relationName, omitted),
        );
        if (throughPlan) {
          tablePlans[relationName] = throughPlan;
        }
        continue;
      }

      // A relation joining on more than one column per side cannot be written by setting one
      // key: `extractJoinColumns` reads the first pair only, so the rest of the join — a
      // tenant column, say — would be neither matched nor written. Left out, as a junction
      // with a composite join is.
      if (
        (relationColumns(relation, 'source')?.length ?? 0) > 1 ||
        (relationColumns(relation, 'target')?.length ?? 0) > 1
      ) {
        continue;
      }

      const joinColumns = extractJoinColumns(relEntry, table, targetTable);
      if (!joinColumns) {
        warnUnresolvedJoin(relEntry, tableName, relationName, omitted);
        continue;
      }
      const { localColPropName, foreignCol, foreignColPropName } = joinColumns;
      const localCol = getColumns(table)[localColPropName] as Column | undefined;
      if (!localCol) {
        continue;
      }

      const isOne = is(relation, One);
      const localIsPk = singleColumnPk(tableName, table) === localColPropName;
      const foreignIsPk = singleColumnPk(targetTableName, targetTable) === foreignColPropName;
      const localIsUnique = singleColumnUniques(tableName, table).has(localColPropName);
      const foreignIsUnique = singleColumnUniques(targetTableName, targetTable).has(foreignColPropName);

      // Which of the two columns actually holds the reference. A to-many is always the
      // child's — one parent column cannot point at many rows. For a to-one, the side that
      // joins on its own primary key is the one being pointed *at*, so the reference lives on
      // the other side; a unique constraint is the fallback signal when neither is a key.
      // A relation whose join column identifies a row on neither side is left out entirely:
      // there would be no way to say which row an operation meant.
      let fkSide: 'child' | 'parent';
      if (!isOne) {
        fkSide = 'child';
      } else if (foreignIsPk && !localIsPk) {
        fkSide = 'parent';
      } else if (localIsPk) {
        fkSide = 'child';
      } else if (foreignIsUnique) {
        fkSide = 'parent';
      } else if (localIsUnique) {
        fkSide = 'child';
      } else {
        continue;
      }

      const fkColumn = fkSide === 'child' ? foreignCol : localCol;
      const targetColumns = getColumns(targetTable);
      const targetPrimaryKey = resolvePrimaryKeys(targetTable).filter((name) => targetColumns[name]);
      const targetKeyColumns: Record<string, Column> = Object.fromEntries(
        targetPrimaryKey.map((name) => [name, targetColumns[name] as Column]),
      );
      targetKeyColumns[foreignColPropName] = foreignCol;

      const ownWhere = ownWherePlan(relEntry, table, targetTable, localCol, resolvePrimaryKeys(table));
      const ops: readonly NestedWriteOp[] = !fkColumn.notNull
        ? isOne
          ? ['create', 'connect', 'disconnect']
          : ALL_OPS
        : ['create', 'connect'];
      tablePlans[relationName] = {
        relationName,
        targetTableName,
        targetTable,
        localColPropName,
        foreignColPropName,
        foreignCol,
        localCol,
        isOne,
        fkSide,
        canDetach: !fkColumn.notNull,
        targetKeyColumns,
        targetPrimaryKey,
        ...ownWhere,
        // `set` replaces a to-many's whole set, and `disconnect` / `set` need a key that can
        // be nulled. Whether the input is the update one, and whether `connect` has a filter
        // to select with, is decided where the input types are built. A `where` on the
        // target takes `create` away — see ownWherePlan.
        allowed: new Set<NestedWriteOp>(ownWhere.ownCondition ? ops.filter((op) => op !== 'create') : ops),
      };
    }

    if (Object.keys(tablePlans).length) {
      plans[tableName] = tablePlans;
    }
  }

  return plans;
};

/**
 * Whether the key a child-side relation writes on its target is (part of) the target's own
 * primary key — a one-to-one that shares its primary key (`profiles.user_id`). A `connect`
 * there would rewrite the primary key of whichever row its filter picked, so it only checks
 * that the row already holds the parent's key.
 */
export const writesTargetKey = (plan: NestedRelationPlan): boolean =>
  !plan.through && plan.fkSide === 'child' && !!plan.targetPrimaryKey?.includes(plan.foreignColPropName);
