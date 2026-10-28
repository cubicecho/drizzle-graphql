// Which dialect a drizzle handle speaks, decided once from its class, with what each dialect
// supplies to the code that only holds the handle: the schema build and the selection helpers.

import { type DrizzleEntityClass, is, type Table } from 'drizzle-orm';
import { MySqlAsyncDatabase } from 'drizzle-orm/mysql-core';
import { PgAsyncDatabase } from 'drizzle-orm/pg-core';
import { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';
import {
  DIALECT_NULL_ORDERING,
  type getUniqueColumnSets,
  type NullOrdering,
  type TablesRelationalConfig,
} from './common.ts';
import { generateSchemaData as generateMySQL, mysqlPrimaryKeyPropNames, mysqlTableConfig } from './mysql.ts';
import { generateSchemaData as generatePG, pgPrimaryKeyPropNames, pgTableConfig } from './pg.ts';
import { generateSchemaData as generateSQLite, sqlitePrimaryKeyPropNames, sqliteTableConfig } from './sqlite.ts';
import type { SchemaGeneratorOptions } from './types.ts';
import type { PrimaryKeyPropNames } from './write-resolvers.ts';

/** A dialect's cached `getTableConfig`, as the unique-key helpers read it. */
type TableConfigLookup = Parameters<typeof getUniqueColumnSets<Table>>[2];

/** What one dialect hands the code that picked it from a database handle. */
export type Dialect = {
  /** The dialect's database class, which `is()` tests a handle against. */
  databaseClass: DrizzleEntityClass<unknown>;
  /** The dialect's schema generator. */
  generateSchemaData: (
    db: any,
    schema: Record<string, unknown>,
    relations: TablesRelationalConfig,
    options: SchemaGeneratorOptions,
  ) => any;
  /** Primary-key property names, composite-aware, from the dialect's `getTableConfig`. */
  primaryKeyPropNames: PrimaryKeyPropNames;
  /** The dialect's `getTableConfig`, cached per table — the same cache its schema builder reads. */
  getTableConfig: TableConfigLookup;
  /** Where the dialect sorts NULLs, which cursor predicates must agree with. */
  nullOrdering: NullOrdering;
};

/** Every supported dialect, in the order a handle is tested against them. */
const DIALECTS: readonly Dialect[] = [
  {
    databaseClass: MySqlAsyncDatabase,
    generateSchemaData: generateMySQL,
    primaryKeyPropNames: mysqlPrimaryKeyPropNames,
    getTableConfig: mysqlTableConfig as unknown as TableConfigLookup,
    nullOrdering: DIALECT_NULL_ORDERING.mysql,
  },
  {
    databaseClass: PgAsyncDatabase,
    generateSchemaData: generatePG,
    primaryKeyPropNames: pgPrimaryKeyPropNames,
    getTableConfig: pgTableConfig as unknown as TableConfigLookup,
    nullOrdering: DIALECT_NULL_ORDERING.pg,
  },
  {
    databaseClass: SQLiteAsyncDatabase,
    generateSchemaData: generateSQLite,
    primaryKeyPropNames: sqlitePrimaryKeyPropNames,
    getTableConfig: sqliteTableConfig as unknown as TableConfigLookup,
    nullOrdering: DIALECT_NULL_ORDERING.sqlite,
  },
];

/** The dialect of a drizzle handle, or `undefined` when it is none this library supports. */
export const dialectOf = (db: unknown): Dialect | undefined =>
  DIALECTS.find((dialect) => is(db, dialect.databaseClass));
