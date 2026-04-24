#!/usr/bin/env node
/**
 * scripts/secrets/audit-env — drift audit for SCRUM-1055 (SEC-HARDEN-02).
 *
 * Read-only. Parses `.github/workflows/deploy-worker.yml`'s `--set-secrets`
 * line + compares against the SEC-HARDEN-02 expected-secrets list. Prints
 * 3 columns: secret name | currently bound on Cloud Run? | Secret Manager path.
 *
 * Useful as the gate BEFORE running the per-secret migration in
 * `docs/runbooks/sec-harden/sec-harden-02-secret-manager-migration.md` —
 * surfaces drift without making any cloud-side change.
 *
 * Usage:
 *   npm run audit:secrets               # exit 0 if no drift, 1 if drift
 *   npm run audit:secrets -- --json     # machine-readable output
 *
 * Parent: SCRUM-1055 (SEC-HARDEN-02).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Secrets the SEC-HARDEN-02 epic expects to see under Secret Manager. */
export const EXPECTED_SECRETS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "BITCOIN_TREASURY_WIF",
  "SENTRY_DSN",
  "API_KEY_HMAC_SECRET",
  "GEMINI_API_KEY",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "TOGETHER_API_KEY",
  "COURTLISTENER_API_TOKEN",
  "OPENSTATES_API_KEY",
  "BITCOIN_RPC_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "ANTHROPIC_API_KEY",
  "RUNPOD_API_KEY",
  "EDGAR_USER_AGENT",
  "SAM_GOV_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_TUNNEL_TOKEN",
] as const;

export type SecretBinding = { envVar: string; secretPath: string };

/** Parse a `--set-secrets "K=v:tag,K2=v2:tag"` line into ENV→secret-path bindings. */
export function parseDeployWorkerSecrets(yamlContent: string): SecretBinding[] {
  const match = yamlContent.match(/--set-secrets\s+"([^"]+)"/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return null;
      return { envVar: pair.slice(0, eq), secretPath: pair.slice(eq + 1) };
    })
    .filter((b): b is SecretBinding => b !== null);
}

export type AuditRow = {
  envVar: string;
  bound: boolean;
  secretPath: string | null;
};

/** Diff expected-list against current Cloud Run bindings. */
export function auditDrift(
  bindings: SecretBinding[],
  expected: readonly string[] = EXPECTED_SECRETS,
): AuditRow[] {
  const byEnv = new Map(bindings.map((b) => [b.envVar, b.secretPath]));
  return expected.map((envVar) => ({
    envVar,
    bound: byEnv.has(envVar),
    secretPath: byEnv.get(envVar) ?? null,
  }));
}

function formatTable(rows: AuditRow[]): string {
  const pad = Math.max(...rows.map((r) => r.envVar.length));
  const lines = rows.map((r) => {
    const mark = r.bound ? "✓" : "✗";
    const path = r.secretPath ?? "(missing — needs `gcloud secrets create`)";
    return `${mark} ${r.envVar.padEnd(pad)}  ${path}`;
  });
  const missing = rows.filter((r) => !r.bound).length;
  return [...lines, "", `${rows.length - missing}/${rows.length} bound. ${missing} drift.`].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");

  const yamlPath = resolve(process.cwd(), ".github/workflows/deploy-worker.yml");
  const yaml = readFileSync(yamlPath, "utf-8");
  const bindings = parseDeployWorkerSecrets(yaml);
  const rows = auditDrift(bindings);

  if (json) {
    console.log(JSON.stringify({ rows, missing: rows.filter((r) => !r.bound).map((r) => r.envVar) }, null, 2));
  } else {
    console.log(formatTable(rows));
  }

  process.exit(rows.every((r) => r.bound) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
