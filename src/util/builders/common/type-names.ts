// Every name the build gives a generated type, in one place. `typeNameMapper` names a table's
// object type; the types derived from it (filter, inputs, order-by, aggregates) go through the
// naming rule, where `derivedTypeNameMapper` may rename one kind and `typeNamePrefix` /
// `typeNameSuffix` wrap the rest, so a stitched subschema can avoid colliding names.

import type { GraphQLNamedType } from 'graphql';
import { capitalize } from '../../case-ops/index.ts';

/** Optional mapper from table key to singular/plural name pair. Return undefined to use default naming for a table. */
export type TypeNameMapper = (tableName: string) => { singular: string; plural: string } | undefined;

/** Produce the GraphQL object type name for a table, using the mapper if provided. */
export const resolveTypeName = (name: string, typeNameMapper?: TypeNameMapper): string => {
  const mapped = typeNameMapper?.(name);
  return mapped ? capitalize(mapped.singular) : capitalize(name);
};

/**
 * The name a table's object type actually carries in the built schema — {@link resolveTypeName}
 * put through the build's naming rule. Resolvers read selections out of
 * `fieldsByTypeName`, which is keyed by the real type name, so anything that walks a
 * selection tree has to ask for the name this way rather than assuming the default.
 */
export const resolveObjectTypeName = (
  name: string,
  typeNameMapper?: TypeNameMapper,
  resolveName?: TypeNameResolver,
): string => applyObjectTypeName(resolveTypeName(name, typeNameMapper), name, resolveName);

/** {@link resolveObjectTypeName} for a caller that already holds the table's default type name. */
export const applyObjectTypeName = (defaultName: string, tableName: string, resolveName?: TypeNameResolver): string =>
  resolveName ? resolveName({ kind: 'object', defaultName, table: tableName }) : defaultName;

/**
 * What a generated type is, so a name mapper can answer for one kind without matching on the
 * spelling of the default name.
 *
 * - `object` — a table's row type, the one `typeNameMapper` already names
 * - `filter` / `listRelationFilter` — `<Type>Filters` and the `some`/`none`/`every` wrapper
 * - `orderBy` — `<Type>OrderBy`
 * - `createInput` / `updateInput` / `updateManyInput` / `upsertInput` / `nestedWriteInput` /
 *   `fieldUpdateInput` — the write inputs (`upsertInput` only on a table with nested-write
 *   relations; any other table's upsert takes its `createInput`)
 * - `aggregate` — `<Type>Aggregate` and its per-operation children (`operation` names which)
 * - `having` / `groupBy` / `groupKeys` — the group-by family
 * - `onConflict` — the upsert's conflict input
 * - `uniqueKey` — a compound unique constraint's key input
 * - `columnEnum` — an enum naming a table's columns (`distinct`, conflict target, …)
 * - `columnFilter` — a shared per-scalar filter (`StringFilter`, `IntFilter`, …), not per table
 * - `shared` — everything else the build creates once (`OrderNulls`, `DeletedFilter`, …)
 */
export type GeneratedTypeKind =
  | 'object'
  | 'filter'
  | 'listRelationFilter'
  | 'orderBy'
  | 'createInput'
  | 'updateInput'
  | 'updateManyInput'
  | 'upsertInput'
  | 'nestedWriteInput'
  | 'fieldUpdateInput'
  | 'aggregate'
  | 'having'
  | 'groupBy'
  | 'groupKeys'
  | 'onConflict'
  | 'uniqueKey'
  | 'columnEnum'
  | 'columnFilter'
  | 'shared';

/** What a name mapper is told about the type it is being asked to name. */
export interface GeneratedTypeInfo {
  /** Which kind of generated type this is. */
  kind: GeneratedTypeKind;
  /** The name the library would use, before any prefix or suffix. */
  defaultName: string;
  /** The table key the type belongs to, where it belongs to one. */
  table?: string;
  /**
   * The narrower thing the type is for, where the kind alone does not say: the aggregate
   * operation (`sum`, `avg`, …), the relation a nested-write input is for, the scalar a
   * column filter covers, the columns of a unique key.
   */
  operation?: string;
}

/**
 * Renames a generated type. Return `undefined` — or the same name — to keep the default,
 * which is what an unlisted kind should do; anything returned is used verbatim, without the
 * build's prefix or suffix.
 */
export type DerivedTypeNameMapper = (info: GeneratedTypeInfo) => string | undefined;

/** The build's resolved naming rule, asked at every type construction. */
export type TypeNameResolver = (info: GeneratedTypeInfo) => string;

/** The naming knobs `resolveGeneratedTypeNames` reads off the build config. */
export interface GeneratedTypeNameConfig {
  derivedTypeNameMapper?: DerivedTypeNameMapper;
  typeNamePrefix?: string;
  typeNameSuffix?: string;
}

/**
 * The build's naming rule: the mapper's answer where it has one, otherwise the default name
 * wrapped in the build's prefix and suffix.
 *
 * A build that configures neither gets the identity function, so the fast path costs a
 * property read and today's schemas are byte-for-byte unchanged.
 */
export const resolveGeneratedTypeNames = (config: GeneratedTypeNameConfig | undefined): TypeNameResolver => {
  const mapper = config?.derivedTypeNameMapper;
  const prefix = config?.typeNamePrefix ?? '';
  const suffix = config?.typeNameSuffix ?? '';

  if (!mapper && !prefix && !suffix) {
    return (info) => info.defaultName;
  }

  return (info) => {
    const mapped = mapper?.(info);
    // Verbatim: the caller named this type explicitly, so wrapping it would be overruling
    // the more specific of the two knobs with the blunter one.
    return mapped || `${prefix}${info.defaultName}${suffix}`;
  };
};

// Types the build creates once rather than per table — `OrderNulls`, `StringFilter` and the
// like — used to be module-level constants, shared by every build in the process. They still
// are, but keyed by the name they resolved to: two builds that name a type the same way share
// one instance exactly as before, and a build that renames it gets its own.
const sharedTypeCache = new Map<string, GraphQLNamedType>();

/**
 * A build-wide shared type, built once per name it is known by.
 *
 * @param build receives the resolved name — the type must be constructed with it, not with
 *   the default the caller passed in
 */
export const sharedType = <T extends GraphQLNamedType>(
  resolveName: TypeNameResolver,
  info: GeneratedTypeInfo,
  build: (name: string) => T,
): T => {
  const name = resolveName(info);
  const cached = sharedTypeCache.get(name);
  if (cached) {
    return cached as T;
  }
  const built = build(name);
  sharedTypeCache.set(name, built);
  return built;
};
