import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Vite library mode build for the Arkova embeddable widget.
 *
 * Output:
 *   dist/embed.umd.js  — UMD bundle, attaches window.ArkovaEmbed
 *   dist/embed.es.js   — ESM bundle for modern bundlers
 *   dist/embed.iife.js — IIFE for plain <script> usage on cdn.arkova.ai
 *
 * No React. No Tailwind. No external runtime dependencies.
 * Target bundle size: <15 KB gzipped.
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ArkovaEmbed',
      formats: ['es', 'umd', 'iife'],
      fileName: (format) => `embed.${format}.js`,
    },
    rollupOptions: {
      external: [],
      output: {
        globals: {},
        // Named exports only — index.ts exposes `mount`, `autoInit`, and the
        // types, and attaches `window.ArkovaEmbed = { mount, autoInit }` at
        // load time. The `export default` there is for ESM ergonomics; the
        // UMD/IIFE consumers shouldn't have to unwrap `.default`.
        exports: 'named',
      },
    },
    minify: 'esbuild',
    sourcemap: true,
    emptyOutDir: true,
    target: 'es2018',
  },
  test: {
    globals: false,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
