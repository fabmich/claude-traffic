import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 5_000,
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/scenarios/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
