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

function rootLivePrSteps(workflow: string): string[] {
  const idBinding = /^ {8}id:\s*["']?live_pr["']?\s*$/mu;
  return rootSteps(workflow).filter((step) => idBinding.test(step));
}

/**
 * SCRUM-3026 contract: the staging-evidence gate must never trust the FROZEN
 * `github.sha` / `github.event.pull_request.*` payload for the fields that
 * decide what gets checked out and what evidence is validated. A bare rerun
 * of an existing job (no new webhook delivery) replays that frozen payload
 * untouched, which voided RC-manifest base coverage during the 07-27 10-PR
 * wave and hid post-event body edits from the gate.
 *
 * The fix is a `Resolve live PR state` step (`id: live_pr`) that fetches the
 * PR's CURRENT head/base/merge-preview SHA and body via `gh api`, run before
 * checkout. Checkout then pins to the live-resolved merge-preview SHA
 * (`steps.live_pr.outputs.checkout_sha`) instead of a frozen `github.sha`
 * literal, and the evidence-check step's PR_BODY / HEAD_REF_SHA / BASE_REF_SHA
 * bind to `steps.live_pr.outputs.*` instead of `github.event.pull_request.*`
 * directly. This test pins that shape and rejects every way it previously
 * regressed to a frozen-payload binding (bare `github.sha`, branch-head SHA,
 * `github.ref`, `github.head_ref`, or a raw `github.event.pull_request.*`
 * evidence binding), across the quoting/escaping/anchor edge cases the prior
 * `github.sha`-pinning contract already guarded.
 */
function assertWorkflowContract(workflow: string): void {
  const yamlAnchorOrAlias =
    /(?:^|\s|:|\[|\{|,)[&*][A-Za-z0-9_][A-Za-z0-9_.-]*(?=$|[\s\]},#])/gmu;
  const yamlTag = /(?:^|\s|:|\[|\{|,)!(?:!|<|[A-Za-z0-9_])/gmu;
  const yamlMergeKey = /<<\s*:/gu;
  const forbiddenHeadRefBinding =
    /^\s+(?:ref|"ref"|'ref'):\s*.*github\.head_ref.*$/gmu;

  expect(workflow).toContain("  pull_request:\n");
  expect(workflow.match(/\\/gu) ?? []).toHaveLength(0);
  expect(workflow.match(yamlAnchorOrAlias) ?? []).toHaveLength(0);
  expect(workflow.match(yamlTag) ?? []).toHaveLength(0);
  expect(workflow.match(yamlMergeKey) ?? []).toHaveLength(0);
  expect(workflow.match(/actions\/checkout@/giu) ?? []).toHaveLength(1);
  expect(workflow.match(forbiddenHeadRefBinding) ?? []).toHaveLength(0);
  expect(
    workflow.match(/github\.event\.pull_request\.head\.ref/gu) ?? [],
  ).toHaveLength(0);

  // ── Live-state resolution step (SCRUM-3026) ──
  const livePrSteps = rootLivePrSteps(workflow);
  expect(
    livePrSteps,
    "staging-evidence must have exactly one `id: live_pr` step",
  ).toHaveLength(1);
  const livePrStep = livePrSteps[0];
  expect(livePrStep).toMatch(/gh api/u);
  expect(livePrStep).toMatch(/\/pulls\/\$\{PR_NUMBER\}/u);
  expect(livePrStep).toMatch(/checkout_sha=/u);
  expect(livePrStep).toMatch(/head_sha=/u);
  expect(livePrStep).toMatch(/base_sha=/u);
  expect(livePrStep).toMatch(/body<</u);

  // ── PR-body heredoc delimiter must be randomized per run, not a fixed
  // literal (adversarial review, 2026-07-28) ──
  // The PR body interpolated into this heredoc is fully author-controlled. A
  // FIXED delimiter lets a PR author place that exact string on its own line
  // in their PR body to terminate the heredoc early, then have the rest of
  // their body parsed as literal `key=value` lines appended to
  // $GITHUB_OUTPUT — including overwriting head_sha/base_sha/checkout_sha
  // written earlier in this same step, since GitHub Actions resolves a
  // duplicate output name to its LAST occurrence. A per-run random delimiter
  // (GitHub's own documented remedy) closes this off: the attacker cannot
  // know it in advance.
  const bodyHeredocStarts = [
    ...livePrStep.matchAll(/body<<(\S+)\s*$/gmu),
  ].map((match) => match[1].replace(/^["']|["']$/gu, ""));
  expect(
    bodyHeredocStarts,
    "the PR-body heredoc must appear exactly once in the live_pr step",
  ).toHaveLength(1);
  const [bodyDelimiterToken] = bodyHeredocStarts;
  expect(
    bodyDelimiterToken,
    "the PR-body heredoc delimiter must be a shell-variable expansion (derived at runtime), never a fixed literal string an attacker could pre-empt by embedding it in the PR body",
  ).toMatch(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u);
  const bodyDelimiterVarName = bodyDelimiterToken.slice(2, -1);
  const bodyDelimiterAssignment = new RegExp(
    `\\b${bodyDelimiterVarName}=.*\\$\\(`,
    "u",
  );
  expect(
    livePrStep,
    "the delimiter variable must be assigned from a command substitution (a runtime-random source), not a static string",
  ).toMatch(bodyDelimiterAssignment);
  const closingDelimiterLines = [
    ...livePrStep.matchAll(/^\s+echo "\$\{([A-Za-z_][A-Za-z0-9_]*)\}"\s*$/gmu),
  ].map((match) => match[1]);
  expect(
    closingDelimiterLines,
    "the heredoc's closing line must reuse the exact same delimiter variable that opened it",
  ).toContain(bodyDelimiterVarName);

  const livePrIndex = workflow.indexOf(livePrStep);
  const checkoutIndex = workflow.indexOf(
    "uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  );
  expect(
    livePrIndex,
    "the live_pr step must exist before the checkout step",
  ).toBeGreaterThan(-1);
  expect(checkoutIndex).toBeGreaterThan(-1);
  expect(livePrIndex).toBeLessThan(checkoutIndex);

  // ── Checkout must pin the LIVE-resolved merge-preview SHA ──
  const checkouts = rootCheckoutSteps(workflow);
  expect(
    checkouts,
    "staging-evidence must have exactly one root checkout step",
  ).toHaveLength(1);

  const frozenPayloadCheckoutRef =
    /^\s+ref:\s*["']?\s*\$\{\{\s*(?:github\.sha|github\.ref|github\.head_ref|github\.event\.pull_request\.head\.sha)\s*\}\}\s*["']?\s*$/mu;
  expect(
    checkouts.some((checkout) => frozenPayloadCheckoutRef.test(checkout)),
    "checkout must not pin a frozen github.sha / github.ref / github.event.pull_request.head.sha value",
  ).toBe(false);

  const checkoutRefs = checkouts.flatMap((checkout) =>
    [...checkout.matchAll(/^ {10}ref:\s*(.+)$/gmu)].map((match) => match[1]),
  );
  expect(checkoutRefs).toEqual(["${{ steps.live_pr.outputs.checkout_sha }}"]);
  expect(checkoutRefs).not.toContain("${{ github.sha }}");
  expect(checkoutRefs).not.toContain(
    "${{ github.event.pull_request.head.sha }}",
  );

  const fetchDepths = checkouts.flatMap((checkout) =>
    [...checkout.matchAll(/^ {10}fetch-depth:\s*(.+)$/gmu)].map(
      (match) => match[1],
    ),
  );
  expect(fetchDepths).toEqual(["0"]);

  // ── Evidence-check step must bind to the LIVE outputs, never the raw event ──
  expect(workflow.match(/HEAD_REF_SHA/gu) ?? []).toHaveLength(1);
  expect(workflow.match(/BASE_REF_SHA/gu) ?? []).toHaveLength(1);
  expect(
    workflow.match(/github\.event\.pull_request\.head\.sha/gu) ?? [],
  ).toHaveLength(0);
  expect(
    workflow.match(/github\.event\.pull_request\.base\.sha/gu) ?? [],
  ).toHaveLength(0);
  expect(
    workflow.match(/github\.event\.pull_request\.body/gu) ?? [],
  ).toHaveLength(0);

  const headEvidenceBindings = [
    ...workflow.matchAll(
      /^( +)(?:HEAD_REF_SHA|"HEAD_REF_SHA"|'HEAD_REF_SHA'):\s*(.+)$/gmu,
    ),
  ].map((match) => ({ indentation: match[1].length, value: match[2] }));
  expect(headEvidenceBindings).toEqual([
    { indentation: 10, value: "${{ steps.live_pr.outputs.head_sha }}" },
  ]);

  const baseEvidenceBindings = [
    ...workflow.matchAll(
      /^( +)(?:BASE_REF_SHA|"BASE_REF_SHA"|'BASE_REF_SHA'):\s*(.+)$/gmu,
    ),
  ].map((match) => ({ indentation: match[1].length, value: match[2] }));
  expect(baseEvidenceBindings).toEqual([
    { indentation: 10, value: "${{ steps.live_pr.outputs.base_sha }}" },
  ]);

  const bodyEvidenceBindings = [
    ...workflow.matchAll(/^( +)(?:PR_BODY|"PR_BODY"|'PR_BODY'):\s*(.+)$/gmu),
  ].map((match) => ({ indentation: match[1].length, value: match[2] }));
  // PR_BODY appears once (evidence-check step, live output); no job-level
  // frozen-payload seed is allowed for this field.
  expect(bodyEvidenceBindings).toEqual([
    { indentation: 10, value: "${{ steps.live_pr.outputs.body }}" },
  ]);
}

describe("staging-evidence workflow live-state contract (SCRUM-3026)", () => {
  it("resolves PR state live via gh api and checks out the live merge-preview SHA", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    assertWorkflowContract(workflow);
  });

  it("rejects a later checkout that silently switches execution back to the frozen branch head", () => {
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

  it("rejects a later checkout that reverts to the frozen github.sha value", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Later frozen-sha checkout",
      "        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "        with:",
      "          ref: ${{ github.sha }}",
      "          fetch-depth: 0",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a step-level HEAD_REF_SHA override that shadows the live-output pin", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadow exact-head evidence",
      "        env:",
      "          HEAD_REF_SHA: ${{ github.event.pull_request.head.sha }}",
      "        run: echo shadowed",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a step-level BASE_REF_SHA override that reverts to the frozen event payload", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadow exact-base evidence",
      "        env:",
      "          BASE_REF_SHA: ${{ github.event.pull_request.base.sha }}",
      "        run: echo shadowed",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a step-level PR_BODY override that reverts to the frozen event payload", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadow live body",
      "        env:",
      "          PR_BODY: ${{ github.event.pull_request.body }}",
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

  it("rejects a quoted step-level HEAD_REF_SHA key shadow", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Quote-shadow exact-head evidence",
      "        env:",
      '          "HEAD_REF_SHA": ${{ github.event.pull_request.head.sha }}',
      "        run: echo shadowed",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects an escaped checkout action that semantically resolves to a branch-head checkout", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Escaped branch-head checkout",
      '        uses: "actions\\u002fcheckout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"',
      "        with:",
      "          ref: ${{ github.head_ref }}",
      "          fetch-depth: 0",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects an anchored checkout reused through a step alias", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const checkoutLine =
      "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0";
    const anchored = workflow.replace(
      checkoutLine,
      [
        "      - &staging_checkout",
        "        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
      ].join("\n"),
    );
    expect(anchored).not.toBe(workflow);
    const mutated = `${anchored}\n      - *staging_checkout\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects removing the live_pr step while leaving the live-output checkout binding", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const livePrStepPattern =
      / {6}- name: Resolve live PR state\n(?:^ {8,}.*(?:\n|$))+/mu;
    const withoutLiveStep = workflow.replace(livePrStepPattern, "");
    expect(withoutLiveStep).not.toBe(workflow);

    expect(() => assertWorkflowContract(withoutLiveStep)).toThrow();
  });

  it("rejects reverting the PR-body heredoc to a fixed, predictable delimiter", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const fixedDelimiterHeredoc =
      /echo "body<<\$\{[A-Za-z_][A-Za-z0-9_]*\}"\n(?:.*\n)*?\s+echo "\$\{[A-Za-z_][A-Za-z0-9_]*\}"\n/mu;
    expect(workflow).toMatch(fixedDelimiterHeredoc);
    const mutated = workflow.replace(
      fixedDelimiterHeredoc,
      [
        'echo "body<<STAGING_EVIDENCE_PR_BODY_EOF"',
        '            jq -r \'.body // ""\' <<<"${DATA}"',
        '            echo "STAGING_EVIDENCE_PR_BODY_EOF"',
        "",
      ].join("\n"),
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a delimiter variable assigned from a static string instead of a runtime-random source", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      /BODY_DELIM="ghadelim_\$\(openssl rand -hex 16\)"/u,
      'BODY_DELIM="ghadelim_static_value"',
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });
});

/**
 * Founder directive 2026-08-01: the temporary `SOAK_GATE_DISABLED` bypass is
 * only defensible while its ON switch lives in repo-admin state. `vars.*` is
 * settable by a repo admin (`gh variable set`) and by nobody else; the frozen
 * webhook payload, the PR body, the branch name and the labels are all
 * author-reachable. If that binding ever regressed to one of those, any PR
 * author could disable the staging-evidence gate for their own PR.
 *
 * This also pins that the variable is threaded at all — silently dropping the
 * env line leaves a set variable with no effect, i.e. an operator who believes
 * the queue is unblocked while every PR is still red.
 */
describe("staging-evidence workflow soak-gate bypass contract", () => {
  const soakGateEnvLine = /^ {10}SOAK_GATE_DISABLED:\s*\$\{\{\s*vars\.SOAK_GATE_DISABLED\s*\}\}\s*$/mu;

  it("threads SOAK_GATE_DISABLED into the check step from the live vars context", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    expect(soakGateEnvLine.test(workflow)).toBe(true);
  });

  it("binds the bypass beside DEPLOY_WORKER_PAUSED on the evidence-check step", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const checkStep = rootSteps(workflow).find((step) => /check-staging-evidence\.ts/u.test(step));
    expect(checkStep).toBeDefined();
    expect(soakGateEnvLine.test(checkStep!)).toBe(true);
    expect(/DEPLOY_WORKER_PAUSED:\s*\$\{\{\s*vars\.DEPLOY_WORKER_PAUSED\s*\}\}/u.test(checkStep!)).toBe(true);
  });

  it("pins the bypass to exactly ONE binding of the key", () => {
    // Asserting the correct line is PRESENT is not enough: a second
    // `SOAK_GATE_DISABLED:` under the same `env:` mapping leaves the pinned
    // line intact while changing what the step actually receives.
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const bindings = workflow.match(/^\s*SOAK_GATE_DISABLED:/gmu) ?? [];
    expect(bindings).toHaveLength(1);
  });

  it("rejects rebinding the bypass to any author-reachable context", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    for (const forged of [
      "${{ github.event.pull_request.body }}",
      "${{ contains(github.event.pull_request.labels.*.name, 'soak-gate-disabled') }}",
      "${{ github.head_ref }}",
      "${{ github.event.pull_request.title }}",
      "true",
    ]) {
      const mutated = workflow.replace(soakGateEnvLine, `          SOAK_GATE_DISABLED: ${forged}`);
      expect(mutated).not.toBe(workflow);
      expect(soakGateEnvLine.test(mutated)).toBe(false);
    }
  });
});
