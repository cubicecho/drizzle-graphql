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
import { and, type Column, eq, getColumns, inArray, is, One, type Table } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInputObjectType, type GraphQLInputType, GraphQLList, GraphQLNonNull } from 'graphql';
import { capitalize } from '../case-ops/index.ts';
import { remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { drizzleColumnToGraphQLType } from '../type-converter/index.ts';
import { drizzleError } from './common/errors.ts';
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
  type RelationFilterBase,
  relationFilterCtx,
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
 * with no default, which no `connect` operand could supply a value for.
 *
 * `onUnresolved` is called when the relation's columns are of a supported shape but cannot be
 * matched to the three tables — a drizzle-orm mismatch rather than an unsupported relation.
 */
const buildThroughPlan = (
  relationName: string,
  relation: any,
  table: Table,
  targetTableName: string,
  targetTable: Table,
  tableNameOf: (table: Table) => string | undefined,
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
  const unsuppliable = Object.entries(junctionColumns).some(
    ([propName, column]) =>
      propName !== sourceColPropName && propName !== targetColPropName && !isOptionalOnInsert(column as Column),
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
      tableName: tableNameOf(junction),
      sourceColPropName,
      targetColPropName,
      sourceCol,
      targetCol,
    },
    targetKeyColumns: { [foreignColPropName]: foreignCol },
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
 * relations whose join columns cannot be read off the drizzle relation; and relations where
 * neither join column is unique, which leaves no way to tell which side stores the key.
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
          relation,
          table,
          targetTableName,
          targetTable,
          tableNameOf,
          () => warnUnresolvedJoin(relEntry, tableName, relationName, omitted),
        );
        if (throughPlan) {
          tablePlans[relationName] = throughPlan;
        }
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
      const targetKeyColumns: Record<string, Column> = Object.fromEntries(
        resolvePrimaryKeys(targetTable)
          .filter((name) => targetColumns[name])
          .map((name) => [name, targetColumns[name] as Column]),
      );
      targetKeyColumns[foreignColPropName] = foreignCol;

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
        // `set` replaces a to-many's whole set, and `disconnect` / `set` need a key that can
        // be nulled. Whether the input is the update one, and whether `connect` has a filter
        // to select with, is decided where the input types are built.
        allowed: new Set<NestedWriteOp>(
          !fkColumn.notNull ? (isOne ? ['create', 'connect', 'disconnect'] : ALL_OPS) : ['create', 'connect'],
        ),
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
   * Columns a relation on the same input can fill in, which therefore cannot stay required:
   * `authorId` is NOT NULL, but `author: { create: … }` supplies it.
   */
  relaxedColumns: (tableName: string) => ReadonlySet<string>;
};

const NO_COLUMNS: ReadonlySet<string> = new Set();

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
    // is not something a nested `create` may supply either.
    const contextColumns = cacheCtx.contextValuesOf?.(plan.targetTableName);
    const fields = Object.fromEntries(
      Object.entries(visibleColumns(plan.targetTable))
        .filter(([columnName]) => columnName !== omitted && !contextColumns?.[columnName])
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
   * `<Type><Relation>NestedCreateInput` / `<Type><Relation>NestedUpdateInput` — the operations
   * offered on one relation. The create variant has no `disconnect` or `set`: a row that does
   * not exist yet has nothing attached to detach or replace.
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
    forUpdate: boolean,
  ): GraphQLInputObjectType | undefined => {
    const key = `${tableName}.${plan.relationName}.${forUpdate ? 'update' : 'create'}`;
    const cached = wrapperCache.get(key);
    if (cached) {
      return cached;
    }

    const filters = targetFilters(plan);
    const targetTypeName = resolveTypeName(plan.targetTableName, typeNameMapper);
    const fields: Record<string, { type: GraphQLInputType; description: string }> = {};

    const offers = (op: NestedWriteOp) => plan.allowed.has(op);

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
          description: `Unlink every linked ${targetTypeName} row these match, leaving the rows in place`,
        };
      }
      if (filters && forUpdate && offers('set')) {
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: unlink everything linked, then link every ${targetTypeName} row these match. \`set: []\` clears the relation. Applied before \`disconnect\` and \`connect\`.`,
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
          description: `Detach the currently attached ${targetTypeName} row, leaving it in place`,
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
          description: `Detach every attached ${targetTypeName} row these match, leaving the rows in place`,
        };
      }
      if (filters && forUpdate && offers('set')) {
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: detach everything attached, then attach every ${targetTypeName} row these match. Applied before \`disconnect\`, \`connect\` and \`create\`.`,
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
        defaultName: `${typeName}${capitalize(plan.relationName)}Nested${forUpdate ? 'Update' : 'Create'}Input`,
        table: tableName,
        operation: plan.relationName,
      }),
      description: `Writes through ${typeName}.${plan.relationName}`,
      fields,
    });
    wrapperCache.set(key, type);
    return type;
  };

  const relationFields = (tableName: string, typeName: string, forUpdate: boolean) => {
    const tablePlans = plans[tableName];
    if (!tablePlans) {
      return {};
    }
    return Object.fromEntries(
      Object.values(tablePlans).flatMap((plan) => {
        const wrapper = wrapperType(tableName, typeName, plan, forUpdate);
        return wrapper
          ? [[plan.relationName, { type: wrapper, description: `Writes through ${typeName}.${plan.relationName}` }]]
          : [];
      }),
    );
  };

  return {
    createFields: (tableName, typeName) => relationFields(tableName, typeName, false),
    updateFields: (tableName, typeName) => relationFields(tableName, typeName, true),
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
  ) => Promise<Record<string, any>>;
  /** Runs the operations that attach to a parent row, once that row exists. */
  applyChildSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    parentRows: Record<string, any>[],
    request?: NestedWriteRequest,
  ) => Promise<void>;
};

/**
 * The union of the relation names a batch of entries writes through — enough to decide which
 * join columns the whole batch's RETURNING clause needs, without inspecting each row's write.
 */
export const mergedOps = (entries: { ops: NestedOps }[]): NestedOps =>
  Object.assign({}, ...entries.map((entry) => entry.ops));

const asArray = (value: any): any[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

const supplied = (value: any) => value !== undefined && value !== null;

/** The write a nested statement performs on the table it lands on. */
type NestedOperation = 'insert' | 'update' | 'delete';

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
const registerChildSteps = (steps: HookSteps, plan: NestedRelationPlan, op: Record<string, any>) => {
  if (plan.through) {
    if (supplied(op['set'])) {
      steps.add('set', 'delete');
      steps.add('set', 'insert');
    }
    if (supplied(op['disconnect'])) {
      steps.add('disconnect', 'delete');
    }
    if (supplied(op['connect'])) {
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
  if (op['connect'] !== undefined) {
    steps.add('connect', 'update');
  }
  if (op['create'] !== undefined) {
    steps.add('create', 'insert');
  }
};

/** The input that attaches a row to a to-one, which detaches whatever was attached before. */
const attachingOp = (op: Record<string, any>): NestedWriteOp | undefined =>
  op['connect'] !== undefined ? 'connect' : op['create'] !== undefined ? 'create' : undefined;

export const createNestedWriteRuntime = (params: {
  plans: NestedWritePlans;
  filterCtx: RelationFilterBase | undefined;
  policies?: TablePolicies;
  contextValues?: ContextValuesFor;
}): NestedWriteRuntime => {
  const { plans, filterCtx, policies, contextValues } = params;
  const onWrite = policies?.onWrite;

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
    // see, and out-of-scope rows are not detached.
    return withScope(scope, plan.targetTableName, plan.targetTable, condition)!;
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
  ) => {
    const through = plan.through!;

    const link = async (operands: any[], operation: 'connect' | 'set') => {
      const existing = new Set(
        (
          await executor
            .select({ [through.targetColPropName]: through.targetCol })
            .from(through.table)
            .where(eq(through.sourceCol, key))
        ).map((row: any) => row[through.targetColPropName]),
      );
      const rows: Record<string, any>[] = [];
      for (const filter of operands) {
        for (const targetKey of await selectedTargetKeys(executor, plan, filter, operation, scope)) {
          if (!existing.has(targetKey)) {
            existing.add(targetKey);
            rows.push({ [through.sourceColPropName]: key, [through.targetColPropName]: targetKey });
          }
        }
      }
      if (rows.length) {
        await steps.run(executor.insert(through.table).values(rows), operation, 'insert');
      }
    };

    // Replace-the-set first, so a `set` alongside a `connect` reads as "these rows, plus that
    // one". `set: []` unlinks everything and links nothing back, which is how the relation is
    // cleared.
    if (supplied(op['set'])) {
      await steps.run(executor.delete(through.table).where(eq(through.sourceCol, key)), 'set', 'delete');
      await link(asArray(op['set']), 'set');
    }

    if (supplied(op['disconnect'])) {
      for (const filter of asArray(op['disconnect'])) {
        const targetKeys = await selectedTargetKeys(executor, plan, filter, 'disconnect', scope);
        if (targetKeys.length) {
          await steps.run(
            executor
              .delete(through.table)
              .where(and(eq(through.sourceCol, key), inArray(through.targetCol, targetKeys))),
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
        .where(withScope(scope, plan.targetTableName, plan.targetTable, eq(plan.foreignCol, key))),
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
        if (plan?.fkSide === 'child' && !(plan.localColPropName in columns) && allColumns[plan.localColPropName]) {
          (columns as any)[plan.localColPropName] = allColumns[plan.localColPropName];
        }
      }
      return columns;
    },

    applyParentSide: async (executor, tableName, ops, request) => {
      const tablePlans = plans[tableName];
      const patch: Record<string, any> = {};
      if (!tablePlans) {
        return patch;
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
            contextValues?.(plan.targetTableName),
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
        } else if (op['connect'] !== undefined) {
          // `rows.length` drives the match check and is unaffected by the projection, so the
          // read asks only for the key that ends up on the parent's patch.
          const rows = await executor
            .select({ [plan.foreignColPropName]: plan.foreignCol })
            .from(plan.targetTable)
            .where(conditionOf(plan, op['connect'], 'connect', scope));
          if (rows.length !== 1) {
            throw drizzleError(
              `Drizzle-GraphQL Error: 'connect' on '${relationName}' matched ${rows.length} rows — it attaches a single row, so its filter must match exactly one.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }
          patch[plan.localColPropName] = rows[0][plan.foreignColPropName];
        } else if (op['disconnect'] === true) {
          patch[plan.localColPropName] = null;
        }
      }

      return patch;
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
        registerChildSteps(steps, plan, op);
        await steps.before();

        for (const parentRow of parentRows) {
          const key = parentRow?.[plan.localColPropName];
          if (key === undefined || key === null) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot write through '${relationName}': the ${tableName} row has no '${plan.localColPropName}' value to attach to.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }

          if (plan.through) {
            await applyThroughOps(executor, plan, key, op, scope, steps);
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

          // A to-one relation holds one row, so attaching a new one detaches whatever was
          // there — otherwise both rows point at this parent and the relation is ambiguous.
          const attachedBy = attachingOp(op);
          if (plan.isOne && attachedBy && plan.canDetach && op['set'] === undefined) {
            await detachAll(executor, plan, key, scope, steps, attachedBy);
          }

          if (op['connect'] !== undefined) {
            for (const filter of asArray(op['connect'])) {
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
            const rows = asArray(op['create']).map((row) => ({
              ...applyContextValues(
                remapFromGraphQLSingleInput({ ...row }, plan.targetTable),
                contextValues?.(plan.targetTableName),
                context,
              ),
              [plan.foreignColPropName]: key,
            }));
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
  write: (executor: any, values: Record<string, any>) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, entries, remapValues, write, request } = params;

  return executor.transaction(async (tx: any) => {
    const rows: Record<string, any>[] = [];
    for (const entry of entries) {
      const patch = await runtime.applyParentSide(tx, tableName, entry.ops, request);
      const written = await write(tx, { ...remapValues(entry.columns), ...patch });
      await runtime.applyChildSide(tx, tableName, entry.ops, written, request);
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

  return executor.transaction(async (tx: any) => {
    const patch = await runtime.applyParentSide(tx, tableName, ops, request);
    const rows = await write(tx, { ...remapValues(columns), ...patch });
    await runtime.applyChildSide(tx, tableName, ops, rows, request);
    return rows;
  });
};
