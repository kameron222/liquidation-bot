import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.js'],
    exclude: ['node_modules/**', 'lib/**', 'out/**', 'forge-cache/**', 'broadcast/**'],
  },
});
