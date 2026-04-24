/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_WORKER_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BITCOIN_NETWORK?: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  readonly VITE_BETA_INVITE_CODE?: string;
  readonly VITE_ENABLE_DSAR_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
