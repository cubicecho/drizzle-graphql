import type { Table } from 'drizzle-orm';
import { type BaseSQLiteDatabase, getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { GeneratedEntities } from '../../types.ts';
import { getPrimaryKeyPropNamesFromConfig, type TablesRelationalConfig } from '../builders/common.ts';
import { createSchemaDataGenerator } from './schema-data.ts';
import type { SchemaGeneratorOptions } from './types.ts';
import { createUpdateManyGenerator, type UpdateManyBatchRunner, type UpdateManyEntry } from './update-many.ts';

/** Primary-key property names for a SQLite table, including table-level composite keys. */
const sqlitePrimaryKeyPropNames = (table: SQLiteTable): string[] =>
  getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

/**
 * SQLite's batch runner. A synchronous driver (better-sqlite3) commits the moment its
 * transaction callback returns, so that callback must not be async — an awaited statement
 * would run after the COMMIT. The driver kind is probed from the first statement's result
 * rather than declared, so the same resolver serves both driver families.
 */
const runSqliteUpdateManyBatch: UpdateManyBatchRunner = ({
  executor,
  entries,
  table,
  returning,
  anyNested,
  nested,
  tableName,
  context,
}) => {
  const runEntry = (tx: any, entry: UpdateManyEntry) => {
    let query = tx.update(table).set(entry.set);
    if (entry.filters) {
      query = query.where(entry.filters);
    }
    // `.all()` instead of awaiting the thenable: a sync driver executes it immediately,
    // which is the only way the statement still runs inside the native transaction below.
    return query.returning(returning).all();
  };

  // Nested writes need statements interleaved with awaited reads, which only an async driver
  // can do inside a transaction — `features.nestedWrites` rejects a sync driver at build
  // time, so this path is always on one.
  const runNestedEntry = async (tx: any, entry: UpdateManyEntry) => {
    const values = entry.ops
      ? { ...entry.set, ...(await nested!.applyParentSide(tx, tableName, entry.ops, context)) }
      : entry.set;

    // Same as the single update: an entry with no column values reads the rows its `where`
    // matched so the nested operations have something to attach to.
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

  // On a caller-supplied transaction — or the shared multi-mutation transaction opened by
  // `runMutation` — this opens a savepoint, so the batch stays atomic without breaking the
  // outer transaction.
  return executor.transaction((tx: any) => {
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
};

const generateUpdateMany = createUpdateManyGenerator(sqlitePrimaryKeyPropNames, runSqliteUpdateManyBatch);

const sqliteSchemaData = createSchemaDataGenerator({
  tableClass: SQLiteTable,
  getTableConfig,
  primaryKeyPropNames: sqlitePrimaryKeyPropNames,
  // SQLite sorts NULLs as the smallest values (first in ASC).
  nullOrdering: 'nulls-smallest',
  // Writes come back with their rows, so the table types carry the `${Table}Item` outputs.
  returnsRows: true,
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
