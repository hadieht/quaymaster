import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The host has 2 cores and runs real services: keep test files serial.
    fileParallelism: false,
    pool: 'forks',
  },
});
