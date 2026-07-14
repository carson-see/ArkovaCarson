import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..", "..");
const WORKFLOW_PATH = resolve(REPO, ".github/workflows/staging-evidence.yml");

function rootSteps(workflow: string): string[] {
  const lines = workflow.split("\n");
  const steps: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {6}- \S/u.test(lines[index])) continue;

    const block = [lines[index]];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (/^ {6}- \S/u.test(line)) break;
      if (line.trim() !== "" && !/^ {8,}\S/u.test(line)) break;
      block.push(line);
      cursor += 1;
    }
    steps.push(block.join("\n"));
    index = cursor - 1;
  }

  return steps;
}

function rootCheckoutSteps(workflow: string): string[] {
  const checkoutUse = /^(?: {6}- | {8})uses:\s*actions\/checkout@[^\s#]+/mu;
  return rootSteps(workflow).filter((step) => checkoutUse.test(step));
}

function assertWorkflowContract(workflow: string): void {
  expect(workflow).toContain("  pull_request:\n");
  expect(workflow.match(/actions\/checkout@/gu) ?? []).toHaveLength(1);
  expect(workflow.match(/HEAD_REF_SHA/gu) ?? []).toHaveLength(1);
  expect(
    workflow.match(/github\.event\.pull_request\.head\.sha/gu) ?? [],
  ).toHaveLength(1);

  const checkouts = rootCheckoutSteps(workflow);
  expect(
    checkouts,
    "staging-evidence must have exactly one root checkout step",
  ).toHaveLength(1);

  const branchHeadCheckoutRef =
    /^\s+ref:\s*["']?\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}\s*["']?\s*$/mu;
  expect(
    checkouts.some((checkout) => branchHeadCheckoutRef.test(checkout)),
  ).toBe(false);

  const checkoutRefs = checkouts.flatMap((checkout) =>
    [...checkout.matchAll(/^ {10}ref:\s*(.+)$/gmu)].map((match) => match[1]),
  );
  expect(checkoutRefs).toEqual(["${{ github.ref }}"]);
  expect(checkoutRefs).not.toContain(
    "${{ github.event.pull_request.head.sha }}",
  );

  const fetchDepths = checkouts.flatMap((checkout) =>
    [...checkout.matchAll(/^ {10}fetch-depth:\s*(.+)$/gmu)].map(
      (match) => match[1],
    ),
  );
  expect(fetchDepths).toEqual(["0"]);

  const headEvidenceBindings = [
    ...workflow.matchAll(
      /^( +)(?:HEAD_REF_SHA|"HEAD_REF_SHA"|'HEAD_REF_SHA'):\s*(.+)$/gmu,
    ),
  ].map((match) => ({ indentation: match[1].length, value: match[2] }));
  expect(headEvidenceBindings).toEqual([
    {
      indentation: 6,
      value: "${{ github.event.pull_request.head.sha }}",
    },
  ]);
}

describe("staging-evidence workflow integration-ref contract", () => {
  it("tests the pull-request merge ref while separately pinning exact branch-head evidence", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    assertWorkflowContract(workflow);
  });

  it("rejects a later checkout that silently switches execution back to the branch head", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Later branch-head checkout",
      "        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
      "          fetch-depth: 0",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a step-level HEAD_REF_SHA override without rejecting the job evidence pin", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadow exact-head evidence",
      "        env:",
      "          HEAD_REF_SHA: ${{ github.ref }}",
      "        run: echo shadowed",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a later double-quoted checkout and quoted branch-head ref", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Quoted branch-head checkout",
      '        uses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"',
      "        with:",
      '          ref: "${{ github.event.pull_request.head.sha }}"',
      "          fetch-depth: 0",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a later single-quoted checkout and quoted branch-head ref", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Single-quoted branch-head checkout",
      "        uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'",
      "        with:",
      "          ref: '${{ github.event.pull_request.head.sha }}'",
      "          fetch-depth: 0",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a quoted step-level HEAD_REF_SHA key", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Quote-shadow exact-head evidence",
      "        env:",
      '          "HEAD_REF_SHA": ${{ github.ref }}',
      "        run: echo shadowed",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });
});
