const DRIZZLE_LOADERS_KEY = Symbol('drizzle-graphql-loaders');
const DRIZZLE_REQUEST_CACHE_KEY = Symbol('drizzle-graphql-request-cache');

type BatchFn<K, V> = (keys: readonly K[]) => Promise<readonly V[]>;

class BatchLoader<K, V> {
  private batch: Array<{ key: K; resolve: (v: V) => void; reject: (e: unknown) => void }> = [];
  private scheduled = false;

  constructor(private readonly batchFn: BatchFn<K, V>) {}

  load(key: K): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      this.batch.push({ key, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        Promise.resolve().then(() => this.dispatch());
      }
    });
  }

  private async dispatch(): Promise<void> {
    const current = this.batch.splice(0);
    this.scheduled = false;
    try {
      const results = await this.batchFn(current.map(({ key }) => key));
      for (let i = 0; i < current.length; i++) {
        current[i]!.resolve(results[i] as V);
      }
    } catch (err) {
      for (const { reject } of current) {
        reject(err);
      }
    }
  }
}

/**
 * Returns a BatchLoader keyed by `key` on the GraphQL context object.
 * Loaders are stored under a Symbol so they never collide with consumer properties.
 * If context is absent or not an object, a fresh (unbatched) loader is returned.
 */
export const getOrCreateLoader = <K, V>(context: any, key: string, batchFn: BatchFn<K, V>): BatchLoader<K, V> => {
  if (!context || typeof context !== 'object') {
    return new BatchLoader<K, V>(batchFn);
  }
  if (!context[DRIZZLE_LOADERS_KEY]) {
    context[DRIZZLE_LOADERS_KEY] = new Map<string, BatchLoader<any, any>>();
  }
  const loaders = context[DRIZZLE_LOADERS_KEY] as Map<string, BatchLoader<any, any>>;
  if (!loaders.has(key)) {
    loaders.set(key, new BatchLoader<K, V>(batchFn));
  }
  return loaders.get(key) as BatchLoader<K, V>;
};

type RequestCacheNode = { children: WeakMap<object, RequestCacheNode>; entries: Map<string, unknown> };

const requestCacheNode = (): RequestCacheNode => ({ children: new WeakMap(), entries: new Map() });

/**
 * Memoizes a value that a resolver derives from its own field — its args and its selection —
 * for the length of one request. Resolvers run once per parent row, so anything derived only
 * from the field is otherwise recomputed for every row of a batch.
 *
 * The value is keyed by every AST node of the field — `info.fieldNodes`, the nodes graphql-js
 * merged into this one response field — not only the first. A fragment's field node is the first
 * node wherever the fragment is spread, but the merged selection differs when a sibling selection
 * at one spread site adds to it, so keying on one node would serve one site the other's selection.
 * The nodes are matched by identity, in order, through a chain of weak maps, so a document cached
 * across requests never carries values between them (the root lives on the context), and an array
 * graphql rebuilds per call still hits. `key` separates fields that share nodes: one fragment
 * selection can resolve for more than one parent type. Without a context object, or without
 * nodes, there is nowhere request-scoped to cache, so the value is simply computed.
 *
 * `compute` must not read the parent row.
 */
export const getOrCreateRequestValue = <T>(
  context: any,
  nodes: readonly object[] | undefined,
  key: string,
  compute: () => T,
): T => {
  if (
    !context ||
    typeof context !== 'object' ||
    !Array.isArray(nodes) ||
    !nodes.length ||
    nodes.some((node) => !node || typeof node !== 'object')
  ) {
    return compute();
  }
  if (!context[DRIZZLE_REQUEST_CACHE_KEY]) {
    context[DRIZZLE_REQUEST_CACHE_KEY] = requestCacheNode();
  }
  let level = context[DRIZZLE_REQUEST_CACHE_KEY] as RequestCacheNode;
  for (const node of nodes) {
    let next = level.children.get(node);
    if (!next) {
      next = requestCacheNode();
      level.children.set(node, next);
    }
    level = next;
  }
  const entries = level.entries;
  if (entries.has(key)) {
    return entries.get(key) as T;
  }
  const value = compute();
  entries.set(key, value);
  return value;
};
