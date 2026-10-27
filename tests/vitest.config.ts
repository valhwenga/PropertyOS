import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // More specific first: Vite matches an alias key as a prefix, so the
      // bare package name would otherwise swallow this subpath and resolve it
      // to `index.ts/dates`.
      'server-only': `${root}tests/support/server-only.ts`,
      '@propertyos/domain/dates': `${root}packages/domain/src/dates.ts`,
      '@propertyos/db/client': `${root}packages/db/src/privileged.ts`,
      '@propertyos/db': `${root}packages/db/src/index.ts`,
      '@propertyos/domain': `${root}packages/domain/src/index.ts`,
      '@propertyos/integrations': `${root}packages/integrations/src/index.ts`,
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
