import { createRequire } from 'node:module';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
import { defineConfig } from 'vitest/config';

const GRAPHQL_ENTRY = createRequire(import.meta.url).resolve('graphql');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    isolate: true,
    // `expectTypeOf` assertions are compile-time only; `npm run typecheck` is what
    // actually enforces them (tests/tsconfig.json is the project that includes tests/).
    typecheck: {
      tsconfig: 'tests/tsconfig.json',
    },
    testTimeout: 100000,
    hookTimeout: 120000,
    // Limit Docker-based tests to avoid container startup contention
    maxWorkers: 3,
    minWorkers: 1,
  },
  plugins: [viteCommonjs()],
  // Vite resolves `@/*` from tsconfig natively since 7.2; `vite-tsconfig-paths` used to do it.
  //
  // `graphql` is aliased to the one file Node itself would load, because Vite and Node do not
  // agree on which of the several files the package ships is *the* one. Both majors offer more
  // than one: 16 has no `exports` map, so Vite follows `module` to `index.mjs` while Node
  // follows `main` to `index.js`; 17 has one, and routes a `development` condition — which Vite
  // sets and Node does not — to a second complete copy under `__dev__/`. Vitest transforms the
  // repo's own sources but leaves `graphql-scalars` and `graphql-yoga` to Node, so without the
  // alias the two sides hold different instances of the same installed version and every schema
  // dies on `Cannot use GraphQLScalarType "JSON" from another module or realm`. Resolving it
  // here, rather than hard-coding a path, is what makes it hold across both majors.
  resolve: { tsconfigPaths: true, alias: { graphql: GRAPHQL_ENTRY } },
});
