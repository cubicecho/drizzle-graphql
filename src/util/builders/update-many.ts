// =============================================================================
// The dialect-independent half of `update<Table>Many`.
//
// PostgreSQL and SQLite build this resolver identically right up to the point
// where the entries actually execute — argument parsing, the per-entry remap
// and validation, the nested-write split, the write hooks, relation
// enrichment and the per-entry output slots are all the same. The two dialects
// differ only in HOW the batch runs inside its transaction, which is what
// {@link UpdateManyBatchRunner} abstracts.
// =============================================================================

import type { Table } from 'drizzle-orm';
import type { GraphQLFieldConfigArgumentMap, GraphQLInputObjectType } from 'graphql';
import { GraphQLError, GraphQLList, GraphQLNonNull } from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import {
  eagerLoadMutationRelations,
  extractFilters,
  type LimitPolicyFor,
  type MutationTxCtx,
  prepareMutationRelationColumns,
  type RelationFilterBase,
  type ResolverPolicies,
  relationFilterCtx,
  runMutation,
  runWriteHook,
  stripContextValues,
  type TypeNameMapper,
  toGraphQLError,
  withScope,
} from '../builders/common.ts';
import { remapToGraphQLSingleOutput } from '../data-mappers/index.ts';
import { remapUpdateInput } from './field-updates.ts';
import { mergedOps, type NestedWriteRuntime } from './nested-writes.ts';
import type { UpdateManyGenerator } from './schema-data.ts';
import type { CreatedResolver, Filters, TableNamedRelations } from './types.ts';

/** One entry of the `updates` argument, already remapped and validated. */
export type UpdateManyEntry = {
  /** Column values to write, context-supplied columns stripped. */
  set: Record<string, any>;
  /** Nested-write operations, or `undefined` when the entry writes columns only. */
  ops: Record<string, any> | undefined;
  /** The entry's `where`, already combined with the row scope. */
  filters: any;
};

/** Everything a batch runner needs; assembled by the shared resolver before the batch opens. */
export type UpdateManyBatchCtx = {
  /** The executor the mutation runs on — `db`, a caller's transaction, or the shared one. */
  executor: any;
  entries: UpdateManyEntry[];
  table: any;
  /** The columns each statement returns, join columns included when nested writes are on. */
  returning: Record<string, any>;
  /** True when at least one entry carries nested-write operations. */
  anyNested: boolean;
  nested: NestedWriteRuntime | undefined;
  tableName: string;
  context: any;
};

/** Runs the entries and returns each one's rows, in entry order. */
export type UpdateManyBatchRunner = (ctx: UpdateManyBatchCtx) => Promise<Record<string, any>[][]>;

/**
 * The batch runner for a dialect whose driver is always asynchronous: one UPDATE per entry,
 * awaited in input order, inside a single transaction. On a caller-supplied transaction — or
 * the shared multi-mutation transaction opened by `runMutation` — this opens a savepoint, so
 * the batch stays atomic without breaking the outer transaction.
 */
export const runUpdateManyBatch: UpdateManyBatchRunner = ({
  executor,
  entries,
  table,
  returning,
  nested,
  tableName,
  context,
}) =>
  executor.transaction(async (tx: any) => {
    const results: Record<string, any>[][] = [];
    for (const entry of entries) {
      const values = entry.ops
        ? { ...entry.set, ...(await nested!.applyParentSide(tx, tableName, entry.ops, context)) }
        : entry.set;

      // Same as the single update: an entry with no column values reads the rows its
      // `where` matched so the nested operations have something to attach to.
      const writes = Object.keys(values).length > 0;
      let query = writes ? tx.update(table).set(values) : tx.select(returning).from(table);
      if (entry.filters) {
        query = query.where(entry.filters) as any;
      }
      const rows = (await (writes ? (query.returning(returning) as any) : query)) as Record<string, any>[];

      if (entry.ops) {
        await nested!.applyChildSide(tx, tableName, entry.ops, rows, context);
      }
      results.push(rows);
    }
    return results;
  });

/**
 * Builds a dialect's `update<Table>Many` generator.
 *
 * `update<Table>Many` is a batch update with a per-entry `set` and `where`. The entries run
 * as one UPDATE statement each, in input order, inside a single transaction (a savepoint when
 * the request context already carries one), so a failing entry rolls the whole batch back and
 * a row matched by several entries sees them applied in order. The result lists each entry's
 * updated rows in entry order, with `null` standing in for an entry whose `where` matched no
 * rows, so the common one-row-per-entry case stays aligned with the input.
 *
 * @param primaryKeyPropNames the dialect's composite-aware primary-key lookup
 * @param runBatch how the entries execute; defaults to {@link runUpdateManyBatch}
 */
export const createUpdateManyGenerator = (
  primaryKeyPropNames: (table: any) => string[],
  runBatch: UpdateManyBatchRunner = runUpdateManyBatch,
): UpdateManyGenerator => {
  return (
    db: any,
    tableName: string,
    table: any,
    tables: Record<string, Table>,
    relationMap: Record<string, Record<string, TableNamedRelations>>,
    updateManyInput: GraphQLInputObjectType,
    fieldName: string,
    typeName: string,
    typeNameMapper?: TypeNameMapper,
    filterCtx?: RelationFilterBase,
    txCtx?: MutationTxCtx,
    nested?: NestedWriteRuntime,
    limits?: LimitPolicyFor,
    policies?: ResolverPolicies,
  ): CreatedResolver => {
    const queryArgs = {
      updates: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateManyInput))),
      },
    } as const satisfies GraphQLFieldConfigArgumentMap;

    // Derived once at build time — PK prop names don't change per request.
    const pkNames = primaryKeyPropNames(table);
    const hooks = policies?.onWrite?.(tableName, 'updateMany');

    return {
      name: fieldName,
      resolver: async (
        _source,
        args: { updates: { where?: Filters<Table>; set: Record<string, any> }[] },
        context,
        info,
      ) => {
        try {
          return await runMutation(
            db,
            context,
            info,
            txCtx,
            async (executor) => {
              const { updates } = args;
              if (!updates.length) {
                throw new GraphQLError('No updates were provided!');
              }
              await runWriteHook(hooks, 'before', {
                table: tableName,
                operation: 'updateMany',
                single: false,
                args,
                context,
                info,
                tx: executor,
              });
              const scope = policies?.scope?.(context);
              const contextColumns = policies?.contextValues?.(tableName);

              const parsedInfo = parseResolveInfo(info, {
                deep: true,
              }) as ResolveTree;

              const { columns, hasRelations, withParams } = prepareMutationRelationColumns({
                relationMap,
                tables,
                tableName,
                typeName,
                typeNameMapper,
                table,
                pkNames,
                parsedInfo,
                limits,
                scope,
                defaultOrderBy: policies?.defaultOrderBy,
              });

              // Remap and validate every entry before the transaction opens, so a malformed
              // entry rejects the request instead of rolling back mid-batch.
              const entries: UpdateManyEntry[] = updates.map(({ where, set }) => {
                const split = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
                const ops = split && nested!.hasOps(split.ops) ? split.ops : undefined;
                const input = stripContextValues(
                  remapUpdateInput(split ? split.columns : set, table, tableName),
                  contextColumns,
                );
                // An entry that only writes through a relation still has work to do.
                if (!Object.keys(input).length && !ops) {
                  throw new GraphQLError('Unable to update with no values specified!');
                }
                return {
                  set: input,
                  ops,
                  filters: withScope(
                    scope,
                    tableName,
                    table,
                    where
                      ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName))
                      : undefined,
                  ),
                };
              });

              const anyNested = entries.some((entry) => entry.ops);
              const returning = anyNested
                ? nested!.withJoinColumns(
                    tableName,
                    mergedOps(entries.map((entry) => ({ ops: entry.ops ?? {} }))),
                    { ...columns },
                    table,
                  )
                : columns;

              const perEntry = await runBatch({
                executor,
                entries,
                table,
                returning,
                anyNested,
                nested,
                tableName,
                context,
              });

              const flatRows = perEntry.flat();
              await runWriteHook(hooks, 'after', {
                table: tableName,
                operation: 'updateMany',
                single: false,
                args,
                rows: flatRows,
                context,
                info,
                tx: executor,
              });

              const enriched = hasRelations
                ? await eagerLoadMutationRelations(executor, tableName, flatRows, pkNames, withParams)
                : flatRows;

              // Rebuild the per-entry slots: a no-match entry contributes `null`, a multi-match
              // entry contributes each of its rows.
              const output: (Record<string, any> | null)[] = [];
              let offset = 0;
              for (const rows of perEntry) {
                if (!rows.length) {
                  output.push(null);
                  continue;
                }
                for (let i = 0; i < rows.length; i++) {
                  output.push(remapToGraphQLSingleOutput(enriched[offset + i], tableName, table, relationMap));
                }
                offset += rows.length;
              }
              return output;
            },
            !!hooks,
          );
        } catch (e) {
          throw toGraphQLError(e);
        }
      },
      args: queryArgs,
    };
  };
};
