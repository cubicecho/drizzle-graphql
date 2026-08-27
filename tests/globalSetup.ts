import { mkdir, rm } from 'node:fs/promises';

// Each pglite test spins up its own on-disk data directory under tests/.temp.
// Per-file afterAll hooks remove them, but a crashed or interrupted run leaves
// ~28MB behind per test file. Wiping the whole directory around every run keeps
// that from accumulating (it once reached 19GB / 724 stale directories).
// PGlite's mkdir is not recursive, so tests/.temp itself must exist before tests run.
const TEMP_DIR = new URL('./.temp', import.meta.url);

export async function setup(): Promise<void> {
  await rm(TEMP_DIR, { recursive: true, force: true });
  await mkdir(TEMP_DIR, { recursive: true });
}

export async function teardown(): Promise<void> {
  await rm(TEMP_DIR, { recursive: true, force: true });
  await mkdir(TEMP_DIR, { recursive: true });
}
