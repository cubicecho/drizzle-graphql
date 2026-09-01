import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep every chunk in one file per format, matching the previous tsup build.
  unbundle: false,
  // tsdown would otherwise emit `.mjs` / `.d.mts` for ESM. The `exports` map in
  // package.json is the published contract, so pin the names it already points at.
  outExtensions: ({ format }) => (format === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.js', dts: '.d.ts' }),
});
