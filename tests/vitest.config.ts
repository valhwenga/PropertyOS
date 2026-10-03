import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@propertyos/db': `${root}packages/db/src/index.ts`,
      '@propertyos/domain': `${root}packages/domain/src/index.ts`,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    setupFiles: ['tests/support/setup.ts'],
    // Database tests share one cluster; isolation comes from per-test
    // organisations rather than from parallel databases.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
