import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'node:path';

export default defineConfig({
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
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('react-router-dom') ||
            id.includes('/react-router/')
          ) {
            return 'vendor-react';
          }
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
