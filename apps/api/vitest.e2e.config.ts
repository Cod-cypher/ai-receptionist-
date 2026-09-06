import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import swc from 'unplugin-swc';

/**
 * Integration tests run against a real Postgres, because the guarantees they
 * check — row-level security, transactional lead+notification writes — do not
 * exist in a mock. They use their own database so a run cannot disturb
 * development data.
 */
export default defineConfig({
  // Vitest transforms with esbuild, which does not emit `design:paramtypes`.
  // Nest resolves constructor dependencies from exactly that metadata, so
  // without SWC every injected class arrives undefined. This is the same
  // reason the dev server runs the tsc build rather than tsx.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.e2e.test.ts'],
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    // Nest bootstrapping plus argon2 hashing is slow; and these must not race
    // each other over the same tables.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@towai/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
