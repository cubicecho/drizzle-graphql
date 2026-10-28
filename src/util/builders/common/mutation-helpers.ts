// Pieces the generated mutations share: the relation columns a write has to prepare, the batch
// update's input type, the filters a write requires, and the write-count return type.

import type { Column, Table } from 'drizzle-orm';
import { and, getColumns, is, type SQL, sql } from 'drizzle-orm';
import { PgDoublePrecision, PgReal } from 'drizzle-orm/pg-core';
import type { GraphQLFieldConfigArgumentMap } from 'graphql';
import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { capitalize } from '../../case-ops/index.ts';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import { parseResolveInfo } from '../../parse-resolve-info.ts';
import { remapUpdateInput } from '../field-updates.ts';
// Type-only: the nested-write module imports this one at runtime, so the dependency has to
// stay one-directional. The implementation is injected by the dialect builder.
import type { NestedWriteRuntime } from '../nested-writes/runtime.ts';
import type { CreatedResolver, Filters, ProcessedTableSelectArgs, TableNamedRelations } from '../types.ts';
import { drizzleError } from './errors.ts';
import { isMySqlSingleFloat, MATCHES_EVERY_ROW } from './filters.ts';
import { withPrimaryKeyColumns } from './keys.ts';
import type { DefaultOrderByFor, LimitPolicyFor } from './limits.ts';
import type { DeletedMode, ResolverPolicies, RowVisibility } from './policies.ts';
import { stripContextValues, withRowVisibility } from './policies.ts';
import type { RelationFilterBase, RelationFilterContext } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import { extractRelationsParams } from './relation-params.ts';
import { eagerLoadMutationRelations } from './select-runtime.ts';
import { extractSelectedColumnsFromTreeSQLFormat } from './selected-columns.ts';
import type { MutationTxCtx } from './transactions.ts';
import type { TypeCacheCtx } from './type-cache.ts';
import type { TypeNameMapper, TypeNameResolver } from './type-names.ts';
import { resolveObjectTypeName } from './type-names.ts';
import { writeResolver } from './write-scaffold.ts';

/**
 * The `hard` argument on the delete mutations of a soft-deleting table that opted into
 * `hardDelete`. One config shared by every such field — argument configs carry no per-field
 * state — and generated nowhere else, so the schema says which tables can be purged.
 */
export const hardDeleteArg = {
  type: GraphQLBoolean,
  defaultValue: false,
  description:
    'Remove the matched rows instead of marking them deleted. Reads at `INCLUDE`, so it reaches rows that are already marked; a `scope` still confines what it can reach.',
} as const;

/**
 * Computes the RETURNING columns and relation selection for a mutation resolver: extracts
 * the selected scalar columns, determines whether any relations were selected, and only
 * then forces the primary key into the column set (so the post-mutation eager-load can
 * re-key rows). Returns everything the resolver needs to decide whether to eager-load.
 */
export interface PrepareMutationRelationColumnsParams {
  /** The eager-load map: the relations the re-fetch attaches through `with:`. */
  eagerRelations: Record<string, Record<string, TableNamedRelations>>;
  /**
   * The build's relation-filter context. Its `namedRelations` is every relation, including the ones
   * `eagerLoadRelations` leaves to their own resolver, which still need their join column (and
   * the primary key) in RETURNING; and a relation argument that filters or orders through a
   * relation needs it to compile in the re-fetch. Required so no write path can leave it off.
   */
  filterCtx: RelationFilterBase | undefined;
  tables: Record<string, Table>;
  tableName: string;
  typeName: string;
  typeNameMapper: TypeNameMapper | undefined;
  table: Table;
  pkNames: readonly string[];
  parsedInfo: ResolveTree;
  limits?: LimitPolicyFor;
  visibility?: RowVisibility;
  defaultOrderBy?: DefaultOrderByFor;
  /** The build's type-naming rule — the selection tree is keyed by the name it produced. */
  resolveName?: TypeNameResolver;
}

export const prepareMutationRelationColumns = (
  params: PrepareMutationRelationColumnsParams,
): {
  columns: Record<string, Column>;
  hasRelations: boolean;
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined;
} => {
  const { eagerRelations, filterCtx, tables, tableName, typeNameMapper, table, pkNames, parsedInfo, resolveName } =
    params;
  const typeName = resolveObjectTypeName(tableName, typeNameMapper, resolveName);
  const withParams = eagerRelations[tableName]
    ? extractRelationsParams(eagerRelations, tables, tableName, parsedInfo, typeName, {
        typeNameMapper,
        filterCtx,
        limits: params.limits,
        visibility: params.visibility,
        defaultOrderBy: params.defaultOrderBy,
        resolveName,
      })
    : undefined;
  const hasRelations = !!(withParams && Object.keys(withParams).length);
  const baseColumns = extractSelectedColumnsFromTreeSQLFormat(parsedInfo.fieldsByTypeName[typeName]!, table, {
    tableName,
    eagerRelations,
    tables,
    namedRelations: filterCtx?.namedRelations,
  });
  const columns = hasRelations ? withPrimaryKeyColumns(baseColumns, table, pkNames) : baseColumns;
  return { columns, hasRelations, withParams };
};

/**
 * The prologue every write resolver runs: parse the resolve info, then work out the columns
 * to return and the relations to eager-load from it. `parsedInfo` comes back too — the delete
 * resolver reads its own columns off the tree rather than taking the prepared set.
 */
export const mutationSelection = (
  info: any,
  params: Omit<PrepareMutationRelationColumnsParams, 'parsedInfo'>,
): {
  parsedInfo: ResolveTree;
  columns: Record<string, Column>;
  hasRelations: boolean;
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined;
} => {
  const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
  return { parsedInfo, ...prepareMutationRelationColumns({ ...params, parsedInfo }) };
};

/**
 * The `where` a write runs under: the caller's filters — required when the mutation refuses to
 * run unbounded — with the row scope ANDed on last, so a supplied filter can only narrow the
 * scope and never widen it. An out-of-scope row is simply not matched.
 *
 * `deleted` states which soft-delete mode the match reads at, for the writes that need one:
 * `restore` sees only marked rows, a hard delete has to see them too.
 */
export const visibleWhere = <TTable extends Table>(params: {
  visibility: RowVisibility | undefined;
  tableName: string;
  table: TTable;
  where: Filters<TTable> | undefined;
  relationCtx?: RelationFilterContext;
  /** The single-row writes always require a `where`; the plural ones do under `requireWhere`. */
  required?: boolean;
  deleted?: DeletedMode;
}): SQL | undefined => {
  const { visibility, tableName, table, where, relationCtx, required, deleted } = params;
  return withRowVisibility(
    visibility,
    tableName,
    table,
    required
      ? extractRequiredFilters(table, tableName, where, relationCtx)
      : where
        ? extractFilters(table, tableName, where, relationCtx)
        : undefined,
    deleted,
  );
};

/**
 * The epilogue: the written rows with their selected relations attached, or the rows as they
 * came back when the selection asked for no relation at all.
 */
export const withEagerRelations = (
  executor: any,
  tableName: string,
  rows: any[],
  pkNames: readonly string[],
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined,
  hasRelations: boolean,
): Promise<any[]> | any[] =>
  hasRelations ? eagerLoadMutationRelations(executor, tableName, rows, pkNames, withParams) : rows;

/**
 * The per-entry input of `update<Table>Many`: `{ where, set }`, reusing the table's
 * update `set` input and filter input. Shared by all three dialect builders.
 */
export const generateUpdateManyInput = (params: {
  tableName: string;
  typeName: string;
  updatePrefix: string;
  updateInput: GraphQLInputObjectType;
  tableFilters: GraphQLInputObjectType;
  cacheCtx: TypeCacheCtx;
}): GraphQLInputObjectType => {
  const { tableName, typeName, updatePrefix, updateInput, tableFilters, cacheCtx } = params;
  return new GraphQLInputObjectType({
    name: cacheCtx.resolveName({
      kind: 'updateManyInput',
      defaultName: `${capitalize(updatePrefix)}${typeName}ManyInput`,
      table: tableName,
    }),
    description: `One entry of a batch update of ${typeName}: the rows \`where\` matches get this entry's \`set\` applied.`,
    fields: {
      where: {
        type: tableFilters,
        description: 'Rows this entry updates. An omitted filter updates every row.',
      },
      set: {
        type: new GraphQLNonNull(updateInput),
      },
    },
  });
};

/**
 * Extracts a `where` argument that a mutation refuses to run without: missing, or present
 * but compiling to "matches every row" (`where: {}`, `notInArray: []`, `NOT: { inArray: [] }`),
 * both throw instead of becoming an unbounded write. Used by the `Single` write variants always
 * and by the plural update/delete mutations when `features.requireWhere` is on.
 */
export const extractRequiredFilters = <TTable extends Table>(
  table: TTable,
  tableName: string,
  where: Filters<TTable> | undefined,
  relationCtx?: RelationFilterContext,
): SQL => {
  const filters = where ? extractFilters(table, tableName, where, relationCtx) : MATCHES_EVERY_ROW;
  if (filters === MATCHES_EVERY_ROW) {
    throw drizzleError(
      "A 'where' argument with at least one filter is required — this mutation does not run unbounded. A filter that matches every row, such as `{}` or `notInArray: []`, counts as none.",
      { code: 'DRIZZLE_WHERE_REQUIRED' },
    );
  }
  return filters;
};

/**
 * How many rows a returnless write reported affecting. The three dialects' drivers each
 * spell it differently — `rowCount` (node-postgres, Neon), `affectedRows` (PGlite, and MySQL
 * on its result header), `count` (postgres.js), `rowsAffected` (libsql), `changes`
 * (better-sqlite3) — and none of them is reachable through a common drizzle type, so the
 * shape is probed rather than declared.
 *
 * Only the result object itself is read, plus `affectedRows` one level in, since MySQL
 * returns `[header, fields]`. A row of the table is never inspected, so a table with a
 * column named `count` cannot be mistaken for a count.
 */
export const rowsAffected = (result: any): number => {
  const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : undefined;

  if (result && typeof result === 'object') {
    for (const key of ['rowCount', 'affectedRows', 'rowsAffected', 'changes', 'count']) {
      const value = asNumber((result as any)[key]);
      if (value !== undefined) {
        return value;
      }
    }
    const header = Array.isArray(result) ? result[0] : undefined;
    const affected = header && typeof header === 'object' ? asNumber(header.affectedRows) : undefined;
    if (affected !== undefined) {
      return affected;
    }
  }

  throw drizzleError('The driver did not report how many rows the write affected.', {
    code: 'DRIZZLE_ROW_COUNT_UNAVAILABLE',
  });
};

/** Alias prefix for the key columns {@link narrowToSingleMatch} reads. */
const KEY_ALIAS_PREFIX = '__single_key_';

/**
 * How {@link narrowToSingleMatch} reads a key column and matches the value it read. Most keys are
 * read raw (no `mapWith`) and bound back as they are, which names the same value. A float key's
 * raw read need not:
 *
 * - PostgreSQL prints `real` / `double precision` with `extra_float_digits`, and below 1 that is
 *   rounded (`0.12345679` reads as `0.123457`), so the bound value matches no row. The key is
 *   read and matched as the hex of its binary form (`float4send` / `float8send`) instead.
 * - MySQL prints a single-precision `float` with 6 significant digits, and compares it with a
 *   bound value in double precision, so even `0.1` reads back as a different number. It is read
 *   as `cast(… as double)`, which is exact and prints exactly, and matched as it is.
 *
 * SQLite stores a REAL as a double and hands it to the driver as one, so it reads exactly. Number
 * mode `numeric` / `decimal` / 64-bit keys read exactly too: the drivers return them as strings
 * (or a BigInt) where a JS number would round, and the raw read skips the column's `mapWith`.
 */
const keyAccess = (column: Column): { read: SQL; matches: (value: unknown) => SQL } => {
  if (is(column, PgReal) || is(column, PgDoublePrecision)) {
    const bits = sql`encode(${sql.raw(is(column, PgReal) ? 'float4send' : 'float8send')}(${column}), 'hex')`;
    return { read: bits, matches: (value) => sql`${bits} = ${value}` };
  }
  const matches = (value: unknown) => sql`${column} = ${value}`;
  return isMySqlSingleFloat(column)
    ? { read: sql`cast(${column} as double)`, matches }
    : { read: sql`${column}`, matches };
};

/**
 * The `where` a `Single` update or delete runs with. It checks that `filters` matches at most
 * one row and narrows it to that row's key, so a row that starts matching between the check and
 * the write is never written.
 *
 * `keySets` are the table's candidates from `keys.getRowKeyCandidates`: the primary key, else a
 * NOT NULL unique key, else the nullable unique keys. The first set the checked row holds a
 * value in every column of is used — a NULL names no single row. When none does (or the table
 * has no key), the write keeps `filters`, and a row arriving between check and write is written
 * too. A check that found nothing writes nothing, key or not.
 */
export const narrowToSingleMatch = async (
  executor: any,
  table: Table,
  filters: SQL,
  keySets: readonly (readonly string[])[],
): Promise<SQL> => {
  const columns = getColumns(table) as Record<string, Column>;
  const keyNames = [...new Set(keySets.flat())];
  const aliasOf = (name: string) => `${KEY_ALIAS_PREFIX}${keyNames.indexOf(name)}`;
  const access = Object.fromEntries(keyNames.map((name) => [name, keyAccess(columns[name]!)]));
  // Each key is read in a form that binds back exactly as the database holds it (`keyAccess`).
  const probe = keyNames.length
    ? Object.fromEntries(keyNames.map((name) => [aliasOf(name), access[name]!.read]))
    : { found: sql`1` };
  const matched = await executor.select(probe).from(table).where(filters).limit(2);
  if (matched.length > 1) {
    throw drizzleError("'where' matched more than one row — nothing was written!", {
      code: 'DRIZZLE_MULTI_ROW_MATCH',
    });
  }
  const [found] = matched;
  if (!found) {
    // Nothing matched when checked, so a row arriving afterwards is not written either.
    return sql`1 = 0`;
  }
  const keySet = keySets.find((set) => set.every((name) => found[aliasOf(name)] != null));
  if (!keySet) {
    return filters;
  }
  return and(filters, ...keySet.map((name) => access[name]!.matches(found[aliasOf(name)])))!;
};

/**
 * `update<Tables>Count` / `delete<Tables>Count` — the plural write without the payload
 * (`features.countMutations`).
 *
 * The plural `update` and `delete` always `RETURNING *`, which is the wrong shape for
 * "archive everything older than a year": the caller pays to ship rows it does not want, and
 * on a large match that cost is the whole mutation. These return `Int!` instead — how many
 * rows the write touched.
 *
 * Leaving the payload off changes nothing else: the write obeys every rule of the plural
 * mutation it mirrors, through the same {@link writeResolver} scaffolding.
 *
 * - `scope` (and the soft-delete marker) is ANDed into the `where`, so only rows the plural
 *   write could reach are counted and written.
 * - On a soft-deleting table the delete is the marking `UPDATE`, not a `DELETE`, and rows that
 *   are already marked are not matched; the update skips marked rows too. `hard: true` exists
 *   exactly where the plural delete takes it.
 * - Context-derived columns are stripped from the update's `set`, as the plural update does.
 * - `onWrite` hooks run `before` and `after`, inside a transaction. The `after` hook is handed
 *   rows, so a table with one pays for a `RETURNING` — of the columns the hook names in
 *   `columns`, or of the primary key when it names none (the whole row on a table without a
 *   key) — and the count is the number of rows returned. Every other write, and every write on
 *   MySQL (no `RETURNING`; its hooks see `rows: []` as on every MySQL mutation), skips the
 *   `RETURNING` and reads the count off the driver's result via {@link rowsAffected}.
 */
export const generateWriteCount = ({
  db,
  tableName,
  table,
  kind,
  setArgs,
  filterArgs,
  fieldName,
  requireWhere,
  filterCtx,
  txCtx,
  nested,
  policies,
  pkNames = [],
  returnsRows,
  writeFilter,
}: {
  db: any;
  tableName: string;
  table: Table;
  kind: 'update' | 'delete';
  /** The update `set` input; omitted for the delete variant, which has nothing to set. */
  setArgs?: GraphQLInputObjectType;
  filterArgs: GraphQLInputObjectType;
  fieldName: string;
  requireWhere: boolean;
  filterCtx?: RelationFilterBase;
  txCtx?: MutationTxCtx;
  nested?: NestedWriteRuntime;
  policies?: ResolverPolicies;
  /** The table's primary-key property names: what an `after` hook that named no columns gets. */
  pkNames?: readonly string[];
  /** Whether the dialect has `RETURNING` (false on MySQL), which an `after` hook's rows need. */
  returnsRows: boolean;
  /**
   * Rewrites the `where` into a form the dialect accepts on a write (MySQL; see
   * `mysqlWriteFilter`). It may read the table, so it runs on the executor after `before`.
   */
  writeFilter?: (filters: SQL, executor: any) => Promise<SQL>;
}): CreatedResolver => {
  const softDelete = kind === 'delete' ? policies?.softDelete?.(tableName) : undefined;
  // The plural delete's rule: only a soft-deleting table that opted in can purge.
  const canHardDelete = softDelete?.hardDelete === true;
  const queryArgs = {
    ...(setArgs ? { set: { type: new GraphQLNonNull(setArgs) } } : {}),
    where: {
      type: requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
    },
    ...(canHardDelete ? { hard: hardDeleteArg } : {}),
  } as GraphQLFieldConfigArgumentMap;

  // Only an `after` hook is handed rows, so only a table with one gives up the returnless write.
  const readsRows = returnsRows && !!policies?.onWrite?.(tableName, kind)?.after;
  // What the `after` hook's rows carry when it named no `columns`: the key, which identifies
  // each written row without shipping the rest of it — or the whole row when there is no key.
  const allColumns = getColumns(table) as Record<string, Column>;
  const keyColumns: Record<string, Column> = pkNames.length
    ? Object.fromEntries(pkNames.map((name) => [name, allColumns[name]!]))
    : allColumns;

  return writeResolver<{ where?: Filters<Table>; set?: Record<string, any>; hard?: boolean }>({
    db,
    tableName,
    operation: kind,
    single: false,
    fieldName,
    txCtx,
    policies,
    args: queryArgs,
    run: async ({ executor, args, context, before, after, returning }) => {
      const { where, set } = args;
      // `canHardDelete` decides whether the argument exists; this decides what it does, so a
      // stitched-in `hard: true` on a table that never opted in stays a soft delete.
      const hard = canHardDelete && args.hard === true;
      const visibility = policies?.visibility?.(context);

      let query: any;
      if (kind === 'delete') {
        query =
          softDelete && !hard
            ? executor.update(table).set({ [softDelete.columnName]: softDelete.writeDeleted() })
            : executor.delete(table);
      } else {
        // Nested writes need the parent rows they attach to, which is exactly what this
        // mutation exists not to fetch — so they are refused rather than silently dropped.
        const entry = nested?.enabled(tableName) ? nested.split(tableName, set!) : undefined;
        if (entry && nested!.hasOps(entry.ops)) {
          throw drizzleError(
            'This mutation does not support nested writes — use the one that returns the rows instead.',
            { code: 'DRIZZLE_NESTED_WRITES_UNSUPPORTED' },
          );
        }
        // A context-derived column is the server's to set, so an update never reassigns one.
        const values = stripContextValues(
          remapUpdateInput(entry ? entry.columns : set!, table, tableName),
          policies?.contextValues?.(tableName),
        );
        if (!Object.keys(values).length) {
          throw drizzleError('Unable to update with no values specified!', {
            code: 'DRIZZLE_NO_VALUES',
          });
        }
        query = executor.update(table).set(values);
      }

      // The scope — and on a soft-deleting table the not-yet-marked predicate — is ANDed on
      // last, so a caller's `where` can only narrow what the write reaches.
      const filters = visibleWhere({
        visibility,
        tableName,
        table,
        where,
        relationCtx: relationFilterCtx(filterCtx, tableName, visibility),
        required: requireWhere,
        // A hard delete reads at INCLUDE, so it reaches the rows that are already marked.
        deleted: hard ? 'INCLUDE' : undefined,
      });
      // Every check above reads only the arguments, so a rejected request never reaches the hook.
      await before();
      if (filters) {
        query = query.where(writeFilter ? await writeFilter(filters, executor) : filters);
      }

      if (!readsRows) {
        const result = await query;
        await after();
        return rowsAffected(result);
      }

      // The client selected nothing, so the rows hold only what the hook asked for.
      const named = returning({});
      const rows = (await query.returning(Object.keys(named).length ? named : keyColumns)) as any[];
      await after(rows);
      return rows.length;
    },
  });
};
