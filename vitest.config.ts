import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', include: ['packages/contracts/src/**/*.test.ts'] } },
      { test: { name: 'migrations', include: ['database/migrations/src/**/*.test.ts'] } },
      { test: { name: 'relief', include: ['apps/relief/src/**/*.test.ts', 'apps/relief/web/src/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
