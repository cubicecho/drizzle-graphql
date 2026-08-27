import type { Table } from 'drizzle-orm';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import { type BaseSQLiteDatabase, getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { GraphQLFieldConfigArgumentMap, GraphQLResolveInfo } from 'graphql';
import { GraphQLError, type GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';

import type { GeneratedEntities } from '../../types.ts';
import {
  applyLimitPolicy,
  eagerLoadMutationRelations,
  extractFilters,
  generateDistinctEnum,
  getPrimaryKeyPropNamesFromConfig,
  type LimitPolicyFor,
  type MutationTxCtx,
  prepareMutationRelationColumns,
  type RelationFilterBase,
  type ResolverPolicies,
  relationFilterCtx,
  resolveQueryExecutor,
  runMutation,
  runRelationalSelect,
  runWriteHook,
  selectArrayArgs,
  selectSingleArgs,
  stripContextValues,
  type TablesRelationalConfig,
  type TypeNameMapper,
  toGraphQLError,
  withDefaultOrderBy,
  withScope,
} from '../builders/common.ts';
import { remapToGraphQLSingleOutput } from '../data-mappers/index.ts';
import { remapUpdateInput } from './field-updates.ts';
import { mergedOps, type NestedWriteRuntime } from './nested-writes.ts';
import { createSchemaDataGenerator } from './schema-data.ts';
import type {
  CreatedResolver,
  Filters,
  SchemaGeneratorOptions,
  TableNamedRelations,
  TableSelectArgs,
} from './types.ts';

const generateSelectArray = (
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  distinctEnabled: boolean = true,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryBase = db.query[tableName as keyof typeof db.query & string] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  if (!queryBase) {
    throw new Error(
      `Drizzle-GraphQL Error: Table ${tableName} not found in drizzle instance. Did you forget to pass schema to drizzle constructor?`,
    );
  }

  const table = tables[tableName]!;
  const limitPolicy = limits?.(tableName);
  const pkNames = sqlitePrimaryKeyPropNames(table as SQLiteTable);
  const queryArgs = selectArrayArgs(
    orderArgs,
    filterArgs,
    distinctEnabled ? generateDistinctEnum(table, typeName) : undefined,
    policies?.softDelete,
    tableName,
  );

  return {
    name: fieldName,
    resolver: async (_source: any, rawArgs: Partial<TableSelectArgs>, context: any, info: GraphQLResolveInfo) => {
      // An omitted `orderBy` falls back to the table's configured default ordering here,
      // before anything reads the arguments — the cursor tuple, a `distinct` pass and the
      // plain-select fallback all have to agree on one effective ordering.
      const args = withDefaultOrderBy(rawArgs, tableName, policies?.defaultOrderBy);
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
        return await runRelationalSelect({
          queryBase: requestQueryBase,
          tables,
          tableName,
          table,
          relationMap,
          typeName,
          typeNameMapper,
          parsedInfo,
          ...args,
          limit: applyLimitPolicy(args.limit, limitPolicy, fieldName),
          single: false,
          filterCtx,
          limits,
          defaultOrderBy: policies?.defaultOrderBy,
          pkNames,
          db: executor,
          scope: policies?.scope?.(context),
          // SQLite sorts NULLs as the smallest values (first in ASC).
          nullOrdering: 'nulls-smallest',
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateSelectSingle = (
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryBase = db.query[tableName as keyof typeof db.query & string] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  if (!queryBase) {
    throw new Error(
      `Drizzle-GraphQL Error: Table ${tableName} not found in drizzle instance. Did you forget to pass schema to drizzle constructor?`,
    );
  }

  const queryArgs = selectSingleArgs(orderArgs, filterArgs, policies?.softDelete, tableName);

  const table = tables[tableName]!;
  const pkNames = sqlitePrimaryKeyPropNames(table as SQLiteTable);

  return {
    name: fieldName,
    resolver: async (_source, rawArgs: Partial<TableSelectArgs>, context, info) => {
      // An omitted `orderBy` falls back to the table's configured default ordering here,
      // before anything reads the arguments — the cursor tuple, a `distinct` pass and the
      // plain-select fallback all have to agree on one effective ordering.
      const args = withDefaultOrderBy(rawArgs, tableName, policies?.defaultOrderBy);
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
        return await runRelationalSelect({
          queryBase: requestQueryBase,
          tables,
          tableName,
          table,
          relationMap,
          typeName,
          typeNameMapper,
          parsedInfo,
          ...args,
          single: true,
          filterCtx,
          limits,
          defaultOrderBy: policies?.defaultOrderBy,
          pkNames,
          db: executor,
          scope: policies?.scope?.(context),
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/** Primary-key property names for a SQLite table, including table-level composite keys. */
const sqlitePrimaryKeyPropNames = (table: SQLiteTable): string[] =>
  getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

/**
 * `update<Table>Many` — batch update with a per-entry `set` and `where`.
 *
 * The entries run as one UPDATE statement each, in input order, inside a single
 * transaction (a savepoint when the request context already carries one), so a failing
 * entry rolls the whole batch back and a row matched by several entries sees them applied
 * in order. The result lists each entry's updated rows in entry order, with `null`
 * standing in for an entry whose `where` matched no rows, so the common one-row-per-entry
 * case stays aligned with the input.
 */
const generateUpdateMany = (
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
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
  const pkNames = sqlitePrimaryKeyPropNames(table);

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
            const entries = updates.map(({ where, set }) => {
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
                  where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
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

            const runEntry = (tx: any, entry: (typeof entries)[number]) => {
              let query = tx.update(table).set(entry.set);
              if (entry.filters) {
                query = query.where(entry.filters);
              }
              // `.all()` instead of awaiting the thenable: a sync driver (better-sqlite3)
              // executes it immediately, which is the only way the statement still runs
              // inside the synchronous native transaction below.
              return query.returning(returning).all();
            };

            // Nested writes need statements interleaved with awaited reads, which only an async
            // driver can do inside a transaction — `features.nestedWrites` rejects a sync driver
            // at build time, so this branch is always on one.
            const runNestedEntry = async (tx: any, entry: (typeof entries)[number]) => {
              const values = entry.ops
                ? { ...entry.set, ...(await nested!.applyParentSide(tx, tableName, entry.ops, context)) }
                : entry.set;

              // Same as the single update: an entry with no column values reads the rows its
              // `where` matched so the nested operations have something to attach to.
              const writes = Object.keys(values).length > 0;
              let query = writes ? tx.update(table).set(values) : tx.select(returning).from(table);
              if (entry.filters) {
                query = query.where(entry.filters);
              }
              const rows = (await (writes ? query.returning(returning) : query)) as Record<string, any>[];

              if (entry.ops) {
                await nested!.applyChildSide(tx, tableName, entry.ops, rows, context);
              }
              return rows;
            };

            // On a caller-supplied transaction — or the shared multi-mutation transaction
            // opened by `runMutation` — this opens a savepoint, so the batch stays atomic
            // without breaking the outer transaction. A sync driver's transaction callback
            // must not be async — it would commit before any awaited statement ran — so the
            // driver kind is probed from the first statement's result instead.
            const perEntry: Record<string, any>[][] = await executor.transaction((tx: any) => {
              if (anyNested) {
                return (async () => {
                  const results: Record<string, any>[][] = [];
                  for (const entry of entries) {
                    results.push(await runNestedEntry(tx, entry));
                  }
                  return results;
                })();
              }

              const first = runEntry(tx, entries[0]!);
              if (typeof (first as any)?.then === 'function') {
                // Async driver: await sequentially so the entries apply in input order.
                return (async () => {
                  const results: Record<string, any>[][] = [await first];
                  for (let i = 1; i < entries.length; i++) {
                    results.push(await runEntry(tx, entries[i]!));
                  }
                  return results;
                })();
              }
              const results: Record<string, any>[][] = [first];
              for (let i = 1; i < entries.length; i++) {
                results.push(runEntry(tx, entries[i]!));
              }
              return results;
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

const sqliteSchemaData = createSchemaDataGenerator({
  tableClass: SQLiteTable,
  getTableConfig,
  primaryKeyPropNames: sqlitePrimaryKeyPropNames,
  // SQLite sorts NULLs as the smallest values (first in ASC).
  nullOrdering: 'nulls-smallest',
  // A synchronous driver (e.g. better-sqlite3) commits the moment its transaction callback
  // returns, so it can neither interleave awaited statements inside one transaction nor hold
  // one open across resolver calls — which is what both of these features require.
  preflight: (db, options) => {
    if (options.features.nestedWrites && (db as any).resultKind === 'sync') {
      throw new Error(
        'Drizzle-GraphQL Error: features.nestedWrites requires an asynchronous SQLite driver (e.g. libsql). Synchronous drivers cannot run the multi-statement transaction a nested write needs.',
      );
    }
    if (options.transactions && (db as any).resultKind === 'sync') {
      throw new Error(
        "Drizzle-GraphQL Error: transactions: 'auto' requires an asynchronous SQLite driver (e.g. libsql). Synchronous drivers cannot hold a transaction open across resolvers.",
      );
    }
  },
  generateSelectArray,
  generateSelectSingle,
  generateUpdateMany,
});

export const generateSchemaData = <
  TDrizzleInstance extends BaseSQLiteDatabase<any, any, any, any>,
  TSchema extends Record<string, Table | unknown>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TablesRelationalConfig,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> => sqliteSchemaData(db, schema, relations, options);
