// The per-schema cache the type generators share, so a type is built once and referenced
// everywhere it appears.

import type { GraphQLInputObjectType, GraphQLObjectType } from 'graphql';
import type {
  ConvertedColumn,
  ConvertedInputColumn,
  ConvertedRelationColumnWithArgs,
  SchemaDocs,
} from '../../type-converter/types.ts';
import type { TableFeatures } from '../types.ts';
import type { LimitPolicyFor, ResolvedComplexityOptions } from './limits.ts';
import type { ContextValuesFor, SoftDeleteFor } from './policies.ts';

/** Per-call cache context — created fresh on each generateSchemaData call to avoid type name collisions. */
export interface TypeCacheCtx {
  /** Cache of generic filter types, keyed by generic name (e.g. "String", "DateTime"). */
  genericFilterCache: Map<string, GraphQLInputObjectType>;
  /**
   * Cache of shared select object types, keyed by table name.
   * Value: the ${capitalize(tableName)} type (columns + relation fields).
   * A table may be pre-registered here as a columns-only shell before its root call runs.
   * Use fullyBuiltTables to distinguish a complete type from a pre-registered shell.
   */
  objectTypeCache: Map<string, GraphQLObjectType>;
  /**
   * Mutable containers for relation fields, keyed by table name.
   * Each container object is closed over by the corresponding GraphQLObjectType thunk so that
   * when the root call for a table populates its relation fields, the thunk automatically picks
   * them up — even if the shell was pre-registered by a different table's relation traversal.
   */
  relationFieldContainers: Map<string, { fields: Record<string, ConvertedRelationColumnWithArgs> }>;
  /**
   * Set of table names whose GraphQL object type has been fully built (root call completed).
   * Pre-registered shells (created when another table references this table as a relation target)
   * are NOT in this set until the root call for that table runs.
   */
  fullyBuiltTables: Set<string>;
  /**
   * Cache of relation types, keyed by "${fromTableName}::${relName}".
   * @deprecated No longer used — relation fields now reference the target table's own type directly.
   */
  relationTypeCache: Map<string, GraphQLObjectType>;
  /**
   * Per-call cache for a table's converted select-field map, keyed by table reference.
   * Per-call (not module-level) because scalar overrides can differ between builds that
   * share the same table objects.
   */
  selectFieldCache: WeakMap<object, Record<string, ConvertedColumn>>;
  /** Per-call cache for a table's column-filter field map, keyed by table reference. */
  filterFieldCache: WeakMap<object, Record<string, ConvertedInputColumn>>;
  /** Per-call cache for order GraphQL input types, keyed by table reference. */
  orderTypeCache: WeakMap<object, GraphQLInputObjectType>;
  /** Per-call cache for filter GraphQL input types, keyed by table reference. */
  filterTypeCache: WeakMap<object, GraphQLInputObjectType>;
  /**
   * Per-call cache for `${Target}ListRelationFilter` input types (the some/every/none wrapper
   * used by to-many relation filters), keyed by target table name.
   */
  listRelationFilterCache: Map<string, GraphQLInputObjectType>;
  /**
   * Per-call cache for `${Table}Aggregate` output types, keyed by table name. Shared between the
   * root `<table>Aggregate` query and the `<relation>Aggregate` field on every table that points
   * at it, so the schema never holds two types with the same name.
   */
  aggregateTypeCache: Map<string, GraphQLObjectType>;
  /**
   * Resolved complexity settings for this call, or `undefined` when the caller turned the hints
   * off. Not a cache, but the type builders are several calls deep and this context is already
   * threaded through all of them.
   */
  complexity: ResolvedComplexityOptions | undefined;
  /**
   * The build's documentation hooks (`describeColumn`, `describeTable`, `describeRelation`,
   * `deprecateColumn`). Empty when the caller configured none, which is the default — the
   * generator emits no descriptions of its own for column and relation fields.
   */
  docs: SchemaDocs;
  /**
   * The build's resolved limit policy, or `undefined` when the caller configured none. Read
   * here so a to-many relation field can price its cost hint against the policy of the table
   * it targets, the same one its resolver enforces.
   */
  limits: LimitPolicyFor | undefined;
  /**
   * A table's primary-key property names, from the dialect's own resolver. Object types and
   * relation fields publish it on `extensions.drizzle` so a consumer can identify the rows a
   * field is about without re-deriving the key from the Drizzle schema.
   */
  primaryKeyOf?: (tableName: string) => readonly string[];
  /**
   * The context-derived columns of a table, if any. Read when the create/update inputs are
   * built: a column the server fills in is not part of either.
   */
  contextValuesOf?: ContextValuesFor;
  /**
   * The soft-delete convention of a table, if it declares one. Read when the write inputs are
   * built — the marker column is written by the delete and restore mutations, not by a client
   * — and when a read field's `deleted` argument is generated.
   */
  softDeleteOf?: SoftDeleteFor;
  /**
   * This build's feature flags, resolved for one table. Like `complexity` and `docs`, not a
   * cache — the type builders are several calls deep and this context is already threaded
   * through them. A lookup rather than a flat object because a flag may be a per-table
   * predicate, and because the table a builder is asked about is not always the one whose
   * type it is building: a relation field reads the flags of the table it points at.
   */
  featureOf: (tableName: string) => TableFeatures;
}
