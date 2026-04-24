/**
 * Frontend Environment Variables — VITE_* Convention
 *
 * SCRUM-1059 (SEC-HARDEN-06) audit.
 *
 * Vite bakes every VITE_* env var into the client bundle at build time.
 * These vars are PUBLIC — they ship to every browser that loads the app.
 * NEVER prefix a secret with VITE_.
 *
 * Audit date: 2026-04-24
 * Auditor: automated + manual review
 *
 * ┌──────────────────────────────┬───────────────────────────────────────────┬────────┐
 * │ Variable                     │ Justification                             │ Public │
 * ├──────────────────────────────┼───────────────────────────────────────────┼────────┤
 * │ VITE_SUPABASE_URL            │ Supabase public endpoint URL              │ Yes    │
 * │ VITE_SUPABASE_ANON_KEY       │ Supabase anon key (RLS-gated, no secret)  │ Yes    │
 * │ VITE_WORKER_URL              │ Worker service URL (public endpoint)      │ Yes    │
 * │ VITE_SENTRY_DSN              │ Sentry DSN (ingest-only, no auth)         │ Yes    │
 * │ VITE_APP_URL                 │ Canonical app URL                         │ Yes    │
 * │ VITE_APP_VERSION             │ Semver for Sentry release tracking        │ Yes    │
 * │ VITE_BITCOIN_NETWORK         │ "mainnet" / "testnet" display hint        │ Yes    │
 * │ VITE_STRIPE_PUBLISHABLE_KEY  │ Stripe publishable key (pk_, not sk_)     │ Yes    │
 * │ VITE_BETA_INVITE_CODE        │ Beta gate code (low-risk, UX gate only)   │ Yes    │
 * │ VITE_ENABLE_DSAR_UI          │ Feature flag for DSAR UI                  │ Yes    │
 * └──────────────────────────────┴───────────────────────────────────────────┴────────┘
 *
 * Verdict: All VITE_* vars are public-safe. No secrets found.
 *
 * VITE_BETA_INVITE_CODE is a soft UX gate (not a security boundary).
 * If hardened auth-gating is needed, move to a server-side check.
 */

export const ENV = {
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  WORKER_URL: import.meta.env.VITE_WORKER_URL || 'http://localhost:3001',
  SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN || '',
  APP_URL: import.meta.env.VITE_APP_URL || 'https://app.arkova.ai',
  APP_VERSION: import.meta.env.VITE_APP_VERSION || '0.1.0',
  BITCOIN_NETWORK: import.meta.env.VITE_BITCOIN_NETWORK || 'mainnet',
  STRIPE_PUBLISHABLE_KEY: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '',
  BETA_INVITE_CODE: import.meta.env.VITE_BETA_INVITE_CODE as string | undefined,
  ENABLE_DSAR_UI: import.meta.env.VITE_ENABLE_DSAR_UI === 'true',
  IS_DEV: import.meta.env.DEV,
  IS_PROD: import.meta.env.PROD,
  MODE: import.meta.env.MODE || 'development',
} as const;
