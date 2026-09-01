// A resolver's `info` carries the query AST, not the selection: reading which fields were
// actually asked for means walking `fieldNodes`, resolving fragments against `info.fragments`,
// honouring `@include` / `@skip`, and coercing each field's arguments. Every generated
// resolver in this library needs that walk before it can decide which columns to SELECT and
// which relations to join, so it happens on every request.
//
// This is an in-repo replacement for `graphql-parse-resolve-info`, which used to be a required
// peer dependency. That package is CommonJS, so it reaches graphql through `require`, and it
// decides whether a field has sub-selections with `instanceof` against whatever that `require`
// returned. graphql 17 ships several builds of itself out of one package — a `development`
// export condition routes to a whole second copy under `__dev__/`, with `.js`/`.mjs` behind the
// format conditions — so any loader that resolves the CommonJS graph differently from the ESM
// one hands it a different instance than the one that built the schema. The `instanceof` then
// answers "not composite", the walk returns `fieldsByTypeName: {}` instead of throwing, and
// every resolver downstream reads a selection of nothing. Upstream is dead (4.14.1, unchanged
// since 2025-04-27) and its own peer range stops at 16, so npm refuses the install as well.
//
// The replacement keeps the `ResolveTree` shape byte-for-byte so nothing downstream moves, and
// answers the "is this composite / what are its fields" questions structurally instead of by
// `instanceof`, so it cannot silently disagree with the graphql copy that is executing the
// query. Argument coercion is still graphql's own `getArgumentValues` — spec-correct handling
// of variables, defaults, enums, input objects and list/non-null wrapping is not worth
// re-deriving, and passing `info.variableValues` straight through works under both majors
// (graphql 16 hands resolvers a plain map, graphql 17 a `{ sources, coerced }` record, and each
// major's `getArgumentValues` expects its own).

import type { DirectiveNode, GraphQLResolveInfo, NamedTypeNode, SelectionNode, ValueNode } from 'graphql';
import { getArgumentValues, Kind } from 'graphql';

/**
 * The selections made against one concrete type, keyed by the *response key* — the field's
 * alias when it has one, otherwise its name. A selection spanning an abstract type has one
 * entry per type condition it was written against (the interface or union itself included,
 * when fields were selected directly on it).
 */
export interface FieldsByTypeName {
  [typeName: string]: {
    [responseKey: string]: ResolveTree;
  };
}

/** One selected field: what was asked for, under what alias, with which arguments. */
export interface ResolveTree {
  /** The field name as declared in the schema. */
  name: string;
  /** The response key — the alias when the selection carried one, otherwise `name`. */
  alias: string;
  /** The field's arguments, coerced by graphql's own `getArgumentValues`. */
  args: {
    [argName: string]: unknown;
  };
  /** The field's own sub-selections, keyed by the type they were written against. */
  fieldsByTypeName: FieldsByTypeName;
}

/** Options accepted by {@link parseResolveInfo}. */
export interface ParseResolveInfoOptions {
  /**
   * Whether to descend into sub-selections and fragments. Defaults to `true`; `false` reads
   * only the root field's own name, alias and arguments.
   */
  deep?: boolean;
}

/**
 * A GraphQL type as this module needs to see it. Deliberately structural: the type objects on
 * `info` come from whichever copy of graphql is executing the query, which is not necessarily
 * the copy this module imported, so `instanceof` is not a question that can be asked here.
 */
type TypeLike = {
  name?: string;
  ofType?: TypeLike;
  getFields?: () => Record<string, { type?: TypeLike }>;
  getTypes?: () => unknown[];
};

/** Unwraps `[T]!`-style wrappers down to the named type. `getNamedType` without the realm tie. */
const namedTypeOf = (type: TypeLike | undefined): TypeLike | undefined => {
  let current = type;
  while (current?.ofType) {
    current = current.ofType;
  }
  return current;
};

/**
 * Whether a field's named output type has sub-selections. Object types and interfaces expose
 * `getFields`, unions expose `getTypes`; scalars and enums expose neither. Input object types
 * also expose `getFields`, but an input type can never be a field's output type, so there is
 * nothing here for that to collide with.
 */
const isCompositeLike = (type: TypeLike | undefined): boolean =>
  !!type && (typeof type.getFields === 'function' || typeof type.getTypes === 'function');

/**
 * The fields declared on a type, or `undefined` when it has none to declare. A union is the
 * case that matters: it has no fields of its own, so a selection directly against one resolves
 * to nothing and is dropped — only the inline fragments underneath contribute.
 */
const fieldsOf = (type: TypeLike | undefined): Record<string, { type?: TypeLike }> | undefined =>
  typeof type?.getFields === 'function' ? type.getFields() : undefined;

/**
 * The runtime variable values, in the plain-map form the directive check wants. graphql 17
 * wraps them in `{ sources, coerced }`; graphql 16 hands over the map itself.
 */
const coercedVariables = (info: GraphQLResolveInfo): Record<string, unknown> => {
  const values = info.variableValues as unknown;
  if (values && typeof values === 'object' && 'coerced' in (values as Record<string, unknown>)) {
    return ((values as { coerced?: Record<string, unknown> }).coerced ?? {}) as Record<string, unknown>;
  }
  return (values ?? {}) as Record<string, unknown>;
};

/** The value of a `@skip` / `@include` `if:` argument — a literal or a variable reference. */
const directiveIfValue = (info: GraphQLResolveInfo, value: ValueNode): unknown => {
  if (value.kind === Kind.VARIABLE) {
    return coercedVariables(info)[value.name.value];
  }
  if (value.kind === Kind.BOOLEAN) {
    return value.value;
  }
  return undefined;
};

/**
 * Whether `@skip` / `@include` on this selection exclude it. Applies to fields, fragment
 * spreads and inline fragments alike, which is where graphql puts them.
 */
const isExcluded = (
  info: GraphQLResolveInfo,
  node: { readonly directives?: ReadonlyArray<DirectiveNode> },
): boolean => {
  for (const directive of node.directives ?? []) {
    const directiveName = directive.name.value;
    if (directiveName !== 'skip' && directiveName !== 'include') {
      continue;
    }
    const ifArgument = directive.arguments?.find((argument) => argument.name.value === 'if');
    if (!ifArgument) {
      continue;
    }
    const value = directiveIfValue(info, ifArgument.value);
    if (directiveName === 'skip' ? !!value : !value) {
      return true;
    }
  }
  return false;
};

/** The type a fragment's `on Type` condition names, looked up in the executing schema. */
const typeFromCondition = (info: GraphQLResolveInfo, condition: NamedTypeNode): TypeLike | undefined =>
  info.schema.getType(condition.name.value) as TypeLike | undefined;

/**
 * Introspection meta-fields are not schema fields and never reach the database. `__typename` is
 * the one that turns up in practice; `__id` is excluded from the rule because a schema is free
 * to declare a field by that name.
 */
const isMetaField = (name: string): boolean => name.startsWith('__') && name !== '__id';

/**
 * Merges one selection set into `tree`, which is a `fieldsByTypeName` map — the caller owns the
 * level, this owns the entries under `parentType`'s name.
 *
 * `activeFragments` is the set of fragment names on the current spread path. A document that
 * passed validation cannot contain a fragment cycle, but this parser also runs on trees a
 * caller assembled by hand, and an unbounded walk would hang rather than fail.
 */
const collectSelections = (
  selections: ReadonlyArray<SelectionNode>,
  info: GraphQLResolveInfo,
  tree: FieldsByTypeName,
  parentType: TypeLike | undefined,
  deep: boolean,
  activeFragments: Set<string>,
): FieldsByTypeName => {
  const parentTypeName = parentType?.name;
  if (!parentTypeName) {
    return tree;
  }
  // Seeded even when nothing under it survives, so a consumer can tell "selected nothing on
  // this type" from "never reached this type" — the shape `graphql-parse-resolve-info` produced.
  let fields = tree[parentTypeName];
  if (!fields) {
    fields = {};
    tree[parentTypeName] = fields;
  }

  for (const selection of selections) {
    if (isExcluded(info, selection)) {
      continue;
    }

    if (selection.kind === Kind.FIELD) {
      const name = selection.name.value;
      if (isMetaField(name)) {
        continue;
      }

      const fieldDef = fieldsOf(parentType)?.[name];
      // A field the parent type does not declare: either a union's own selection set, which
      // carries nothing but meta-fields, or a document that never passed validation.
      if (!fieldDef) {
        continue;
      }

      const fieldType = namedTypeOf(fieldDef.type);
      if (!fieldType) {
        continue;
      }
      const composite = isCompositeLike(fieldType);

      const alias = selection.alias?.value || name;
      let node = fields[alias];
      if (!node) {
        node = {
          name,
          alias,
          // Spread out of the null-prototype object graphql returns, so downstream code can
          // treat it as an ordinary record. The casts are on the installed major's own
          // signature: graphql 17 brands its field type and takes a `{ sources, coerced }`
          // variables record where 16 takes a plain map, and `info` carries whichever shape
          // that major's executor produced.
          args: {
            ...getArgumentValues(
              fieldDef as unknown as Parameters<typeof getArgumentValues>[0],
              selection,
              info.variableValues as unknown as Parameters<typeof getArgumentValues>[2],
            ),
          },
          fieldsByTypeName: composite && fieldType.name ? { [fieldType.name]: {} } : {},
        };
        fields[alias] = node;
      }

      // Two selections of the same response key merge, exactly as execution merges them: the
      // first one's arguments stand (validation requires them to be identical) and both
      // sub-selections are collected into the one node.
      if (selection.selectionSet && deep && composite) {
        collectSelections(
          selection.selectionSet.selections,
          info,
          node.fieldsByTypeName,
          fieldType,
          deep,
          activeFragments,
        );
      }
      continue;
    }

    if (!deep) {
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragmentName = selection.name.value;
      const fragment = info.fragments?.[fragmentName];
      if (!fragment) {
        throw new Error(
          `Drizzle-GraphQL Error: unknown fragment '${fragmentName}' — it is spread in the query but not defined in the document.`,
        );
      }
      if (activeFragments.has(fragmentName)) {
        continue;
      }

      const fragmentType = fragment.typeCondition ? typeFromCondition(info, fragment.typeCondition) : parentType;
      if (!isCompositeLike(fragmentType)) {
        continue;
      }

      activeFragments.add(fragmentName);
      try {
        // Spread into the *caller's* level, not a nested one: a fragment contributes its fields
        // to the selection it was spread into, keyed by its own type condition.
        collectSelections(fragment.selectionSet.selections, info, tree, fragmentType, deep, activeFragments);
      } finally {
        activeFragments.delete(fragmentName);
      }
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const fragmentType = selection.typeCondition ? typeFromCondition(info, selection.typeCondition) : parentType;
      if (!isCompositeLike(fragmentType)) {
        continue;
      }
      collectSelections(selection.selectionSet.selections, info, tree, fragmentType, deep, activeFragments);
    }
  }

  return tree;
};

const firstKey = (object: Record<string, unknown>): string | undefined => Object.keys(object)[0];

/**
 * Reads the selection under a resolver's own field out of its `info`, as a tree of
 * {@link ResolveTree} nodes.
 *
 * ```ts
 * const parsed = parseResolveInfo(info, { deep: true })!;
 * const selected = parsed.fieldsByTypeName['Users']; // keyed by response key
 * ```
 *
 * Returns `undefined` when the resolver's field produced no node at all, which in practice
 * means `info` carried no field nodes.
 */
export const parseResolveInfo = (
  info: GraphQLResolveInfo,
  options: ParseResolveInfoOptions = {},
): ResolveTree | undefined => {
  const fieldNodes = info.fieldNodes;
  if (!fieldNodes) {
    throw new Error(
      'Drizzle-GraphQL Error: resolve info carries no fieldNodes, so no selection could be read from it.',
    );
  }

  const tree = collectSelections(
    fieldNodes,
    info,
    {},
    info.parentType as unknown as TypeLike,
    options.deep ?? true,
    new Set(),
  );

  // Every field node handed to one resolver shares one response key under one parent type, so
  // the tree has exactly one entry at each of its two top levels — which is the node wanted.
  const typeKey = firstKey(tree);
  const fields = typeKey === undefined ? undefined : tree[typeKey];
  const fieldKey = fields && firstKey(fields);
  return fieldKey === undefined ? undefined : fields?.[fieldKey];
};
