import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for @takk/modelchain.
 *
 * - Node environment by default; multi-runtime smoke tests live alongside as
 *   separate scripts.
 * - Explicit imports (no globals) for editor go-to-definition.
 * - Coverage excludes pure type modules, the CLI bootstrap script, and the
 *   public re-export barrels.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli/index.ts',
        'src/**/types.ts',
        'src/index.ts',
        'src/web/index.ts',
        'src/edge/index.ts',
        'src/providers/index.ts',
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 55,
        statements: 75,
      },
    },
  },
});
