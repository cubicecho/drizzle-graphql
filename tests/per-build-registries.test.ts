import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Per-build state — scalar overrides, enum config, column exclusions, the aggregate and
// field-update caches — lives on the build (`createBuildRegistries`), never in a module global, so
// two schemas built in one process cannot see each other's config (#234; behaviour pinned by
// `build-isolation.test.ts`). This is the source-level backstop: module scope in `src/` holds no
// reassignable binding and no mutable collection, except the caches listed here, each of which
// is safe to share across builds for the reason given.

/** `file: name` of every module-level mutable collection, and why sharing it is safe. */
const GLOBAL_CACHES: Record<string, string> = {
  'util/builders/common/type-names.ts: sharedTypeCache': 'keyed by the resolved type name',
  'util/builders/common/table-inputs.ts: orderMap': 'keyed by table and InnerOrder instance; skipped under exclusions',
  'util/builders/common/column-enums.ts: columnEnumCache':
    "keyed by table, enum name, the build's exclusions and variant",
  'util/builders/common/build-registry.ts: runtimeByTypeMeta': 'maps a generated type back to the build that made it',
  'util/builders/common/build-registry.ts: buildsByDb': 'counts the builds of one drizzle instance',
  'util/builders/common/relation-filters.ts: narrowedCtxCache': "keyed by the build's own filter base",
  'util/builders/common/relation-filters.ts: aliasCounters': "keyed by the build's own filter base",
  'util/builders/common/relations.ts: columnCollations': "a column's collation, a fact about the database",
  'util/builders/common/filters.ts: noRowPredicates': 'marks SQL objects the filter compiler built',
  'util/builders/common/executor.ts: autoTransactions': 'per request context',
  'util/builders/common/commit-callbacks.ts: callerQueues': 'per request context',
  'util/batch-loader/index.ts: loadersByExecution': 'per execution',
  'util/batch-loader/index.ts: memoByExecution': 'per execution',
  'util/graphql-variables.ts: fragmentArgumentsCache': 'per parsed document',
  'util/selection.ts: contextCache': 'derived from the drizzle instance alone, with no build config',
};

const SRC = join(import.meta.dirname, '..', 'src');
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );

/** Each top-level statement's first line, per file — module scope is what is unindented. */
const topLevelLines = (): [string, string][] =>
  sourceFiles(SRC).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line): [string, string] => [relative(SRC, file), line]),
  );

describe('per-build state', () => {
  it('no module in src/ has a reassignable module-level binding', () => {
    const offenders = topLevelLines()
      .filter(([, line]) => /^(export\s+)?(let|var)\s/.test(line))
      .map(([file, line]) => `${file}: ${line}`);
    expect(offenders).toEqual([]);
  });

  it('every module-level mutable collection is a documented global cache', () => {
    // An empty `new Map()` / `Set` / `WeakMap` / `WeakSet` at module scope is a collection
    // something writes to later. A collection built from a literal list is a lookup table, and
    // one declared `Readonly…` cannot be written through.
    const found = topLevelLines()
      .map(([file, line]) => {
        const match =
          /^(?:export\s+)?const\s+(\w+)\s*(?:\s*:\s*([^=]+))?=\s*new\s+(?:Weak)?(?:Map|Set)\b[^(]*\(\s*\)/.exec(line);
        return match && !match[2]?.trim().startsWith('Readonly') ? `${file}: ${match[1]}` : undefined;
      })
      .filter((entry): entry is string => !!entry)
      .sort();
    expect(found).toEqual(Object.keys(GLOBAL_CACHES).sort());
  });

  it('the build-wide registries are gone', () => {
    const leftovers = sourceFiles(SRC)
      .filter((file) => /installBuildRegistries|declarePerBuildRegistry/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(leftovers).toEqual([]);
  });
});
