import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    isolate: true,
    typecheck: {
      tsconfig: 'tsconfig.json',
    },
    testTimeout: 100000,
    hookTimeout: 120000,
    // Limit Docker-based tests to avoid container startup contention
    maxWorkers: 3,
    minWorkers: 1,
  },
  plugins: [viteCommonjs(), tsconfigPaths()],
  resolve: { alias: { graphql: 'graphql/index.js' } },
});
