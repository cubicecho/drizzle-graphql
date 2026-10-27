// =============================================================================
// Nested writes — `create` / `connect` / `disconnect` / `set` on the relation
// fields of a table's create and update inputs.
//
// A nested write is always several statements (the parent row plus one per
// relation operation), so every resolver that runs one opens a transaction —
// a savepoint when the request already carries one. What a relation can offer
// is decided here, at build time, from which side of the relation stores the
// foreign key and whether that column is nullable, so the schema never advertises
// an operation whose every call would be a database error.
// =============================================================================
import {
  and,
  type Column,
  eq,
  getColumns,
  inArray,
  is,
  One,
  relationsFilterToSQL,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInputObjectType, type GraphQLInputType, GraphQLList, GraphQLNonNull } from 'graphql';
import { capitalize } from '../case-ops/index.ts';
import { remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { drizzleColumnToGraphQLType } from '../type-converter/index.ts';
import { drizzleError } from './common/errors.ts';
import { parentKeyChunks, parentKeyCondition, relationOwnWhere } from './common/relations.ts';
import {
  type NestedWriteOp,
  type ResolvedWriteHooks,
  runWriteHook,
  type WriteHookPayload,
  withHookColumns,
} from './common/write-hooks.ts';
import {
  applyContextValues,
  type ContextValuesFor,
  extractFilters,
  insertStamps,
  isRelationFilterReversed,
  junctionPolicy,
  type RelationFilterBase,
  relationColumns,
  relationFilterCtx,
  relationOwnCondition,
  resolveScope,
  resolveTypeName,
  type ScopeResolver,
  type TablePolicies,
  type TypeCacheCtx,
  type TypeNameMapper,
  unwrapRelationColumn,
  visibleColumns,
  warnUnresolvedJoin,
  withScope,
} from './common.ts';
import type { TableFeatures, TableNamedRelations } from './types.ts';

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
   * whether the parent row keyed `key` shows the relation at all. A child-side write through
   * a relation that shows nothing for its parent is refused.
   */
  parentShows?: (executor: any, key: any) => Promise<boolean>;
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

/** The nested operations of one mutation input, keyed by relation name. */
export type NestedOps = Record<string, Record<string, any>>;

/**
 * Whether a column can be left out of an INSERT — either the database fills it in or it
 * accepts NULL.
 */
const isOptionalOnInsert = (column: Column): boolean =>
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
): Pick<NestedRelationPlan, 'ownCondition' | 'parentShows' | 'parentHidden' | 'parentKeyColumns'> => {
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
  // matching it against the one parent row answers whether that row passes the filter.
  return {
    parentShows: async (executor, key) =>
      (
        await executor
          .select({ key: localCol })
          .from(parentTable)
          .where(and(eq(localCol, key), condition()))
          .limit(1)
      ).length > 0,
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
const keyString = (value: unknown): string =>
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
  relationMap: Record<string, Record<string, TableNamedRelations>>,
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

  for (const [tableName, relations] of Object.entries(relationMap)) {
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

/** The writes one relation-field input performs, as `[table, operation]` pairs. */
type RequiredWrite = { tableName: string | undefined; feature: 'insert' | 'update' | 'delete' };

/**
 * Which of the target's (or junction's) write features each input of a relation needs. A
 * parent-side `connect` / `disconnect` only rewrites the parent's own column, so it needs
 * nothing of the target; a child-side one moves the target's foreign key, which is an update
 * of the target. A to-one child-side `create` also detaches the row attached before it, when
 * the key is nullable.
 */
const requiredWrites = (plan: NestedRelationPlan, op: NestedWriteOp): RequiredWrite[] => {
  if (plan.through) {
    const junction = plan.through.tableName;
    if (op === 'connect') {
      return [{ tableName: junction, feature: 'insert' }];
    }
    if (op === 'disconnect') {
      return [{ tableName: junction, feature: 'delete' }];
    }
    if (op === 'set') {
      return [
        { tableName: junction, feature: 'delete' },
        { tableName: junction, feature: 'insert' },
      ];
    }
    return [];
  }
  const target = plan.targetTableName;
  if (op === 'create') {
    const detaches = plan.fkSide === 'child' && plan.isOne && plan.canDetach;
    return detaches
      ? [
          { tableName: target, feature: 'insert' },
          { tableName: target, feature: 'update' },
        ]
      : [{ tableName: target, feature: 'insert' }];
  }
  return plan.fkSide === 'child' ? [{ tableName: target, feature: 'update' }] : [];
};

/**
 * Narrows every plan's `allowed` inputs to the ones whose writes the table they land on
 * permits: its `features.insert` / `update` / `delete`, and for a junction table that it is
 * not excluded. A plan left with nothing is dropped, so its relation field is not generated.
 *
 * Returns one line per input taken out, for the build note.
 */
export const gateNestedWritePlans = (
  plans: NestedWritePlans,
  featureOf: (tableName: string) => TableFeatures,
  isExcluded: (tableName: string) => boolean,
): string[] => {
  const omitted: string[] = [];
  for (const [tableName, tablePlans] of Object.entries(plans)) {
    for (const [relationName, plan] of Object.entries(tablePlans)) {
      for (const op of [...plan.allowed]) {
        const blocked = requiredWrites(plan, op).filter(
          ({ tableName: target, feature }) =>
            target !== undefined && (isExcluded(target) || !featureOf(target)[feature]),
        );
        if (blocked.length) {
          plan.allowed.delete(op);
          const reasons = blocked.map(({ tableName: target, feature }) =>
            isExcluded(target!) ? `${target} is excluded` : `${target}.${feature} is off`,
          );
          omitted.push(`${tableName}.${relationName}.${op} (${[...new Set(reasons)].join(', ')})`);
        }
      }
      if (!plan.allowed.size) {
        delete tablePlans[relationName];
      }
    }
    if (!Object.keys(tablePlans).length) {
      delete plans[tableName];
    }
  }
  return omitted;
};

/**
 * Takes out every relation whose foreign key is a `contextValues` column of the table storing
 * it — the parent's own column for a parent-side relation, the target's for a child-side one,
 * either junction column for a many-to-many.
 *
 * Every operation on such a relation writes that column: `connect`, `disconnect` and `set`
 * by definition, and a child-side `create` too, since it fills the key in from the parent row
 * rather than from context. That column is the server's to set — an insert stamps it and an
 * update never touches it — so writing it from a nested input would let a client pick, or
 * change, the owner the server assigns. Whole relations are dropped, not single inputs: no
 * operation on them is left that does not write the key.
 *
 * Returns one line per relation taken out, for the build note.
 */
export const dropContextValueRelations = (
  plans: NestedWritePlans,
  contextValuesOf: ContextValuesFor | undefined,
): string[] => {
  const omitted: string[] = [];
  if (!contextValuesOf) {
    return omitted;
  }
  for (const [tableName, tablePlans] of Object.entries(plans)) {
    for (const [relationName, plan] of Object.entries(tablePlans)) {
      const keys: [string | undefined, string][] = plan.through
        ? [
            [plan.through.tableName, plan.through.sourceColPropName],
            [plan.through.tableName, plan.through.targetColPropName],
          ]
        : plan.fkSide === 'parent'
          ? [[tableName, plan.localColPropName]]
          : [[plan.targetTableName, plan.foreignColPropName]];
      const stamped = keys.find(([owner, column]) => owner !== undefined && contextValuesOf(owner)?.[column]);
      if (stamped) {
        delete tablePlans[relationName];
        omitted.push(`${tableName}.${relationName} (${stamped[0]}.${stamped[1]} is a contextValues column)`);
      }
    }
    if (!Object.keys(tablePlans).length) {
      delete plans[tableName];
    }
  }
  return omitted;
};

// ── input types ──────────────────────────────────────────────────────────────

/**
 * The extra input fields nested writes add to a table's create and update inputs, plus the
 * columns whose NOT NULL requirement the create input has to relax.
 */
export type NestedWriteTypes = {
  /** Relation fields for `Create<Table>Input`, empty when the table has no writable relation. */
  createFields: (
    tableName: string,
    typeName: string,
  ) => Record<string, { type: GraphQLInputType; description: string }>;
  /** Relation fields for `Update<Table>Input`. */
  updateFields: (
    tableName: string,
    typeName: string,
  ) => Record<string, { type: GraphQLInputType; description: string }>;
  /**
   * Relation fields for `Upsert<Table>Input`: what the update input offers, since the row may
   * already exist, applied the same way on either branch (see {@link wrapperType}).
   */
  upsertFields: (
    tableName: string,
    typeName: string,
  ) => Record<string, { type: GraphQLInputType; description: string }>;
  /** Whether the table has any writable relation, and so needs an upsert input of its own. */
  hasRelations: (tableName: string) => boolean;
  /**
   * Columns a relation on the same input can fill in, which therefore cannot stay required:
   * `authorId` is NOT NULL, but `author: { create: … }` supplies it.
   */
  relaxedColumns: (tableName: string) => ReadonlySet<string>;
};

const NO_COLUMNS: ReadonlySet<string> = new Set();

/** Which root input a relation field's operations input belongs to. */
type WrapperMode = 'create' | 'update' | 'upsert';

/**
 * Builds the nested-write input types for a schema.
 *
 * Every field map is produced lazily, from inside the enclosing input type's own thunk: the
 * operand of `connect` is the target table's `Filters` input, which does not exist yet while
 * the first table's types are being generated.
 */
export const createNestedWriteTypes = (params: {
  plans: NestedWritePlans;
  cacheCtx: TypeCacheCtx;
  typeNameMapper: TypeNameMapper | undefined;
}): NestedWriteTypes => {
  const { plans, cacheCtx, typeNameMapper } = params;
  const wrapperCache = new Map<string, GraphQLInputObjectType>();
  const payloadCache = new Map<string, GraphQLInputObjectType>();

  /**
   * `<Type><Relation>NestedCreatePayloadInput` — the row a nested `create` inserts. Built from
   * the target's columns rather than from its create input: the join column this relation
   * fills in is left out (setting it by hand could point the new row somewhere other than its
   * parent), and the nesting stops here, so the type carries no relation fields of its own.
   *
   * The name shares the wrapper's `<Type><Relation>Nested…` segment rather than reading
   * `Create<Type><Relation>Input`, which lands in the same namespace as a table's own create
   * input: `item.type` spells `CreateItemTypeInput`, and so does a sibling table named
   * `itemType`. Two types of that name is a schema that cannot be built at all, and
   * `nestedWrites` is a whole-schema flag, so one such pair made it unusable.
   */
  const payloadType = (tableName: string, typeName: string, plan: NestedRelationPlan): GraphQLInputObjectType => {
    const key = `${tableName}.${plan.relationName}`;
    const cached = payloadCache.get(key);
    if (cached) {
      return cached;
    }

    const omitted = plan.fkSide === 'child' ? plan.foreignColPropName : undefined;
    // Same rule as the table's own create input: a column the server fills in from context
    // is not something a nested `create` may supply either, and neither is the soft-delete
    // marker, which only the delete and restore mutations write.
    const contextColumns = cacheCtx.contextValuesOf?.(plan.targetTableName);
    const markerColumn = cacheCtx.softDeleteOf?.(plan.targetTableName)?.columnName;
    const fields = Object.fromEntries(
      Object.entries(visibleColumns(plan.targetTable))
        .filter(
          ([columnName]) => columnName !== omitted && !contextColumns?.[columnName] && columnName !== markerColumn,
        )
        .map(([columnName, column]) => [
          columnName,
          drizzleColumnToGraphQLType(column as Column, columnName, plan.targetTableName, false, true, true),
        ]),
    );

    const type = new GraphQLInputObjectType({
      name: cacheCtx.typeName({
        kind: 'nestedWriteInput',
        defaultName: `${typeName}${capitalize(plan.relationName)}NestedCreatePayloadInput`,
        table: tableName,
        operation: plan.relationName,
      }),
      description:
        omitted === undefined
          ? `A new ${resolveTypeName(plan.targetTableName, typeNameMapper)} row for ${typeName}.${plan.relationName}`
          : `A new ${resolveTypeName(plan.targetTableName, typeNameMapper)} row for ${typeName}.${plan.relationName}. \`${omitted}\` is set from the ${typeName} row this is written with.`,
      fields,
    });
    payloadCache.set(key, type);
    return type;
  };

  /** The target's `Filters` input, which every `connect` / `disconnect` / `set` selects with. */
  const targetFilters = (plan: NestedRelationPlan): GraphQLInputObjectType | undefined =>
    cacheCtx.filterTypeCache.get(plan.targetTable);

  const listOf = (type: GraphQLInputObjectType) => new GraphQLList(new GraphQLNonNull(type));

  /**
   * `<Type><Relation>NestedCreateInput` / `<Type><Relation>NestedUpdateInput` /
   * `<Type><Relation>NestedUpsertInput` — the operations offered on one relation. The create
   * variant has no `disconnect` or `set`: a row that does not exist yet has nothing attached
   * to detach or replace.
   *
   * The upsert variant offers what the update one does, because the row may already exist.
   * Its operations run the same way on both branches: on a row the upsert just inserted there
   * is nothing attached yet, so `set` only attaches and `disconnect` finds nothing to detach.
   *
   * A many-to-many relation offers no `create`: inserting a row *and* linking it is two
   * writes to two tables, and the link half is what the relation field is for. Its
   * `disconnect` and `set` do not depend on nullability, since breaking a link deletes a
   * junction row rather than nulling a column that might be NOT NULL.
   *
   * Each input is also subject to `plan.allowed` — the table it writes has to have that
   * write turned on (see {@link gateNestedWritePlans}).
   */
  const wrapperType = (
    tableName: string,
    typeName: string,
    plan: NestedRelationPlan,
    mode: WrapperMode,
  ): GraphQLInputObjectType | undefined => {
    const key = `${tableName}.${plan.relationName}.${mode}`;
    const cached = wrapperCache.get(key);
    if (cached) {
      return cached;
    }

    const filters = targetFilters(plan);
    const targetTypeName = resolveTypeName(plan.targetTableName, typeNameMapper);
    const fields: Record<string, { type: GraphQLInputType; description: string }> = {};

    const forUpdate = mode !== 'create';
    const upsert = mode === 'upsert';
    const offers = (op: NestedWriteOp) => plan.allowed.has(op);
    // What `disconnect` and `set` mean when the upsert inserted the row instead.
    const onInsert = upsert ? ' Does nothing when the upsert inserts the row.' : '';
    const setOnInsert = upsert ? ' When the upsert inserts the row, this only attaches.' : '';

    if (plan.through) {
      // Without a `Filters` input there is no way to name the rows to link, and `create` is
      // not offered here.
      if (filters && offers('connect')) {
        fields['connect'] = {
          type: listOf(filters),
          description: `Link every existing ${targetTypeName} row these match. Already-linked rows are left alone.`,
        };
      }
      if (filters && forUpdate && offers('disconnect')) {
        fields['disconnect'] = {
          type: listOf(filters),
          description: `Unlink every linked ${targetTypeName} row these match, leaving the rows in place.${onInsert}`,
        };
      }
      if (filters && forUpdate && offers('set')) {
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: unlink everything linked, then link every ${targetTypeName} row these match. \`set: []\` clears the relation. Applied before \`disconnect\` and \`connect\`.${setOnInsert}`,
        };
      }
    } else if (plan.isOne) {
      if (offers('create')) {
        fields['create'] = {
          type: payloadType(tableName, typeName, plan),
          description: `Insert a ${targetTypeName} row and attach it`,
        };
      }
      if (filters && offers('connect')) {
        fields['connect'] = {
          type: filters,
          description: `Attach the existing ${targetTypeName} row this matches. Must match exactly one row.`,
        };
      }
      if (forUpdate && offers('disconnect')) {
        fields['disconnect'] = {
          type: GraphQLBoolean,
          description: `Detach the currently attached ${targetTypeName} row, leaving it in place.${onInsert}`,
        };
      }
    } else {
      if (offers('create')) {
        fields['create'] = {
          type: listOf(payloadType(tableName, typeName, plan)),
          description: `Insert these ${targetTypeName} rows and attach them`,
        };
      }
      if (filters && offers('connect')) {
        fields['connect'] = {
          type: listOf(filters),
          description: `Attach every existing ${targetTypeName} row these match`,
        };
      }
      if (filters && forUpdate && offers('disconnect')) {
        fields['disconnect'] = {
          type: listOf(filters),
          description: `Detach every attached ${targetTypeName} row these match, leaving the rows in place.${onInsert}`,
        };
      }
      if (filters && forUpdate && offers('set')) {
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: detach everything attached, then attach every ${targetTypeName} row these match. Applied before \`disconnect\`, \`connect\` and \`create\`.${setOnInsert}`,
        };
      }
    }

    // The target's (or junction's) features can leave a relation with nothing on it, and a
    // GraphQL input object needs at least one field — so the relation is left out instead.
    if (!Object.keys(fields).length) {
      return undefined;
    }

    const type = new GraphQLInputObjectType({
      name: cacheCtx.typeName({
        kind: 'nestedWriteInput',
        defaultName: `${typeName}${capitalize(plan.relationName)}Nested${capitalize(mode)}Input`,
        table: tableName,
        operation: plan.relationName,
      }),
      description: `Writes through ${typeName}.${plan.relationName}`,
      fields,
    });
    wrapperCache.set(key, type);
    return type;
  };

  const relationFields = (tableName: string, typeName: string, mode: WrapperMode) => {
    const tablePlans = plans[tableName];
    if (!tablePlans) {
      return {};
    }
    return Object.fromEntries(
      Object.values(tablePlans).flatMap((plan) => {
        const wrapper = wrapperType(tableName, typeName, plan, mode);
        return wrapper
          ? [[plan.relationName, { type: wrapper, description: `Writes through ${typeName}.${plan.relationName}` }]]
          : [];
      }),
    );
  };

  return {
    createFields: (tableName, typeName) => relationFields(tableName, typeName, 'create'),
    updateFields: (tableName, typeName) => relationFields(tableName, typeName, 'update'),
    upsertFields: (tableName, typeName) => relationFields(tableName, typeName, 'upsert'),
    hasRelations: (tableName) => !!plans[tableName],
    relaxedColumns: (tableName) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return NO_COLUMNS;
      }
      const relaxed = new Set<string>();
      for (const plan of Object.values(tablePlans)) {
        // Only a parent-side relation writes a column of *this* table, and only a column that
        // is otherwise required needs relaxing.
        if (
          plan.fkSide === 'parent' &&
          (plan.allowed.has('create') || plan.allowed.has('connect')) &&
          !isOptionalOnInsert(plan.localCol)
        ) {
          relaxed.add(plan.localColPropName);
        }
      }
      return relaxed.size ? relaxed : NO_COLUMNS;
    },
  };
};

// ── runtime ──────────────────────────────────────────────────────────────────

/**
 * The request a nested write runs for. `context` drives the scope and the context values;
 * all three are what the target table's `onWrite` hooks are handed alongside the rows.
 */
export type NestedWriteRequest = { context?: any; args?: any; info?: any };

/** What the resolvers call into. Created once per build, next to the plans it closes over. */
export type NestedWriteRuntime = {
  /** Whether the table has any writable relation at all — the cheap check on the hot path. */
  enabled: (tableName: string) => boolean;
  /** Splits one mutation input into plain column values and the nested operations. */
  split: (tableName: string, values: Record<string, any>) => { columns: Record<string, any>; ops: NestedOps };
  /** Whether a split produced anything to do. */
  hasOps: (ops: NestedOps) => boolean;
  /**
   * Adds the join columns the child-side operations will need to a RETURNING column map, so
   * the parent rows come back with the key their children are attached by.
   */
  withJoinColumns: <T extends Record<string, Column>>(tableName: string, ops: NestedOps, columns: T, table: Table) => T;
  /**
   * Runs the operations that have to happen *before* the parent row is written, and returns
   * the parent column values they produced.
   */
  applyParentSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    request?: NestedWriteRequest,
    /** The parent write updates existing rows rather than inserting (or upserting) them. */
    existing?: boolean,
  ) => Promise<ParentSidePatch>;
  /**
   * Checks the parent rows a write returned against what its parent-side operations asked
   * for: each one has to hold the key they set, and show any relation whose `where` filters
   * the parent. Throws, so the enclosing transaction rolls the write back.
   */
  checkParentSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    rows: Record<string, any>[],
    patch: ParentSidePatch,
  ) => Promise<void>;
  /**
   * An upsert's conflict `SET`, with the key of every parent-side relation in `ops` whose
   * `where` filters its target written as an update writes it: a key pointing at a row the
   * `where` hides is kept, so `checkParentSide` can tell that apart from a key the conflict
   * branch did not write. Returned unchanged when no such relation is written.
   */
  guardConflictSet: (tableName: string, ops: NestedOps, set: Record<string, SQL>) => Record<string, SQL>;
  /** Runs the operations that attach to a parent row, once that row exists. */
  applyChildSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    parentRows: Record<string, any>[],
    request?: NestedWriteRequest,
  ) => Promise<void>;
  /** Whether the operations insert a target row before the parent row is written. */
  createsParentSide: (tableName: string, ops: NestedOps) => boolean;
  /**
   * The parent rows as they stand after the child-side statements. Those statements write the
   * target table, which on a self-referencing relation is the parent's own — so the rows the
   * parent write returned can be stale. Returned unchanged when no operation targets the
   * parent's own table.
   */
  refreshed: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    rows: Record<string, any>[],
  ) => Promise<Record<string, any>[]>;
};

/**
 * What the parent-side operations produced: `values` for the parent write, and the key each
 * written row must end up holding (`expected`, by relation name). The two differ on an update,
 * where a `disconnect` or `connect` is written as an expression that leaves a key the
 * relation's own `where` hides in place.
 */
export type ParentSidePatch = { values: Record<string, any>; expected: Record<string, any>; existing: boolean };

/**
 * The union of the relation names a batch of entries writes through — enough to decide which
 * join columns the whole batch's RETURNING clause needs, without inspecting each row's write.
 */
export const mergedOps = (entries: { ops: NestedOps }[]): NestedOps =>
  Object.assign({}, ...entries.map((entry) => entry.ops));

/** A to-one `connect` whose filter did not match exactly one row. */
const connectMatchError = (relationName: string, matched: number) =>
  drizzleError(
    `Drizzle-GraphQL Error: 'connect' on '${relationName}' matched ${matched} rows — it attaches a single row, so its filter must match exactly one.`,
    { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
  );

const asArray = (value: any): any[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

const supplied = (value: any) => value !== undefined && value !== null;

/** The write a nested statement performs on the table it lands on. */
type NestedOperation = 'insert' | 'update' | 'delete' | 'restore';

/**
 * One `onWrite` call for a nested write: every statement one relation-field input runs
 * against one table with one operation, within one call of the runtime. Their rows are
 * collected and handed to `after` together, the way a root field's hook sees its whole
 * statement's rows at once.
 */
type HookStep = {
  tableName: string;
  operation: NestedOperation;
  op: NestedWriteOp;
  hooks: ResolvedWriteHooks;
  /** The keys the write touches plus the hook's `columns` — what each statement returns. */
  returning: Record<string, Column>;
  rows: any[];
};

/**
 * The hook calls one relation field makes. Every step is registered before the field's first
 * statement, so each `before` runs ahead of all of them and each `after` once the last has
 * returned. A table without hooks registers nothing, and its statements run exactly as they
 * did before hooks reached nested writes — no RETURNING clause is added.
 */
const createHookSteps = (
  onWrite: TablePolicies['onWrite'],
  executor: any,
  request: NestedWriteRequest | undefined,
  parentTable: string,
  plan: NestedRelationPlan,
) => {
  const steps = new Map<string, HookStep>();
  const keyOf = (op: NestedWriteOp, operation: NestedOperation) => `${op}:${operation}`;

  const payload = (step: HookStep): Omit<WriteHookPayload, 'position' | 'rows'> => ({
    table: step.tableName,
    operation: step.operation,
    single: plan.isOne,
    args: request?.args,
    context: request?.context,
    info: request?.info,
    tx: executor,
    nested: { parentTable, relation: plan.relationName, op: step.op },
  });

  return {
    /** Registers the hook call for `op`'s `operation` statements, if that table has hooks. */
    add: (op: NestedWriteOp, operation: NestedOperation) => {
      const through = plan.through;
      const tableName = through ? through.tableName : plan.targetTableName;
      const hooks = tableName ? onWrite?.(tableName, operation) : undefined;
      if (!tableName || !hooks || steps.has(keyOf(op, operation))) {
        return;
      }
      const keyColumns: Record<string, Column> = through
        ? { [through.sourceColPropName]: through.sourceCol, [through.targetColPropName]: through.targetCol }
        : { ...plan.targetKeyColumns };
      steps.set(keyOf(op, operation), {
        tableName,
        operation,
        op,
        hooks,
        returning: withHookColumns(hooks, keyColumns).returning,
        rows: [],
      });
    },
    get: (op: NestedWriteOp, operation: NestedOperation) => steps.get(keyOf(op, operation)),
    /** Runs one statement, returning its rows to the step it belongs to when there is one. */
    run: async (query: any, op: NestedWriteOp, operation: NestedOperation) => {
      const step = steps.get(keyOf(op, operation));
      if (!step) {
        await query;
        return;
      }
      step.rows.push(...((await query.returning(step.returning)) as any[]));
    },
    before: async () => {
      for (const step of steps.values()) {
        await runWriteHook(step.hooks, 'before', payload(step));
      }
    },
    after: async () => {
      for (const step of steps.values()) {
        await runWriteHook(step.hooks, 'after', { ...payload(step), rows: step.rows });
      }
    },
  };
};

type HookSteps = ReturnType<typeof createHookSteps>;

/**
 * Registers the hook calls a child-side relation field will make, in the order its
 * statements run, so the `before` hooks fire in that order too. Mirrors the branches of
 * `applyChildSide` and `applyThroughOps` exactly: a step registered for an input that runs no
 * statement would fire with no rows, and one missing would miss them.
 */
const registerChildSteps = (
  steps: HookSteps,
  plan: NestedRelationPlan,
  op: Record<string, any>,
  /** The junction soft-deletes, so a link is restored rather than inserted when it can be. */
  junctionSoftDeletes = false,
) => {
  if (plan.through) {
    if (supplied(op['set'])) {
      steps.add('set', 'delete');
      if (junctionSoftDeletes) {
        steps.add('set', 'restore');
      }
      steps.add('set', 'insert');
    }
    if (supplied(op['disconnect'])) {
      steps.add('disconnect', 'delete');
    }
    if (supplied(op['connect'])) {
      if (junctionSoftDeletes) {
        steps.add('connect', 'restore');
      }
      steps.add('connect', 'insert');
    }
    return;
  }
  if (op['set'] !== undefined) {
    steps.add('set', 'update');
  }
  if (op['disconnect'] !== undefined && (!plan.isOne || op['disconnect'] === true)) {
    steps.add('disconnect', 'update');
  }
  const attachedBy = attachingOp(op);
  if (plan.isOne && attachedBy && plan.canDetach && op['set'] === undefined) {
    steps.add(attachedBy, 'update');
  }
  if (op['connect'] !== undefined && !writesTargetKey(plan)) {
    steps.add('connect', 'update');
  }
  if (op['create'] !== undefined) {
    steps.add('create', 'insert');
  }
};

/**
 * Whether the key a child-side relation writes on its target is (part of) the target's own
 * primary key — a one-to-one that shares its primary key (`profiles.user_id`). A `connect`
 * there would rewrite the primary key of whichever row its filter picked, so it only checks
 * that the row already holds the parent's key.
 */
const writesTargetKey = (plan: NestedRelationPlan): boolean =>
  !plan.through && plan.fkSide === 'child' && !!plan.targetPrimaryKey?.includes(plan.foreignColPropName);

/** The input that attaches a row to a to-one, which detaches whatever was attached before. */
const attachingOp = (op: Record<string, any>): NestedWriteOp | undefined =>
  op['connect'] !== undefined ? 'connect' : op['create'] !== undefined ? 'create' : undefined;

/** The child-side relation in `ops` whose target is the parent's own table, if there is one. */
const selfTargetingPlan = (
  tablePlans: Record<string, NestedRelationPlan> | undefined,
  tableName: string,
  ops: NestedOps,
): NestedRelationPlan | undefined =>
  Object.keys(ops)
    .map((relationName) => tablePlans?.[relationName])
    .find((plan) => plan?.fkSide === 'child' && !plan.through && plan.targetTableName === tableName);

export const createNestedWriteRuntime = (params: {
  plans: NestedWritePlans;
  filterCtx: RelationFilterBase | undefined;
  policies?: TablePolicies;
  contextValues?: ContextValuesFor;
}): NestedWriteRuntime => {
  const { plans, filterCtx, policies, contextValues } = params;
  const onWrite = policies?.onWrite;
  /** What an insert into `tableName` stamps — see {@link insertStamps}. */
  const stampsOf = (tableName: string) => insertStamps({ contextValues, softDelete: policies?.softDelete }, tableName);

  /**
   * A `connect` / `disconnect` / `set` operand compiled to SQL. An operand that compiles to
   * nothing is rejected: `connect: {}` would otherwise attach every row in the table.
   */
  const conditionOf = (
    plan: NestedRelationPlan,
    filter: Record<string, any>,
    operation: string,
    scope: ScopeResolver | undefined,
  ) => {
    const condition = extractFilters(
      plan.targetTable,
      plan.targetTableName,
      filter,
      relationFilterCtx(filterCtx, plan.targetTableName, scope),
    );
    if (!condition) {
      throw drizzleError(
        `Drizzle-GraphQL Error: '${operation}' on '${plan.relationName}' needs a filter that selects rows — it was given one that matches everything.`,
        { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
      );
    }
    // The filter selects rows to attach or detach, so it is a write against the target
    // table and is narrowed by its scope: `connect` cannot reach a row the caller cannot
    // see, and out-of-scope rows are not detached. The relation's own `where` narrows it the
    // same way: only rows the relation shows are detached, and only rows it would show are
    // attached.
    return withScope(scope, plan.targetTableName, plan.targetTable, and(condition, plan.ownCondition?.()))!;
  };

  const assertSingleOperation = (plan: NestedRelationPlan, op: Record<string, any>) => {
    const given = ['create', 'connect', 'disconnect'].filter((key) => supplied(op[key]));
    if (given.length > 1) {
      throw drizzleError(
        `Drizzle-GraphQL Error: '${plan.relationName}' takes one of ${given.join(', ')} at a time — it holds a single row.`,
        { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
      );
    }
  };

  /** The values the junction stores for the target rows one operand selects. */
  const selectedTargetKeys = async (
    executor: any,
    plan: NestedRelationPlan,
    filter: Record<string, any>,
    operation: string,
    scope: ScopeResolver | undefined,
  ): Promise<any[]> => {
    // Only the key the junction stores is read back, so the projection asks for that column
    // alone — a wide target row is never dragged across the wire to pick one value off it.
    const rows = await executor
      .select({ [plan.foreignColPropName]: plan.foreignCol })
      .from(plan.targetTable)
      .where(conditionOf(plan, filter, operation, scope));
    return rows
      .map((row: any) => row[plan.foreignColPropName])
      .filter((value: any) => value !== undefined && value !== null);
  };

  /**
   * The link half of a many-to-many write: junction rows are inserted and deleted, and both
   * the parent row and the target rows are left exactly as they are.
   *
   * `connect` reads the parent's existing links first and inserts only the missing ones, so
   * re-connecting a linked row is a no-op on every dialect rather than a unique-constraint
   * error on some of them — the read and the write share the surrounding transaction, so no
   * other writer can slip a duplicate in between them.
   */
  const applyThroughOps = async (
    executor: any,
    plan: NestedRelationPlan,
    key: any,
    op: Record<string, any>,
    scope: ScopeResolver | undefined,
    steps: HookSteps,
    context: any,
  ) => {
    const through = plan.through!;
    const junctionName = through.tableName;
    // The junction's own policy decides which links exist for this request, as it does on every
    // read path: a link row another tenant's scope owns is not one this request can see,
    // unlink, or count as already linked, and a soft-deleted link row is a removed link.
    const live = junctionPolicy(scope, junctionName, through.table);
    const marker = junctionName ? policies?.softDelete?.(junctionName) : undefined;

    // Unlinking a soft-deleting junction marks the link row, as a delete of that table does.
    const unlink = (where: SQL) =>
      marker
        ? executor
            .update(through.table)
            .set({ [marker.columnName]: marker.writeDeleted() })
            .where(and(where, live))
        : executor.delete(through.table).where(and(where, live));

    const link = async (operands: any[], operation: 'connect' | 'set') => {
      const existing = new Set(
        (
          await executor
            .select({ [through.targetColPropName]: through.targetCol })
            .from(through.table)
            .where(and(eq(through.sourceCol, key), live))
        ).map((row: any) => row[through.targetColPropName]),
      );
      const missing: any[] = [];
      for (const filter of operands) {
        for (const targetKey of await selectedTargetKeys(executor, plan, filter, operation, scope)) {
          if (!existing.has(targetKey)) {
            existing.add(targetKey);
            missing.push(targetKey);
          }
        }
      }
      if (!missing.length) {
        return;
      }
      // A link this request removed earlier is still there, marked: it is restored rather than
      // inserted again, which a key on the junction's two columns would refuse.
      let restored = new Set<any>();
      if (marker && junctionName) {
        const step = steps.get(operation, 'restore');
        const rows = (await executor
          .update(through.table)
          .set({ [marker.columnName]: marker.writeRestored })
          .where(
            and(
              eq(through.sourceCol, key),
              inArray(through.targetCol, missing),
              scope?.on(junctionName, through.table, 'ONLY'),
            ),
          )
          .returning(step ? step.returning : { [through.targetColPropName]: through.targetCol })) as any[];
        step?.rows.push(...rows);
        restored = new Set(rows.map((row) => row[through.targetColPropName]));
      }
      const rows = missing
        .filter((targetKey) => !restored.has(targetKey))
        .map((targetKey) =>
          applyContextValues(
            { [through.sourceColPropName]: key, [through.targetColPropName]: targetKey },
            junctionName ? stampsOf(junctionName) : undefined,
            context,
          ),
        );
      if (rows.length) {
        await steps.run(executor.insert(through.table).values(rows), operation, 'insert');
      }
    };

    // Replace-the-set first, so a `set` alongside a `connect` reads as "these rows, plus that
    // one". `set: []` unlinks everything and links nothing back, which is how the relation is
    // cleared.
    //
    // "Everything" is everything the caller could have attached: links to targets outside the
    // scope, soft-deleted, or hidden by the relation's own `where` are kept, exactly as
    // `disconnect` could not have reached them — and so are link rows the junction's own
    // policy hides.
    if (supplied(op['set'])) {
      const reachable = withScope(scope, plan.targetTableName, plan.targetTable, plan.ownCondition?.());
      const linked = reachable
        ? and(
            eq(through.sourceCol, key),
            inArray(
              through.targetCol,
              executor
                .select({ [plan.foreignColPropName]: plan.foreignCol })
                .from(plan.targetTable)
                .where(reachable),
            ),
          )!
        : eq(through.sourceCol, key);
      await steps.run(unlink(linked), 'set', 'delete');
      await link(asArray(op['set']), 'set');
    }

    if (supplied(op['disconnect'])) {
      for (const filter of asArray(op['disconnect'])) {
        const targetKeys = await selectedTargetKeys(executor, plan, filter, 'disconnect', scope);
        if (targetKeys.length) {
          await steps.run(
            unlink(and(eq(through.sourceCol, key), inArray(through.targetCol, targetKeys))!),
            'disconnect',
            'delete',
          );
        }
      }
    }

    if (supplied(op['connect'])) {
      await link(asArray(op['connect']), 'connect');
    }
  };

  /**
   * The value a parent-side `connect` / `disconnect` writes to an existing row's key: `next`,
   * unless the key points at a row the relation's own `where` hides, which it then keeps.
   */
  const keepingHidden = (plan: NestedRelationPlan, next: any): any => {
    if (!plan.ownCondition) {
      return next;
    }
    return keepingHiddenSql(plan, next === null ? sql`null` : sql`${sql.param(next, plan.localCol)}`);
  };

  /** {@link keepingHidden} around a value that is already SQL — an upsert's `excluded.<key>`. */
  const keepingHiddenSql = (plan: NestedRelationPlan, replacement: SQL): SQL => {
    const shown = sql`select ${plan.foreignCol} from ${plan.targetTable} where ${plan.ownCondition!()}`;
    return sql`case when ${plan.localCol} is null or ${plan.localCol} in (${shown}) then ${replacement} else ${plan.localCol} end`;
  };

  /**
   * Which of `keys` — keys the written parent rows hold — point at a target row the relation's
   * own `where` hides. A null key points at nothing, so it is never hidden.
   */
  const hiddenKeys = async (executor: any, plan: NestedRelationPlan, keys: any[]): Promise<Set<string>> => {
    const held = keys.filter((key) => key !== null && key !== undefined);
    if (!held.length || !plan.ownCondition) {
      return new Set();
    }
    const shown = new Set(
      (
        (await executor
          .select({ key: plan.foreignCol })
          .from(plan.targetTable)
          .where(and(inArray(plan.foreignCol, held), plan.ownCondition()))) as { key: any }[]
      ).map((row) => keyString(row.key)),
    );
    return new Set(held.map(keyString).filter((key) => !shown.has(key)));
  };

  const detachAll = (
    executor: any,
    plan: NestedRelationPlan,
    key: any,
    scope: ScopeResolver | undefined,
    steps: HookSteps,
    op: NestedWriteOp,
  ) =>
    steps.run(
      executor
        .update(plan.targetTable)
        .set({ [plan.foreignColPropName]: null })
        .where(
          withScope(
            scope,
            plan.targetTableName,
            plan.targetTable,
            and(eq(plan.foreignCol, key), plan.ownCondition?.()),
          ),
        ),
      op,
      'update',
    );

  return {
    enabled: (tableName) => !!plans[tableName],

    split: (tableName, values) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return { columns: values, ops: {} };
      }
      const columns: Record<string, any> = {};
      const ops: NestedOps = {};
      for (const [key, value] of Object.entries(values)) {
        if (tablePlans[key] && value !== undefined && value !== null) {
          ops[key] = value;
        } else if (!tablePlans[key]) {
          columns[key] = value;
        }
      }
      return { columns, ops };
    },

    hasOps: (ops) => Object.keys(ops).length > 0,

    withJoinColumns: (tableName, ops, columns, table) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return columns;
      }
      const allColumns = getColumns(table);
      for (const relationName of Object.keys(ops)) {
        const plan = tablePlans[relationName];
        // Child-side operations attach by this key; parent-side ones are checked against it
        // (see `checkParentSide`), along with the primary key an inherited `where` needs.
        if (plan && !(plan.localColPropName in columns) && allColumns[plan.localColPropName]) {
          (columns as any)[plan.localColPropName] = allColumns[plan.localColPropName];
        }
        if (plan?.fkSide === 'parent' && plan.parentHidden) {
          for (const [name, column] of Object.entries(plan.parentKeyColumns ?? {})) {
            if (!(name in columns)) {
              (columns as any)[name] = column;
            }
          }
        }
      }
      // A self-referencing write reads the parent rows back by primary key — see `refreshed`.
      for (const name of selfTargetingPlan(tablePlans, tableName, ops)?.targetPrimaryKey ?? []) {
        if (!(name in columns) && allColumns[name]) {
          (columns as any)[name] = allColumns[name];
        }
      }
      return columns;
    },

    createsParentSide: (tableName, ops) =>
      Object.entries(ops).some(
        ([relationName, op]) => plans[tableName]?.[relationName]?.fkSide === 'parent' && supplied(op?.['create']),
      ),

    refreshed: async (executor, tableName, ops, rows) => {
      const plan = selfTargetingPlan(plans[tableName], tableName, ops);
      const pk = plan?.targetPrimaryKey ?? [];
      if (!plan || !pk.length || !rows.length || !pk.every((name) => name in rows[0]!)) {
        return rows;
      }
      const columns = getColumns(plan.targetTable) as Record<string, Column>;
      const selection = Object.fromEntries(
        Object.keys(rows[0]!)
          .filter((name) => columns[name])
          .map((name) => [name, columns[name]!]),
      );
      const keyOf = (row: Record<string, any>) => pk.map((name) => String(row[name])).join('\u0000');
      const pkCols = pk.map((name) => columns[name]!);
      const fresh = new Map<string, Record<string, any>>();
      for (const chunk of parentKeyChunks(rows, pk.length)) {
        const match = parentKeyCondition(
          pkCols,
          chunk.map((row) => pk.map((name) => row[name])),
        );
        for (const row of (await executor.select(selection).from(plan.targetTable).where(match)) as Record<
          string,
          any
        >[]) {
          fresh.set(keyOf(row), row);
        }
      }
      return rows.map((row) => ({ ...row, ...fresh.get(keyOf(row)) }));
    },

    applyParentSide: async (executor, tableName, ops, request, existing = false) => {
      const tablePlans = plans[tableName];
      const result: ParentSidePatch = { values: {}, expected: {}, existing };
      const patch = result.values;
      if (!tablePlans) {
        return result;
      }
      const context = request?.context;
      const scope = resolveScope(policies, context, filterCtx);

      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (plan?.fkSide !== 'parent') {
          continue;
        }
        assertSingleOperation(plan, op);

        if (op['create'] !== undefined) {
          // The only parent-side input that writes the target: `connect` and `disconnect`
          // change the parent's own column, which the parent's own hooks already cover.
          const steps = createHookSteps(onWrite, executor, request, tableName, plan);
          steps.add('create', 'insert');
          await steps.before();
          const values = applyContextValues(
            remapFromGraphQLSingleInput({ ...op['create'] }, plan.targetTable),
            stampsOf(plan.targetTableName),
            context,
          );
          // The hook's RETURNING always includes the join column, which the patch reads.
          const step = steps.get('create', 'insert');
          const inserted = await executor
            .insert(plan.targetTable)
            .values(values)
            .returning(step ? step.returning : { [plan.foreignColPropName]: plan.foreignCol });
          step?.rows.push(...inserted);
          const created = inserted[0];
          if (!created) {
            throw drizzleError(
              `Drizzle-GraphQL Error: 'create' on '${relationName}' inserted no row, so there is nothing to attach.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }
          await steps.after();
          patch[plan.localColPropName] = created[plan.foreignColPropName];
          result.expected[relationName] = created[plan.foreignColPropName];
        } else if (op['connect'] !== undefined) {
          // `rows.length` drives the match check and is unaffected by the projection, so the
          // read asks only for the key that ends up on the parent's patch.
          const rows = await executor
            .select({ [plan.foreignColPropName]: plan.foreignCol })
            .from(plan.targetTable)
            .where(conditionOf(plan, op['connect'], 'connect', scope));
          if (rows.length !== 1) {
            throw connectMatchError(relationName, rows.length);
          }
          const key = rows[0][plan.foreignColPropName];
          // Replacing the key detaches the row it pointed at, which the relation's own `where`
          // may hide. Such a row keeps its key, and `checkParentSide` refuses the connect.
          patch[plan.localColPropName] = existing ? keepingHidden(plan, key) : key;
          result.expected[relationName] = key;
        } else if (op['disconnect'] === true) {
          // A row the relation's own `where` hides is out of a disconnect's reach, as it is
          // child-side: the key is cleared only where it points at a row the relation shows.
          patch[plan.localColPropName] = existing ? keepingHidden(plan, null) : null;
          // Only an upsert's input offers this without `existing`, and its conflict branch
          // has to write the cleared key, as it has to write a connected one. A key it kept
          // because the relation's `where` hides its row is allowed (see `checkParentSide`).
          if (!existing) {
            result.expected[relationName] = null;
          }
        }
      }

      // A context-derived column is the server's to set, never a nested input's. No relation
      // whose key is one is planned (see dropContextValueRelations); this keeps the patch from
      // ever overriding the stamped value, or reassigning it on an update, regardless.
      for (const columnName of Object.keys(contextValues?.(tableName) ?? {})) {
        delete patch[columnName];
      }
      return result;
    },

    checkParentSide: async (executor, tableName, ops, rows, patch) => {
      const tablePlans = plans[tableName];
      if (!tablePlans || !rows.length) {
        return;
      }
      for (const relationName of Object.keys(ops)) {
        const plan = tablePlans[relationName];
        if (plan?.fkSide !== 'parent') {
          continue;
        }
        if (relationName in patch.expected) {
          const expected = keyString(patch.expected[relationName]);
          const mismatched = rows.filter((row) => keyString(row[plan.localColPropName]) !== expected);
          if (mismatched.length) {
            const hiddenError = drizzleError(
              `Drizzle-GraphQL Error: cannot connect through '${relationName}': the row it holds now is one its \`where\` hides, which a write through it cannot detach.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
            // On an update the key is only ever kept because its row is hidden.
            if (patch.existing) {
              throw hiddenError;
            }
            // An upsert's conflict branch either kept a hidden key (see `guardConflictSet`) or
            // did not write the key at all, and the two read the same from the row alone.
            const hidden = await hiddenKeys(
              executor,
              plan,
              mismatched.map((row) => row[plan.localColPropName]),
            );
            if (mismatched.some((row) => !hidden.has(keyString(row[plan.localColPropName])))) {
              throw drizzleError(
                `Drizzle-GraphQL Error: cannot write through '${relationName}': the ${tableName} row was not written with it — an upsert whose conflict branch did not write '${plan.localColPropName}'. Include it in onConflict.update, or leave update unset.`,
                { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
              );
            }
            // A disconnect that leaves a hidden row attached is what an update does too.
            if (ops[relationName]?.['disconnect'] !== true) {
              throw hiddenError;
            }
          }
        }
        if (plan.parentHidden && (await plan.parentHidden(executor, rows))) {
          throw drizzleError(
            `Drizzle-GraphQL Error: cannot write through '${relationName}': its \`where\` hides the relation on this ${tableName} row.`,
            { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
          );
        }
      }
    },

    guardConflictSet: (tableName, ops, set) => {
      const tablePlans = plans[tableName];
      let guarded = set;
      for (const relationName of Object.keys(ops)) {
        const plan = tablePlans?.[relationName];
        if (plan?.fkSide === 'parent' && plan.ownCondition && set[plan.localColPropName]) {
          guarded = { ...guarded, [plan.localColPropName]: keepingHiddenSql(plan, set[plan.localColPropName]!) };
        }
      }
      return guarded;
    },

    applyChildSide: async (executor, tableName, ops, parentRows, request) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return;
      }
      const context = request?.context;
      const scope = resolveScope(policies, context, filterCtx);

      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (plan?.fkSide !== 'child') {
          continue;
        }
        if (plan.isOne) {
          assertSingleOperation(plan, op);
        }

        // One hook call per input and operation for the whole batch of parent rows: an update
        // matching several rows writes each one's children, and the hook sees them together.
        const steps = createHookSteps(onWrite, executor, request, tableName, plan);
        registerChildSteps(
          steps,
          plan,
          op,
          !!(plan.through?.tableName && policies?.softDelete?.(plan.through.tableName)),
        );
        await steps.before();

        for (const parentRow of parentRows) {
          const key = parentRow?.[plan.localColPropName];
          if (key === undefined || key === null) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot write through '${relationName}': the ${tableName} row has no '${plan.localColPropName}' value to attach to.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }

          if (plan.parentShows && !(await plan.parentShows(executor, key))) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot write through '${relationName}': its \`where\` hides the relation on this ${tableName} row.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }

          if (plan.through) {
            await applyThroughOps(executor, plan, key, op, scope, steps, context);
            continue;
          }

          // Replace-the-set first, so a `set` alongside a `create` reads as "these rows, plus
          // this new one" rather than dropping the row it just inserted.
          if (op['set'] !== undefined) {
            await detachAll(executor, plan, key, scope, steps, 'set');
            for (const filter of asArray(op['set'])) {
              await steps.run(
                executor
                  .update(plan.targetTable)
                  .set({ [plan.foreignColPropName]: key })
                  .where(conditionOf(plan, filter, 'set', scope)),
                'set',
                'update',
              );
            }
          }

          if (op['disconnect'] !== undefined) {
            if (plan.isOne) {
              if (op['disconnect'] === true) {
                await detachAll(executor, plan, key, scope, steps, 'disconnect');
              }
            } else {
              for (const filter of asArray(op['disconnect'])) {
                await steps.run(
                  executor
                    .update(plan.targetTable)
                    .set({ [plan.foreignColPropName]: null })
                    .where(and(eq(plan.foreignCol, key), conditionOf(plan, filter, 'disconnect', scope))),
                  'disconnect',
                  'update',
                );
              }
            }
          }

          // A to-one `connect` attaches a single row, so its filter has to match exactly one —
          // checked before anything is detached, so a miss leaves the current row in place.
          if (plan.isOne && op['connect'] !== undefined) {
            const matched = await executor
              .select({ [plan.foreignColPropName]: plan.foreignCol })
              .from(plan.targetTable)
              .where(conditionOf(plan, op['connect'], 'connect', scope));
            if (matched.length !== 1) {
              throw connectMatchError(relationName, matched.length);
            }
          }

          // A to-one relation holds one row, so attaching a new one detaches whatever was
          // there — otherwise both rows point at this parent and the relation is ambiguous.
          const attachedBy = attachingOp(op);
          if (plan.isOne && attachedBy && plan.canDetach && op['set'] === undefined) {
            await detachAll(executor, plan, key, scope, steps, attachedBy);
          }

          if (op['connect'] !== undefined) {
            for (const filter of asArray(op['connect'])) {
              if (writesTargetKey(plan)) {
                const held = await executor
                  .select({ [plan.foreignColPropName]: plan.foreignCol })
                  .from(plan.targetTable)
                  .where(conditionOf(plan, filter, 'connect', scope));
                if (held.some((row: any) => keyString(row[plan.foreignColPropName]) !== keyString(key))) {
                  throw drizzleError(
                    `Drizzle-GraphQL Error: cannot connect through '${relationName}': '${plan.foreignColPropName}' is the primary key of ${plan.targetTableName}, which a connect never rewrites. A row that already holds this ${tableName} row's key is connected as it is.`,
                    { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
                  );
                }
                continue;
              }
              await steps.run(
                executor
                  .update(plan.targetTable)
                  .set({ [plan.foreignColPropName]: key })
                  .where(conditionOf(plan, filter, 'connect', scope)),
                'connect',
                'update',
              );
            }
          }

          if (op['create'] !== undefined) {
            // The context values go on last: a relation whose key is one of them is never
            // planned (see dropContextValueRelations), and the server's value wins regardless.
            const rows = asArray(op['create']).map((row) =>
              applyContextValues(
                { ...remapFromGraphQLSingleInput({ ...row }, plan.targetTable), [plan.foreignColPropName]: key },
                stampsOf(plan.targetTableName),
                context,
              ),
            );
            if (rows.length) {
              await steps.run(executor.insert(plan.targetTable).values(rows), 'create', 'insert');
            }
          }
        }

        await steps.after();
      }
    },
  };
};

/** Thrown inside an entry's savepoint to undo a parent-side `create` whose parent was never written. */
class NoParentRow extends Error {}

/**
 * One parent write with its nested operations around it: the parent-side operations, whose
 * values `write` receives as a patch, then the write, then the child-side operations — and
 * the rows it returns read back when a child-side statement may have changed them.
 *
 * A parent write can come back empty: an update whose `where` matched nothing, an insert or
 * upsert that a conflict turned into a no-op. Anything a parent-side `create` inserted would
 * then be left with nothing pointing at it, so such an entry runs in a savepoint of its own
 * that is rolled back when the write produced no row, and the entry returns no rows — as it
 * would have without the nested operation. The rest of the batch is unaffected.
 *
 * `executor` must already be a transaction.
 */
export const writeNestedEntry = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  ops: NestedOps;
  write: (executor: any, patch: Record<string, any>) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
  /** The write updates existing rows; see {@link NestedWriteRuntime.applyParentSide}. */
  existing?: boolean;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, ops, write, request, existing } = params;
  const guarded = runtime.createsParentSide(tableName, ops);

  const run = async (tx: any) => {
    const patch = await runtime.applyParentSide(tx, tableName, ops, request, existing);
    const rows = await write(tx, patch.values);
    if (guarded && !rows.length) {
      throw new NoParentRow();
    }
    await runtime.checkParentSide(tx, tableName, ops, rows, patch);
    await runtime.applyChildSide(tx, tableName, ops, rows, request);
    return runtime.refreshed(tx, tableName, ops, rows);
  };

  if (!guarded) {
    return run(executor);
  }
  try {
    return await executor.transaction(run);
  } catch (error) {
    if (error instanceof NoParentRow) {
      return [];
    }
    throw error;
  }
};

/**
 * Runs one parent write per input entry, with that entry's nested operations around it, all
 * inside a single transaction — a savepoint when the caller already runs on one, so a failing
 * entry rolls the whole batch back.
 *
 * That transaction is also the `tx` the target tables' `onWrite` hooks run on. Every nested
 * write opens it, so a hook on a nested target has the whole tree to roll back even when the
 * root field carries no hook of its own and was not forced into a transaction for one.
 *
 * Entries are written one at a time rather than as a single multi-row statement: a nested
 * operation attaches to the row its own entry produced, so the two have to stay correlated.
 * The batch path is untouched when no entry carries a nested operation.
 */
export const writeWithNestedOps = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  entries: { columns: Record<string, any>; ops: NestedOps }[];
  remapValues: (columns: Record<string, any>) => Record<string, any>;
  /** `ops` is the entry's nested operations, for a write whose statement depends on them. */
  write: (executor: any, values: Record<string, any>, ops: NestedOps) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, entries, remapValues, write, request } = params;

  return executor.transaction(async (tx: any) => {
    const rows: Record<string, any>[] = [];
    for (const entry of entries) {
      const written = await writeNestedEntry({
        executor: tx,
        runtime,
        tableName,
        ops: entry.ops,
        write: (target, patch) => write(target, { ...remapValues(entry.columns), ...patch }, entry.ops),
        request,
      });
      rows.push(...written);
    }
    return rows;
  });
};

/**
 * The update counterpart: one `set` whose nested operations apply to every row the `where`
 * matched. Resolves the parent-side operations into the values first, writes once, then
 * attaches to each row that came back.
 */
export const updateWithNestedOps = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  columns: Record<string, any>;
  ops: NestedOps;
  remapValues: (columns: Record<string, any>) => Record<string, any>;
  write: (executor: any, values: Record<string, any>) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, columns, ops, remapValues, write, request } = params;

  return executor.transaction((tx: any) =>
    writeNestedEntry({
      executor: tx,
      runtime,
      tableName,
      ops,
      write: (target, patch) => write(target, { ...remapValues(columns), ...patch }),
      request,
      existing: true,
    }),
  );
};
