import {
  and,
  avg,
  type Column,
  count,
  countDistinct,
  eq,
  extractExtendedColumnType,
  getColumns,
  gt,
  gte,
  inArray,
  lt,
  lte,
  max,
  min,
  ne,
  sum,
  type Table,
} from 'drizzle-orm';
import {
  type GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from 'graphql';
import { getOrCreateLoader } from '../batch-loader/index.ts';
import { capitalize } from '../case-ops/index.ts';
import { remapToGraphQLCore } from '../data-mappers/index.ts';
import type { ResolveTree } from '../parse-resolve-info.ts';
import { parseResolveInfo } from '../parse-resolve-info.ts';
import { drizzleColumnToGraphQLType } from '../type-converter/index.ts';
import type { ConvertedColumn } from '../type-converter/types.ts';
import {
  columnDocs,
  type DeletedMode,
  type DrizzleErrorContext,
  deletedArg,
  drizzleError,
  extractFilters,
  extractRelationJoinColumns,
  type GeneratedTypeInfo,
  generateColumnEnum,
  type RelationAggregateFactory,
  type RelationFilterBase,
  relationDeletedDefault,
  relationFilterCtx,
  resolveExecutor,
  resolveScope,
  resolveTypeName,
  sharedType,
  type TablePolicies,
  type TypeCacheCtx,
  type TypeNameMapper,
  type TypeNameResolver,
  toGraphQLError,
  visibleColumns,
  withErrorContext,
  withScope,
} from './common.ts';
import type { CreatedResolver, Filters } from './types.ts';

/** Operations that aggregate over a set of column values. `count` is handled separately (whole rows). */
const AGGREGATE_OPS = ['avg', 'sum', 'min', 'max', 'countNonNull', 'countDistinct'] as const;
type AggregateOp = (typeof AGGREGATE_OPS)[number];

/** Ops whose result is a row count: never null, and returned as `Int!` rather than the column's type. */
const COUNT_OPS = new Set<AggregateOp>(['countNonNull', 'countDistinct']);

const OP_FNS: Record<AggregateOp, (col: Column) => any> = {
  avg,
  sum,
  min,
  max,
  countNonNull: count,
  countDistinct,
};

/** Separator for flat select aliases (`avg__price`) — reassembled into nested output by the resolver. */
const SEP = '__';

interface AggregateColumnSets {
  /** Columns avg/sum apply to: plain Int/Float scalars. */
  numeric: Record<string, Column>;
  /** Columns min/max apply to: anything with a total ordering the DB supports (numbers, strings, dates, enums). */
  orderable: Record<string, { column: Column; converted: ConvertedColumn }>;
  /** Every column — `count(col)` is valid whatever the type. */
  all: Record<string, Column>;
}

/**
 * Classifies a table's columns for aggregation. avg/sum only make sense on numeric scalars;
 * min/max work on any orderable scalar (numbers, strings, bigints, dates, enums). Booleans,
 * arrays (including array-typed number columns), JSON, buffers, and object-shaped columns
 * (e.g. geometry) are excluded entirely.
 */
/**
 * Cache for {@link classifyAggregateColumns}. Keyed on the table object, then on the name it
 * was classified under — the name only reaches `drizzleColumnToGraphQLType` for enum naming,
 * but a table registered under two names would name its enums differently, so it is part of
 * the key rather than assumed irrelevant.
 *
 * The entries hold this build's GraphQL types and this build's column exclusions, so the
 * cache lives exactly as long as a build: {@link resetAggregateColumnCache} runs at the start
 * of every one, alongside the other per-build registries. Kept across builds it would hand a
 * second build the first build's enum instances, which is a schema with two types of one name.
 */
let aggregateColumnSetsCache = new WeakMap<Table, Map<string, AggregateColumnSets>>();

/** Drops the classifications cached for the previous build. Called once per `generateSchemaData`. */
export const resetAggregateColumnCache = (): void => {
  aggregateColumnSetsCache = new WeakMap();
};

const classifyAggregateColumns = (table: Table, tableName: string): AggregateColumnSets => {
  // Called from every aggregate/group-by generator for the same table — five times per table
  // at build time, plus twice per to-many relation — and each call re-converts every column.
  let byName = aggregateColumnSetsCache.get(table);
  if (!byName) {
    byName = new Map();
    aggregateColumnSetsCache.set(table, byName);
  }
  const cached = byName.get(tableName);
  if (cached) {
    return cached;
  }

  const numeric: AggregateColumnSets['numeric'] = {};
  const orderable: AggregateColumnSets['orderable'] = {};
  const all: AggregateColumnSets['all'] = {};

  for (const [columnName, column] of Object.entries(visibleColumns(table))) {
    all[columnName] = column;
    const converted = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, false);
    const gqlType = converted.type;

    // Anything that isn't a plain scalar in the generated schema (arrays, geometry objects)
    // has no meaningful min/max. This also catches array-typed number columns, which keep
    // their scalar drizzle dataType but convert to a GraphQL list.
    if (gqlType instanceof GraphQLList || gqlType instanceof GraphQLObjectType) {
      continue;
    }

    // Classify on the drizzle data type rather than the GraphQL one: date columns convert to
    // different GraphQL scalars per dialect, but are orderable everywhere.
    const { type: dataType, constraint } = extractExtendedColumnType(column);
    if (dataType === 'boolean' || dataType === 'array' || dataType === 'custom') {
      continue;
    }
    if (dataType === 'object' && constraint !== 'date') {
      continue;
    }

    orderable[columnName] = { column, converted };
    if (dataType === 'number') {
      numeric[columnName] = column;
    }
  }

  const sets = { numeric, orderable, all };
  byName.set(tableName, sets);

  return sets;
};

/**
 * Builds the `${typeName}Aggregate` output type for a table:
 * - `count: Int!` — number of matching rows
 * - `avg` / `sum` — per numeric column, always nullable Float (SQL returns NULL on empty sets,
 *   and avg/sum of integers overflow Int / produce decimals)
 * - `min` / `max` — per orderable column, the column's own (nullable) scalar type
 * - `countNonNull` — per column, `Int!`: how many matching rows have a non-null value there
 * - `countDistinct` — per orderable column, `Int!`: how many distinct non-null values there are
 * Each wrapper is omitted when no column qualifies for it.
 */
export const generateAggregateTypes = (
  table: Table,
  tableName: string,
  typeName: string,
  cacheCtx?: TypeCacheCtx,
): GraphQLObjectType => {
  const cached = cacheCtx?.aggregateTypeCache.get(tableName);
  if (cached) {
    return cached;
  }

  const { numeric, orderable, all } = classifyAggregateColumns(table, tableName);
  const nameOf = (op: string) =>
    cacheCtx?.typeName({
      kind: 'aggregate',
      defaultName: `${typeName}${capitalize(op)}Aggregate`,
      table: tableName,
      operation: op,
    }) ?? `${typeName}${capitalize(op)}Aggregate`;

  const fields: Record<string, { type: any }> = {
    count: { type: new GraphQLNonNull(GraphQLInt) },
  };

  if (Object.keys(numeric).length) {
    for (const op of ['avg', 'sum'] as const) {
      fields[op] = {
        type: new GraphQLObjectType({
          name: nameOf(op),
          fields: Object.fromEntries(Object.keys(numeric).map((columnName) => [columnName, { type: GraphQLFloat }])),
        }),
      };
    }
  }

  if (Object.keys(orderable).length) {
    for (const op of ['min', 'max'] as const) {
      fields[op] = {
        type: new GraphQLObjectType({
          name: nameOf(op),
          fields: Object.fromEntries(
            Object.entries(orderable).map(([columnName, { column, converted }]) => [
              columnName,
              { type: converted.type, ...columnDocs(cacheCtx?.docs ?? {}, column, tableName, columnName) },
            ]),
          ),
        }),
      };
    }
  }

  // `count(col)` works on any column type; `count(distinct col)` needs an equality operator,
  // which is the same requirement min/max have, so it reuses the orderable set.
  const countSets: Record<string, Record<string, unknown>> = { countNonNull: all, countDistinct: orderable };
  for (const [op, columns] of Object.entries(countSets)) {
    const columnNames = Object.keys(columns);
    if (!columnNames.length) {
      continue;
    }
    fields[op] = {
      type: new GraphQLObjectType({
        name: nameOf(op),
        fields: Object.fromEntries(
          columnNames.map((columnName) => [columnName, { type: new GraphQLNonNull(GraphQLInt) }]),
        ),
      }),
    };
  }

  const aggregateType = new GraphQLObjectType({
    name:
      cacheCtx?.typeName({ kind: 'aggregate', defaultName: `${typeName}Aggregate`, table: tableName }) ??
      `${typeName}Aggregate`,
    fields,
  });

  cacheCtx?.aggregateTypeCache.set(tableName, aggregateType);

  return aggregateType;
};

/** Parses a driver-level date/time string (`2024-04-02 06:44:41.785`, `2024-04-02`) as UTC. */
const parseDriverDateTime = (raw: string): Date => {
  let v = raw.includes(' ') ? raw.replace(' ', 'T') : raw;
  if (!v.includes('T')) {
    v = `${v}T00:00:00`;
  }
  if (!/(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(v)) {
    v = `${v}Z`;
  }
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? new Date(raw) : parsed;
};

/** What the client asked for, plus the drizzle select map that computes it. */
interface AggregateRequest {
  count: boolean;
  ops: Record<AggregateOp, string[]>;
  selection: Record<string, any>;
}

/** Everything about a table that aggregating over it needs, resolved once at build time. */
interface AggregateTarget {
  tableName: string;
  typeName: string;
  /** The name the `${Table}Aggregate` object type actually carries, which keys the resolve tree. */
  aggregateTypeName: string;
  /** The same for each per-op sub-type, e.g. `${Table}AvgAggregate`. */
  opTypeName: (op: AggregateOp) => string;
  columns: Record<string, Column>;
  /** Columns whose GraphQL output is DateTime — their min/max may need string→Date coercion. */
  dateTimeColumns: Set<string>;
}

const aggregateTarget = (
  table: Table,
  tableName: string,
  typeName: string,
  resolveName?: TypeNameResolver,
): AggregateTarget => {
  const { orderable } = classifyAggregateColumns(table, tableName);
  // Named exactly the way `generateAggregateTypes` names them, so the resolver reads the
  // selection tree under the key the schema actually published.
  return {
    tableName,
    typeName,
    aggregateTypeName:
      resolveName?.({ kind: 'aggregate', defaultName: `${typeName}Aggregate`, table: tableName }) ??
      `${typeName}Aggregate`,
    opTypeName: (op) =>
      resolveName?.({
        kind: 'aggregate',
        defaultName: `${typeName}${capitalize(op)}Aggregate`,
        table: tableName,
        operation: op,
      }) ?? `${typeName}${capitalize(op)}Aggregate`,
    columns: getColumns(table),
    dateTimeColumns: new Set(
      Object.entries(orderable)
        .filter(([, { converted }]) => converted.typeLabel === 'DateTime')
        .map(([columnName]) => columnName),
    ),
  };
};

/**
 * Reads the requested count/avg/sum/min/max selections off the resolve tree and turns them
 * into one drizzle select expression per (op, column) pair. An empty `selection` means the
 * client asked for nothing runnable (`__typename` only, or empty sub-selections).
 */
const parseAggregateRequest = (
  info: any,
  target: AggregateTarget,
  rootTypeName = target.aggregateTypeName,
): AggregateRequest => {
  const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
  const selectionTree = parsedInfo.fieldsByTypeName[rootTypeName] ?? {};

  const request: AggregateRequest = {
    count: false,
    ops: { avg: [], sum: [], min: [], max: [], countNonNull: [], countDistinct: [] },
    selection: {},
  };

  // Keys are aliases; `field.name` is the real field. Duplicate selections of the same
  // field under different aliases collapse into one SQL expression — graphql-js resolves
  // every alias from the same result property.
  for (const field of Object.values(selectionTree) as ResolveTree[]) {
    if (field.name === 'count') {
      request.count = true;
      request.selection['count'] = count();
      continue;
    }

    if (!AGGREGATE_OPS.includes(field.name as AggregateOp)) {
      continue;
    }
    const op = field.name as AggregateOp;
    const subTree = field.fieldsByTypeName[target.opTypeName(op)];
    if (!subTree) {
      continue;
    }

    for (const subField of Object.values(subTree) as ResolveTree[]) {
      const columnName = subField.name;
      const column = target.columns[columnName];
      if (!column || request.ops[op].includes(columnName)) {
        continue;
      }
      request.ops[op].push(columnName);
      request.selection[`${op}${SEP}${columnName}`] = OP_FNS[op](column);
    }
  }

  return request;
};

/** Reassembles a flat aggregate row (`avg__price`) into the nested GraphQL shape. */
const assembleAggregateRow = (row: Record<string, any>, request: AggregateRequest, target: AggregateTarget) => {
  const result: Record<string, any> = {};

  if (request.count) {
    // drizzle's count() maps to number already; guard for drivers returning strings.
    result['count'] = row['count'] == null ? 0 : Number(row['count']);
  }

  for (const op of AGGREGATE_OPS) {
    if (!request.ops[op].length) {
      continue;
    }
    const opResult: Record<string, any> = {};
    for (const columnName of request.ops[op]) {
      const value = row[`${op}${SEP}${columnName}`];
      if (COUNT_OPS.has(op)) {
        // A count is never null: an empty set counts to 0, and a missing group means no rows.
        opResult[columnName] = value == null ? 0 : Number(value);
      } else if (value == null) {
        opResult[columnName] = null;
      } else if (op === 'avg' || op === 'sum') {
        // Drivers return numeric/decimal aggregates as strings — coerce to Float.
        opResult[columnName] = Number(value);
      } else {
        // min/max keep the column's own type — drizzle already ran the column's decoder over
        // the value (`min`/`max` are `mapWith(column)`), so all that's left is coercing a
        // leftover raw date string (PG decodes timestamps in driver-level codecs, which raw
        // select expressions bypass) and remapping for GraphQL output.
        // Present by construction: a name only reaches `request.ops` after the same lookup
        // succeeded in `buildAggregateRequest`.
        const column = target.columns[columnName]!;
        const decoded =
          typeof value === 'string' && target.dateTimeColumns.has(columnName) ? parseDriverDateTime(value) : value;
        opResult[columnName] = remapToGraphQLCore(columnName, decoded, target.tableName, column);
      }
    }
    result[op] = opResult;
  }

  return result;
};

/**
 * Creates the resolver for a table's aggregate query field. Reads the requested
 * count/avg/sum/min/max selections from the resolve tree, runs them all as a single
 * `SELECT` with one aggregate expression per requested (op, column) pair, and
 * reassembles the flat row into the nested GraphQL shape.
 *
 * Shared by all three dialects — it only relies on `db.select().from().where()`.
 */
export const generateAggregate = (
  db: any,
  tableName: string,
  table: Table,
  typeName: string,
  fieldName: string,
  filterArgs: GraphQLInputObjectType,
  filterCtx?: RelationFilterBase,
  policies?: TablePolicies,
  resolveName?: TypeNameResolver,
): CreatedResolver => {
  const target = aggregateTarget(table, tableName, typeName, resolveName);
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'aggregate', field: fieldName };

  const queryArgs = {
    where: { type: filterArgs },
    ...deletedArg(policies?.softDelete, tableName, resolveName),
  };

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table>; deleted?: DeletedMode }, context, info) => {
      try {
        const request = parseAggregateRequest(info, target);
        if (!Object.keys(request.selection).length) {
          return {};
        }

        let query = resolveExecutor(db, context).select(request.selection).from(table);
        const where = withScope(
          resolveScope(policies, context, filterCtx),
          tableName,
          table,
          args.where
            ? extractFilters(table, tableName, args.where, relationFilterCtx(filterCtx, tableName))
            : undefined,
          args.deleted,
        );
        if (where) {
          query = query.where(where);
        }
        const rows = await query;

        return assembleAggregateRow(rows[0] ?? {}, request, target);
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};

/** Alias the grouping key is selected under. Prefixed so it can't collide with `${op}__${column}`. */
const GROUP_KEY = '__dgql_group_key';

/**
 * Builds the `${relationName}Aggregate` field that hangs off a parent type for each to-many
 * relation — `user { postsAggregate { count } }`.
 *
 * Resolution is batched the same way relation fields are: every parent row in the current tick
 * that asked for the same relation with the same arguments is served by one
 * `SELECT fk, <aggregates> ... WHERE fk IN (...) GROUP BY fk`, so a list of N parents costs one
 * extra query rather than N. Parents with no matching related rows get `count: 0` and `null`
 * for every other aggregate.
 */
export const createRelationAggregateFactory = (
  db: any,
  tables: Record<string, Table>,
  cacheCtx: TypeCacheCtx,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  policies?: TablePolicies,
): RelationAggregateFactory => {
  return ({ tableName, relationName, relEntry }) => {
    const parentTable = tables[tableName];
    const targetTableName = relEntry.targetTableName;
    const targetTable = tables[targetTableName];

    if (!parentTable || !targetTable) {
      return undefined;
    }

    const joinCols = extractRelationJoinColumns(relEntry, parentTable, targetTable);
    if (!joinCols) {
      return undefined;
    }
    const { localColPropName, foreignCol } = joinCols;
    // An aggregate over a relation counts the rows the relation itself returns, so it takes
    // the same soft-delete default — a `scope: 'root'` target is not hidden here either.
    const defaultDeleted = relationDeletedDefault(policies?.softDelete, targetTableName, false);

    const targetTypeName = resolveTypeName(targetTableName, typeNameMapper);
    const type = generateAggregateTypes(targetTable, targetTableName, targetTypeName, cacheCtx);
    const target = aggregateTarget(targetTable, targetTableName, targetTypeName, cacheCtx.typeName);
    const errorCtx: DrizzleErrorContext = {
      table: targetTableName,
      operation: 'relationAggregate',
      relation: relationName,
    };

    const resolve = async (
      parent: any,
      args: { where?: Filters<Table>; deleted?: DeletedMode },
      context: any,
      info: any,
    ) => {
      try {
        const request = parseAggregateRequest(info, target);
        if (!Object.keys(request.selection).length) {
          return {};
        }

        const localValue = parent[localColPropName];
        // No key to correlate on — the relation is empty by definition.
        if (localValue == null) {
          return assembleAggregateRow({}, request, target);
        }

        const whereArg = args?.where;
        const deleted = args?.deleted;
        // Siblings only share a batch when they'd run the same query: same filters, same aggregates.
        const argsKey = JSON.stringify({
          where: whereArg ?? null,
          deleted: deleted ?? defaultDeleted ?? null,
          selection: Object.keys(request.selection).sort(),
        });
        const loaderKey = `${tableName}::${relationName}::aggregate::${argsKey}`;

        const loader = getOrCreateLoader(context, loaderKey, async (parentIds: readonly any[]) => {
          // Loaders are cached per context, so the whole batch shares this request's executor.
          const executor = resolveExecutor(db, context);
          const uniqueIds = [...new Set(parentIds)];
          // An aggregate over a relation counts the same rows the relation itself returns,
          // so it is narrowed by the target table's scope too.
          const whereCondition = withScope(
            resolveScope(policies, context, filterCtx),
            targetTableName,
            targetTable,
            and(
              inArray(foreignCol, uniqueIds),
              whereArg
                ? extractFilters(targetTable, targetTableName, whereArg, relationFilterCtx(filterCtx, targetTableName))
                : undefined,
            ),
            deleted ?? defaultDeleted,
          );

          const rows: any[] = await executor
            .select({ [GROUP_KEY]: foreignCol, ...request.selection })
            .from(targetTable)
            .where(whereCondition)
            .groupBy(foreignCol);

          const byKey = new Map(rows.map((row) => [row[GROUP_KEY], row]));

          // A parent with no matching rows produces no group — hand back an empty row so it
          // assembles to count 0 / null aggregates rather than dropping the field.
          return parentIds.map((id) => byKey.get(id) ?? {});
        });

        return assembleAggregateRow(await loader.load(localValue), request, target);
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    };

    return { type, resolve };
  };
};

// ── group by ──────────────────────────────────────────────────────────────────

/** Alias prefix for grouped columns, kept clear of the `${op}__${column}` aggregate aliases. */
const GROUP_COL = `group${SEP}`;

/** Comparison operators a `having` clause can apply to an aggregated value. */
const HAVING_OPS = { eq, ne, gt, gte, lt, lte } as const;

/**
 * Columns a query can group on. Grouping needs an equality operator, which is the same
 * requirement min/max has, plus booleans — orderable excludes them because a min/max over
 * true/false says nothing, but `GROUP BY isConfirmed` is perfectly ordinary.
 */
const groupableColumns = (
  table: Table,
  tableName: string,
): Record<string, { column: Column; converted: ConvertedColumn }> => {
  const { orderable } = classifyAggregateColumns(table, tableName);
  const groupable: Record<string, { column: Column; converted: ConvertedColumn }> = { ...orderable };

  for (const [columnName, column] of Object.entries(visibleColumns(table))) {
    if (groupable[columnName]) {
      continue;
    }
    const { type: dataType } = extractExtendedColumnType(column);
    if (dataType !== 'boolean') {
      continue;
    }
    groupable[columnName] = {
      column,
      converted: drizzleColumnToGraphQLType(column, columnName, tableName, true, false, false),
    };
  }

  return groupable;
};

/** The `${typeName}GroupByColumn` enum listing what a group-by query can group on. */
export const generateGroupByEnum = (
  table: Table,
  tableName: string,
  typeName: string,
  cacheCtx?: TypeCacheCtx,
): GraphQLEnumType | undefined => {
  const groupable = groupableColumns(table, tableName);
  const defaultName = `${typeName}GroupByColumn`;

  return generateColumnEnum(
    table,
    cacheCtx?.typeName({ kind: 'columnEnum', defaultName, table: tableName, operation: 'groupBy' }) ?? defaultName,
    `Columns of ${typeName} that a query can group by`,
    (_column, columnName) => Boolean(groupable[columnName]),
  );
};

/** Shared by every `having` clause, so it is created once per name rather than per table. */
export const aggregateNumberFilterType = (typeName: TypeNameResolver): GraphQLInputObjectType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'AggregateNumberFilter' },
    (name) =>
      new GraphQLInputObjectType({
        name,
        description: 'Compares an aggregated value. Several operators in one filter are ANDed together.',
        fields: Object.fromEntries(Object.keys(HAVING_OPS).map((op) => [op, { type: GraphQLFloat }])),
      }),
  );

/**
 * The `${typeName}Having` input: one entry per aggregate the group-by query can filter on.
 * Several entries are ANDed together, as are several operators within one entry.
 *
 * `min`/`max` are limited to numeric columns here even though the output type computes them
 * for every orderable column — the comparison is numeric, so a min over a text column has
 * nothing to compare against.
 */
export const generateHavingInput = (
  table: Table,
  tableName: string,
  typeName: string,
  cacheCtx?: TypeCacheCtx,
): GraphQLInputObjectType => {
  const { numeric, orderable, all } = classifyAggregateColumns(table, tableName);
  const resolveName = cacheCtx?.typeName ?? ((info: GeneratedTypeInfo) => info.defaultName);
  const numberFilter = aggregateNumberFilterType(resolveName);

  const fields: Record<string, { type: any; description?: string }> = {
    count: { type: numberFilter, description: 'Filters groups by how many rows they contain' },
  };

  const opColumns: Record<string, Record<string, unknown>> = {
    avg: numeric,
    sum: numeric,
    min: numeric,
    max: numeric,
    countNonNull: all,
    countDistinct: orderable,
  };

  for (const [op, columns] of Object.entries(opColumns)) {
    const columnNames = Object.keys(columns);
    if (!columnNames.length) {
      continue;
    }
    fields[op] = {
      type: new GraphQLInputObjectType({
        name: resolveName({
          kind: 'having',
          defaultName: `${typeName}${capitalize(op)}Having`,
          table: tableName,
          operation: op,
        }),
        fields: Object.fromEntries(columnNames.map((columnName) => [columnName, { type: numberFilter }])),
      }),
    };
  }

  return new GraphQLInputObjectType({
    name: resolveName({ kind: 'having', defaultName: `${typeName}Having`, table: tableName }),
    description: `Filters ${typeName} groups by their aggregated values`,
    fields,
  });
};

/**
 * The `${typeName}GroupBy` output type: the grouped columns under `group`, alongside the same
 * aggregate fields the `${typeName}Aggregate` type carries — the wrapper types are the very
 * same instances, so the schema holds one `${typeName}AvgAggregate` however it is reached.
 *
 * The keys are nested rather than spread across the top level so a column called `count`,
 * `avg` or `min` cannot collide with the aggregate it sits next to.
 */
export const generateGroupByType = (
  table: Table,
  tableName: string,
  typeName: string,
  cacheCtx?: TypeCacheCtx,
): GraphQLObjectType | undefined => {
  const groupable = groupableColumns(table, tableName);
  if (!Object.keys(groupable).length) {
    return undefined;
  }

  const keysType = new GraphQLObjectType({
    name:
      cacheCtx?.typeName({ kind: 'groupKeys', defaultName: `${typeName}GroupKeys`, table: tableName }) ??
      `${typeName}GroupKeys`,
    description: `The grouped column values of one ${typeName} group. A column the query did not group by is null.`,
    fields: Object.fromEntries(
      Object.entries(groupable).map(([columnName, { column, converted }]) => [
        columnName,
        { type: converted.type, ...columnDocs(cacheCtx?.docs ?? {}, column, tableName, columnName) },
      ]),
    ),
  });

  const aggregateType = generateAggregateTypes(table, tableName, typeName, cacheCtx);
  const aggregateFields = Object.fromEntries(
    Object.values(aggregateType.getFields()).map((field) => [
      field.name,
      { type: field.type, description: field.description ?? undefined },
    ]),
  );

  return new GraphQLObjectType({
    name:
      cacheCtx?.typeName({ kind: 'groupBy', defaultName: `${typeName}GroupBy`, table: tableName }) ??
      `${typeName}GroupBy`,
    fields: { group: { type: new GraphQLNonNull(keysType) }, ...aggregateFields },
  });
};

/** Turns one `${typeName}Having` entry into SQL conditions over the matching aggregate expression. */
const havingComparisons = (expression: any, filter: Record<string, any>): any[] =>
  Object.entries(filter)
    .filter(([op, value]) => value != null && op in HAVING_OPS)
    .map(([op, value]) => HAVING_OPS[op as keyof typeof HAVING_OPS](expression, value));

const buildHavingCondition = (having: Record<string, any> | undefined, columns: Record<string, Column>) => {
  if (!having) {
    return undefined;
  }

  const conditions: any[] = [];

  for (const [key, value] of Object.entries(having)) {
    if (value == null) {
      continue;
    }
    if (key === 'count') {
      conditions.push(...havingComparisons(count(), value));
      continue;
    }
    if (!AGGREGATE_OPS.includes(key as AggregateOp)) {
      continue;
    }
    for (const [columnName, filter] of Object.entries(value as Record<string, any>)) {
      const column = columns[columnName];
      if (!column || filter == null) {
        continue;
      }
      conditions.push(...havingComparisons(OP_FNS[key as AggregateOp](column), filter));
    }
  }

  return conditions.length ? and(...conditions) : undefined;
};

/**
 * Creates the resolver for a table's `<plural>GroupBy` query: the same aggregates the
 * `<plural>Aggregate` query computes, but one row per distinct combination of the requested
 * columns, optionally filtered on the aggregated values with `having`.
 *
 * Shared by all three dialects — `SELECT <keys>, <aggregates> FROM t WHERE … GROUP BY <keys>
 * HAVING …` is the same everywhere.
 */
export const generateGroupBy = (
  db: any,
  tableName: string,
  table: Table,
  typeName: string,
  fieldName: string,
  filterArgs: GraphQLInputObjectType,
  groupByEnum: GraphQLEnumType,
  havingInput: GraphQLInputObjectType,
  filterCtx?: RelationFilterBase,
  policies?: TablePolicies,
  resolveName?: TypeNameResolver,
): CreatedResolver => {
  const target = aggregateTarget(table, tableName, typeName, resolveName);
  const groupable = groupableColumns(table, tableName);
  const columns = getColumns(table);
  const rootTypeName =
    resolveName?.({ kind: 'groupBy', defaultName: `${typeName}GroupBy`, table: tableName }) ?? `${typeName}GroupBy`;
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'groupBy', field: fieldName };

  const queryArgs = {
    groupBy: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(groupByEnum))),
      description: 'Columns to group by. One result row per distinct combination of their values.',
    },
    where: { type: filterArgs, description: 'Filters the rows before they are grouped.' },
    having: { type: havingInput, description: 'Filters the groups after they are aggregated.' },
    ...deletedArg(policies?.softDelete, tableName, resolveName),
  };

  return {
    name: fieldName,
    resolver: async (
      _source,
      args: { groupBy?: string[]; where?: Filters<Table>; having?: Record<string, any>; deleted?: DeletedMode },
      context,
      info,
    ) => {
      try {
        const requestedKeys = [...new Set(args.groupBy ?? [])];
        if (!requestedKeys.length) {
          throw drizzleError('At least one column to group by is required!', {
            code: 'DRIZZLE_INVALID_GROUP_BY',
          });
        }

        const keyColumns = requestedKeys.map((columnName) => {
          const groupableColumn = groupable[columnName];
          if (!groupableColumn) {
            throw drizzleError(`Cannot group ${typeName} by ${columnName}!`, {
              code: 'DRIZZLE_INVALID_GROUP_BY',
            });
          }
          return [columnName, groupableColumn.column] as const;
        });

        const request = parseAggregateRequest(info, target, rootTypeName);
        const selection = {
          ...Object.fromEntries(keyColumns.map(([columnName, column]) => [`${GROUP_COL}${columnName}`, column])),
          ...request.selection,
        };

        let query = resolveExecutor(db, context).select(selection).from(table);
        const where = withScope(
          resolveScope(policies, context, filterCtx),
          tableName,
          table,
          args.where
            ? extractFilters(table, tableName, args.where, relationFilterCtx(filterCtx, tableName))
            : undefined,
          args.deleted,
        );
        if (where) {
          query = query.where(where);
        }
        query = query.groupBy(...keyColumns.map(([, column]) => column));

        const havingCondition = buildHavingCondition(args.having, columns);
        if (havingCondition) {
          query = query.having(havingCondition);
        }

        const rows: any[] = await query;

        return rows.map((row) => {
          const group: Record<string, any> = {};
          for (const [columnName, column] of keyColumns) {
            const value = row[`${GROUP_COL}${columnName}`];
            const decoded =
              typeof value === 'string' && target.dateTimeColumns.has(columnName) ? parseDriverDateTime(value) : value;
            group[columnName] = value == null ? null : remapToGraphQLCore(columnName, decoded, tableName, column);
          }

          return { group, ...assembleAggregateRow(row, request, target) };
        });
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};
