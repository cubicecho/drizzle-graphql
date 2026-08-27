// Every name the build gives a generated type, in one place.
//
// `typeNameMapper` names a table's object type and its root fields. It does not reach the
// types generated *around* that table — the filter, the write inputs, the order-by, the
// aggregate family — which are derived from that name by a fixed rule. A build that stitches
// its schema next to a second generator over the same tables collides on exactly those
// derived names, and had no hook to say otherwise.
//
// Both levers here answer that. `derivedTypeNameMapper` is asked for every type the build
// creates and may decline, so a single kind can be renamed and nothing else moves;
// `typeNamePrefix` / `typeNameSuffix` wrap every name the mapper did not answer for, which is
// the one-line way to make a whole subschema collision-free.

import type { GraphQLNamedType } from 'graphql';

/**
 * What a generated type is, so a name mapper can answer for one kind without matching on the
 * spelling of the default name.
 *
 * - `object` — a table's row type, the one `typeNameMapper` already names
 * - `filter` / `listRelationFilter` — `<Type>Filters` and the `some`/`none`/`every` wrapper
 * - `orderBy` — `<Type>OrderBy`
 * - `createInput` / `updateInput` / `updateManyInput` / `nestedWriteInput` / `fieldUpdateInput`
 *   — the write inputs
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
  typeName: TypeNameResolver,
  info: GeneratedTypeInfo,
  build: (name: string) => T,
): T => {
  const name = typeName(info);
  const cached = sharedTypeCache.get(name);
  if (cached) {
    return cached as T;
  }
  const built = build(name);
  sharedTypeCache.set(name, built);
  return built;
};
