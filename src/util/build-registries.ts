// The state one `buildSchema` call owns beyond its type cache: what its config decided about
// each column, and the caches that hold types built from those decisions. Created once per
// build, before any type is generated, and reached by every reader through the build — the
// type generators through `TypeCacheCtx.registries`, the request-time code through the build's
// relation filter base (`RelationFilterBase.registries`), which every generated resolver closes
// over. Nothing here is a module global, so two schemas built in one process never see each
// other's config.

import type { Table } from 'drizzle-orm';
import type { AggregateColumnSetsCache } from './builders/aggregates.ts';
import { type ColumnExclusions, createColumnExclusions } from './builders/common/exclusions.ts';
import { createFieldUpdateCaches, type FieldUpdateCaches } from './builders/field-updates.ts';
import type { SchemaGeneratorOptions } from './builders/types.ts';
import { type ColumnTypeRegistries, createEnumRegistry, createScalarOverrides } from './type-converter/index.ts';

/** One build's registries. */
export type BuildRegistries = ColumnTypeRegistries & {
  /** The columns `exclude.columns` hides from the schema, by table. */
  exclusions: ColumnExclusions;
  /** Each table's columns classified for aggregation, built from this build's types. */
  aggregateColumnSets: AggregateColumnSetsCache;
  /** Which operations input each column's update field takes, and the inputs themselves. */
  fieldUpdates: FieldUpdateCaches;
};

/** A build's registries, from the tables it covers and its resolved options. */
export const createBuildRegistries = (
  tables: Record<string, Table>,
  options: Pick<
    SchemaGeneratorOptions,
    'scalars' | 'mapColumnType' | 'enumNameMapper' | 'enumValueNameMapper' | 'exclude'
  >,
): BuildRegistries => ({
  scalarOverrides: createScalarOverrides(tables, options),
  enums: createEnumRegistry(options),
  exclusions: createColumnExclusions(tables, options.exclude),
  aggregateColumnSets: new WeakMap(),
  fieldUpdates: createFieldUpdateCaches(),
});
