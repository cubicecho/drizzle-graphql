// Reading variable values out of a resolver's `info` the same way under both graphql majors.
//
// graphql 16 hands resolvers `info.variableValues` as the coerced map itself. graphql 17 wraps
// it in a `{ sources, coerced }` record, so anything that indexes it by variable name has to go
// through `operationVariables` — reading the record directly finds no variable at all, which
// turns every `@skip(if: $v)` into "don't skip" and every `@include(if: $v)` into "exclude".
//
// graphql 17 also supports fragment arguments (`...F(limit: 2)` against
// `fragment F($limit: Int = 1) on T`), opt-in at parse time through
// `experimentalFragmentArguments`. A fragment variable is scoped to the fragment it is declared
// on, so a field inside it reads `$limit` from the spread's arguments rather than from the
// operation. graphql computes that scope during field collection and passes it to
// `getArgumentValues` as a fourth argument, but never exposes it on `info` — so code that
// re-walks the document from `info` (the resolve-info parser, the auto-transaction counter)
// has to rebuild it. The scope objects here have exactly the `{ sources, coerced }` shape 17's
// own `getFragmentVariableValues` produces, so they can be handed straight back to 17's
// `getArgumentValues`. Under 16 none of this ever runs: fragment spreads carry no arguments
// there, and `fragmentArgumentsInUse` is false whenever the variables are a plain map.

import type {
  DirectiveNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  GraphQLResolveInfo,
  GraphQLSchema,
  SelectionSetNode,
  ValueNode,
} from 'graphql';
import { getArgumentValues, Kind, typeFromAST } from 'graphql';

/**
 * The variable values of one fragment spread — graphql 17's internal `FragmentVariableValues`.
 * `sources` holds an entry for every variable the fragment declares, whether or not the spread
 * supplied it; that is what decides a `$name` inside the fragment refers to the fragment's
 * variable and not the operation's.
 */
export type FragmentVariableScope = {
  readonly sources: Readonly<Record<string, unknown>>;
  readonly coerced: Readonly<Record<string, unknown>>;
};

type VariablesRecord = { sources?: unknown; coerced?: Record<string, unknown> };

/** Whether `values` is graphql 17's `{ sources, coerced }` record rather than 16's plain map. */
const isVariablesRecord = (values: unknown): values is VariablesRecord =>
  !!values && typeof values === 'object' && 'coerced' in values && 'sources' in values;

/** The operation's coerced variable values as a plain map, under either major. */
export const operationVariables = (variableValues: unknown): Record<string, unknown> => {
  if (isVariablesRecord(variableValues)) {
    return (variableValues.coerced ?? {}) as Record<string, unknown>;
  }
  return (variableValues ?? {}) as Record<string, unknown>;
};

/** A `$name` reference's runtime value, read from the fragment scope when it declares `name`. */
const variableValue = (name: string, variableValues: unknown, scope: FragmentVariableScope | undefined): unknown =>
  scope?.sources[name] !== undefined ? scope.coerced[name] : operationVariables(variableValues)[name];

/** The value of a `@skip` / `@include` `if:` argument — a literal or a variable reference. */
const directiveIfValue = (value: ValueNode, variableValues: unknown, scope: FragmentVariableScope | undefined) => {
  if (value.kind === Kind.VARIABLE) {
    return variableValue(value.name.value, variableValues, scope);
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
export const isExcludedByDirectives = (
  node: { readonly directives?: ReadonlyArray<DirectiveNode> | undefined },
  variableValues: unknown,
  scope?: FragmentVariableScope,
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
    const value = directiveIfValue(ifArgument.value, variableValues, scope);
    if (directiveName === 'skip' ? !!value : !value) {
      return true;
    }
  }
  return false;
};

/**
 * graphql's own `getArgumentValues`, given the variables `info` carries and the fragment scope
 * the node sits in. The casts are on the installed major's own signature: graphql 17 brands its
 * field type and takes a `{ sources, coerced }` record where 16 takes a plain map, and `info`
 * carries whichever shape that major's executor produced. The scope is only ever set under 17,
 * whose `getArgumentValues` takes it as the fourth argument; 16 is called with three.
 */
export const argumentValues = (
  def: unknown,
  node: unknown,
  variableValues: unknown,
  scope?: FragmentVariableScope,
): Record<string, unknown> => {
  const args: unknown[] = [def, node, variableValues];
  if (scope) {
    args.push(scope);
  }
  return (getArgumentValues as (...args: unknown[]) => Record<string, unknown>)(...args);
};

const fragmentArgumentsCache = new WeakMap<object, boolean>();

/**
 * Whether this request can have fragment-variable scopes at all: graphql 17, and a document with
 * at least one fragment that declares variables. Cached per fragment map, which graphql builds
 * once per execution and hands to every resolver.
 */
export const fragmentArgumentsInUse = (
  variableValues: unknown,
  fragments: Readonly<Record<string, FragmentDefinitionNode>> | undefined,
): boolean => {
  if (!fragments || !isVariablesRecord(variableValues)) {
    return false;
  }
  let inUse = fragmentArgumentsCache.get(fragments);
  if (inUse === undefined) {
    inUse = Object.values(fragments).some((fragment) => fragment?.variableDefinitions !== undefined);
    fragmentArgumentsCache.set(fragments, inUse);
  }
  return inUse;
};

/**
 * The scope a fragment's selections run in when it is spread at `spread` — graphql 17's
 * `getFragmentVariableValues`, which is internal to it. As in 17's field collection, a fragment
 * that declares no variables gets no scope at all (not its parent's): inside it every `$name` is
 * an operation variable again.
 */
export const enterFragmentScope = (
  schema: GraphQLSchema,
  spread: FragmentSpreadNode,
  fragment: FragmentDefinitionNode,
  variableValues: unknown,
  parentScope: FragmentVariableScope | undefined,
): FragmentVariableScope | undefined => {
  if (!fragment.variableDefinitions) {
    return undefined;
  }
  const argumentNodes = new Map(
    ((spread as { arguments?: ReadonlyArray<{ name: { value: string }; value: ValueNode }> }).arguments ?? []).map(
      (argument) => [argument.name.value, argument],
    ),
  );
  const sources: Record<string, unknown> = Object.create(null);
  const signatures: unknown[] = [];
  for (const definition of fragment.variableDefinitions) {
    const name = definition.variable.name.value;
    const type = typeFromAST(schema, definition.type as Parameters<typeof typeFromAST>[1]);
    if (!type) {
      // Not an input type in this schema: the executor refuses the document before any
      // resolver runs, so there is nothing to scope.
      continue;
    }
    const signature = {
      name,
      type,
      default: definition.defaultValue ? { literal: definition.defaultValue } : undefined,
    };
    signatures.push(signature);
    const argument = argumentNodes.get(name);
    sources[name] = argument
      ? parentScope
        ? { signature, value: argument.value, fragmentVariableValues: parentScope }
        : { signature, value: argument.value }
      : { signature };
  }
  // A fragment variable is coerced exactly like a field argument against the spread's arguments
  // — which is how 17 does it too — so 17's `getArgumentValues` does the work.
  const coerced = argumentValues({ args: signatures }, spread, variableValues, parentScope);
  return { sources, coerced };
};

/**
 * Which fragment scope each of a resolver's own field nodes sits in, and the fragment spreads
 * on the way to them. `info` does not carry either, so they are rebuilt by walking the operation
 * down `info.path`, entering fragments as execution does. `undefined` when the request cannot
 * have fragment scopes (graphql 16, or no fragment declares variables), which is the common case
 * and costs one cached lookup.
 *
 * Intermediate levels are walked without type conditions, since `info` does not say which
 * concrete type each ancestor resolved to; nodes are matched by identity at the end, so an
 * extra candidate is harmless unless one node is reached through two spreads with different
 * arguments under different type conditions of one abstract field — the first one wins there.
 */
export const fieldNodeScopes = (
  info: GraphQLResolveInfo,
): { scopes: Map<FieldNode, FragmentVariableScope | undefined>; spreads: FragmentSpreadNode[] } | undefined => {
  const fragments = info.fragments as Readonly<Record<string, FragmentDefinitionNode>> | undefined;
  if (!fragmentArgumentsInUse(info.variableValues, fragments)) {
    return undefined;
  }

  const keys: string[] = [];
  for (let path: GraphQLResolveInfo['path'] | undefined = info.path; path; path = path.prev) {
    if (typeof path.key === 'string') {
      keys.unshift(path.key);
    }
  }

  type Entry = { node: FieldNode; scope: FragmentVariableScope | undefined; spreads: FragmentSpreadNode[] };
  type Level = {
    selectionSet: SelectionSetNode;
    scope: FragmentVariableScope | undefined;
    spreads: FragmentSpreadNode[];
  };

  const collect = (level: Level, key: string, out: Entry[], active: Set<string>): void => {
    for (const selection of level.selectionSet.selections) {
      if (isExcludedByDirectives(selection, info.variableValues, level.scope)) {
        continue;
      }
      if (selection.kind === Kind.FIELD) {
        if ((selection.alias?.value ?? selection.name.value) === key) {
          out.push({ node: selection, scope: level.scope, spreads: level.spreads });
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect({ ...level, selectionSet: selection.selectionSet }, key, out, active);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        const fragment = fragments?.[name];
        if (!fragment || active.has(name)) {
          continue;
        }
        active.add(name);
        try {
          collect(
            {
              selectionSet: fragment.selectionSet,
              scope: enterFragmentScope(info.schema, selection, fragment, info.variableValues, level.scope),
              spreads: [...level.spreads, selection],
            },
            key,
            out,
            active,
          );
        } finally {
          active.delete(name);
        }
      }
    }
  };

  let levels: Level[] = [{ selectionSet: info.operation.selectionSet, scope: undefined, spreads: [] }];
  let entries: Entry[] = [];
  for (const key of keys) {
    entries = [];
    for (const level of levels) {
      collect(level, key, entries, new Set());
    }
    levels = entries.flatMap((entry) =>
      entry.node.selectionSet
        ? [{ selectionSet: entry.node.selectionSet, scope: entry.scope, spreads: entry.spreads }]
        : [],
    );
  }

  const own = new Set<FieldNode>(info.fieldNodes);
  const scopes = new Map<FieldNode, FragmentVariableScope | undefined>();
  const spreads = new Set<FragmentSpreadNode>();
  for (const entry of entries) {
    if (!own.has(entry.node) || scopes.has(entry.node)) {
      continue;
    }
    scopes.set(entry.node, entry.scope);
    for (const spread of entry.spreads) {
      spreads.add(spread);
    }
  }
  return { scopes, spreads: [...spreads] };
};

/**
 * The AST nodes a per-request memo of this field should be keyed by (see
 * `getOrCreateRequestValue`). Normally just `info.fieldNodes`. With fragment arguments the same
 * field nodes can resolve under different arguments — one fragment spread twice with different
 * arguments — so the fragment spreads that lead to them are part of the key too.
 */
export const requestValueNodes = (info: GraphQLResolveInfo | undefined): readonly object[] | undefined => {
  if (!info) {
    return undefined;
  }
  const scoped = fieldNodeScopes(info);
  return scoped?.spreads.length ? [...info.fieldNodes, ...scoped.spreads] : info.fieldNodes;
};
