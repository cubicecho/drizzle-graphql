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
import { and, Column, eq, getColumns, inArray, is, One, type Table } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInputObjectType, type GraphQLInputType, GraphQLList, GraphQLNonNull } from 'graphql';
import { capitalize } from '../case-ops/index.ts';
import { remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { drizzleColumnToGraphQLType } from '../type-converter/index.ts';
import { drizzleError } from './common/errors.ts';
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
  visibleColumns,
  withScope,
} from './common.ts';
import type { TableNamedRelations } from './types.ts';

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
};

/**
 * The junction table of a `.through()` relation, and the two of its columns this relation
 * joins on. A many-to-many is attached and detached by inserting and deleting junction rows,
 * so neither the parent row nor the target row is written at all.
 */
export type NestedThroughPlan = {
  table: Table;
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
 * The junction column one entry of a relation's `through` config points at. Drizzle wraps it
 * in a descriptor while the relation is being defined; the raw column is accepted too, so a
 * change of shape there degrades to skipping the relation rather than mis-planning it.
 */
const throughColumn = (entry: any): Column | undefined =>
  entry && is(entry, Column) ? (entry as Column) : (entry?._?.column as Column | undefined);

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
 */
const buildThroughPlan = (
  relationName: string,
  relation: any,
  table: Table,
  targetTableName: string,
  targetTable: Table,
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
  const localCol = relation.sourceColumns[0] as Column;
  const foreignCol = relation.targetColumns[0] as Column;
  const localColPropName = propNameOf(table, localCol);
  const foreignColPropName = propNameOf(targetTable, foreignCol);
  const sourceColPropName = propNameOf(junction, throughColumn(sourceEntries[0]));
  const targetColPropName = propNameOf(junction, throughColumn(targetEntries[0]));
  if (!localColPropName || !foreignColPropName || !sourceColPropName || !targetColPropName) {
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
    through: { table: junction, sourceColPropName, targetColPropName, sourceCol, targetCol },
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

      if ((relation as any).through) {
        const throughPlan = buildThroughPlan(relationName, relation, table, targetTableName, targetTable);
        if (throughPlan) {
          tablePlans[relationName] = throughPlan;
        }
        continue;
      }

      const joinColumns = extractJoinColumns(relEntry, table, targetTable);
      if (!joinColumns) {
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
      };
    }

    if (Object.keys(tablePlans).length) {
      plans[tableName] = tablePlans;
    }
  }

  return plans;
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
      name: `${typeName}${capitalize(plan.relationName)}NestedCreatePayloadInput`,
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
   * `disconnect` and `set` are offered unconditionally, since breaking a link deletes a
   * junction row rather than nulling a column that might be NOT NULL.
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

    if (plan.through) {
      // Without a `Filters` input there is no way to name the rows to link, and `create` is
      // not offered here, so the whole field would be empty — the relation is left out.
      if (!filters) {
        return undefined;
      }
      fields['connect'] = {
        type: listOf(filters),
        description: `Link every existing ${targetTypeName} row these match. Already-linked rows are left alone.`,
      };
      if (forUpdate) {
        fields['disconnect'] = {
          type: listOf(filters),
          description: `Unlink every linked ${targetTypeName} row these match, leaving the rows in place`,
        };
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: unlink everything linked, then link every ${targetTypeName} row these match. \`set: []\` clears the relation. Applied before \`disconnect\` and \`connect\`.`,
        };
      }
    } else if (plan.isOne) {
      fields['create'] = {
        type: payloadType(tableName, typeName, plan),
        description: `Insert a ${targetTypeName} row and attach it`,
      };
      if (filters) {
        fields['connect'] = {
          type: filters,
          description: `Attach the existing ${targetTypeName} row this matches. Must match exactly one row.`,
        };
      }
      if (forUpdate && plan.canDetach) {
        fields['disconnect'] = {
          type: GraphQLBoolean,
          description: `Detach the currently attached ${targetTypeName} row, leaving it in place`,
        };
      }
    } else {
      fields['create'] = {
        type: listOf(payloadType(tableName, typeName, plan)),
        description: `Insert these ${targetTypeName} rows and attach them`,
      };
      if (filters) {
        fields['connect'] = {
          type: listOf(filters),
          description: `Attach every existing ${targetTypeName} row these match`,
        };
        if (forUpdate && plan.canDetach) {
          fields['disconnect'] = {
            type: listOf(filters),
            description: `Detach every attached ${targetTypeName} row these match, leaving the rows in place`,
          };
          fields['set'] = {
            type: listOf(filters),
            description: `Replace the whole set: detach everything attached, then attach every ${targetTypeName} row these match. Applied before \`disconnect\`, \`connect\` and \`create\`.`,
          };
        }
      }
    }

    // `create` alone is still a usable relation field, and outside a many-to-many a relation
    // with nothing on it at all cannot happen: `create` is unconditional there.
    const type = new GraphQLInputObjectType({
      name: `${typeName}${capitalize(plan.relationName)}Nested${forUpdate ? 'Update' : 'Create'}Input`,
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
        if (plan.fkSide === 'parent' && !isOptionalOnInsert(plan.localCol)) {
          relaxed.add(plan.localColPropName);
        }
      }
      return relaxed.size ? relaxed : NO_COLUMNS;
    },
  };
};

// ── runtime ──────────────────────────────────────────────────────────────────

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
  applyParentSide: (executor: any, tableName: string, ops: NestedOps, context?: any) => Promise<Record<string, any>>;
  /** Runs the operations that attach to a parent row, once that row exists. */
  applyChildSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    parentRows: Record<string, any>[],
    context?: any,
  ) => Promise<void>;
};

/**
 * The union of the relation names a batch of entries writes through — enough to decide which
 * join columns the whole batch's RETURNING clause needs, without inspecting each row's write.
 */
export const mergedOps = (entries: { ops: NestedOps }[]): NestedOps =>
  Object.assign({}, ...entries.map((entry) => entry.ops));

const asArray = (value: any): any[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

export const createNestedWriteRuntime = (params: {
  plans: NestedWritePlans;
  filterCtx: RelationFilterBase | undefined;
  policies?: TablePolicies;
  contextValues?: ContextValuesFor;
}): NestedWriteRuntime => {
  const { plans, filterCtx, policies, contextValues } = params;

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
      relationFilterCtx(filterCtx, plan.targetTableName),
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
    const supplied = ['create', 'connect', 'disconnect'].filter((key) => op[key] !== undefined && op[key] !== null);
    if (supplied.length > 1) {
      throw drizzleError(
        `Drizzle-GraphQL Error: '${plan.relationName}' takes one of ${supplied.join(', ')} at a time — it holds a single row.`,
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
    const rows = await executor
      .select()
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
  ) => {
    const through = plan.through!;
    const unlinkAll = () => executor.delete(through.table).where(eq(through.sourceCol, key));

    const link = async (operands: any[], operation: string) => {
      const existing = new Set(
        (await executor.select().from(through.table).where(eq(through.sourceCol, key))).map(
          (row: any) => row[through.targetColPropName],
        ),
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
        await executor.insert(through.table).values(rows);
      }
    };

    // Replace-the-set first, so a `set` alongside a `connect` reads as "these rows, plus that
    // one". `set: []` unlinks everything and links nothing back, which is how the relation is
    // cleared.
    if (op['set'] !== undefined && op['set'] !== null) {
      await unlinkAll();
      await link(asArray(op['set']), 'set');
    }

    if (op['disconnect'] !== undefined && op['disconnect'] !== null) {
      for (const filter of asArray(op['disconnect'])) {
        const targetKeys = await selectedTargetKeys(executor, plan, filter, 'disconnect', scope);
        if (targetKeys.length) {
          await executor
            .delete(through.table)
            .where(and(eq(through.sourceCol, key), inArray(through.targetCol, targetKeys)));
        }
      }
    }

    if (op['connect'] !== undefined && op['connect'] !== null) {
      await link(asArray(op['connect']), 'connect');
    }
  };

  const detachAll = async (executor: any, plan: NestedRelationPlan, key: any, scope: ScopeResolver | undefined) =>
    executor
      .update(plan.targetTable)
      .set({ [plan.foreignColPropName]: null })
      .where(withScope(scope, plan.targetTableName, plan.targetTable, eq(plan.foreignCol, key)));

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

    applyParentSide: async (executor, tableName, ops, context) => {
      const tablePlans = plans[tableName];
      const patch: Record<string, any> = {};
      if (!tablePlans) {
        return patch;
      }
      const scope = resolveScope(policies, context, filterCtx);

      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (!plan || plan.fkSide !== 'parent') {
          continue;
        }
        assertSingleOperation(plan, op);

        if (op['create'] !== undefined) {
          const values = applyContextValues(
            remapFromGraphQLSingleInput({ ...op['create'] }, plan.targetTable),
            contextValues?.(plan.targetTableName),
            context,
          );
          const inserted = await executor.insert(plan.targetTable).values(values).returning();
          const created = inserted[0];
          if (!created) {
            throw drizzleError(
              `Drizzle-GraphQL Error: 'create' on '${relationName}' inserted no row, so there is nothing to attach.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }
          patch[plan.localColPropName] = created[plan.foreignColPropName];
        } else if (op['connect'] !== undefined) {
          const rows = await executor
            .select()
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

    applyChildSide: async (executor, tableName, ops, parentRows, context) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return;
      }
      const scope = resolveScope(policies, context, filterCtx);

      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (!plan || plan.fkSide !== 'child') {
          continue;
        }
        if (plan.isOne) {
          assertSingleOperation(plan, op);
        }

        for (const parentRow of parentRows) {
          const key = parentRow?.[plan.localColPropName];
          if (key === undefined || key === null) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot write through '${relationName}': the ${tableName} row has no '${plan.localColPropName}' value to attach to.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }

          if (plan.through) {
            await applyThroughOps(executor, plan, key, op, scope);
            continue;
          }

          // Replace-the-set first, so a `set` alongside a `create` reads as "these rows, plus
          // this new one" rather than dropping the row it just inserted.
          if (op['set'] !== undefined) {
            await detachAll(executor, plan, key, scope);
            for (const filter of asArray(op['set'])) {
              await executor
                .update(plan.targetTable)
                .set({ [plan.foreignColPropName]: key })
                .where(conditionOf(plan, filter, 'set', scope));
            }
          }

          if (op['disconnect'] !== undefined) {
            if (plan.isOne) {
              if (op['disconnect'] === true) {
                await detachAll(executor, plan, key, scope);
              }
            } else {
              for (const filter of asArray(op['disconnect'])) {
                await executor
                  .update(plan.targetTable)
                  .set({ [plan.foreignColPropName]: null })
                  .where(and(eq(plan.foreignCol, key), conditionOf(plan, filter, 'disconnect', scope)));
              }
            }
          }

          // A to-one relation holds one row, so attaching a new one detaches whatever was
          // there — otherwise both rows point at this parent and the relation is ambiguous.
          const attaches = op['connect'] !== undefined || op['create'] !== undefined;
          if (plan.isOne && attaches && plan.canDetach && op['set'] === undefined) {
            await detachAll(executor, plan, key, scope);
          }

          if (op['connect'] !== undefined) {
            for (const filter of asArray(op['connect'])) {
              await executor
                .update(plan.targetTable)
                .set({ [plan.foreignColPropName]: key })
                .where(conditionOf(plan, filter, 'connect', scope));
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
              await executor.insert(plan.targetTable).values(rows);
            }
          }
        }
      }
    },
  };
};

/**
 * Runs one parent write per input entry, with that entry's nested operations around it, all
 * inside a single transaction — a savepoint when the caller already runs on one, so a failing
 * entry rolls the whole batch back.
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
  context?: any;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, entries, remapValues, write, context } = params;

  return executor.transaction(async (tx: any) => {
    const rows: Record<string, any>[] = [];
    for (const entry of entries) {
      const patch = await runtime.applyParentSide(tx, tableName, entry.ops, context);
      const written = await write(tx, { ...remapValues(entry.columns), ...patch });
      await runtime.applyChildSide(tx, tableName, entry.ops, written, context);
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
  context?: any;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, columns, ops, remapValues, write, context } = params;

  return executor.transaction(async (tx: any) => {
    const patch = await runtime.applyParentSide(tx, tableName, ops, context);
    const rows = await write(tx, { ...remapValues(columns), ...patch });
    await runtime.applyChildSide(tx, tableName, ops, rows, context);
    return rows;
  });
};
