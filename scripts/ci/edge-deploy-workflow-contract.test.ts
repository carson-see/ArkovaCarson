import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { load } from "js-yaml";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..", "..");
const WORKFLOW_PATH = resolve(REPO, ".github/workflows/edge-deploy.yml");

/**
 * Actions-budget hygiene (2026-09-21): a burst of pushes to `main` used to
 * run a full `deploy` job (build + Cloudflare deploy + parity check) for
 * EVERY push, serialized by `concurrency: { group: deploy-edge,
 * cancel-in-progress: false }` but never coalesced — 19 deploys on
 * 2026-09-21 alone. `cancel-in-progress: true` was rejected (see the
 * workflow's own comment on the `Evaluate DEPLOY_EDGE_PAUSED` step): the
 * `wrangler deploy` step and the deployed-version parity check are separate
 * later steps in the SAME `deploy` job, so cancelling mid-flight can leave a
 * real, live deploy with no completed verification run for it. Instead, a
 * queued run checks whether its own commit is still the tip of `main` before
 * doing any real work, and skips (not fails) if a later push has already
 * superseded it.
 *
 * This test extracts and executes the ACTUAL shell from the
 * `Evaluate DEPLOY_EDGE_PAUSED` step's `run:` block, the same technique
 * `staging-evidence-workflow-contract.test.ts` uses for `live_pr` — so it
 * exercises the real bash, not a paraphrase of it.
 */
function evaluateGateStep(workflow: string): string {
  const lines = workflow.split("\n");
  const nameLine = lines.findIndex((l) => /^\s*- name: Evaluate DEPLOY_EDGE_PAUSED\s*$/u.test(l));
  if (nameLine === -1) throw new Error("Evaluate DEPLOY_EDGE_PAUSED step not found");
  const bulletIndent = /^(\s*)-/u.exec(lines[nameLine])?.[1].length ?? 0;
  const block: string[] = [lines[nameLine]];
  let cursor = nameLine + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === "") {
      block.push(line);
      cursor += 1;
      continue;
    }
    const indent = /^(\s*)/u.exec(line)?.[1].length ?? 0;
    if (indent <= bulletIndent) break;
    block.push(line);
    cursor += 1;
  }
  return block.join("\n");
}

function runGateCheck(opts: {
  eventName: "push" | "workflow_dispatch";
  sha: string;
  currentMainSha: string;
  paused?: string;
}): { output: string; calls: string[] } {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const step = evaluateGateStep(workflow);
  const run = step.split(/^ {8}run: \|\s*$/mu)[1];
  if (!run) throw new Error("Evaluate DEPLOY_EDGE_PAUSED run block missing");
  const shell = run
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
    .replaceAll("${{ github.repository }}", "carson-see/ArkovaCarson");

  const dir = mkdtempSync(resolve(tmpdir(), "edge-deploy-gate-"));
  const callsPath = resolve(dir, "calls");
  const outputPath = resolve(dir, "output");
  const ghPath = resolve(dir, "gh");
  writeFileSync(outputPath, "");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\nset -euo pipefail\necho "$*" >> "${callsPath}"\ncase "$*" in\n  *"/commits/main --jq .sha") echo "${opts.currentMainSha}" ;;\n  *) exit 77 ;;\nesac\n`,
  );
  chmodSync(ghPath, 0o755);
  try {
    execFileSync("bash", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: resolve(dir, "summary"),
        EVENT_NAME: opts.eventName,
        SHA: opts.sha,
        ACTOR: "some-actor",
        PAUSED: opts.paused ?? "false",
        GH_TOKEN: "test-token",
      },
      stdio: "pipe",
    });
    return {
      output: readFileSync(outputPath, "utf8"),
      calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("edge-deploy.yml supersession-skip (Actions-budget hygiene, 2026-09-21)", () => {
  it("proceeds when the push commit is still the tip of main", () => {
    const { output, calls } = runGateCheck({
      eventName: "push",
      sha: "a".repeat(40),
      currentMainSha: "a".repeat(40),
    });
    expect(output).toContain("proceed=true");
    expect(calls.some((c) => c.includes("/commits/main"))).toBe(true);
  });

  it("skips (proceed=false) when a later push has already superseded this commit", () => {
    const { output } = runGateCheck({
      eventName: "push",
      sha: "a".repeat(40),
      currentMainSha: "b".repeat(40),
    });
    expect(output).toContain("proceed=false");
  });

  it("never checks main's tip for workflow_dispatch — always proceeds", () => {
    const { output, calls } = runGateCheck({
      eventName: "workflow_dispatch",
      sha: "a".repeat(40),
      currentMainSha: "b".repeat(40),
    });
    expect(output).toContain("proceed=true");
    expect(calls.some((c) => c.includes("/commits/main"))).toBe(false);
  });

  it("still honors DEPLOY_EDGE_PAUSED for a non-superseded push", () => {
    const { output } = runGateCheck({
      eventName: "push",
      sha: "a".repeat(40),
      currentMainSha: "a".repeat(40),
      paused: "true",
    });
    expect(output).toContain("proceed=false");
  });

  it("keeps the workflow-level queue-of-one (cancel-in-progress: false)", () => {
    const workflow = load(readFileSync(WORKFLOW_PATH, "utf8")) as {
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    expect(workflow.concurrency.group).toBe("deploy-edge");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("keeps the push/pull_request path filters scoped to services/edge and this workflow file", () => {
    const workflow = load(readFileSync(WORKFLOW_PATH, "utf8")) as {
      on: { push: { paths: string[] }; pull_request: { paths: string[] } };
    };
    for (const trigger of [workflow.on.push, workflow.on.pull_request]) {
      expect(trigger.paths).toEqual(
        expect.arrayContaining(["services/edge/**", ".github/workflows/edge-deploy.yml"]),
      );
    }
  });
});
