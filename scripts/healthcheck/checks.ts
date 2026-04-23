import type { Check } from "./runner";

const env = (k: string) => process.env[k];
const has = (k: string) => Boolean(env(k));

async function httpOk(url: string, init?: RequestInit): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    detail: `${res.status} ${res.statusText}`,
  };
}

export const checks: Check[] = [
  {
    name: "supabase",
    run: async () => {
      if (!has("SUPABASE_URL") || !has("SUPABASE_SERVICE_ROLE_KEY")) {
        return { ok: false, detail: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
      }
      const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/`, {
        headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY")! },
      });
      return { ok: res.ok, detail: `${res.status}` };
    },
    remediation: "Rotate via Supabase dashboard → Settings → API. Update projects/arkova1/secrets/supabase-service-role-key in Secret Manager.",
  },
  {
    name: "stripe",
    run: async () =>
      has("STRIPE_SECRET_KEY")
        ? httpOk("https://api.stripe.com/v1/balance", {
            headers: { Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}` },
          })
        : { ok: false, detail: "missing STRIPE_SECRET_KEY" },
    remediation: "Rotate via Stripe dashboard → Developers → API keys. Update Secret Manager.",
  },
  {
    name: "together",
    run: async () =>
      has("TOGETHER_API_KEY")
        ? httpOk("https://api.together.xyz/v1/models", {
            headers: { Authorization: `Bearer ${env("TOGETHER_API_KEY")}` },
          })
        : { ok: false, detail: "missing TOGETHER_API_KEY" },
    remediation: "Regenerate at https://api.together.xyz/settings/api-keys and update Secret Manager.",
  },
  {
    name: "runpod",
    run: async () => {
      if (!has("RUNPOD_API_KEY") || !has("RUNPOD_ENDPOINT_ID")) {
        return { ok: false, detail: "missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID" };
      }
      return httpOk(`https://api.runpod.ai/v2/${env("RUNPOD_ENDPOINT_ID")}/health`, {
        headers: { Authorization: `Bearer ${env("RUNPOD_API_KEY")}` },
      });
    },
    remediation: "Regenerate at console.runpod.io → Settings → API Keys and update Secret Manager.",
  },
  {
    name: "resend",
    run: async () =>
      has("RESEND_API_KEY")
        ? httpOk("https://api.resend.com/domains", {
            headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` },
          })
        : { ok: false, detail: "missing RESEND_API_KEY" },
    remediation: "Regenerate at resend.com/api-keys and update Secret Manager.",
  },
  {
    name: "courtlistener",
    run: async () =>
      has("COURTLISTENER_API_TOKEN")
        ? httpOk("https://www.courtlistener.com/api/rest/v3/", {
            headers: { Authorization: `Token ${env("COURTLISTENER_API_TOKEN")}` },
          })
        : { ok: false, detail: "missing COURTLISTENER_API_TOKEN" },
    remediation: "Request new token via CourtListener API page. Update Secret Manager.",
  },
  {
    name: "openstates",
    run: async () =>
      has("OPENSTATES_API_KEY")
        ? httpOk("https://v3.openstates.org/jurisdictions", {
            headers: { "X-API-Key": env("OPENSTATES_API_KEY")! },
          })
        : { ok: false, detail: "missing OPENSTATES_API_KEY" },
    remediation: "Regenerate at openstates.org/accounts/profile/ and update Secret Manager.",
  },
  {
    name: "upstash",
    run: async () => {
      if (!has("UPSTASH_REDIS_REST_URL") || !has("UPSTASH_REDIS_REST_TOKEN")) {
        return { ok: false, detail: "missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN" };
      }
      return httpOk(`${env("UPSTASH_REDIS_REST_URL")}/ping`, {
        headers: { Authorization: `Bearer ${env("UPSTASH_REDIS_REST_TOKEN")}` },
      });
    },
    remediation: "Rotate at console.upstash.com → your DB → REST API → Reset.",
  },
  {
    name: "gemini-vertex",
    run: async () => {
      if (!has("GEMINI_API_KEY")) return { ok: false, detail: "missing GEMINI_API_KEY (Vertex migration pending per GCP-MAX-01)" };
      return httpOk(`https://generativelanguage.googleapis.com/v1beta/models?key=${env("GEMINI_API_KEY")}`);
    },
    remediation: "Rotate at aistudio.google.com/app/apikey or (preferred) migrate to Vertex SA per SCRUM-1061.",
  },
  {
    name: "anthropic",
    run: async () =>
      has("ANTHROPIC_API_KEY")
        ? httpOk("https://api.anthropic.com/v1/models", {
            headers: {
              "x-api-key": env("ANTHROPIC_API_KEY")!,
              "anthropic-version": "2023-06-01",
            },
          })
        : { ok: true, detail: "not configured (optional — NVI-07/NVI-12 only)" },
    remediation: "Rotate at console.anthropic.com → Settings → API Keys. Update Secret Manager.",
  },
  {
    name: "cloudflare",
    run: async () =>
      has("CLOUDFLARE_API_TOKEN")
        ? httpOk("https://api.cloudflare.com/client/v4/user/tokens/verify", {
            headers: { Authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}` },
          })
        : { ok: false, detail: "missing CLOUDFLARE_API_TOKEN" },
    remediation: "Rotate at dash.cloudflare.com/profile/api-tokens. Scope to least-privilege. Update Secret Manager.",
  },
  {
    name: "sentry",
    run: async () => {
      const dsn = env("SENTRY_DSN");
      if (!dsn) return { ok: false, detail: "missing SENTRY_DSN" };
      try {
        // DSN structure: https://<key>@<host>/<projectId>
        const u = new URL(dsn);
        return { ok: Boolean(u.hostname && u.pathname.length > 1), detail: "dsn parsed" };
      } catch (e) {
        return { ok: false, detail: `invalid DSN: ${String(e)}` };
      }
    },
    remediation: "Regenerate DSN at sentry.io → your project → Settings → Client Keys (DSN). Update Secret Manager.",
  },
  {
    name: "gcp-adc",
    run: async () => {
      // ADC (Application Default Credentials) path — works in Cloud Run + local `gcloud auth application-default login`
      // We just confirm the env advertises service-account context.
      const ok =
        has("GOOGLE_APPLICATION_CREDENTIALS") ||
        has("K_SERVICE") || // set on Cloud Run
        has("GCP_KMS_PROJECT_ID");
      return {
        ok,
        detail: ok ? "service-account context present" : "no GOOGLE_APPLICATION_CREDENTIALS / K_SERVICE / GCP_KMS_PROJECT_ID",
      };
    },
    remediation: "Locally: `gcloud auth application-default login`. On Cloud Run: Workload Identity auto-mounts.",
  },
  {
    name: "jira",
    run: async () => {
      if (!has("JIRA_API_TOKEN") || !has("JIRA_EMAIL")) {
        return { ok: true, detail: "not configured (optional — MCP path is primary)" };
      }
      const auth = Buffer.from(`${env("JIRA_EMAIL")}:${env("JIRA_API_TOKEN")}`).toString("base64");
      return httpOk("https://arkova.atlassian.net/rest/api/3/myself", {
        headers: { Authorization: `Basic ${auth}` },
      });
    },
    remediation: "Regenerate at id.atlassian.com/manage-profile/security/api-tokens. Update Secret Manager.",
  },
];
