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

/** Required secrets the production worker must receive from Secret Manager. */
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
  "RUNPOD_API_KEY",
  "EDGAR_USER_AGENT",
  "SAM_GOV_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_TUNNEL_TOKEN",
] as const;

/** Optional secrets may be present, but missing values do not block production deploys. */
export const OPTIONAL_SECRETS = [
  "ANTHROPIC_API_KEY",
] as const;

export type SecretBinding = { envVar: string; secretPath: string };

/**
 * Parse every `--set-secrets "K=v:tag,K2=v2:tag"` occurrence in the YAML into
 * ENV→secret-path bindings. Uses `matchAll` (global regex) so a workflow that
 * splits the flag list across multiple `--set-secrets` invocations (common
 * once the inventory grows past ~20 secrets) still surfaces every binding —
 * a single-match parse would silently drop everything after the first line
 * and make `auditDrift` report bogus missing-bindings.
 */
export function parseDeployWorkerSecrets(yamlContent: string): SecretBinding[] {
  const bindings: SecretBinding[] = [];
  for (const match of yamlContent.matchAll(/--set-secrets\s+"([^"]+)"/g)) {
    for (const pair of match[1].split(",").map((p) => p.trim()).filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      bindings.push({ envVar: pair.slice(0, eq), secretPath: pair.slice(eq + 1) });
    }
  }
  return bindings;
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

function formatTable(requiredRows: AuditRow[], optionalRows: AuditRow[]): string {
  const rows = [...requiredRows, ...optionalRows];
  const pad = Math.max(...rows.map((r) => r.envVar.length));
  const lines = rows.map((r) => {
    const required = requiredRows.includes(r);
    const mark = r.bound ? "✓" : required ? "✗" : "○";
    const path = r.secretPath ?? (required ? "(missing — needs `gcloud secrets create`)" : "(optional — not configured)");
    return `${mark} ${r.envVar.padEnd(pad)}  ${path}`;
  });
  const missingRequired = requiredRows.filter((r) => !r.bound).length;
  return [
    ...lines,
    "",
    `${requiredRows.length - missingRequired}/${requiredRows.length} required bound. ${missingRequired} drift.`,
    `${optionalRows.filter((r) => r.bound).length}/${optionalRows.length} optional bound.`,
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");

  const yamlPath = resolve(process.cwd(), ".github/workflows/deploy-worker.yml");
  const yaml = readFileSync(yamlPath, "utf-8");
  const bindings = parseDeployWorkerSecrets(yaml);
  const rows = auditDrift(bindings);
  const optionalRows = auditDrift(bindings, OPTIONAL_SECRETS);
  const missing = rows.filter((r) => !r.bound);

  if (json) {
    console.log(JSON.stringify({
      rows,
      optionalRows,
      missing: missing.map((r) => r.envVar),
      optionalMissing: optionalRows.filter((r) => !r.bound).map((r) => r.envVar),
    }, null, 2));
  } else {
    console.log(formatTable(rows, optionalRows));
  }

  process.exit(missing.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
