// What a finished build needs at request time, findable from the types it generated — so the
// selection helpers a consumer calls from their own resolver (`resolveSelection`,
// `selectionToWith`) apply the same row policies as the generated fields without being handed
// the config again.

import { drizzleExtension } from '../../extensions.ts';
import type { NullOrdering } from './cursor.ts';
import type { LimitPolicyFor } from './limits.ts';
import type { ResolverPolicies } from './policies.ts';
import type { RelationFilterBase } from './relation-filters.ts';

/** The request-time half of one `buildSchema` call. */
export type BuildRuntime = {
  /** The drizzle instance the build read its tables from. */
  db: object;
  /** The build's filter base, which carries its registries (scalar overrides included). */
  filterCtx: RelationFilterBase;
  /** `scope`, `softDelete` and `defaults.orderBy`, bound the way the generated resolvers use them. */
  policies: ResolverPolicies | undefined;
  /** Whether any table has a `scope` hook — the one policy that needs the request context. */
  hasRowScope: boolean;
  limits: LimitPolicyFor | undefined;
  nullOrdering: NullOrdering;
};

/**
 * Keyed by the `extensions.drizzle` object of every object type the build generated, rather
 * than by the type: a schema composed from `entities.types` keeps the types, and one rebuilt
 * by a schema-transforming tool (`mapSchema`, stitching) keeps their extensions.
 */
const runtimeByTypeMeta = new WeakMap<object, BuildRuntime>();

/**
 * What is known about the builds of one drizzle instance, for a caller with no resolve info to
 * look its build up by. Only a lone build is kept — with two or more there is no telling which
 * one a selection belongs to — so rebuilding a schema repeatedly holds on to nothing extra.
 */
const buildsByDb = new WeakMap<object, { count: number; only?: BuildRuntime; anyPolicies: boolean }>();

/**
 * Whether a build changes what a read returns at all: a row policy, a limit, a default ordering,
 * or a scalar override, which decides how a column's values are mapped.
 */
const hasPolicies = (runtime: BuildRuntime): boolean =>
  !!(
    runtime.policies?.visibility ||
    runtime.policies?.defaultOrderBy ||
    runtime.limits ||
    runtime.filterCtx.registries?.scalarOverrides.size
  );

/** Records a finished build against the object types it generated and the instance it read. */
export const registerBuildRuntime = (runtime: BuildRuntime, types: Iterable<unknown>): void => {
  for (const type of types) {
    const meta = drizzleExtension(type as any);
    if (meta) {
      runtimeByTypeMeta.set(meta, runtime);
    }
  }
  const previous = buildsByDb.get(runtime.db);
  buildsByDb.set(
    runtime.db,
    previous
      ? { count: previous.count + 1, anyPolicies: previous.anyPolicies || hasPolicies(runtime) }
      : { count: 1, only: runtime, anyPolicies: hasPolicies(runtime) },
  );
};

/** The build that generated `type`, when one did. */
export const runtimeForType = (type: unknown): BuildRuntime | undefined => {
  const meta = type && typeof type === 'object' ? drizzleExtension(type as any) : undefined;
  return meta ? runtimeByTypeMeta.get(meta) : undefined;
};

/**
 * The build of `db` to use when no generated type identifies one: the only build, or none
 * when no build applies any policy. Throws when several builds exist and one of them would
 * change the read, since picking either could apply the wrong policies — or none.
 */
export const runtimeForDb = (db: object, helper: string): BuildRuntime | undefined => {
  const builds = buildsByDb.get(db);
  if (!builds) {
    return undefined;
  }
  if (builds.count === 1) {
    return builds.only;
  }
  if (builds.anyPolicies) {
    throw new Error(
      `Drizzle-GraphQL Error: ${helper} cannot tell which of the ${builds.count} schemas built over this database the selection belongs to, and at least one applies row policies (scope, softDelete, limits or defaults) or scalar overrides. Pass the resolver's \`info\` rather than a parsed selection tree, from a field whose type the build generated.`,
    );
  }
  return undefined;
};
