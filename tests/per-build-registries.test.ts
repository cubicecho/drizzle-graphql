import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { declaredPerBuildRegistries, uninstalledPerBuildRegistries } from '@/util/per-build-registry';

// `installBuildRegistries` resets the module-global per-build state from a hand-kept list of
// calls. Each registry declares itself with `declarePerBuildRegistry` when its module loads and
// reports in from its install function, so a build that skips one — a call dropped from the
// list, or a new registry never added to it — leaves that registry's name behind here.

const Items = sqliteTable('items', { id: integer('id').primaryKey(), name: text('name') });

const build = () =>
  buildSchema(
    (drizzle as any)({ client: new DatabaseSync(':memory:'), relations: buildRelations({ Items }, { Items: {} }) }),
  );

const SRC = join(import.meta.dirname, '..', 'src');
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );

describe('per-build registries', () => {
  it('a build installs every registry that has declared itself', () => {
    build();
    // The registries `installBuildRegistries` was written against, so the check cannot pass
    // vacuously because the declarations went missing.
    expect(declaredPerBuildRegistries()).toEqual(
      expect.arrayContaining([
        'scalar overrides',
        'SQLite blob JSON decoders',
        'enum config',
        'column exclusions',
        'aggregate column sets',
        'field-update kinds and inputs',
      ]),
    );
    expect(uninstalledPerBuildRegistries()).toEqual([]);
  });

  it('every module with reassignable module-level state declares a registry', () => {
    // The backstop for a registry that never declared itself: per-build state is reset by
    // reassigning it, so it lives in a top-level `let`. Any file holding one has to declare
    // the registry it belongs to, or the check above cannot see it.
    const undeclared = sourceFiles(SRC)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /^let /m.test(source) && !source.includes('declarePerBuildRegistry(');
      })
      .map((file) => relative(SRC, file));
    expect(undeclared).toEqual([]);
  });
});
