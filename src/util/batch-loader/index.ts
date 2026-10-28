// Per-request state, keyed by the execution (see `executionKey` in ../execution.ts) through
// weak maps, so it is never written onto the consumer's objects and goes when the request does.

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

const loadersByExecution = new WeakMap<object, Map<string, BatchLoader<any, any>>>();

/**
 * Returns the BatchLoader for `key` in this execution (see `executionKey`).
 * Without one a fresh, unbatched loader is returned.
 */
export const getOrCreateLoader = <K, V>(
  execution: object | undefined,
  key: string,
  batchFn: BatchFn<K, V>,
): BatchLoader<K, V> => {
  if (!execution) {
    return new BatchLoader<K, V>(batchFn);
  }
  let loaders = loadersByExecution.get(execution);
  if (!loaders) {
    loaders = new Map();
    loadersByExecution.set(execution, loaders);
  }
  let loader = loaders.get(key);
  if (!loader) {
    loader = new BatchLoader<K, V>(batchFn);
    loaders.set(key, loader);
  }
  return loader as BatchLoader<K, V>;
};

type RequestCacheNode = { children: WeakMap<object, RequestCacheNode>; entries: Map<string, unknown> };

const requestCacheNode = (): RequestCacheNode => ({ children: new WeakMap(), entries: new Map() });

const memoByExecution = new WeakMap<object, RequestCacheNode>();

/**
 * Memoizes a value that a resolver derives from its own field — its args and its selection —
 * for the length of one execution (see `executionKey`). Args depend on the
 * execution's variables, so a context object or document reused across executions must not
 * carry a value from one to the next. Resolvers run once per parent row, so anything derived only
 * from the field is otherwise recomputed for every row of a batch.
 *
 * The value is keyed by every AST node of the field — `info.fieldNodes`, the nodes graphql-js
 * merged into this one response field — not only the first. A fragment's field node is the first
 * node wherever the fragment is spread, but the merged selection differs when a sibling selection
 * at one spread site adds to it, so keying on one node would serve one site the other's selection.
 * The nodes are matched by identity, in order, through a chain of weak maps rooted at the execution,
 * so a document cached across executions never carries values between them, and an array
 * graphql rebuilds per call still hits. `key` separates fields that share nodes: one fragment
 * selection can resolve for more than one parent type. Without an execution, or without nodes, there
 * is nowhere request-scoped to cache, so the value is simply computed.
 *
 * `compute` must not read the parent row.
 */
export const getOrCreateRequestValue = <T>(
  execution: object | undefined,
  nodes: readonly object[] | undefined,
  key: string,
  compute: () => T,
): T => {
  const cacheable =
    !!execution &&
    Array.isArray(nodes) &&
    nodes.length > 0 &&
    nodes.every((node) => !!node && typeof node === 'object');
  if (!cacheable) {
    return compute();
  }
  let root = memoByExecution.get(execution);
  if (!root) {
    root = requestCacheNode();
    memoByExecution.set(execution, root);
  }
  let level = root;
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
