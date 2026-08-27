import type { Table } from 'drizzle-orm';
import { getTableConfig, type PgAsyncDatabase, PgTable } from 'drizzle-orm/pg-core';
import type { GeneratedEntities } from '../../types.ts';
import { getPrimaryKeyPropNamesFromConfig, type TablesRelationalConfig } from '../builders/common.ts';
import { createSchemaDataGenerator } from './schema-data.ts';
import type { SchemaGeneratorOptions } from './types.ts';
import { createUpdateManyGenerator } from './update-many.ts';

/** Primary-key property names for a PG table, including table-level composite keys. */
const pgPrimaryKeyPropNames = (table: PgTable): string[] => getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

const generateUpdateMany = createUpdateManyGenerator(pgPrimaryKeyPropNames);

const pgSchemaData = createSchemaDataGenerator({
  tableClass: PgTable,
  getTableConfig,
  primaryKeyPropNames: pgPrimaryKeyPropNames,
  // PostgreSQL sorts NULLs as the largest values (last in ASC).
  nullOrdering: 'nulls-largest',
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
