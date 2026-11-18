import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'deploy/**/*.test.ts', 'infra/test/**/*.test.ts'],
  },
});
