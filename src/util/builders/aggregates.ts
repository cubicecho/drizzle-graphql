// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import {
  and,
  avg,
  type Column,
  count,
  extractExtendedColumnType,
  getColumns,
  inArray,
  max,
  min,
  sum,
  type Table,
} from 'drizzle-orm';
import {
  GraphQLFloat,
  type GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import { getOrCreateLoader } from '../batch-loader/index.ts';
import { capitalize } from '../case-ops/index.ts';
import { remapToGraphQLCore } from '../data-mappers/index.ts';
import { drizzleColumnToGraphQLType } from '../type-converter/index.ts';
import type { ConvertedColumn } from '../type-converter/types.ts';
import {
  extractFilters,
  extractRelationJoinColumns,
  type RelationAggregateFactory,
  type RelationFilterBase,
  relationFilterCtx,
  resolveTypeName,
  type TypeCacheCtx,
  type TypeNameMapper,
  toGraphQLError,
} from './common.ts';
import type { CreatedResolver, Filters } from './types.ts';

/** Operations that aggregate over a set of column values. `count` is handled separately (whole rows). */
const AGGREGATE_OPS = ['avg', 'sum', 'min', 'max'] as const;
type AggregateOp = (typeof AGGREGATE_OPS)[number];

const OP_FNS: Record<AggregateOp, (col: Column) => any> = { avg, sum, min, max };

/** Separator for flat select aliases (`avg__price`) — reassembled into nested output by the resolver. */
const SEP = '__';

interface AggregateColumnSets {
  /** Columns avg/sum apply to: plain Int/Float scalars. */
  numeric: Record<string, Column>;
  /** Columns min/max apply to: anything with a total ordering the DB supports (numbers, strings, dates, enums). */
  orderable: Record<string, { column: Column; converted: ConvertedColumn }>;
}

/**
 * Classifies a table's columns for aggregation. avg/sum only make sense on numeric scalars;
 * min/max work on any orderable scalar (numbers, strings, bigints, dates, enums). Booleans,
 * arrays (including array-typed number columns), JSON, buffers, and object-shaped columns
 * (e.g. geometry) are excluded entirely.
 */
const classifyAggregateColumns = (table: Table, tableName: string): AggregateColumnSets => {
  const numeric: AggregateColumnSets['numeric'] = {};
  const orderable: AggregateColumnSets['orderable'] = {};

  for (const [columnName, column] of Object.entries(getColumns(table))) {
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

  return { numeric, orderable };
};

/**
 * Builds the `${typeName}Aggregate` output type for a table:
 * - `count: Int!` — number of matching rows
 * - `avg` / `sum` — per numeric column, always nullable Float (SQL returns NULL on empty sets,
 *   and avg/sum of integers overflow Int / produce decimals)
 * - `min` / `max` — per orderable column, the column's own (nullable) scalar type
 * The avg/sum (min/max) wrappers are omitted when no column qualifies.
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

  const { numeric, orderable } = classifyAggregateColumns(table, tableName);

  const fields: Record<string, { type: any }> = {
    count: { type: new GraphQLNonNull(GraphQLInt) },
  };

  if (Object.keys(numeric).length) {
    for (const op of ['avg', 'sum'] as const) {
      fields[op] = {
        type: new GraphQLObjectType({
          name: `${typeName}${capitalize(op)}Aggregate`,
          fields: Object.fromEntries(Object.keys(numeric).map((columnName) => [columnName, { type: GraphQLFloat }])),
        }),
      };
    }
  }

  if (Object.keys(orderable).length) {
    for (const op of ['min', 'max'] as const) {
      fields[op] = {
        type: new GraphQLObjectType({
          name: `${typeName}${capitalize(op)}Aggregate`,
          fields: Object.fromEntries(
            Object.entries(orderable).map(([columnName, { converted }]) => [
              columnName,
              { type: converted.type, description: converted.description },
            ]),
          ),
        }),
      };
    }
  }

  const aggregateType = new GraphQLObjectType({
    name: `${typeName}Aggregate`,
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
  columns: Record<string, Column>;
  /** Columns whose GraphQL output is DateTime — their min/max may need string→Date coercion. */
  dateTimeColumns: Set<string>;
}

const aggregateTarget = (table: Table, tableName: string, typeName: string): AggregateTarget => {
  const { orderable } = classifyAggregateColumns(table, tableName);

  return {
    tableName,
    typeName,
    columns: getColumns(table),
    dateTimeColumns: new Set(
      Object.entries(orderable)
        .filter(([, { converted }]) => converted.description === 'DateTime')
        .map(([columnName]) => columnName),
    ),
  };
};

/**
 * Reads the requested count/avg/sum/min/max selections off the resolve tree and turns them
 * into one drizzle select expression per (op, column) pair. An empty `selection` means the
 * client asked for nothing runnable (`__typename` only, or empty sub-selections).
 */
const parseAggregateRequest = (info: any, target: AggregateTarget): AggregateRequest => {
  const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
  const selectionTree = parsedInfo.fieldsByTypeName[`${target.typeName}Aggregate`] ?? {};

  const request: AggregateRequest = {
    count: false,
    ops: { avg: [], sum: [], min: [], max: [] },
    selection: {},
  };

  // Keys are aliases; `field.name` is the real field. Duplicate selections of the same
  // field under different aliases collapse into one SQL expression — graphql-js resolves
  // every alias from the same result property.
  for (const field of Object.values(selectionTree) as ResolveTree[]) {
    if (field.name === 'count') {
      request.count = true;
      request.selection.count = count();
      continue;
    }

    if (!AGGREGATE_OPS.includes(field.name as AggregateOp)) {
      continue;
    }
    const op = field.name as AggregateOp;
    const subTree = field.fieldsByTypeName[`${target.typeName}${capitalize(op)}Aggregate`];
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
    result.count = row.count == null ? 0 : Number(row.count);
  }

  for (const op of AGGREGATE_OPS) {
    if (!request.ops[op].length) {
      continue;
    }
    const opResult: Record<string, any> = {};
    for (const columnName of request.ops[op]) {
      const value = row[`${op}${SEP}${columnName}`];
      if (value == null) {
        opResult[columnName] = null;
      } else if (op === 'avg' || op === 'sum') {
        // Drivers return numeric/decimal aggregates as strings — coerce to Float.
        opResult[columnName] = Number(value);
      } else {
        // min/max keep the column's own type — drizzle already ran the column's decoder over
        // the value (`min`/`max` are `mapWith(column)`), so all that's left is coercing a
        // leftover raw date string (PG decodes timestamps in driver-level codecs, which raw
        // select expressions bypass) and remapping for GraphQL output.
        const column = target.columns[columnName];
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
): CreatedResolver => {
  const target = aggregateTarget(table, tableName, typeName);

  const queryArgs = {
    where: { type: filterArgs },
  };

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table> }, _context, info) => {
      try {
        const request = parseAggregateRequest(info, target);
        if (!Object.keys(request.selection).length) {
          return {};
        }

        let query = db.select(request.selection).from(table);
        if (args.where) {
          query = query.where(extractFilters(table, tableName, args.where, relationFilterCtx(filterCtx, tableName)));
        }
        const rows = await query;

        return assembleAggregateRow(rows[0] ?? {}, request, target);
      } catch (e) {
        throw toGraphQLError(e);
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

    const targetTypeName = resolveTypeName(targetTableName, typeNameMapper);
    const type = generateAggregateTypes(targetTable, targetTableName, targetTypeName, cacheCtx);
    const target = aggregateTarget(targetTable, targetTableName, targetTypeName);

    const resolve = async (parent: any, args: { where?: Filters<Table> }, context: any, info: any) => {
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
        // Siblings only share a batch when they'd run the same query: same filters, same aggregates.
        const argsKey = JSON.stringify({
          where: whereArg ?? null,
          selection: Object.keys(request.selection).sort(),
        });
        const loaderKey = `${tableName}::${relationName}::aggregate::${argsKey}`;

        const loader = getOrCreateLoader(context, loaderKey, async (parentIds: readonly any[]) => {
          const uniqueIds = [...new Set(parentIds)];
          const whereCondition = and(
            inArray(foreignCol, uniqueIds),
            whereArg
              ? extractFilters(targetTable, targetTableName, whereArg, relationFilterCtx(filterCtx, targetTableName))
              : undefined,
          );

          const rows: any[] = await db
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
        throw toGraphQLError(e);
      }
    };

    return { type, resolve };
  };
};
