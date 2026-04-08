import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
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
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-ui': ['lucide-react', 'sonner', 'class-variance-authority', 'clsx', 'tailwind-merge'],
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
