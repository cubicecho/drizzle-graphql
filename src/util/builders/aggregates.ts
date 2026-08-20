// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import { avg, type Column, count, extractExtendedColumnType, getColumns, max, min, sum, type Table } from 'drizzle-orm';
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
import { capitalize } from '../case-ops/index.ts';
import { remapToGraphQLCore } from '../data-mappers/index.ts';
import { drizzleColumnToGraphQLType } from '../type-converter/index.ts';
import type { ConvertedColumn } from '../type-converter/types.ts';
import { extractFilters, type RelationFilterBase, relationFilterCtx, toGraphQLError } from './common.ts';
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
export const generateAggregateTypes = (table: Table, tableName: string, typeName: string): GraphQLObjectType => {
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

  return new GraphQLObjectType({
    name: `${typeName}Aggregate`,
    fields,
  });
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
  const aggregateTypeName = `${typeName}Aggregate`;
  const columns = getColumns(table);
  // Columns whose GraphQL output is DateTime — their min/max may need string→Date coercion.
  const { orderable } = classifyAggregateColumns(table, tableName);
  const dateTimeColumns = new Set(
    Object.entries(orderable)
      .filter(([, { converted }]) => converted.description === 'DateTime')
      .map(([columnName]) => columnName),
  );

  const queryArgs = {
    where: { type: filterArgs },
  };

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table> }, _context, info) => {
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const selectionTree = parsedInfo.fieldsByTypeName[aggregateTypeName] ?? {};

        const selection: Record<string, any> = {};
        // Which ops (and which columns per op) the client asked for — drives result assembly.
        const requested: { count: boolean; ops: Record<AggregateOp, string[]> } = {
          count: false,
          ops: { avg: [], sum: [], min: [], max: [] },
        };

        // Keys are aliases; `field.name` is the real field. Duplicate selections of the same
        // field under different aliases collapse into one SQL expression — graphql-js resolves
        // every alias from the same result property.
        for (const field of Object.values(selectionTree) as ResolveTree[]) {
          if (field.name === 'count') {
            requested.count = true;
            selection.count = count();
            continue;
          }

          if (!AGGREGATE_OPS.includes(field.name as AggregateOp)) {
            continue;
          }
          const op = field.name as AggregateOp;
          const subTree = field.fieldsByTypeName[`${typeName}${capitalize(op)}Aggregate`];
          if (!subTree) {
            continue;
          }

          for (const subField of Object.values(subTree) as ResolveTree[]) {
            const columnName = subField.name;
            const column = columns[columnName];
            if (!column || requested.ops[op].includes(columnName)) {
              continue;
            }
            requested.ops[op].push(columnName);
            selection[`${op}${SEP}${columnName}`] = OP_FNS[op](column);
          }
        }

        // Only __typename (or empty sub-selections) requested — nothing to run.
        if (!Object.keys(selection).length) {
          return {};
        }

        let query = db.select(selection).from(table);
        if (args.where) {
          query = query.where(extractFilters(table, tableName, args.where, relationFilterCtx(filterCtx, tableName)));
        }
        const rows = await query;
        const row = rows[0] ?? {};

        const result: Record<string, any> = {};
        if (requested.count) {
          // drizzle's count() maps to number already; guard for drivers returning strings.
          result.count = row.count == null ? 0 : Number(row.count);
        }
        for (const op of AGGREGATE_OPS) {
          if (!requested.ops[op].length) {
            continue;
          }
          const opResult: Record<string, any> = {};
          for (const columnName of requested.ops[op]) {
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
              const column = columns[columnName];
              const decoded =
                typeof value === 'string' && dateTimeColumns.has(columnName) ? parseDriverDateTime(value) : value;
              opResult[columnName] = remapToGraphQLCore(columnName, decoded, tableName, column);
            }
          }
          result[op] = opResult;
        }

        return result;
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};
