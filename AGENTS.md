# AGENTS.md — drizzle-graphql

## Project Overview

`drizzle-graphql` is a TypeScript library that automatically generates a fully-typed GraphQL schema from a Drizzle ORM schema. It supports PostgreSQL, MySQL, and SQLite. The output is a `GraphQLSchema` object plus typed resolver helpers that consumers can extend.

Published to npm as `@vantreeseba/drizzle-graphql`. This repo is `github.com/cubicecho/drizzle-graphql` (the `origin` remote) — issues, pull requests and the CHANGELOG's links all point there. `github.com/vantreeseba/drizzle-graphql` is the `upstream` remote it forks from, and is not where work lands.

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
│       ├── parse-resolve-info.ts    # Vendored resolve-info walker (see Peer dependencies)
│       └── type-converter/          # Converts Drizzle column types to GraphQL scalars
├── tests/
│   ├── schema/                      # Drizzle schema fixtures for tests
│   │   ├── pg.ts                    # PostgreSQL test schema
│   │   ├── mysql.ts                 # MySQL test schema
│   │   └── sqlite.ts                # SQLite test schema
│   ├── pglite/                      # PGlite integration tests (no Docker required)
│   ├── util/                        # Test helpers (GraphQL query client, message matchers)
│   ├── pg.test.ts                   # PostgreSQL integration tests (Docker)
│   ├── pg-custom.test.ts            # PostgreSQL custom resolver tests (Docker)
│   ├── mysql.test.ts                # MySQL integration tests (Docker)
│   ├── mysql-custom.test.ts         # MySQL custom resolver tests (Docker)
│   ├── sqlite.test.ts               # SQLite integration tests
│   └── sqlite-custom.test.ts        # SQLite custom resolver tests
├── dist/                            # Build output
├── .github/workflows/
│   ├── checks.yaml              # Lint + typecheck + full suite; called by both below
│   ├── ci.yaml                  # Checks on every PR, once per graphql / graphql-scalars major
│   └── release.yaml             # Checks, then semantic-release, on push to main
├── .releaserc.json                  # semantic-release config
├── biome.json                       # Linter + formatter config
├── tsdown.config.ts                 # Build config (ESM + CJS + types)
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
- Never assert a graphql validation error verbatim: 16 and 17 word them differently and the suite runs against both. `tests/util/validation-messages.ts` has matchers for the ones already hit; add to it rather than pinning a sentence

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

The `!` marker only works because `.releaserc.json` sets both `commit-analyzer` and
`release-notes-generator` to the `conventionalcommits` preset. semantic-release defaults to the
`angular` preset, whose header pattern is `/^(\w*)(?:\((.*)\))?: (.*)$/` — it does not allow a
`!`, so under that default a `fix(deps)!:` header parses to a `null` type and the commit becomes
invisible to *both* plugins: no version bump, and no changelog entry either. That is not
hypothetical; it is how the drizzle-orm rc.4 peer-floor bump shipped as 8.2.1. Do not remove the
preset, and if you are ever unsure, add an explicit `BREAKING CHANGE:` footer as well — the footer
is parsed independently of the header and works under either preset.

The preset is pinned to `conventional-changelog-conventionalcommits@9` on purpose. Version 10
requires `conventional-changelog-writer@9` or newer, and semantic-release 25 resolves
`conventional-changelog-writer@8`, so v10 throws `Missing helper` at the `generateNotes` step —
*after* `analyzeCommits` has already succeeded, which means a dry run that only checks the computed
version will not catch it. Bump the preset past 9 only once semantic-release ships a writer 9.

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

`tsdown.config.ts` uses [tsdown](https://tsdown.dev/) — the rolldown-based successor to tsup — to produce a dual ESM + CJS package. `npm run build` invokes the `tsdown` binary directly; there is no wrapper script.

| Output file | Format |
|-------------|--------|
| `dist/index.js` | ESM |
| `dist/index.cjs` | CommonJS |
| `dist/index.d.ts` | TypeScript declarations (ESM) |
| `dist/index.d.cts` | TypeScript declarations (CJS) |

The `exports` map in `package.json` gates which format is loaded at import time. The `files` field in `package.json` controls what gets published — only `dist/` is included.

tsdown defaults to `.mjs` / `.d.mts` for the ESM half, which the `exports` map does not point at, so `outExtensions` in `tsdown.config.ts` pins all four names. That map is the published contract: change the extensions there and consumers break, so the config must keep producing exactly the four files in the table above. The `copy` option copies `package.json` and `README.md` into `dist/` so the published tarball is self-contained.

`npm run build` is wired to npm's `prepare` lifecycle, so it also runs on `npm pack` and during semantic-release publishing. Any change to the build has to work when invoked that way, not just directly.

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

### TypeScript 7
The devDependency is on `^7.0.2`. Do not move the build back to `tsup`: tsup 8.5.1 bundles a vendored `rollup-plugin-dts` 6.1.1 that throws `Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')` against a TS 7 compiler, so `dist/*.d.ts` never gets written. An npm `override` cannot reach a copy compiled into `tsup/dist/rollup.js`. tsdown builds declarations through `rolldown-plugin-dts`, which peers TypeScript 7 directly. tsdown does warn that the TS 7 API is still experimental; that warning is expected, not a failure.

### Peer dependencies
`drizzle-orm`, `graphql`, and `graphql-scalars` are peer dependencies — they must be provided by the consumer. The library has zero production runtime dependencies except `pluralize`.

`graphql` is peered at `>=16.4.0`, with no upper bound: both 16 and 17 work, and CI runs the whole suite against each. It used to be capped below 17, because `graphql-parse-resolve-info` was a fourth peer, used on every resolver, and peered `graphql` at `^16.3.0` with no 17 entry. That package is now vendored — `src/util/parse-resolve-info.ts` — and the peer is gone.

Vendoring was not impatience. Upstream is dead (4.14.1, unchanged since 2025-04-27, and its own peer range stops at 16), and the package fails under 17 without saying so. It is CommonJS, so it reaches graphql through `require`, and it asks "does this field have sub-selections?" with an `instanceof` against whatever that `require` returned. graphql 17 ships several builds of itself from one package — a `development` export condition routes to a whole second copy under `__dev__/`, and `.js`/`.mjs` sit behind the format conditions — so any loader that resolves the CommonJS graph differently from the ESM one hands it a *different* instance of the same version than the one that built the schema. The `instanceof` then answers "no", the walk returns `fieldsByTypeName: {}`, and every resolver reads a selection of nothing: schema build and validation pass, and the first query dies in `extractSelectedColumnsFromTree` on `Object.entries(undefined)`. Plain `node` happens to resolve both graphs to one instance, so the failure looks intermittent rather than absent — under `tsx` it reproduces on this repo's own schema, and adding `--conditions=development` escalates it to a thrown `Cannot use GraphQLNonNull "[Users!]!" from another module or realm`. The vendored parser asks the same questions structurally (`getFields` / `getTypes` / `ofType`), so it cannot disagree with whichever instance is executing.

The floor is 16.4.0, not 16.3.0, and that one minor is deliberate: the parser uses graphql's own `getArgumentValues` rather than re-deriving argument coercion, and 16.3.0 is the last release that does not re-export it from the package root. It is reachable there only at the internal `graphql/execution/values` path — exactly the kind of deep import that produced the problem above. 16.4.0 is April 2022; re-deriving spec-correct coercion for variables, defaults, enums, input objects and list/non-null wrapping to reach it would be trading a real correctness risk for a theoretical install.

`graphql` is also carried as a `^16` devDependency even though it is a peer. Without it npm's peer auto-install resolves the unbounded range to the newest major and the lockfile floats to 17, which would leave 16 — the major most consumers are on — untested. The lockfile pins 16; the `checks-graphql-17` leg in `ci.yaml` covers the other side.

Under Vitest the same split is why `vitest.config.ts` aliases `graphql` to `createRequire(import.meta.url).resolve('graphql')` — the one file Node itself would load. Vitest transforms the repo's own sources but leaves `graphql-scalars` and `graphql-yoga` to Node, and Vite and Node disagree about which of the several files the package ships is the entry: under 16 there is no `exports` map, so Vite follows `module` to `index.mjs` while Node follows `main` to `index.js`; under 17 there is one, and it routes a `development` condition — Vite sets it, Node does not — to a whole second copy under `__dev__/`. Either way the two sides end up holding different instances and every schema dies on `Cannot use GraphQLScalarType "JSON" from another module or realm`. The alias used to be the hard-coded `graphql/index.js`, which was right for 16 by luck and wrong for 17; resolving it makes it right for both. This is a harness artifact — plain Node has one resolver for the whole graph and never sees it.

`drizzle-orm` is peered at `^1.0.0-rc.4`, and the floor is deliberate rather than cautious: rc.4 renamed `MySqlDatabase` to `MySqlAsyncDatabase` and `BaseSQLiteDatabase` to `SQLiteAsyncDatabase`, dropped the MySQL `mode` option, and finished removing the drizzle constructor's separate `schema` argument, so rc.2 and rc.3 genuinely do not work. Widening the floor back means restoring those names. Note also that a prerelease range admits drizzle's snapshot builds — `1.0.0-rc.4-5d5b77c` sorts *above* `1.0.0-rc.4`, because an alphanumeric prerelease identifier outranks a numeric one — so a consumer on `^1.0.0-rc.4` can land on a build nobody tested. That is why the devDependency is pinned exactly — `npm update` against the caret range really does pull the latest snapshot, and the lockfile has to stay on the version CI runs.

`graphql-scalars` is peered at `^1.25.0 || ^2.0.0`. The lockfile pins v2; CI runs the whole suite a second time against v1, so widening or narrowing that range means changing the matrix in `ci.yaml` too.
