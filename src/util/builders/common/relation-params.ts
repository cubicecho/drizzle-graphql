// Turning a parsed selection tree into the relational query builder's `with:` clause, and
// pruning the relations that opted out of eager loading.

import type { Table } from 'drizzle-orm';
import { is, One } from 'drizzle-orm';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import type { ProcessedTableSelectArgs, TableNamedRelations, TableSelectArgs } from '../types.ts';
import { isCursorFieldSelected } from './cursor.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import type { DefaultOrderByFor, LimitPolicyFor } from './limits.ts';
import { applyLimitPolicy, withDefaultOrderBy } from './limits.ts';
import type { TypeNameMapper } from './naming.ts';
import { resolveObjectTypeName } from './naming.ts';
import { extractOrderBy } from './order-by.ts';
import type { DeletedMode, ScopeResolver } from './policies.ts';
import { withScope } from './policies.ts';
import type { RelationFilterBase } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import { extractSelectedColumnsFromTree } from './selected-columns.ts';
import type { TypeNameResolver } from './type-names.ts';

/**
 * The build-wide policy the walk carries down unchanged. Grouped rather than passed
 * positionally because the recursion below re-passes every one of them as it descends, and
 * five of the six are object-or-undefined — a positional list of those is a silent hazard
 * (a caller that means "no limits, no scope" writes three bare `undefined`s in a row).
 */
export interface RelationParamsOptions {
  typeNameMapper?: TypeNameMapper;
  filterCtx?: RelationFilterBase;
  limits?: LimitPolicyFor;
  scope?: ScopeResolver;
  defaultOrderBy?: DefaultOrderByFor;
  resolveName?: TypeNameResolver;
}

export const extractRelationsParams = (
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  tables: Record<string, Table>,
  tableName: string,
  info: ResolveTree | undefined,
  typeName: string,
  options: RelationParamsOptions = {},
): Record<string, Partial<ProcessedTableSelectArgs>> | undefined => {
  const { typeNameMapper, filterCtx, limits, scope, defaultOrderBy, resolveName } = options;
  if (!info) {
    return undefined;
  }

  const relationsForTable = relationMap[tableName];
  if (!relationsForTable) {
    return undefined;
  }

  const baseField = Object.entries(info.fieldsByTypeName).find(([key, _value]) => key === typeName)?.[1];
  if (!baseField) {
    return undefined;
  }

  const args: Record<string, Partial<ProcessedTableSelectArgs>> = {};

  for (const [relName, relEntry] of Object.entries(relationsForTable)) {
    const { targetTableName, targetPkNames } = relEntry;
    // The relation field resolves to the target table's own type, e.g. "Posts" not "UsersPostsRelation".
    const relTypeName = resolveObjectTypeName(targetTableName, typeNameMapper, resolveName);
    // Look up by field name OR by alias (when the caller uses an alias for the relation).
    // The parsed tree keys fieldsByTypeName entries by response key, which is the alias.
    const field = baseField[relName] ?? Object.values(baseField).find((f) => (f as ResolveTree).name === relName);
    if (!field) {
      continue;
    }

    // The `with:` clause is keyed by relation name, so one relation selected twice under
    // different aliases has no eager representation: the first selection's args and column
    // set would win, and both aliases would then read the same pre-fetched array off the
    // parent — wrong rows for the loser, and missing columns it selected. Drizzle's RQB
    // cannot fetch one relation twice under two keys, so there is no eager fix. Leave the
    // relation out of `with:` and let every alias resolve through the field resolver's
    // batch loader, which keys its loader by the serialized args and so is per-alias
    // correct (and still batched across parents).
    const selectionCount = Object.values(baseField).reduce(
      (n, f) => n + ((f as ResolveTree).name === relName ? 1 : 0),
      0,
    );
    if (selectionCount > 1) {
      continue;
    }
    const relField = (field as ResolveTree)?.fieldsByTypeName;
    const relFieldSelection = relField?.[relTypeName];

    // Guard: if the relation type is not in fieldsByTypeName, this field is
    // either an aliased scalar column (not an actual relation) or the relation
    // was not selected in the query. Skip it in both cases.
    if (!relFieldSelection) {
      continue;
    }

    // `after`, `distinct` and the `cursor` field are the relation-level half of the root
    // list's keyset and distinct machinery, and drizzle's `with:` clause can express none of
    // them: keyset needs a predicate over the request's own total order, distinct needs a
    // window pass, and a cursor has to be computed from the raw row. As with an aliased
    // relation above, the fix is to leave the relation out of the eager clause — the field
    // resolver's batch loader implements all three, still in one query per relation.
    const eagerArgs = (field as ResolveTree).args as Partial<TableSelectArgs> | undefined;
    if (
      !is((relEntry as any).relation ?? relEntry, One) &&
      (eagerArgs?.after != null ||
        !!(eagerArgs?.distinct as string[] | undefined)?.length ||
        isCursorFieldSelected(relFieldSelection, tables[targetTableName]!))
    ) {
      continue;
    }

    const columns = extractSelectedColumnsFromTree(relFieldSelection, tables[targetTableName]!, {
      tableName: targetTableName,
      relationMap,
      tables,
      allRelations: filterCtx?.relationMap,
    });

    const thisRecord: Partial<ProcessedTableSelectArgs> = {};
    thisRecord.columns = columns;

    const relationField = Object.values(baseField).find((e) => e.name === relName);
    // The eager path reads its arguments off the AST rather than through the relation field's
    // resolver, so the target's default ordering has to be substituted here too — otherwise
    // an eagerly loaded relation would come back in a different order from a lazily loaded one.
    const relationArgs: Partial<TableSelectArgs> | undefined = is(relEntry.relation, One)
      ? relationField?.args
      : relationField && withDefaultOrderBy(relationField.args ?? {}, targetTableName, defaultOrderBy);

    const offset = relationArgs?.offset ?? undefined;
    // The eager path reads its arguments off the AST rather than through the relation field's
    // resolver, so the policy has to be applied here too — otherwise an eagerly loaded
    // relation would be the one way around it. A to-one relation takes no `limit` and is a
    // single row by definition, so it is left alone.
    const limit = is(relEntry.relation, One)
      ? (relationArgs?.limit ?? undefined)
      : applyLimitPolicy(relationArgs?.limit, limits?.(targetTableName), {
          table: targetTableName,
          operation: 'relation',
          relation: relName,
        });

    // drizzle-orm v1 RQB calls both `where` and `orderBy` callbacks with an
    // aliased table proxy (e.g. d0, d1). Pass the proxy through so column
    // references in the generated SQL match the CTE alias rather than the
    // original unaliased table name.
    const relWhere = relationArgs?.where;
    // A relation field's soft-delete default is the target's, not the root default — a
    // required to-one relation, and a table declared `scope: 'root'`, both read INCLUDE.
    const relDeleted =
      ((relationArgs as any)?.deleted as DeletedMode | undefined) ??
      scope?.relationDefault(
        targetTableName,
        is(relEntry.relation, One) && (relEntry.relation as any).optional === false,
      );
    // The eager path is the one read that never passes through the relation field's own
    // resolver, so the target's scope has to be applied here as well — otherwise selecting a
    // relation would be the way around it.
    thisRecord.where =
      relWhere || scope?.has(targetTableName, relDeleted)
        ? {
            RAW: (aliasedTable: Table) =>
              withScope(
                scope,
                targetTableName,
                aliasedTable,
                relWhere
                  ? extractFilters(aliasedTable, relName, relWhere, relationFilterCtx(filterCtx, targetTableName))
                  : undefined,
                relDeleted,
              ),
          }
        : undefined;
    // When a relation is paginated (limit/offset) but unordered, default to the target's
    // primary key so the per-parent slice is deterministic. Drizzle's RQB calls orderBy
    // with the aliased table proxy, so resolve the PK columns from it. targetPkNames is
    // resolved at build time and includes composite keys.
    const hasPagination = offset != null || limit != null;
    const pkNames = targetPkNames ?? [];
    thisRecord.orderBy = relationArgs?.orderBy
      ? (aliasedTable: Table) =>
          extractOrderBy(aliasedTable, relationArgs.orderBy!, relationFilterCtx(filterCtx, targetTableName), relWhere)
      : hasPagination && pkNames.length
        ? (aliasedTable: Table) => primaryKeyOrderExprs(aliasedTable, pkNames)
        : undefined;
    thisRecord.offset = offset;
    thisRecord.limit = limit;

    const relWith = extractRelationsParams(relationMap, tables, targetTableName, relationField, relTypeName, options);
    thisRecord.with = relWith;

    args[relName] = thisRecord;
  }

  return args;
};

/**
 * Returns a copy of `relationMap` containing only the relations that should be eagerly
 * pre-fetched (per the `shouldEagerLoad` predicate). Pass the result wherever a query or
 * mutation resolver builds its `with:` clause; pass the full map to type generation so
 * opted-out relations still get a (lazily-resolved) field. Relations excluded here are
 * never added to `with:`, so they don't overfetch — they resolve through their field
 * resolver instead (or a resolver you override, e.g. via `@graphql-tools/schema`).
 */
export const pruneNonEagerRelations = (
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  shouldEagerLoad: (tableName: string, relationName: string) => boolean,
): Record<string, Record<string, TableNamedRelations>> => {
  const out: Record<string, Record<string, TableNamedRelations>> = {};
  for (const [tableName, rels] of Object.entries(relationMap)) {
    out[tableName] = Object.fromEntries(
      Object.entries(rels).filter(([relationName]) => shouldEagerLoad(tableName, relationName)),
    );
  }
  return out;
};
