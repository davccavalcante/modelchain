import { defineConfig } from 'tsup';

/**
 * Build configuration for @takk/modelchain.
 *
 * Five library entries emit dual ESM + CJS bundles + matching .d.ts/.d.cts:
 *   - `index`         (universal core)
 *   - `providers/index`
 *   - `web/index`     (browser-safe subset)
 *   - `edge/index`    (edge runtime preset)
 *   - `ai-sdk/index`  (Vercel AI SDK adapter)
 *
 * The CLI binary entry emits ESM only with a shebang (Node-only script).
 */
export default defineConfig([
  // Library entries: dual ESM + CJS with types
  {
    entry: {
      index: 'src/index.ts',
      'providers/index': 'src/providers/index.ts',
      'web/index': 'src/web/index.ts',
      'edge/index': 'src/edge/index.ts',
      'ai-sdk/index': 'src/ai-sdk/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: 'node20',
    outDir: 'dist',
    shims: false,
    minify: false,
    esbuildOptions(options) {
      options.conditions = ['module'];
    },
  },
  // CLI: ESM only, with shebang
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    target: 'node20',
    outDir: 'dist',
    shims: false,
    minify: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
