import { is, Table } from 'drizzle-orm';
import { MySqlAsyncDatabase, getTableConfig as mysqlTableConfig } from 'drizzle-orm/mysql-core';
import { PgAsyncDatabase, getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { SQLiteAsyncDatabase, getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import type { GraphQLResolveInfo } from 'graphql';
import type { AnyDrizzleDB } from '../types.ts';
import {
  attachTargetPrimaryKeys,
  buildNamedRelations,
  type DerivedTypeNameMapper,
  extractRelationsParams,
  getPrimaryKeyPropNamesFromConfig,
  memoizeTableConfig,
  type RelationFilterBase,
  resolveGeneratedTypeNames,
  resolveObjectTypeName,
  runRelationalSelect,
  type TypeNameMapper,
  type TypeNameResolver,
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
};

const contextCache = new WeakMap<object, SelectionContext>();

type TableConfigLookup = (table: Table) => { primaryKeys: { columns: { name: string }[] }[] };

// Cached per table, and bound at module scope so the cache is shared with every selection
// this process translates — the same memoization each dialect builder applies.
const getMySqlTableConfig = memoizeTableConfig(mysqlTableConfig as unknown as TableConfigLookup);
const getPgTableConfig = memoizeTableConfig(pgTableConfig as unknown as TableConfigLookup);
const getSQLiteTableConfig = memoizeTableConfig(sqliteTableConfig as unknown as TableConfigLookup);

/** The dialect's `getTableConfig`, which is the only place a composite primary key shows up. */
const tableConfigFor = (db: AnyDrizzleDB<any>): TableConfigLookup => {
  if (is(db, MySqlAsyncDatabase)) {
    return getMySqlTableConfig;
  }
  if (is(db, PgAsyncDatabase)) {
    return getPgTableConfig;
  }
  if (is(db, SQLiteAsyncDatabase)) {
    return getSQLiteTableConfig;
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
  const getTableConfig = tableConfigFor(db);
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

  const context: SelectionContext = {
    tables,
    relationMap,
    filterCtx: { tables, relationMap },
    primaryKeyOf,
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
};

/** The build's naming rule, reassembled from the three options a caller passes back. */
const namingRuleOf = (options: SelectionOptions): TypeNameResolver =>
  resolveGeneratedTypeNames({
    derivedTypeNameMapper: options.derivedTypeNameMapper,
    typeNamePrefix: options.typeNamePrefix,
    typeNameSuffix: options.typeNameSuffix,
  });

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

  const parsed = parseInfo(info);
  const params = extractRelationsParams(
    relationMap,
    tables,
    table,
    parsed,
    resolveObjectTypeName(table, typeNameMapper, resolveName),
    { typeNameMapper, filterCtx, resolveName },
  );
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
};

/**
 * Runs the read a generated select resolver would have run, against whichever executor is
 * given — the whole body, not just the `with` tree: selected columns, relation arguments,
 * eager loading, cursor pagination, and the transport remapping of the result.
 *
 * This is what an override usually wants after it has done its own work:
 *
 * ```ts
 * const rows = await resolveSelection(info, { db, table: 'Users', where, executor: tx });
 * ```
 *
 * Relation arguments and aggregate fields keep behaving as they do in the generated schema,
 * because it is the generated schema's own code path.
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
  } = options;
  const resolveName = namingRuleOf(options);
  const { tables, relationMap, filterCtx, primaryKeyOf } = contextFor(db);
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

  return runRelationalSelect({
    queryBase,
    tables,
    tableName,
    table,
    relationMap,
    typeName: resolveObjectTypeName(tableName, typeNameMapper, resolveName),
    typeNameMapper,
    resolveName,
    parsedInfo,
    single,
    where,
    orderBy,
    limit,
    offset,
    after,
    filterCtx,
    pkNames: primaryKeyOf(tableName),
    db: source,
  });
};
