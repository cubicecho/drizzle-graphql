// Pieces the generated mutations share: the relation columns a write has to prepare, the batch
// update's input type, the filters a write requires, and the write-count return type.

import type { Column, Table } from 'drizzle-orm';
import { type SQL, sql } from 'drizzle-orm';
import type { GraphQLFieldConfigArgumentMap } from 'graphql';
import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { capitalize } from '../../case-ops/index.ts';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import { remapUpdateInput } from '../field-updates.ts';
// Type-only: the nested-write module imports this one at runtime, so the dependency has to
// stay one-directional. The implementation is injected by the dialect builder.
import type { NestedWriteRuntime } from '../nested-writes.ts';
import type { CreatedResolver, Filters, ProcessedTableSelectArgs, TableNamedRelations } from '../types.ts';
import { type DrizzleErrorContext, drizzleError, toGraphQLError, withErrorContext } from './errors.ts';
import { withPrimaryKeyColumns } from './keys.ts';
import type { DefaultOrderByFor, LimitPolicyFor } from './limits.ts';
import type { TypeNameMapper } from './naming.ts';
import { resolveObjectTypeName } from './naming.ts';
import type { ScopeResolver } from './policies.ts';
import type { RelationFilterBase, RelationFilterContext } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import { extractRelationsParams } from './relation-params.ts';
import { extractSelectedColumnsFromTreeSQLFormat } from './selected-columns.ts';
import type { MutationTxCtx } from './transactions.ts';
import { runMutation } from './transactions.ts';
import type { TypeCacheCtx } from './type-cache.ts';
import type { TypeNameResolver } from './type-names.ts';

/**
 * The `hard` argument on the delete mutations of a soft-deleting table that opted into
 * `hardDelete`. One config shared by every such field — argument configs carry no per-field
 * state — and generated nowhere else, so the schema says which tables can be purged.
 */
export const hardDeleteArg = {
  type: GraphQLBoolean,
  defaultValue: false,
  description:
    'Remove the matched rows instead of marking them deleted. Reads at `INCLUDE`, so it reaches rows that are already marked; a `scope` still confines what it can reach.',
} as const;

/**
 * Computes the RETURNING columns and relation selection for a mutation resolver: extracts
 * the selected scalar columns, determines whether any relations were selected, and only
 * then forces the primary key into the column set (so the post-mutation eager-load can
 * re-key rows). Returns everything the resolver needs to decide whether to eager-load.
 */
export const prepareMutationRelationColumns = (params: {
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  tables: Record<string, Table>;
  tableName: string;
  typeName: string;
  typeNameMapper: TypeNameMapper | undefined;
  table: Table;
  pkNames: readonly string[];
  parsedInfo: ResolveTree;
  limits?: LimitPolicyFor;
  scope?: ScopeResolver;
  defaultOrderBy?: DefaultOrderByFor;
  /** The build's type-naming rule — the selection tree is keyed by the name it produced. */
  resolveName?: TypeNameResolver;
}): {
  columns: Record<string, Column>;
  hasRelations: boolean;
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined;
} => {
  const { relationMap, tables, tableName, typeNameMapper, table, pkNames, parsedInfo, resolveName } = params;
  const typeName = resolveObjectTypeName(tableName, typeNameMapper, resolveName);
  const withParams = relationMap[tableName]
    ? extractRelationsParams(relationMap, tables, tableName, parsedInfo, typeName, {
        typeNameMapper,
        limits: params.limits,
        scope: params.scope,
        defaultOrderBy: params.defaultOrderBy,
        resolveName,
      })
    : undefined;
  const hasRelations = !!(withParams && Object.keys(withParams).length);
  const baseColumns = extractSelectedColumnsFromTreeSQLFormat(parsedInfo.fieldsByTypeName[typeName]!, table, {
    tableName,
    relationMap,
    tables,
  });
  const columns = hasRelations ? withPrimaryKeyColumns(baseColumns, table, pkNames) : baseColumns;
  return { columns, hasRelations, withParams };
};

/**
 * The per-entry input of `update<Table>Many`: `{ where, set }`, reusing the table's
 * update `set` input and filter input. Shared by all three dialect builders.
 */
export const generateUpdateManyInput = (params: {
  tableName: string;
  typeName: string;
  updatePrefix: string;
  updateInput: GraphQLInputObjectType;
  tableFilters: GraphQLInputObjectType;
  cacheCtx: TypeCacheCtx;
}): GraphQLInputObjectType => {
  const { tableName, typeName, updatePrefix, updateInput, tableFilters, cacheCtx } = params;
  return new GraphQLInputObjectType({
    name: cacheCtx.typeName({
      kind: 'updateManyInput',
      defaultName: `${capitalize(updatePrefix)}${typeName}ManyInput`,
      table: tableName,
    }),
    description: `One entry of a batch update of ${typeName}: the rows \`where\` matches get this entry's \`set\` applied.`,
    fields: {
      where: {
        type: tableFilters,
        description: 'Rows this entry updates. An omitted filter updates every row.',
      },
      set: {
        type: new GraphQLNonNull(updateInput),
      },
    },
  });
};

/**
 * Extracts a `where` argument that a mutation refuses to run without: missing, or present
 * but matching every row (e.g. `where: {}` or filters that all collapse to nothing), both
 * throw instead of becoming an unbounded write. Used by the `Single` write variants always
 * and by the plural update/delete mutations when `features.requireWhere` is on.
 */
export const extractRequiredFilters = <TTable extends Table>(
  table: TTable,
  tableName: string,
  where: Filters<TTable> | undefined,
  relationCtx?: RelationFilterContext,
): SQL => {
  const filters = where ? extractFilters(table, tableName, where, relationCtx) : undefined;
  if (!filters) {
    throw drizzleError(
      "A 'where' argument with at least one filter is required — this mutation does not run unbounded.",
      { code: 'DRIZZLE_WHERE_REQUIRED' },
    );
  }
  return filters;
};

/**
 * How many rows a returnless write reported affecting. The three dialects' drivers each
 * spell it differently — `rowCount` (node-postgres, Neon), `affectedRows` (PGlite, and MySQL
 * on its result header), `count` (postgres.js), `rowsAffected` (libsql), `changes`
 * (better-sqlite3) — and none of them is reachable through a common drizzle type, so the
 * shape is probed rather than declared.
 *
 * Only the result object itself is read, plus `affectedRows` one level in, since MySQL
 * returns `[header, fields]`. A row of the table is never inspected, so a table with a
 * column named `count` cannot be mistaken for a count.
 */
export const rowsAffected = (result: any): number => {
  const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : undefined;

  if (result && typeof result === 'object') {
    for (const key of ['rowCount', 'affectedRows', 'rowsAffected', 'changes', 'count']) {
      const value = asNumber((result as any)[key]);
      if (value !== undefined) {
        return value;
      }
    }
    const header = Array.isArray(result) ? result[0] : undefined;
    const affected = header && typeof header === 'object' ? asNumber(header.affectedRows) : undefined;
    if (affected !== undefined) {
      return affected;
    }
  }

  throw drizzleError('The driver did not report how many rows the write affected.', {
    code: 'DRIZZLE_ROW_COUNT_UNAVAILABLE',
  });
};

/**
 * Guard for the `Single` write variants: throws before anything is written when `where`
 * matches more than one row, so a multi-row update/delete never executes. Probed with a
 * `LIMIT 2` select rather than a count so the check stays cheap on large matches.
 */
export const assertSingleMatch = async (executor: any, table: Table, filters: SQL): Promise<void> => {
  const matched = await executor.select({ found: sql`1` }).from(table).where(filters).limit(2);
  if (matched.length > 1) {
    throw drizzleError("'where' matched more than one row — nothing was written!", {
      code: 'DRIZZLE_MULTI_ROW_MATCH',
    });
  }
};

/**
 * `update<Tables>Count` / `delete<Tables>Count` — the plural write without the payload
 * (`features.countMutations`).
 *
 * The plural `update` and `delete` always `RETURNING *`, which is the wrong shape for
 * "archive everything older than a year": the caller pays to ship rows it does not want, and
 * on a large match that cost is the whole mutation. These return `Int!` instead — how many
 * rows the write touched, as the driver reported it, with no RETURNING clause at all.
 *
 * Dialect-independent: drizzle's update/delete builders take the same calls everywhere, and
 * the drivers' disagreement about how to spell the row count is handled by
 * {@link rowsAffected}.
 */
export const generateWriteCount = ({
  db,
  tableName,
  table,
  kind,
  setArgs,
  filterArgs,
  fieldName,
  requireWhere,
  filterCtx,
  txCtx,
  nested,
}: {
  db: any;
  tableName: string;
  table: Table;
  kind: 'update' | 'delete';
  /** The update `set` input; omitted for the delete variant, which has nothing to set. */
  setArgs?: GraphQLInputObjectType;
  filterArgs: GraphQLInputObjectType;
  fieldName: string;
  requireWhere: boolean;
  filterCtx?: RelationFilterBase;
  txCtx?: MutationTxCtx;
  nested?: NestedWriteRuntime;
}): CreatedResolver => {
  const queryArgs = {
    ...(setArgs ? { set: { type: new GraphQLNonNull(setArgs) } } : {}),
    where: {
      type: requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
    },
  } as GraphQLFieldConfigArgumentMap;

  const errorCtx: DrizzleErrorContext = { table: tableName, operation: kind, field: fieldName };

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: any; set?: Record<string, any> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const { where, set } = args;

          const relationCtx = relationFilterCtx(filterCtx, tableName);
          const filters = requireWhere
            ? extractRequiredFilters(table, tableName, where, relationCtx)
            : where
              ? extractFilters(table, tableName, where, relationCtx)
              : undefined;

          let query: any;
          if (kind === 'delete') {
            query = executor.delete(table);
          } else {
            // Nested writes need the parent rows they attach to, which is exactly what this
            // mutation exists not to fetch — so they are refused rather than silently dropped.
            const entry = nested?.enabled(tableName) ? nested.split(tableName, set!) : undefined;
            if (entry && nested!.hasOps(entry.ops)) {
              throw drizzleError(
                'This mutation does not support nested writes — use the one that returns the rows instead.',
                { code: 'DRIZZLE_NESTED_WRITES_UNSUPPORTED' },
              );
            }
            const values = remapUpdateInput(entry ? entry.columns : set!, table, tableName);
            if (!Object.keys(values).length) {
              throw drizzleError('Unable to update with no values specified!', {
                code: 'DRIZZLE_NO_VALUES',
              });
            }
            query = executor.update(table).set(values);
          }

          if (filters) {
            query = query.where(filters);
          }

          return rowsAffected(await query);
        });
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};
