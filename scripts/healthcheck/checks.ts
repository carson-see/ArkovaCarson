import type { Check } from "./runner";

const env = (k: string) => process.env[k];
const has = (k: string) => Boolean(env(k));

type Result = { ok: boolean; detail: string };

const HTTP_TIMEOUT_MS = 10_000;

async function httpOk(url: string, init?: RequestInit): Promise<Result> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return { ok: res.ok, detail: `${res.status} ${res.statusText}`.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `fetch failed: ${msg}` };
  }
}

function missingEnv(...vars: string[]): Result | null {
  const missing = vars.filter((v) => !has(v));
  return missing.length ? { ok: false, detail: `missing ${missing.join(", ")}` } : null;
}

function bearerHeader(key: string): HeadersInit {
  return { Authorization: `Bearer ${env(key)}` };
}

async function guardedFetch(url: string, required: string[], headers: HeadersInit): Promise<Result> {
  return missingEnv(...required) ?? httpOk(url, { headers });
}

function rotateAt(vendor: string, path: string): string {
  return `Rotate at ${vendor}${path}. Update Secret Manager.`;
}

export const checks: Check[] = [
  {
    name: "supabase",
    run: () =>
      guardedFetch(
        `${env("SUPABASE_URL") ?? ""}/rest/v1/`,
        ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
        { apikey: env("SUPABASE_SERVICE_ROLE_KEY") ?? "" },
      ),
    remediation: rotateAt("Supabase dashboard", " → Settings → API. Secret Manager key: supabase-service-role-key"),
  },
  {
    name: "stripe",
    run: () => guardedFetch("https://api.stripe.com/v1/balance", ["STRIPE_SECRET_KEY"], bearerHeader("STRIPE_SECRET_KEY")),
    remediation: rotateAt("Stripe dashboard", " → Developers → API keys"),
  },
  {
    name: "together",
    run: () =>
      guardedFetch("https://api.together.xyz/v1/models", ["TOGETHER_API_KEY"], bearerHeader("TOGETHER_API_KEY")),
    remediation: rotateAt("api.together.xyz", "/settings/api-keys"),
  },
  {
    name: "runpod",
    run: () =>
      guardedFetch(
        `https://api.runpod.ai/v2/${env("RUNPOD_ENDPOINT_ID") ?? ""}/health`,
        ["RUNPOD_API_KEY", "RUNPOD_ENDPOINT_ID"],
        bearerHeader("RUNPOD_API_KEY"),
      ),
    remediation: rotateAt("console.runpod.io", " → Settings → API Keys"),
  },
  {
    name: "resend",
    run: () => guardedFetch("https://api.resend.com/domains", ["RESEND_API_KEY"], bearerHeader("RESEND_API_KEY")),
    remediation: rotateAt("resend.com", "/api-keys"),
  },
  {
    name: "courtlistener",
    run: () =>
      guardedFetch("https://www.courtlistener.com/api/rest/v3/", ["COURTLISTENER_API_TOKEN"], {
        Authorization: `Token ${env("COURTLISTENER_API_TOKEN")}`,
      }),
    remediation: "Request new token via the CourtListener API page. Update Secret Manager.",
  },
  {
    name: "openstates",
    run: () =>
      guardedFetch("https://v3.openstates.org/jurisdictions", ["OPENSTATES_API_KEY"], {
        "X-API-Key": env("OPENSTATES_API_KEY") ?? "",
      }),
    remediation: rotateAt("openstates.org", "/accounts/profile/"),
  },
  {
    name: "upstash",
    run: () =>
      guardedFetch(
        `${env("UPSTASH_REDIS_REST_URL") ?? ""}/ping`,
        ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
        bearerHeader("UPSTASH_REDIS_REST_TOKEN"),
      ),
    remediation: rotateAt("console.upstash.com", " → your DB → REST API → Reset"),
  },
  {
    name: "gemini-vertex",
    run: () => {
      const miss = missingEnv("GEMINI_API_KEY");
      if (miss) return Promise.resolve({ ok: false, detail: "missing GEMINI_API_KEY (Vertex migration pending — SCRUM-1061)" });
      return httpOk(`https://generativelanguage.googleapis.com/v1beta/models?key=${env("GEMINI_API_KEY")}`);
    },
    remediation: "Rotate at aistudio.google.com/app/apikey or (preferred) migrate to Vertex SA per SCRUM-1061.",
  },
  {
    name: "anthropic",
    run: () =>
      has("ANTHROPIC_API_KEY")
        ? httpOk("https://api.anthropic.com/v1/models", {
            headers: { "x-api-key": env("ANTHROPIC_API_KEY") ?? "", "anthropic-version": "2023-06-01" },
          })
        : Promise.resolve({ ok: true, detail: "not configured (optional — NVI-07/NVI-12 only)" }),
    remediation: rotateAt("console.anthropic.com", " → Settings → API Keys"),
  },
  {
    name: "cloudflare",
    run: () =>
      guardedFetch(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        ["CLOUDFLARE_API_TOKEN"],
        bearerHeader("CLOUDFLARE_API_TOKEN"),
      ),
    remediation: rotateAt("dash.cloudflare.com", "/profile/api-tokens (least-privilege scope)"),
  },
  {
    name: "sentry",
    run: async () => {
      const dsn = env("SENTRY_DSN");
      if (!dsn) return { ok: false, detail: "missing SENTRY_DSN" };
      try {
        const u = new URL(dsn);
        return { ok: Boolean(u.hostname && u.pathname.length > 1), detail: "dsn parsed" };
      } catch (e) {
        return { ok: false, detail: `invalid DSN: ${String(e)}` };
      }
    },
    remediation: rotateAt("sentry.io", " → your project → Settings → Client Keys (DSN)"),
  },
  {
    name: "gcp-adc",
    run: async () => {
      const ok = has("GOOGLE_APPLICATION_CREDENTIALS") || has("K_SERVICE") || has("GCP_KMS_PROJECT_ID");
      return {
        ok,
        detail: ok ? "service-account context present" : "no GOOGLE_APPLICATION_CREDENTIALS / K_SERVICE / GCP_KMS_PROJECT_ID",
      };
    },
    remediation: "Locally: `gcloud auth application-default login`. On Cloud Run: Workload Identity auto-mounts.",
  },
  {
    name: "jira",
    run: () => {
      if (!has("JIRA_API_TOKEN") || !has("JIRA_EMAIL")) {
        return Promise.resolve({ ok: true, detail: "not configured (optional — MCP path is primary)" });
      }
      const auth = Buffer.from(`${env("JIRA_EMAIL")}:${env("JIRA_API_TOKEN")}`).toString("base64");
      return httpOk("https://arkova.atlassian.net/rest/api/3/myself", {
        headers: { Authorization: `Basic ${auth}` },
      });
    },
    remediation: rotateAt("id.atlassian.com", "/manage-profile/security/api-tokens"),
  },
  {
    name: "confluence",
    run: () => {
      // Atlassian unifies Jira + Confluence under the same API token, so we
      // reuse JIRA_API_TOKEN/JIRA_EMAIL but probe the Confluence space API.
      // Optional, like jira: MCP is the primary path.
      if (!has("JIRA_API_TOKEN") || !has("JIRA_EMAIL")) {
        return Promise.resolve({ ok: true, detail: "not configured (optional — MCP path is primary)" });
      }
      const auth = Buffer.from(`${env("JIRA_EMAIL")}:${env("JIRA_API_TOKEN")}`).toString("base64");
      return httpOk("https://arkova.atlassian.net/wiki/rest/api/space?limit=1", {
        headers: { Authorization: `Basic ${auth}` },
      });
    },
    remediation: rotateAt("id.atlassian.com", "/manage-profile/security/api-tokens (same token covers Jira + Confluence)"),
  },
  {
    name: "github",
    run: () => {
      // Prefer GITHUB_TOKEN; fall back to GH_TOKEN to match the gh CLI's own resolution order.
      const token = env("GITHUB_TOKEN") ?? env("GH_TOKEN");
      if (!token) return Promise.resolve({ ok: false, detail: "missing GITHUB_TOKEN or GH_TOKEN" });
      // /rate_limit works for any valid token regardless of scope (user, app, fine-grained).
      return httpOk("https://api.github.com/rate_limit", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "arkova-healthcheck" },
      });
    },
    remediation: rotateAt("github.com", "/settings/tokens (or `gh auth refresh` for the CLI token)"),
  },
  {
    name: "vercel",
    run: () =>
      // /v2/user works for any valid token regardless of team scope; teams endpoint can 403 on team-scoped tokens.
      guardedFetch("https://api.vercel.com/v2/user", ["VERCEL_TOKEN"], bearerHeader("VERCEL_TOKEN")),
    remediation: rotateAt("vercel.com", "/account/tokens"),
  },
  {
    name: "figma",
    run: () =>
      // Figma PATs use the X-Figma-Token header (NOT Bearer). OAuth tokens use Bearer — we only support PATs here.
      guardedFetch("https://api.figma.com/v1/me", ["FIGMA_TOKEN"], { "X-Figma-Token": env("FIGMA_TOKEN") ?? "" }),
    remediation: rotateAt("figma.com", "/settings → Personal access tokens"),
  },
  {
    name: "sam-gov",
    run: () => {
      // SAM.gov passes the api_key as a query param, not a header. Bound the probe with size=1
      // because their entity API has aggressive per-day quotas.
      if (!has("SAM_GOV_API_KEY")) return Promise.resolve({ ok: false, detail: "missing SAM_GOV_API_KEY" });
      const url = `https://api.sam.gov/entity-information/v4/entities?api_key=${encodeURIComponent(env("SAM_GOV_API_KEY") ?? "")}&samRegistered=Yes&page=0&size=1`;
      return httpOk(url);
    },
    remediation: "Request a new key at https://sam.gov/content/api → My Account → Account Details. Update Secret Manager.",
  },
];
