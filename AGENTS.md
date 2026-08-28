# AGENTS.md — drizzle-graphql

## Project Overview

`drizzle-graphql` is a TypeScript library that automatically generates a fully-typed GraphQL schema from a Drizzle ORM schema. It supports PostgreSQL, MySQL, and SQLite. The output is a `GraphQLSchema` object plus typed resolver helpers that consumers can extend.

Published to npm as `drizzle-graphql`. GitHub: `github.com/vantreeseba/drizzle-graphql`.

## Source Structure

```
drizzle-graphql/
├── src/
│   ├── index.ts                     # Public API: exports buildSchema + all types
│   ├── types.ts                     # All public TypeScript types
│   └── util/
│       ├── builders/
│       │   ├── common.ts            # Shared helpers (extractFilters, extractOrderBy)
│       │   ├── index.ts             # Re-exports all builders
│       │   ├── pg.ts                # PostgreSQL schema generator
│       │   ├── mysql.ts             # MySQL schema generator
│       │   ├── sqlite.ts            # SQLite schema generator
│       │   └── types.ts             # Builder-specific types
│       ├── case-ops/index.ts        # String case utilities
│       ├── data-mappers/index.ts    # Maps Drizzle row data to GraphQL types
│       └── type-converter/          # Converts Drizzle column types to GraphQL scalars
├── tests/
│   ├── schema/                      # Drizzle schema fixtures for tests
│   │   ├── pg.ts                    # PostgreSQL test schema
│   │   ├── mysql.ts                 # MySQL test schema
│   │   └── sqlite.ts                # SQLite test schema
│   ├── pglite/                      # PGlite integration tests (no Docker required)
│   ├── util/                        # Test helpers (GraphQL query client)
│   ├── pg.test.ts                   # PostgreSQL integration tests (Docker)
│   ├── pg-custom.test.ts            # PostgreSQL custom resolver tests (Docker)
│   ├── mysql.test.ts                # MySQL integration tests (Docker)
│   ├── mysql-custom.test.ts         # MySQL custom resolver tests (Docker)
│   ├── sqlite.test.ts               # SQLite integration tests
│   └── sqlite-custom.test.ts        # SQLite custom resolver tests
├── scripts/
│   └── build.ts                     # tsup build script (ESM + CJS + types)
├── dist/                            # Build output
├── .github/workflows/
│   ├── checks.yaml              # Lint + typecheck + full suite; called by both below
│   ├── ci.yaml                  # Checks on every PR, once per graphql-scalars major
│   └── release.yaml             # Checks, then semantic-release, on push to main
├── .releaserc.json                  # semantic-release config
├── biome.json                       # Linter + formatter config
├── vitest.config.ts                 # Vitest config
├── tsconfig.json                    # TypeScript config (strict, bundler resolution)
└── package.json
```

## Commands

### Build
```bash
npm run build       # Build ESM + CJS + type declarations into dist/
npm run pack        # Build and pack into package.tgz (manual publish)
```

### Test
```bash
npm test                              # Run all tests (vitest run)
npx vitest run tests/pglite/          # Run only PGlite tests (no Docker needed)
npx vitest run -t "test name pattern" # Run tests matching a pattern
```

> **Note**: `tests/pg.test.ts` and `tests/mysql.test.ts` require Docker. PGlite and SQLite tests run without it.

### Lint & Format
```bash
npx biome check .          # Check linting + formatting
npx biome check --write .  # Auto-fix linting + formatting
npx biome format --write . # Format only
```

### Type Check
```bash
npx tsc --noEmit
```

## Code Style (Biome)

Config lives in `biome.json`.

| Setting | Value |
|---------|-------|
| Indentation | 2 spaces |
| Quotes | Single |
| Semicolons | Always |
| Trailing commas | All |
| Line width | 120 |
| Arrow parens | Always |
| Line endings | LF |

Key lint rules enforced:
- `style/useImportType: error` — use `import type` for type-only imports
- `correctness/noUnusedImports: error`
- `correctness/noUnusedVariables: error`
- `suspicious/noExplicitAny: off` — library internals need `any` for generics
- `style/noNonNullAssertion: off`

Run `npx biome check --write .` before committing.

## TypeScript Patterns

### Strict mode
All strict compiler flags are on (see `tsconfig.json`). Notable constraints:
- `noUncheckedIndexedAccess` — index access returns `T | undefined`
- `exactOptionalPropertyTypes: false` — optional props accept `undefined`
- `noImplicitAny: true`

### Imports
Use `import type` for type-only imports:
```typescript
import type { GraphQLSchema } from 'graphql';   // type-only — required by Biome
import { buildSchema } from '@/index';           // runtime value
```

Internal imports use the `.ts` extension explicitly:
```typescript
import type { BuildSchemaConfig } from './types.ts';
```

Path alias `@/` maps to `src/` (configured in both `tsconfig.json` and `vitest.config.ts`).

### Naming Conventions
- **Files**: `kebab-case.ts`
- **Types / Interfaces**: `PascalCase`
- **Variables / functions**: `camelCase`
- **Constants**: `SCREAMING_SNAKE_CASE`

### Type Exports
All public types live in `src/types.ts` and are re-exported from `src/index.ts`. Never duplicate types — infer them from Drizzle where possible.

## Testing

Tests live in `tests/` and run with [Vitest](https://vitest.dev/).

```bash
npm test                               # run all tests once
npx vitest run tests/pglite/           # PGlite only (fast, no Docker)
npx vitest run -t "some test name"     # filter by name
```

### Test structure
- Use `describe` / `it` / `expect` with **explicit imports** from `vitest` (not globals)
- Use `beforeAll` / `afterAll` for server / Docker setup and teardown
- Use `beforeEach` / `afterEach` for table setup and teardown between tests
- Create a fresh `Context` object per test file for isolation
- Use `describe.sequential` when tests share mutable database state

### Test types
| Test | Infrastructure | Speed |
|------|---------------|-------|
| `tests/pglite/*.test.ts` | PGlite (embedded Postgres WASM) | Fast |
| `tests/sqlite*.test.ts` | SQLite in-memory | Fast |
| `tests/pg*.test.ts` | Docker (PostgreSQL) | Slow |
| `tests/mysql*.test.ts` | Docker (MySQL) | Slow |

### Example test (PGlite — preferred for new tests)
```typescript
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';
import type { Context } from './common';

const DATA_DIR = `./tests/.temp/pgdata-myfeature-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => { await setupServer(ctx, 4099, DATA_DIR); });
afterAll(async () => { await teardownServer(ctx, DATA_DIR); });
beforeEach(async () => { await setupTables(ctx); });
afterEach(async () => { await teardownTables(ctx); });

describe.sequential('my feature', () => {
  it('returns expected data', async () => {
    const result = await ctx.gql.queryGql(`{ users { id name } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toHaveLength(0);
  });
});
```

### Adding tests for new functionality
- Add PGlite tests in `tests/pglite/` for coverage that doesn't need a specific DB engine
- Add DB-specific tests in the corresponding `tests/pg.test.ts`, `tests/mysql.test.ts`, or `tests/sqlite.test.ts` when the behavior differs per engine
- Mirror in the `*-custom.test.ts` file when testing the `entities` output (custom resolver use case)

## Git Workflow

### Branch naming
- `feat/description` — new features
- `fix/description` — bug fixes
- `chore/description` — maintenance, deps, tooling

### Semantic Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec. This drives automated versioning and changelog generation.

```
<type>(<optional scope>): <short description>

[optional body]

[optional footer(s)]
```

| Type | Version bump | Use for |
|------|-------------|---------|
| `feat` | minor (`0.x.0`) | new functionality |
| `fix` | patch (`0.0.x`) | bug fixes |
| `feat!` / `BREAKING CHANGE` footer | major (`x.0.0`) | breaking API changes |
| `chore` | none | deps, tooling, maintenance |
| `docs` | none | documentation only |
| `refactor` | none | internal restructuring |
| `test` | none | adding/updating tests |
| `ci` | none | CI/CD changes |
| `build` | none | build system changes |

**Examples:**
```
feat: add singularTypes option to BuildSchemaConfig
fix: resolve MySQL enum handling for nullable columns
feat!: rename buildSchema return type to GeneratedData
chore: update drizzle-orm peer dep to 1.0
```

### Merge strategy
Use `git pull --no-rebase` when integrating remote changes.

Do not add `Co-Authored-By` trailers to commits.

## Release Process

Releases are automated via **semantic-release** on every push to `main`.

### How it works
1. Merge a PR to `main` (or push directly)
2. GitHub Actions runs `.github/workflows/release.yaml`
3. `semantic-release` analyzes commits since the last release tag
4. If releasable commits exist (any `feat` or `fix`):
   - Bumps version in `package.json` (semver based on commit types)
   - Rebuilds the package (`npm run build` runs via npm's `prepare` lifecycle)
   - Publishes to npm
   - Updates `CHANGELOG.md`
   - Creates a GitHub release with generated release notes
   - Commits `CHANGELOG.md` + `package.json` back to `main` (tagged `[skip ci]`)
5. If no releasable commits (only `chore`, `docs`, etc.), nothing is published

### Required GitHub secrets
| Secret | Purpose |
|--------|---------|
| `NPM_ACCESS_TOKEN` | npm automation token with publish rights |
| `GITHUB_TOKEN` | automatically provided by Actions |

### Versioning rules (semver)
- `fix:` → patch: `0.8.5` → `0.8.6`
- `feat:` → minor: `0.8.5` → `0.9.0`
- `feat!:` or `BREAKING CHANGE:` → major: `0.8.5` → `1.0.0`

### Manual / emergency release
```bash
npm run build
npm run pack
npm publish package.tgz
```

## Build System

`scripts/build.ts` uses [tsup](https://tsup.egoist.dev/) to produce a dual ESM + CJS package:

| Output file | Format |
|-------------|--------|
| `dist/index.js` | ESM |
| `dist/index.cjs` | CommonJS |
| `dist/index.d.ts` | TypeScript declarations (ESM) |
| `dist/index.d.cts` | TypeScript declarations (CJS) |

The `exports` map in `package.json` gates which format is loaded at import time. The `files` field in `package.json` controls what gets published — only `dist/` is included.

The build also copies `package.json` and `README.md` into `dist/` so the published tarball is self-contained.

## Key Architectural Patterns

### Database engine detection
`buildSchema` detects the DB type at runtime using `is()` from drizzle-orm, then delegates to the appropriate generator:
```typescript
if (is(db, PgAsyncDatabase))    generatorOutput = generatePG(db, ...);
if (is(db, MySqlDatabase))      generatorOutput = generateMySQL(db, ...);
if (is(db, BaseSQLiteDatabase)) generatorOutput = generateSQLite(db, ...);
```

Each engine has its own builder in `src/util/builders/` but shares helpers from `common.ts`.

### Public API surface
Everything public is exported from `src/index.ts`. The type definitions live in `src/types.ts` but are re-exported from `index.ts`. Consumers should only import from the package root (`drizzle-graphql`), never from deep paths.

### Error handling
Throw early with descriptive, prefixed messages. Do not catch drizzle-orm or graphql errors — let them propagate to the caller:
```typescript
if (!schema) {
  throw new Error('Drizzle-GraphQL Error: Schema not found in drizzle instance...');
}
```

### Dual-package exports
The `exports` field in `package.json` is the authoritative routing table. Never import from `dist/` paths directly in consuming code.

### Peer dependencies
`drizzle-orm`, `graphql`, `graphql-parse-resolve-info`, and `graphql-scalars` are peer dependencies — they must be provided by the consumer. The library has zero production runtime dependencies except `pluralize`.

`drizzle-orm` is peered at `^1.0.0-rc.4`, and the floor is deliberate rather than cautious: rc.4 renamed `MySqlDatabase` to `MySqlAsyncDatabase` and `BaseSQLiteDatabase` to `SQLiteAsyncDatabase`, dropped the MySQL `mode` option, and finished removing the drizzle constructor's separate `schema` argument, so rc.2 and rc.3 genuinely do not work. Widening the floor back means restoring those names. Note also that a prerelease range admits drizzle's snapshot builds — `1.0.0-rc.4-5d5b77c` sorts *above* `1.0.0-rc.4`, because an alphanumeric prerelease identifier outranks a numeric one — so a consumer on `^1.0.0-rc.4` can land on a build nobody tested. That is why the devDependency is pinned exactly — `npm update` against the caret range really does pull the latest snapshot, and the lockfile has to stay on the version CI runs.

`graphql-scalars` is peered at `^1.25.0 || ^2.0.0`. The lockfile pins v2; CI runs the whole suite a second time against v1, so widening or narrowing that range means changing the matrix in `ci.yaml` too.
