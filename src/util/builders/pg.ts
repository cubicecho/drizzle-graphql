import type { Table } from 'drizzle-orm';
import { type PgAsyncDatabase, PgTable, getTableConfig as pgTableConfigUncached } from 'drizzle-orm/pg-core';
import type { GeneratedEntities } from '../../types.ts';
import {
  DIALECT_NULL_ORDERING,
  getPrimaryKeyPropNamesFromConfig,
  memoizeTableConfig,
  type TablesRelationalConfig,
} from '../builders/common.ts';
import { createSchemaDataGenerator } from './schema-data.ts';
import type { SchemaGeneratorOptions } from './types.ts';
import { createUpdateManyGenerator } from './update-many.ts';

/** The dialect's table config, cached per table — see {@link memoizeTableConfig}. */
export const pgTableConfig = memoizeTableConfig(pgTableConfigUncached);

/** Primary-key property names for a PG table, including table-level composite keys. */
export const pgPrimaryKeyPropNames = (table: PgTable): string[] =>
  getPrimaryKeyPropNamesFromConfig(table, pgTableConfig);

const generateUpdateMany = createUpdateManyGenerator(pgPrimaryKeyPropNames);

const pgSchemaData = createSchemaDataGenerator({
  tableClass: PgTable,
  getTableConfig: pgTableConfig,
  primaryKeyPropNames: pgPrimaryKeyPropNames,
  // PostgreSQL sorts NULLs as the largest values (last in ASC).
  nullOrdering: DIALECT_NULL_ORDERING.pg,
  // Writes come back with their rows, so the table types carry the `${Table}Item` outputs.
  returnsRows: true,
  generateUpdateMany,
});

export const generateSchemaData = <
  TDrizzleInstance extends PgAsyncDatabase<any, any>,
  TSchema extends Record<string, Table | unknown>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TablesRelationalConfig,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> => pgSchemaData(db, schema, relations, options);
