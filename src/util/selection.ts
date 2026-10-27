import { is, Table } from 'drizzle-orm';
import { MySqlAsyncDatabase, getTableConfig as mysqlTableConfig } from 'drizzle-orm/mysql-core';
import { PgAsyncDatabase, getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { SQLiteAsyncDatabase, getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { type GraphQLResolveInfo, getNamedType } from 'graphql';
import type { AnyDrizzleDB } from '../types.ts';
import { type BuildRuntime, runtimeForDb, runtimeForType } from './builders/common/build-registry.ts';
import type { DeletedMode, RowVisibility } from './builders/common/policies.ts';
import {
  applyLimitPolicy,
  attachTargetPrimaryKeys,
  buildNamedRelations,
  type DerivedTypeNameMapper,
  DIALECT_NULL_ORDERING,
  extractRelationsParams,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  memoizeTableConfig,
  type NullOrdering,
  type RelationFilterBase,
  resolveGeneratedTypeNames,
  resolveObjectTypeName,
  runRelationalSelect,
  type TypeNameMapper,
  type TypeNameResolver,
  tableUniqueKeyMap,
  type UniqueKeyMap,
  withDefaultOrderBy,
} from './builders/common.ts';
import type { TableNamedRelations } from './builders/types.ts';
import { parseResolveInfo, type ResolveTree } from './parse-resolve-info.ts';

/**
 * Everything the translation needs about a drizzle instance: the tables it holds, the
 * relation graph in this library's canonical shape, and the filter context that lets a
 * nested `where` reach a relation's target table. Derived once per instance — the same
 * derivation `buildSchema` does — and cached, since an overriding resolver calls this on
 * every request.
 */
type SelectionContext = {
  tables: Record<string, Table>;
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  filterCtx: RelationFilterBase;
  primaryKeyOf: (tableName: string) => readonly string[];
  /** The dialect's NULL placement, for a read no build identifies. */
  nullOrdering: NullOrdering;
};

const contextCache = new WeakMap<object, SelectionContext>();

type TableConfigLookup = Parameters<typeof getUniqueColumnSets<Table>>[1];

type Dialect = keyof typeof DIALECT_NULL_ORDERING;

/**
 * Each dialect's `getTableConfig`, the only place a composite primary key or a unique constraint
 * shows up. Cached per table, and bound at module scope so the cache is shared with every
 * selection this process translates — the same memoization each dialect builder applies.
 */
const TABLE_CONFIG: Record<Dialect, TableConfigLookup> = {
  mysql: memoizeTableConfig(mysqlTableConfig as unknown as TableConfigLookup),
  pg: memoizeTableConfig(pgTableConfig as unknown as TableConfigLookup),
  sqlite: memoizeTableConfig(sqliteTableConfig as unknown as TableConfigLookup),
};

/** Which dialect a drizzle instance speaks, by the same `is()` checks `buildSchema` dispatches on. */
const dialectOf = (db: AnyDrizzleDB<any>): Dialect => {
  if (is(db, MySqlAsyncDatabase)) {
    return 'mysql';
  }
  if (is(db, PgAsyncDatabase)) {
    return 'pg';
  }
  if (is(db, SQLiteAsyncDatabase)) {
    return 'sqlite';
  }
  throw new Error('Drizzle-GraphQL Error: unsupported database instance — expected a PostgreSQL, MySQL or SQLite one.');
};

const contextFor = (db: AnyDrizzleDB<any>): SelectionContext => {
  const cached = contextCache.get(db as object);
  if (cached) {
    return cached;
  }

  const relations = (db as any)._.relations ?? {};
  // Same reconstruction `buildSchema` does: the relations config is the only table map a v1
  // handle carries, and each of its entries carries its table.
  const schema = Object.fromEntries(
    Object.entries(relations as Record<string, any>)
      .filter(([, config]) => config?.table != null)
      .map(([key, config]) => [key, config.table]),
  );

  const tableEntries = Object.entries(schema as Record<string, unknown>).filter(([, value]) => is(value, Table)) as [
    string,
    Table,
  ][];
  if (!tableEntries.length) {
    throw new Error(
      'Drizzle-GraphQL Error: Schema not found in drizzle instance. Pass relations (from buildRelations/defineRelations) to the drizzle constructor so drizzle-graphql can read your tables.',
    );
  }

  const tables = Object.fromEntries(tableEntries);
  const dialect = dialectOf(db);
  const getTableConfig = TABLE_CONFIG[dialect];
  const primaryKeyCache = new Map<string, readonly string[]>();
  const primaryKeyOf = (tableName: string): readonly string[] => {
    let pk = primaryKeyCache.get(tableName);
    if (!pk) {
      const table = tables[tableName];
      pk = table ? getPrimaryKeyPropNamesFromConfig(table, getTableConfig) : [];
      primaryKeyCache.set(tableName, pk);
    }
    return pk;
  };

  const relationMap = buildNamedRelations(relations, tableEntries);
  // Paginated relations fall back to a primary-key order, which is resolved once per target
  // and hung off the relation entry — exactly as the generated schema does it.
  attachTargetPrimaryKeys(relationMap, tables, (table) => [...primaryKeyOf(tableNameOf(tables, table))]);

  // Every table's unique-key `where` fields, for a read no build identifies: which tables enabled
  // them is per build. A client cannot spell a field its schema did not generate, so offering
  // them all costs nothing, while offering none made a build's own key an unknown filter key.
  const uniqueKeys: Record<string, UniqueKeyMap> = Object.fromEntries(
    tableEntries
      .map(([tableName, table]): [string, UniqueKeyMap] => [
        tableName,
        tableUniqueKeyMap(table, Object.keys(relationMap[tableName] ?? {}), getUniqueColumnSets(table, getTableConfig)),
      ])
      .filter(([, map]) => Object.keys(map).length),
  );

  const context: SelectionContext = {
    tables,
    relationMap,
    filterCtx: { tables, relationMap, uniqueKeys },
    primaryKeyOf,
    nullOrdering: DIALECT_NULL_ORDERING[dialect],
  };
  contextCache.set(db as object, context);
  return context;
};

/** Reverse lookup for `attachTargetPrimaryKeys`, which hands back the table, not its key. */
const tableNameOf = (tables: Record<string, Table>, table: Table): string =>
  Object.keys(tables).find((name) => tables[name] === table) ?? '';

/** Options shared by {@link selectionToWith} and {@link resolveSelection}. */
export type SelectionOptions = {
  /** The drizzle instance the schema was built from. */
  db: AnyDrizzleDB<any>;
  /** The Drizzle schema key of the table the selection is rooted at. */
  table: string;
  /**
   * The `typeNameMapper` the schema was built with, when one was configured. The translation
   * matches selections against GraphQL type names, so a build that renames its types has to
   * pass the same mapper here or nothing will match.
   */
  typeNameMapper?: TypeNameMapper;
  /**
   * The `derivedTypeNameMapper` / `typeNamePrefix` / `typeNameSuffix` the schema was built
   * with, when any were configured. Same reason as `typeNameMapper`: the translation matches
   * selections against the names the build actually published.
   */
  derivedTypeNameMapper?: DerivedTypeNameMapper;
  typeNamePrefix?: string;
  typeNameSuffix?: string;
  /**
   * The resolver's GraphQL context. The build's `scope` hooks are called with it, so a build
   * that configures `scope` requires it — the helpers throw rather than read unscoped.
   */
  context?: any;
};

/** The build's naming rule, reassembled from the three options a caller passes back. */
const namingRuleOf = (options: SelectionOptions): TypeNameResolver =>
  resolveGeneratedTypeNames({
    derivedTypeNameMapper: options.derivedTypeNameMapper,
    typeNamePrefix: options.typeNamePrefix,
    typeNameSuffix: options.typeNameSuffix,
  });

/**
 * The build whose policies the read applies. Looked up through the generated types the
 * resolve info reaches — the field's return type, the root table's type in the executing
 * schema, the parent type — so a resolver over a generated type finds its own build. Without
 * resolve info (a parsed tree was passed), the instance's only build is used.
 */
const runtimeFor = (
  info: GraphQLResolveInfo | ResolveTree,
  db: AnyDrizzleDB<any>,
  typeName: string,
  helper: string,
): BuildRuntime | undefined => {
  if (!('fieldsByTypeName' in info)) {
    const candidates = [
      info.returnType ? getNamedType(info.returnType) : undefined,
      info.schema?.getType(typeName),
      info.parentType,
    ];
    for (const candidate of candidates) {
      const runtime = runtimeForType(candidate);
      if (runtime && runtime.db === db) {
        return runtime;
      }
    }
  }
  return runtimeForDb(db as object, helper);
};

/**
 * The request's row policies under `runtime`, bound to the context the caller passed. A build
 * with `scope` hooks cannot be read without that context: the hooks would be called with
 * nothing, and running the read unscoped is the leak the option exists to prevent.
 */
const visibilityFor = (
  runtime: BuildRuntime | undefined,
  options: SelectionOptions,
  helper: string,
): RowVisibility | undefined => {
  if (!runtime?.policies?.visibility) {
    return undefined;
  }
  if (runtime.hasRowScope && !('context' in options)) {
    throw new Error(
      `Drizzle-GraphQL Error: the schema this selection belongs to configures \`scope\`, so ${helper} needs the request context to apply it. Pass the resolver's context as the \`context\` option.`,
    );
  }
  return runtime.policies.visibility(options.context);
};

/**
 * Reads the parsed selection tree out of a resolver's `info`, resolving fragments and
 * inline fragments. Accepts an already-parsed tree so a caller that has one (or is chaining
 * these helpers) does not pay for the walk twice.
 */
const parseInfo = (info: GraphQLResolveInfo | ResolveTree): ResolveTree | undefined => {
  if ('fieldsByTypeName' in info) {
    return info as ResolveTree;
  }
  return parseResolveInfo(info, { deep: true }) as ResolveTree | undefined;
};

/**
 * Translates a GraphQL selection set into the relational query builder's `with` tree — the
 * same translation the generated resolvers use for their own queries.
 *
 * A resolver that replaces a generated one has to return a row shaped like the type it
 * replaced, and the field resolvers underneath only fill in relations the parent did not
 * already provide. Reproducing that by hand means resolving fragments against
 * `info.fragments`, intersecting selection names against the relations config (so scalars
 * and consumer-added fields drop out instead of becoming invalid `with` keys), following
 * aliases, compiling each relation's `where` / `orderBy` / `limit` / `offset` arguments into
 * its nested entry, and leaving `<relation>Aggregate` selections out — they are not `with`
 * entries at all. This does all of it.
 *
 * ```ts
 * const withTree = selectionToWith(info, { db, table: 'Users' });
 * const row = await tx.query.Users.findFirst({ where: { id: { eq } }, with: withTree });
 * ```
 *
 * Every nested entry carries the build's row policies — `scope`, `softDelete`, `limits` and
 * `defaults.orderBy` — exactly as the generated `with:` clause does. The build is found
 * through the resolve info; pass `context` when it configures `scope`.
 *
 * Returns `undefined` when the selection asks for no relations, which is the value the
 * query builder wants for "no `with` clause".
 */
export const selectionToWith = (
  info: GraphQLResolveInfo | ResolveTree,
  options: SelectionOptions,
): Record<string, any> | undefined => {
  const { db, table, typeNameMapper } = options;
  const resolveName = namingRuleOf(options);
  const { tables, relationMap, filterCtx } = contextFor(db);
  if (!tables[table]) {
    throw new Error(`Drizzle-GraphQL Error: '${table}' is not a table in the Drizzle schema.`);
  }
  if (!relationMap[table]) {
    return undefined;
  }

  const typeName = resolveObjectTypeName(table, typeNameMapper, resolveName);
  const runtime = runtimeFor(info, db, typeName, 'selectionToWith');
  const parsed = parseInfo(info);
  const params = extractRelationsParams(relationMap, tables, table, parsed, typeName, {
    typeNameMapper,
    filterCtx: runtime?.filterCtx ?? filterCtx,
    resolveName,
    // The nested relations get the same policies the generated `with:` clause applies.
    visibility: visibilityFor(runtime, options, 'selectionToWith'),
    limits: runtime?.limits,
    defaultOrderBy: runtime?.policies?.defaultOrderBy,
  });
  // A selection with no relations in it gets no `with` clause at all, rather than an empty
  // object the query builder would have to be asked to ignore.
  return params && Object.keys(params).length ? params : undefined;
};

/** Options for {@link resolveSelection} — the selection options plus the read itself. */
export type ResolveSelectionOptions = SelectionOptions & {
  /**
   * The transaction (or other drizzle executor) to read on. Defaults to `db`, so an override
   * that has opened its own transaction passes it here to see its own uncommitted writes.
   */
  executor?: any;
  /** Whether to return one row or a list. A single read ignores `limit`. */
  single?: boolean;
  /** The generated `where` argument, in the schema's filter DSL — compiled the same way. */
  where?: any;
  /** The generated `orderBy` argument. */
  orderBy?: any;
  limit?: number;
  offset?: number;
  /** The generated `after` cursor argument, for keyset pagination. */
  after?: string;
  /**
   * The generated `deleted` argument, for a soft-deleting table. Defaults to `EXCLUDE`, as the
   * generated field does.
   */
  deleted?: DeletedMode;
};

/**
 * Runs the read a generated select resolver would have run, against whichever executor is
 * given — the whole body, not just the `with` tree: selected columns, relation arguments,
 * eager loading, cursor pagination, and the transport remapping of the result.
 *
 * This is what an override usually wants after it has done its own work:
 *
 * ```ts
 * const rows = await resolveSelection(info, { db, table: 'Users', context, where, executor: tx });
 * ```
 *
 * Relation arguments and aggregate fields keep behaving as they do in the generated schema,
 * because it is the generated schema's own code path. So do the build's row policies: the
 * root table and every nested relation are scoped and soft-delete-filtered, and the limit
 * policy and default ordering apply. Pass `context` when the build configures `scope`.
 */
export const resolveSelection = async (
  info: GraphQLResolveInfo | ResolveTree,
  options: ResolveSelectionOptions,
): Promise<any> => {
  const {
    db,
    table: tableName,
    typeNameMapper,
    executor,
    single = false,
    where,
    orderBy,
    limit,
    offset,
    after,
    deleted,
  } = options;
  const resolveName = namingRuleOf(options);
  const { tables, relationMap, filterCtx, primaryKeyOf, nullOrdering } = contextFor(db);
  const table = tables[tableName];
  if (!table) {
    throw new Error(`Drizzle-GraphQL Error: '${tableName}' is not a table in the Drizzle schema.`);
  }

  const parsedInfo = parseInfo(info);
  if (!parsedInfo) {
    throw new Error('Drizzle-GraphQL Error: resolveSelection could not read a selection set from the resolve info.');
  }

  const source = executor ?? db;
  const queryBase = (source as any).query?.[tableName];
  if (!queryBase) {
    throw new Error(
      `Drizzle-GraphQL Error: the executor passed to resolveSelection has no relational query builder for '${tableName}'.`,
    );
  }

  // The build's policies, applied the way the generated select field applies them: the scope
  // and soft delete on the root table and every nested relation, the limit policy and the
  // default ordering on the root list and on every relation.
  const typeName = resolveObjectTypeName(tableName, typeNameMapper, resolveName);
  const runtime = runtimeFor(info, db, typeName, 'resolveSelection');
  const visibility = visibilityFor(runtime, options, 'resolveSelection');
  const defaultOrderBy = runtime?.policies?.defaultOrderBy;

  return runRelationalSelect({
    queryBase,
    tables,
    tableName,
    table,
    relationMap,
    typeName,
    typeNameMapper,
    resolveName,
    parsedInfo,
    single,
    where,
    orderBy: withDefaultOrderBy({ orderBy }, tableName, defaultOrderBy).orderBy,
    limit: single ? limit : applyLimitPolicy(limit, runtime?.limits?.(tableName)),
    offset,
    after,
    filterCtx: runtime?.filterCtx ?? filterCtx,
    pkNames: primaryKeyOf(tableName),
    db: source,
    visibility,
    deleted,
    limits: runtime?.limits,
    defaultOrderBy,
    nullOrdering: runtime?.nullOrdering ?? nullOrdering,
  });
};
