#!/usr/bin/env node
/**
 * scripts/healthcheck — credential + external-service smoke test.
 *
 * Verifies every external service Arkova depends on is reachable with the
 * credentials currently wired up. Intended for:
 *   - post-rotation verification after any key rotation
 *   - Secret Manager migration gating (SCRUM-1055)
 *   - day-2 smoke test before sensitive releases
 *
 * Usage:
 *   npm run healthcheck                    # exit 0 if green, 1 if any red
 *   npm run healthcheck -- --fix           # print remediation for failed checks
 *   npm run healthcheck -- --only=gcp,jira # filter checks
 *
 * Parent: SCRUM-1056 (SEC-HARDEN-03).
 */

import { runChecks } from "./runner";
import { checks } from "./checks";

const args = process.argv.slice(2);
const showFix = args.includes("--fix");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;

const selected = only ? checks.filter((c) => only.includes(c.name)) : checks;

async function main() {
  const results = await runChecks(selected);
  const pad = Math.max(...results.map((r) => r.name.length));
  let red = 0;
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    const ms = `${r.durationMs}ms`.padStart(6);
    console.log(`${mark} ${r.name.padEnd(pad)}  ${ms}  ${r.detail}`);
    if (!r.ok) red++;
  }
  if (showFix) {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.log("\n--- Remediation ---");
      for (const r of failed) console.log(`[${r.name}] ${r.remediation ?? "(no remediation hint)"}`);
    }
  }
  console.log(`\n${results.length - red}/${results.length} green.`);
  process.exit(red === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("healthcheck runner crashed:", err);
  process.exit(2);
});
