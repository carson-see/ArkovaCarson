import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..", "..");
const WORKFLOW_PATH = resolve(REPO, ".github/workflows/staging-evidence.yml");

function checkoutStep(workflow: string): string {
  const match =
    /^ {6}- uses: actions\/checkout@[^\n]+\n(?:^ {8,}.*(?:\n|$))+/mu.exec(
      workflow,
    );
  expect(
    match,
    "staging-evidence must have one structurally readable checkout step",
  ).not.toBeNull();
  return match![0];
}

describe("staging-evidence workflow integration-ref contract", () => {
  it("tests the pull-request merge ref while separately pinning exact branch-head evidence", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const checkout = checkoutStep(workflow);

    expect(workflow).toContain("  pull_request:\n");
    expect(checkout).toContain("ref: ${{ github.ref }}");
    expect(checkout).toContain("fetch-depth: 0");
    expect(checkout).not.toContain("github.event.pull_request.head.sha");

    const headEvidenceBindings = [
      ...workflow.matchAll(/^ {6}HEAD_REF_SHA:\s*(.+)$/gmu),
    ].map((match) => match[1]);
    expect(headEvidenceBindings).toEqual([
      "${{ github.event.pull_request.head.sha }}",
    ]);
  });
});
