import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // shared/ exports a few runtime constants; resolve it from source so tests need no build step
    alias: { '@quaymaster/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The host has 2 cores and runs real services: keep test files serial.
    fileParallelism: false,
    pool: 'forks',
  },
});
