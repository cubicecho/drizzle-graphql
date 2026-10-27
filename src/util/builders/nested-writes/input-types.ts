// The relation fields nested writes add to a table's create, update and upsert inputs.

import type { Column } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInputObjectType, type GraphQLInputType, GraphQLList, GraphQLNonNull } from 'graphql';
import { capitalize } from '../../case-ops/index.ts';
import { drizzleColumnToGraphQLType } from '../../type-converter/index.ts';
import { isWritableColumn } from '../common/writable-columns.ts';
import type { NestedWriteOp } from '../common/write-hooks.ts';
import { resolveTypeName, type TypeCacheCtx, type TypeNameMapper, visibleColumns } from '../common.ts';

import { isOptionalOnInsert, type NestedRelationPlan, type NestedWritePlans } from './plans.ts';

/**
 * The extra input fields nested writes add to a table's create and update inputs, plus the
 * columns whose NOT NULL requirement the create input has to relax.
 */
export type NestedWriteTypes = {
  /** Relation fields for `Create<Table>Input`, empty when the table has no writable relation. */
  createFields: (
    tableName: string,
    typeName: string,
  ) => Record<string, { type: GraphQLInputType; description: string }>;
  /** Relation fields for `Update<Table>Input`. */
  updateFields: (
    tableName: string,
    typeName: string,
  ) => Record<string, { type: GraphQLInputType; description: string }>;
  /**
   * Relation fields for `Upsert<Table>Input`: what the update input offers, since the row may
   * already exist, applied the same way on either branch (see {@link wrapperType}).
   */
  upsertFields: (
    tableName: string,
    typeName: string,
  ) => Record<string, { type: GraphQLInputType; description: string }>;
  /** Whether the table has any writable relation, and so needs an upsert input of its own. */
  hasRelations: (tableName: string) => boolean;
  /**
   * Columns a relation on the same input can fill in, which therefore cannot stay required:
   * `authorId` is NOT NULL, but `author: { create: … }` supplies it.
   */
  relaxedColumns: (tableName: string) => ReadonlySet<string>;
};

const NO_COLUMNS: ReadonlySet<string> = new Set();

/** Which root input a relation field's operations input belongs to. */
type WrapperMode = 'create' | 'update' | 'upsert';

/**
 * Builds the nested-write input types for a schema.
 *
 * Every field map is produced lazily, from inside the enclosing input type's own thunk: the
 * operand of `connect` is the target table's `Filters` input, which does not exist yet while
 * the first table's types are being generated.
 */
export const createNestedWriteTypes = (params: {
  plans: NestedWritePlans;
  cacheCtx: TypeCacheCtx;
  typeNameMapper: TypeNameMapper | undefined;
}): NestedWriteTypes => {
  const { plans, cacheCtx, typeNameMapper } = params;
  const wrapperCache = new Map<string, GraphQLInputObjectType>();
  const payloadCache = new Map<string, GraphQLInputObjectType>();

  /**
   * `<Type><Relation>NestedCreatePayloadInput` — the row a nested `create` inserts. Built from
   * the target's columns rather than from its create input: the join column this relation
   * fills in is left out (setting it by hand could point the new row somewhere other than its
   * parent), and the nesting stops here, so the type carries no relation fields of its own.
   *
   * The name shares the wrapper's `<Type><Relation>Nested…` segment rather than reading
   * `Create<Type><Relation>Input`, which lands in the same namespace as a table's own create
   * input: `item.type` spells `CreateItemTypeInput`, and so does a sibling table named
   * `itemType`. Two types of that name is a schema that cannot be built at all, and
   * `nestedWrites` is a whole-schema flag, so one such pair made it unusable.
   */
  const payloadType = (tableName: string, typeName: string, plan: NestedRelationPlan): GraphQLInputObjectType => {
    const key = `${tableName}.${plan.relationName}`;
    const cached = payloadCache.get(key);
    if (cached) {
      return cached;
    }

    const omitted = plan.fkSide === 'child' ? plan.foreignColPropName : undefined;
    // Same rule as the table's own create input, minus the key the parent row supplies.
    const fields = Object.fromEntries(
      Object.entries(visibleColumns(plan.targetTable))
        .filter(
          ([columnName, column]) =>
            columnName !== omitted && isWritableColumn(cacheCtx, plan.targetTableName, columnName, column as Column),
        )
        .map(([columnName, column]) => [
          columnName,
          drizzleColumnToGraphQLType(column as Column, columnName, plan.targetTableName, false, true, true),
        ]),
    );

    const type = new GraphQLInputObjectType({
      name: cacheCtx.resolveName({
        kind: 'nestedWriteInput',
        defaultName: `${typeName}${capitalize(plan.relationName)}NestedCreatePayloadInput`,
        table: tableName,
        operation: plan.relationName,
      }),
      description:
        omitted === undefined
          ? `A new ${resolveTypeName(plan.targetTableName, typeNameMapper)} row for ${typeName}.${plan.relationName}`
          : `A new ${resolveTypeName(plan.targetTableName, typeNameMapper)} row for ${typeName}.${plan.relationName}. \`${omitted}\` is set from the ${typeName} row this is written with.`,
      fields,
    });
    payloadCache.set(key, type);
    return type;
  };

  /** The target's `Filters` input, which every `connect` / `disconnect` / `set` selects with. */
  const targetFilters = (plan: NestedRelationPlan): GraphQLInputObjectType | undefined =>
    cacheCtx.filterTypeCache.get(plan.targetTable);

  const listOf = (type: GraphQLInputObjectType) => new GraphQLList(new GraphQLNonNull(type));

  /**
   * `<Type><Relation>NestedCreateInput` / `<Type><Relation>NestedUpdateInput` /
   * `<Type><Relation>NestedUpsertInput` — the operations offered on one relation. The create
   * variant has no `disconnect` or `set`: a row that does not exist yet has nothing attached
   * to detach or replace.
   *
   * The upsert variant offers what the update one does, because the row may already exist.
   * Its operations run the same way on both branches: on a row the upsert just inserted there
   * is nothing attached yet, so `set` only attaches and `disconnect` finds nothing to detach.
   *
   * A many-to-many relation offers no `create`: inserting a row *and* linking it is two
   * writes to two tables, and the link half is what the relation field is for. Its
   * `disconnect` and `set` do not depend on nullability, since breaking a link deletes a
   * junction row rather than nulling a column that might be NOT NULL.
   *
   * Each input is also subject to `plan.allowed` — the table it writes has to have that
   * write turned on (see {@link gateNestedWritePlans}).
   */
  const wrapperType = (
    tableName: string,
    typeName: string,
    plan: NestedRelationPlan,
    mode: WrapperMode,
  ): GraphQLInputObjectType | undefined => {
    const key = `${tableName}.${plan.relationName}.${mode}`;
    const cached = wrapperCache.get(key);
    if (cached) {
      return cached;
    }

    const filters = targetFilters(plan);
    const targetTypeName = resolveTypeName(plan.targetTableName, typeNameMapper);
    const fields: Record<string, { type: GraphQLInputType; description: string }> = {};

    const forUpdate = mode !== 'create';
    const upsert = mode === 'upsert';
    const offers = (op: NestedWriteOp) => plan.allowed.has(op);
    // What `disconnect` and `set` mean when the upsert inserted the row instead.
    const onInsert = upsert ? ' Does nothing when the upsert inserts the row.' : '';
    const setOnInsert = upsert ? ' When the upsert inserts the row, this only attaches.' : '';

    if (plan.through) {
      // Without a `Filters` input there is no way to name the rows to link, and `create` is
      // not offered here.
      if (filters && offers('connect')) {
        fields['connect'] = {
          type: listOf(filters),
          description: `Link every existing ${targetTypeName} row these match. Already-linked rows are left alone.`,
        };
      }
      if (filters && forUpdate && offers('disconnect')) {
        fields['disconnect'] = {
          type: listOf(filters),
          description: `Unlink every linked ${targetTypeName} row these match, leaving the rows in place.${onInsert}`,
        };
      }
      if (filters && forUpdate && offers('set')) {
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: unlink everything linked, then link every ${targetTypeName} row these match. \`set: []\` clears the relation. Applied before \`disconnect\` and \`connect\`.${setOnInsert}`,
        };
      }
    } else if (plan.isOne) {
      if (offers('create')) {
        fields['create'] = {
          type: payloadType(tableName, typeName, plan),
          description: `Insert a ${targetTypeName} row and attach it`,
        };
      }
      if (filters && offers('connect')) {
        fields['connect'] = {
          type: filters,
          description: `Attach the existing ${targetTypeName} row this matches. Must match exactly one row.`,
        };
      }
      if (forUpdate && offers('disconnect')) {
        fields['disconnect'] = {
          type: GraphQLBoolean,
          description: `Detach the currently attached ${targetTypeName} row, leaving it in place.${onInsert}`,
        };
      }
    } else {
      if (offers('create')) {
        fields['create'] = {
          type: listOf(payloadType(tableName, typeName, plan)),
          description: `Insert these ${targetTypeName} rows and attach them`,
        };
      }
      if (filters && offers('connect')) {
        fields['connect'] = {
          type: listOf(filters),
          description: `Attach every existing ${targetTypeName} row these match`,
        };
      }
      if (filters && forUpdate && offers('disconnect')) {
        fields['disconnect'] = {
          type: listOf(filters),
          description: `Detach every attached ${targetTypeName} row these match, leaving the rows in place.${onInsert}`,
        };
      }
      if (filters && forUpdate && offers('set')) {
        fields['set'] = {
          type: listOf(filters),
          description: `Replace the whole set: detach everything attached, then attach every ${targetTypeName} row these match. Applied before \`disconnect\`, \`connect\` and \`create\`.${setOnInsert}`,
        };
      }
    }

    // The target's (or junction's) features can leave a relation with nothing on it, and a
    // GraphQL input object needs at least one field — so the relation is left out instead.
    if (!Object.keys(fields).length) {
      return undefined;
    }

    const type = new GraphQLInputObjectType({
      name: cacheCtx.resolveName({
        kind: 'nestedWriteInput',
        defaultName: `${typeName}${capitalize(plan.relationName)}Nested${capitalize(mode)}Input`,
        table: tableName,
        operation: plan.relationName,
      }),
      description: `Writes through ${typeName}.${plan.relationName}`,
      fields,
    });
    wrapperCache.set(key, type);
    return type;
  };

  const relationFields = (tableName: string, typeName: string, mode: WrapperMode) => {
    const tablePlans = plans[tableName];
    if (!tablePlans) {
      return {};
    }
    return Object.fromEntries(
      Object.values(tablePlans).flatMap((plan) => {
        const wrapper = wrapperType(tableName, typeName, plan, mode);
        return wrapper
          ? [[plan.relationName, { type: wrapper, description: `Writes through ${typeName}.${plan.relationName}` }]]
          : [];
      }),
    );
  };

  return {
    createFields: (tableName, typeName) => relationFields(tableName, typeName, 'create'),
    updateFields: (tableName, typeName) => relationFields(tableName, typeName, 'update'),
    upsertFields: (tableName, typeName) => relationFields(tableName, typeName, 'upsert'),
    hasRelations: (tableName) => !!plans[tableName],
    relaxedColumns: (tableName) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return NO_COLUMNS;
      }
      const relaxed = new Set<string>();
      for (const plan of Object.values(tablePlans)) {
        // Only a parent-side relation writes a column of *this* table, and only a column that
        // is otherwise required needs relaxing.
        if (
          plan.fkSide === 'parent' &&
          (plan.allowed.has('create') || plan.allowed.has('connect')) &&
          !isOptionalOnInsert(plan.localCol)
        ) {
          relaxed.add(plan.localColPropName);
        }
      }
      return relaxed.size ? relaxed : NO_COLUMNS;
    },
  };
};
