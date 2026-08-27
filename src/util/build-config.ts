// =============================================================================
// `BuildSchemaConfig` -> `SchemaGeneratorOptions`.
//
// Everything `buildSchema` decides before it knows which dialect it is talking
// to: defaults filled in, per-table configuration resolved against the real
// schema (so a renamed table or column fails the build rather than silently
// doing nothing), contradictory feature flags warned about, and the whole lot
// normalized into the single options object the three dialect generators take.
// =============================================================================

import { getColumns, is, Table } from 'drizzle-orm';
import type { BuildSchemaConfig, TableLimitPolicy } from '../types.ts';
import {
  DEFAULT_TRANSACTION_TIMEOUT_MS,
  type DefaultOrderByFor,
  type LimitPolicyFor,
  normalizeWriteHooks,
  type ResolvedLimitPolicy,
  type ResolvedWriteHooks,
  resolveLimitPolicy,
  resolveSoftDeleteInfo,
  type SoftDeleteInfo,
  type TablePolicies,
  type WriteHookFor,
  type WriteHookPositions,
  type WriteHooks,
} from './builders/common.ts';
import type { SchemaGeneratorOptions } from './builders/types.ts';
import { singularizeMapper } from './case-ops/index.ts';
import { resolveTableFeatures } from './features.ts';

/**
 * Resolves a caller's `BuildSchemaConfig` against the Drizzle schema it will be applied to.
 *
 * Throws on configuration that names a table or column the schema does not have, and warns on
 * feature flags whose combination generates something other than what it appears to ask for.
 *
 * @param config the caller's config, or `undefined` for an all-defaults build
 * @param schema the Drizzle schema map `buildSchema` resolved from the database instance
 */
export const resolveBuildConfig = (
  config: BuildSchemaConfig | undefined,
  schema: Record<string, unknown>,
): SchemaGeneratorOptions => {
  const prefixes = {
    insert: config?.prefixes?.insert ?? 'create',
    delete: config?.prefixes?.delete ?? 'delete',
    update: config?.prefixes?.update ?? 'update',
    upsert: config?.prefixes?.upsert ?? 'upsert',
    restore: config?.prefixes?.restore ?? 'restore',
  };

  const suffixes = {
    list: config?.suffixes?.list ?? '',
    single: config?.suffixes?.single ?? 'Single',
  };

  // `'singularize'` is the one shipped preset; anything else is the caller's own function.
  const typeNameMapper = config?.typeNameMapper === 'singularize' ? singularizeMapper : config?.typeNameMapper;

  // Table keys this build generates for — what a per-table feature predicate is asked about.
  // Excluded tables are dropped up front so no predicate is ever consulted for a table that
  // generates nothing.
  const tableKeys = Object.entries(schema as Record<string, unknown>)
    .filter(([, value]) => is(value, Table))
    .map(([key]) => key);
  const excludedTableNames = new Set(config?.exclude?.tables ?? []);
  const featureTables = tableKeys.filter((key) => !excludedTableNames.has(key));

  // Resolved the same way the generators resolve it, so the implication warnings below
  // describe exactly what gets generated.
  const forTable = resolveTableFeatures(config?.features);

  // Cost hints are inert without a complexity rule installed, so they are generated unless the
  // caller opts out.
  const complexityConfig = config?.complexity ?? true;
  const complexity =
    complexityConfig === false
      ? undefined
      : {
          defaultListSize: (complexityConfig === true ? undefined : complexityConfig.defaultListSize) ?? 10,
          aggregateCost: (complexityConfig === true ? undefined : complexityConfig.aggregateCost) ?? 10,
        };

  // Off unless asked for: opening transactions the caller did not wire up themselves is a
  // behavior change (and some drivers, e.g. neon-http, cannot open one at all).
  const transactionsOpt = config?.transactions;
  const transactions =
    transactionsOpt === undefined || transactionsOpt === 'none'
      ? undefined
      : {
          timeoutMs:
            (transactionsOpt === 'auto' ? undefined : transactionsOpt.timeoutMs) ?? DEFAULT_TRANSACTION_TIMEOUT_MS,
        };

  // A limit policy is only built when the caller configured one; otherwise `limits` stays
  // undefined and every list keeps its unbounded behavior. Policies are resolved once per
  // table and memoized, since the lookup runs on every relation field build and every list
  // resolve.
  const limitsConfig = config?.limits;
  if (limitsConfig) {
    const check = (policy: TableLimitPolicy, where: string) => {
      for (const key of ['defaultLimit', 'maxLimit'] as const) {
        const value = policy[key];
        if (value === undefined) {
          continue;
        }
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Drizzle-GraphQL Error: config.limits${where}.${key} must be a positive integer.`);
        }
      }
    };
    check(limitsConfig, '');
    for (const [tableName, policy] of Object.entries(limitsConfig.tables ?? {})) {
      check(policy, `.tables.${tableName}`);
    }
  }
  const limitPolicyCache = new Map<string, ResolvedLimitPolicy | undefined>();
  const limits: LimitPolicyFor | undefined = limitsConfig
    ? (tableName: string) => {
        if (limitPolicyCache.has(tableName)) {
          return limitPolicyCache.get(tableName);
        }
        const resolved = resolveLimitPolicy(limitsConfig, limitsConfig.tables?.[tableName]);
        limitPolicyCache.set(tableName, resolved);
        return resolved;
      }
    : undefined;

  // Per-table defaults are resolved against the real schema at build time, so a renamed table
  // or column fails the build rather than silently ordering by nothing. The normalized form is
  // the same shape the generated `orderBy` argument has, so every read path can substitute it
  // without knowing where it came from.
  const defaultsConfig = config?.defaults;
  const defaultOrderByByTable = new Map<string, Record<string, any>>();
  if (defaultsConfig) {
    const defaultsTableNames = new Set(tableKeys);
    for (const [tableName, tableDefaults] of Object.entries(defaultsConfig)) {
      if (!defaultsTableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.defaults names '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
      const orderBy = tableDefaults?.orderBy;
      if (!orderBy || !Object.keys(orderBy).length) {
        continue;
      }
      const columns = getColumns(schema[tableName] as Table);
      const normalized: Record<string, any> = {};
      for (const [columnName, entry] of Object.entries(orderBy)) {
        if (!columns[columnName]) {
          throw new Error(
            `Drizzle-GraphQL Error: config.defaults.${tableName}.orderBy names '${columnName}', which is not a column of '${tableName}'.`,
          );
        }
        const direction = typeof entry === 'string' ? entry : entry?.direction;
        if (direction !== 'asc' && direction !== 'desc') {
          throw new Error(
            `Drizzle-GraphQL Error: config.defaults.${tableName}.orderBy.${columnName} must be 'asc', 'desc', or { direction, priority? }.`,
          );
        }
        const priority = typeof entry === 'string' ? undefined : entry?.priority;
        if (priority !== undefined && !Number.isInteger(priority)) {
          throw new Error(
            `Drizzle-GraphQL Error: config.defaults.${tableName}.orderBy.${columnName}.priority must be an integer.`,
          );
        }
        normalized[columnName] = priority === undefined ? { direction } : { direction, priority };
      }
      defaultOrderByByTable.set(tableName, normalized);
    }
  }
  const defaultOrderBy: DefaultOrderByFor | undefined = defaultOrderByByTable.size
    ? (tableName: string) => defaultOrderByByTable.get(tableName)
    : undefined;

  // A row scope and the context-derived columns are resolved against the real schema for the
  // same reason exclusions are: a renamed table or column must fail the build, not silently
  // stop scoping. Both stay undefined unless configured, so an unconfigured build emits the
  // same SQL it always did.
  const scopeConfig = config?.scope;
  const contextValuesConfig = config?.contextValues;
  if (scopeConfig || contextValuesConfig) {
    const tableNames = new Set(tableKeys);
    for (const [tableName, hook] of Object.entries(scopeConfig ?? {})) {
      if (!tableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.scope names '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
      if (typeof hook !== 'function') {
        throw new Error(`Drizzle-GraphQL Error: config.scope.${tableName} must be a function.`);
      }
    }
    for (const [tableName, columnHooks] of Object.entries(contextValuesConfig ?? {})) {
      if (!tableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.contextValues names '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
      const columns = getColumns(schema[tableName] as Table);
      for (const [columnName, hook] of Object.entries(columnHooks)) {
        if (!columns[columnName]) {
          throw new Error(
            `Drizzle-GraphQL Error: config.contextValues names '${tableName}.${columnName}', which is not a column of that table.`,
          );
        }
        if (typeof hook !== 'function') {
          throw new Error(`Drizzle-GraphQL Error: config.contextValues.${tableName}.${columnName} must be a function.`);
        }
      }
    }
  }
  // Soft delete is resolved against the real columns here, once, so a renamed column or a
  // NOT NULL column with no restore value fails the build rather than silently making every
  // row visible again at runtime.
  const softDeleteConfig = config?.softDelete;
  const softDeleteInfos = new Map<string, SoftDeleteInfo>();
  if (softDeleteConfig) {
    if (typeof softDeleteConfig === 'function') {
      for (const tableName of tableKeys) {
        const declaration = softDeleteConfig(schema[tableName] as Table, tableName);
        if (declaration) {
          softDeleteInfos.set(tableName, resolveSoftDeleteInfo(schema[tableName] as Table, tableName, declaration));
        }
      }
    } else {
      const tableNames = new Set(tableKeys);
      for (const [tableName, declaration] of Object.entries(softDeleteConfig)) {
        if (!tableNames.has(tableName)) {
          throw new Error(
            `Drizzle-GraphQL Error: config.softDelete names '${tableName}', which is not a table in the Drizzle schema.`,
          );
        }
        softDeleteInfos.set(tableName, resolveSoftDeleteInfo(schema[tableName] as Table, tableName, declaration));
      }
    }
  }

  // Write hooks are resolved the same way: a table name that matches nothing fails the build,
  // and the two registration shapes collapse into one per-table lookup here rather than in
  // every resolver.
  const onWriteConfig = config?.onWrite;
  const writeHooks = new Map<string, ResolvedWriteHooks | undefined>();
  let globalWriteHooks: ResolvedWriteHooks | undefined;
  if (onWriteConfig) {
    // A bare function, or an object naming the positions, applies to every table; anything
    // else is a table map. `before`/`after` are reserved as position names for that reason.
    const isGlobal =
      typeof onWriteConfig === 'function' ||
      typeof (onWriteConfig as WriteHookPositions).before === 'function' ||
      typeof (onWriteConfig as WriteHookPositions).after === 'function';
    if (isGlobal) {
      globalWriteHooks = normalizeWriteHooks(onWriteConfig as WriteHooks);
    } else {
      const tableNames = new Set(tableKeys);
      for (const [tableName, hooks] of Object.entries(onWriteConfig as Record<string, WriteHooks>)) {
        if (!tableNames.has(tableName)) {
          throw new Error(
            `Drizzle-GraphQL Error: config.onWrite names '${tableName}', which is not a table in the Drizzle schema.`,
          );
        }
        if (typeof hooks !== 'function' && typeof hooks !== 'object') {
          throw new Error(
            `Drizzle-GraphQL Error: config.onWrite.${tableName} must be a function or an object with 'before' and/or 'after'.`,
          );
        }
        writeHooks.set(tableName, normalizeWriteHooks(hooks));
      }
    }
  }
  const onWrite: WriteHookFor | undefined =
    globalWriteHooks || writeHooks.size
      ? (tableName: string) => globalWriteHooks ?? writeHooks.get(tableName)
      : undefined;

  const policies: TablePolicies | undefined =
    scopeConfig || contextValuesConfig || softDeleteInfos.size || onWrite || defaultOrderBy
      ? {
          scope: scopeConfig ? (tableName: string) => scopeConfig[tableName] : undefined,
          contextValues: contextValuesConfig ? (tableName: string) => contextValuesConfig[tableName] : undefined,
          softDelete: softDeleteInfos.size ? (tableName: string) => softDeleteInfos.get(tableName) : undefined,
          onWrite,
          defaultOrderBy,
        }
      : undefined;

  // Exclusions are resolved against the real schema so a renamed table or column fails the
  // build instead of quietly un-hiding itself — the failure mode that matters when this config
  // is what keeps a secret out of the API.
  const exclude = config?.exclude;
  if (exclude) {
    const tableNames = new Set(tableKeys);
    const excludedTables = excludedTableNames;
    for (const tableName of excludedTables) {
      if (!tableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.exclude.tables names '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
    }
    if (excludedTables.size >= tableNames.size) {
      throw new Error(
        'Drizzle-GraphQL Error: config.exclude.tables excludes every table in the schema, leaving nothing to generate.',
      );
    }
    for (const [tableName, columnNames] of Object.entries(exclude.columns ?? {})) {
      if (!tableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.exclude.columns names table '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
      // An excluded table has no columns left to hide; listing them too is redundant, not wrong.
      if (excludedTables.has(tableName)) {
        continue;
      }
      const columns = getColumns(schema[tableName] as Table);
      for (const columnName of columnNames) {
        const column = columns[columnName];
        if (!column) {
          throw new Error(
            `Drizzle-GraphQL Error: config.exclude.columns names '${tableName}.${columnName}', which is not a column of that table.`,
          );
        }
        // Hiding a column every insert must supply leaves the table readable but unwritable.
        // That is a reasonable thing to configure deliberately, so it warns rather than throws.
        if (column.notNull && !column.hasDefault && !column.defaultFn) {
          console.warn(
            `Drizzle-GraphQL Warning: excluded column '${tableName}.${columnName}' is NOT NULL with no default, so generated inserts for '${tableName}' can never succeed.`,
          );
        }
      }
    }
  }

  // Some operations are built out of others: an upsert writes through the insert and update
  // paths, a batch update reuses the update input, a grouped result reuses the aggregate
  // output types. The generator knows those implications; a table whose flags contradict them
  // is told at build time rather than leaving the consumer to notice a second write path (or a
  // missing operation) later. These warn rather than throw — the resulting schema is coherent,
  // it just isn't what the config appears to ask for.
  const featureConflicts = new Map<string, string[]>();
  const noteConflict = (message: string, tableName: string) => {
    const tables = featureConflicts.get(message);
    if (tables) {
      tables.push(tableName);
    } else {
      featureConflicts.set(message, [tableName]);
    }
  };
  for (const tableName of featureTables) {
    const tableFeatures = forTable(tableName);
    if (tableFeatures.upsert) {
      const missing = [!tableFeatures.insert ? 'insert' : undefined, !tableFeatures.update ? 'update' : undefined]
        .filter(Boolean)
        .join(' and ');
      if (missing) {
        noteConflict(
          `upsert is on while ${missing} is off, so the upsert mutations are a second write path past the operation you turned off`,
          tableName,
        );
      }
    }
    // Nested writes are build-wide, so a relation pointing at this table can still write it
    // from another table's mutation even with its own write operations turned off.
    if (config?.features?.nestedWrites && (!tableFeatures.insert || !tableFeatures.update)) {
      noteConflict(
        "nestedWrites is on while this table's own insert or update is off, so a nested `create` or `connect` under another table's mutation can still write it",
        tableName,
      );
    }
    // Only flagged when the caller actually asked for the dependent feature: both default to
    // on, so turning off the operation they build on is the normal way to remove them.
    if (config?.features?.updateMany !== undefined && tableFeatures.updateMany && !tableFeatures.update) {
      noteConflict('updateMany is on while update is off, so no batch update is generated', tableName);
    }
    if (config?.features?.groupBy !== undefined && tableFeatures.groupBy && !tableFeatures.aggregates) {
      noteConflict('groupBy is on while aggregates is off, so no grouped query is generated', tableName);
    }
    // The count mutations mirror the plural write they count, so they need at least one of the
    // two to be generated at all.
    if (tableFeatures.countMutations && !tableFeatures.update && !tableFeatures.delete) {
      noteConflict(
        'countMutations is on while update and delete are both off, so no count mutation is generated',
        tableName,
      );
    }
  }
  for (const [message, tables] of featureConflicts) {
    const listed =
      tables.length > 5 ? `${tables.slice(0, 5).join(', ')} and ${tables.length - 5} more` : tables.join(', ');
    console.warn(`Drizzle-GraphQL Warning: config.features — ${message} (${listed}).`);
  }

  // Normalize eagerLoadRelations (boolean | predicate | undefined) into a predicate.
  const eagerOpt = config?.eagerLoadRelations;
  const shouldEagerLoad: (tableName: string, relationName: string) => boolean =
    eagerOpt === undefined || eagerOpt === true ? () => true : eagerOpt === false ? () => false : eagerOpt;

  // When a typeNameMapper is provided, the mapper's singular/plural forms disambiguate the
  // list and single fields even if the suffixes are identical (e.g. both '').
  // Only enforce the suffix-collision check when no mapper is active.
  if (!typeNameMapper && suffixes.list === suffixes.single) {
    throw new Error(
      'Drizzle-GraphQL Error: List and single query suffixes cannot be the same. This would create conflicting GraphQL field names.',
    );
  }

  if (typeof config?.relationsDepthLimit === 'number') {
    if (config.relationsDepthLimit < 0) {
      throw new Error(
        'Drizzle-GraphQL Error: config.relationsDepthLimit is supposed to be nonnegative integer or undefined!',
      );
    }
    if (config.relationsDepthLimit !== ~~config.relationsDepthLimit) {
      throw new Error(
        'Drizzle-GraphQL Error: config.relationsDepthLimit is supposed to be nonnegative integer or undefined!',
      );
    }
  }

  const generatorOptions: SchemaGeneratorOptions = {
    relationsDepthLimit: config?.relationsDepthLimit,
    prefixes,
    suffixes,
    conflictDoNothing: config?.conflictDoNothing ?? false,
    typeNameMapper,
    shouldEagerLoad,
    features: config?.features ?? {},
    complexity,
    scalars: config?.scalars,
    mapColumnType: config?.mapColumnType,
    enumNameMapper: config?.enumNameMapper,
    transactions,
    limits,
    policies,
    exclude,
    docs: {
      describeColumn: config?.describeColumn,
      describeTable: config?.describeTable,
      describeRelation: config?.describeRelation,
      deprecateColumn: config?.deprecateColumn,
    },
  };

  return generatorOptions;
};
