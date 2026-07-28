import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'node:path';

// SCRUM-2249 (HARDEN-1-F / SCRUM-2254): Sentry release identity.
// Prefer the real git commit SHA so the `release` tag matches the source maps
// the Sentry Vite plugin uploads. Vercel exposes VERCEL_GIT_COMMIT_SHA at build
// time; CI/other builds may pass GIT_COMMIT_SHA or fall back to VITE_APP_VERSION.
const APP_RELEASE =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GIT_COMMIT_SHA ??
  process.env.VITE_APP_VERSION ??
  'dev';

export default defineConfig({
  define: {
    // Inlined at build time; consumed by src/lib/sentry.ts initSentry().
    __APP_RELEASE__: JSON.stringify(APP_RELEASE),
  },
  build: {
    // Only generate source maps when Sentry can upload them.
    // When SENTRY_AUTH_TOKEN is set, the plugin uploads maps then deletes them
    // from the bundle so users never download them.
    // Without the token, skip generation entirely to reduce build output.
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN,
    rollupOptions: {
      output: {
        // Vite 8 / rolldown requires manualChunks to be a function.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@huggingface/transformers')) return 'vendor-ai-ner';
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
          // F4 (SCRUM founder 22-format KPI): TIFF/HEIC decode + shared PNG
          // re-encoder, all lazy-loaded from ocrWorker.ts on first
          // TIFF/HEIC/scanned-PDF upload — never in the initial bundle.
          if (id.includes('utif2')) return 'vendor-tiff';
          if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';
          if (id.includes('upng-js')) return 'vendor-png-encode';
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
          if (id.includes('@supabase/supabase-js')) return 'vendor-supabase';
          if (
            id.includes('/lucide-react/') ||
            id.includes('/sonner/') ||
            id.includes('class-variance-authority') ||
            id.includes('/clsx/') ||
            id.includes('tailwind-merge')
          ) {
            return 'vendor-ui';
          }
          if (id.includes('/react-dom/')) return 'vendor-react-dom';
          if (id.includes('react-router-dom') || id.includes('/react-router/')) return 'vendor-router';
          if (id.includes('/react/')) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  plugins: [
    react(),
    // Upload source maps to Sentry on production builds (INFRA-07)
    // Requires SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT env vars
    sentryVitePlugin({
      org: process.env.SENTRY_ORG ?? 'arkova',
      project: process.env.SENTRY_PROJECT ?? 'arkova-frontend',
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // SCRUM-2254: associate uploaded source maps with the same release the
      // runtime tags events with (set via __APP_RELEASE__ in initSentry).
      release: { name: APP_RELEASE },
      sourcemaps: {
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
      // Disable in dev / when no auth token present
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
    // Bundle analysis — run `npm run analyze` to generate treemap
    ...(process.env.ANALYZE ? [visualizer({
      filename: 'dist/bundle-stats.html',
      open: false,
      gzipSize: true,
      brotliSize: true,
      template: 'treemap',
    })] : []),
  ],
  server: {
    // SCRUM-354: frame-ancestors only works in HTTP headers, not meta tags.
    // Production uses vercel.json headers; this covers local dev.
    headers: {
      'X-Frame-Options': 'SAMEORIGIN',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
