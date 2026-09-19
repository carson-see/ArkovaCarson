import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
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

function executeLivePrShell(
  prJson: unknown,
  baseJson: unknown,
  eventDraft = false,
): { output: string; calls: string[] } {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const step = rootLivePrSteps(workflow)[0];
  const run = step.split(/^ {8}run: \|\s*$/mu)[1];
  if (!run) throw new Error("live_pr run block missing");
  const shell = run
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
    .replaceAll("${{ github.event.pull_request.number }}", "42")
    .replaceAll("${{ github.repository }}", "carson-see/ArkovaCarson")
    .replaceAll("${{ github.event.pull_request.draft }}", String(eventDraft));
  const dir = mkdtempSync(resolve(tmpdir(), "live-pr-base-"));
  const callsPath = resolve(dir, "calls");
  const outputPath = resolve(dir, "output");
  const ghPath = resolve(dir, "gh");
  writeFileSync(resolve(dir, "pr.json"), JSON.stringify(prJson));
  writeFileSync(resolve(dir, "base.json"), JSON.stringify(baseJson));
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash\nset -euo pipefail\necho "$*" >> "${callsPath}"\ncase "$*" in\n  *"/pulls/42") cat "${resolve(dir, "pr.json")}" ;;\n  *"/git/ref/heads/main") cat "${resolve(dir, "base.json")}" ;;\n  *) exit 77 ;;\nesac\n`,
  );
  chmodSync(ghPath, 0o755);
  try {
    execFileSync("bash", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputPath,
      },
      stdio: "pipe",
    });
    return {
      output: readFileSync(outputPath, "utf8"),
      calls: readFileSync(callsPath, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  expect(livePrStep).toMatch(/\/git\/ref\/heads\/\$\{BASE_REF\}/u);
  expect(livePrStep).toMatch(/BASE_REPO.*github\.repository/u);
  expect(livePrStep).toMatch(/\^\(main\|staging\|develop\)\$/u);
  expect(livePrStep).toMatch(/\.object\.sha/u);
  expect(livePrStep).toMatch(/CACHED_BASE_SHA.*BASE_SHA/u);
  expect(livePrStep).toMatch(/synthesize_merge=/u);
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
  const bodyHeredocStarts = [...livePrStep.matchAll(/body<<(\S+)\s*$/gmu)].map(
    (match) => match[1].replace(/^["']|["']$/gu, ""),
  );
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
  // Locate the checkout by its ACTION REFERENCE, never by a hardcoded action
  // SHA: pinning the literal `actions/checkout@<sha>` here made this contract
  // test break on every Dependabot pin bump (GH #2396, v7.0.0 -> v7.0.1, turned
  // this lookup into -1 and failed the required `Tests` check on a PR that
  // changed nothing about the contract being asserted). The assertion below
  // still fails closed if the checkout step is removed outright.
  const checkoutUses =
    /^(?: {6}- | {8})uses:\s*actions\/checkout@[^\s#]+/mu.exec(workflow);
  const checkoutIndex = checkoutUses ? checkoutUses.index : -1;
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

describe("staging-evidence draft admission contract", () => {
  it("skips ordinary event-time drafts before allocating a runner", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const jobIf = workflow.match(/^    if: (.+)$/mu)?.[1];
    const jobName = workflow.match(/^    name: (.+)$/mu)?.[1];

    expect(jobIf).toContain("!github.event.pull_request.draft");
    expect(jobIf).toContain("startsWith(github.head_ref, 'mergify/merge-queue/')");
    expect(jobIf).toContain("github.event.pull_request.user.login == 'mergify[bot]'");
    expect(jobName).toContain("'Staging evidence deferred (Draft)'");
    expect(jobName).toContain("'Staging Soak Evidence Gate'");

    // Event truth table pinned by the expression above: ordinary and forged
    // queue drafts allocate no runner; Ready/missing-draft events and genuine
    // Mergify speculative drafts retain their existing evaluation paths.
    const admits = (draft: unknown, branch: string, author: string) =>
      draft !== true ||
      (branch.startsWith("mergify/merge-queue/") && author === "mergify[bot]");
    expect(admits(true, "feature/human", "human")).toBe(false);
    expect(admits(true, "mergify/merge-queue/forged", "human")).toBe(false);
    expect(admits(false, "feature/ready", "human")).toBe(true);
    expect(admits(undefined, "feature/missing", "human")).toBe(true);
    expect(admits(true, "mergify/merge-queue/real", "mergify[bot]")).toBe(true);
  });
});

describe("staging-evidence workflow live-state contract (SCRUM-3026)", () => {
  it("defers an ordinary live draft before base resolution, checkout, or dependency installation", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const { output, calls } = executeLivePrShell(
      { draft: true },
      { object: { sha: "b".repeat(40) } },
      true,
    );

    expect(output).toContain("evaluate=false");
    expect(output).toContain("is_draft=true");
    expect(output).not.toContain("head_sha=");
    expect(calls).toEqual(["api repos/carson-see/ArkovaCarson/pulls/42"]);

    expect(workflow).toContain(
      "types: [opened, edited, synchronize, reopened, ready_for_review, converted_to_draft]",
    );
    expect(workflow).toContain("'Staging evidence deferred (Draft)'");
    expect(workflow).toContain("'Staging Soak Evidence Gate'");
    expect(workflow).toContain(
      "if [[ \"${EVENT_DRAFT}\" == \"true\" ]]",
    );
    expect(workflow).toContain("&& 'draft' || 'gate'");
    expect(workflow).toContain("- name: Defer ordinary draft PR");
    for (const stepName of [
      "actions/checkout@",
      "- name: Setup Node.js",
      "- name: Install root dependencies (typescript + tsx + supabase-js)",
      "- name: Run staging-evidence check",
    ]) {
      const step = rootSteps(workflow).find((candidate) =>
        candidate.includes(stepName),
      );
      expect(step, `${stepName} step must exist`).toBeDefined();
      expect(step).toContain("if: steps.live_pr.outputs.evaluate == 'true'");
    }
  });

  it("keeps a frozen draft event cheap when the live PR is now ready", () => {
    const { output, calls } = executeLivePrShell(
      { draft: false },
      { object: { sha: "b".repeat(40) } },
      true,
    );
    expect(output).toContain("evaluate=false");
    expect(output).toContain("is_draft=false");
    expect(calls).toEqual(["api repos/carson-see/ArkovaCarson/pulls/42"]);
  });

  it("fails a frozen ready event when the live PR has since converted to draft", () => {
    expect(() =>
      executeLivePrShell(
        { draft: true },
        { object: { sha: "b".repeat(40) } },
        false,
      ),
    ).toThrow();
  });

  it("evaluates missing or false draft metadata fail-closed through the complete gate", () => {
    const base = { object: { sha: "b".repeat(40) } };
    const common = {
      head: { sha: "a".repeat(40) },
      base: {
        sha: "b".repeat(40),
        ref: "main",
        repo: { full_name: "carson-see/ArkovaCarson" },
      },
      user: { login: "human-author" },
      merge_commit_sha: "c".repeat(40),
      mergeable_state: "clean",
      body: "Tier: T2",
    };

    for (const draft of [false, undefined, null, "true", { forged: true }]) {
      const pr = { ...common, ...(draft === undefined ? {} : { draft }) };
      const { output, calls } = executeLivePrShell(pr, base);
      expect(output).toContain("evaluate=true");
      expect(output).toContain(`head_sha=${"a".repeat(40)}`);
      expect(calls).toEqual([
        "api repos/carson-see/ArkovaCarson/pulls/42",
        "api repos/carson-see/ArkovaCarson/git/ref/heads/main",
      ]);
    }
  });

  it("resolves PR state live via gh api and checks out the live merge-preview SHA", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    assertWorkflowContract(workflow);
  });

  it("resolves the authoritative base ref instead of trusting the PR resource's cached base SHA", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const livePrStep = rootLivePrSteps(workflow)[0];

    expect(livePrStep).toContain(
      'BASE_DATA="$(gh api "repos/${BASE_REPO}/git/ref/heads/${BASE_REF}")"',
    );
    expect(livePrStep).toContain("BASE_SHA=\"$(jq -r '.object.sha // empty'");
    expect(livePrStep).not.toMatch(
      /^ {10}BASE_SHA="\$\(jq -r '\.base\.sha \/\/ empty'/mu,
    );
    expect(livePrStep).toContain(
      'if [[ "${CACHED_BASE_SHA}" != "${BASE_SHA}" ]]',
    );
    expect(livePrStep).toContain('CHECKOUT_SHA="${HEAD_SHA}"');
    expect(livePrStep).toContain('SYNTHESIZE_MERGE="true"');
  });

  it("fails closed on malformed authoritative base identity or SHA", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const livePrStep = rootLivePrSteps(workflow)[0];

    expect(livePrStep).toContain(
      'if [[ "${BASE_REPO}" != "${{ github.repository }}" ]]',
    );
    expect(livePrStep).toContain(
      'if [[ ! "${BASE_REF}" =~ ^(main|staging|develop)$ ]]',
    );
    expect(livePrStep).toContain(
      'if [[ ! "${HEAD_SHA}" =~ ^[0-9a-f]{40}$ || ! "${BASE_SHA}" =~ ^[0-9a-f]{40}$ ]]',
    );
    expect(livePrStep.match(/exit 1/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("behaviorally replaces a stale PR base SHA with the authoritative branch ref SHA", () => {
    const head = "1".repeat(40);
    const stale = "2".repeat(40);
    const fresh = "3".repeat(40);
    const result = executeLivePrShell(
      {
        head: { sha: head },
        base: {
          sha: stale,
          ref: "main",
          repo: { full_name: "carson-see/ArkovaCarson" },
        },
        user: { login: "author" },
        merge_commit_sha: "4".repeat(40),
        mergeable_state: "clean",
        body: "evidence",
      },
      { object: { sha: fresh } },
    );

    expect(result.calls).toEqual([
      "api repos/carson-see/ArkovaCarson/pulls/42",
      "api repos/carson-see/ArkovaCarson/git/ref/heads/main",
    ]);
    expect(result.output).toContain(`base_sha=${fresh}`);
    expect(result.output).toContain(`checkout_sha=${head}`);
    expect(result.output).toContain("synthesize_merge=true");
  });

  it("synthesizes the tested tree against the authoritative base when the merge preview is stale", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const synth = rootSteps(workflow).find((step) => step.includes("Synthesize merge against authoritative base"));
    expect(synth).toBeDefined();
    expect(synth).toContain("if: steps.live_pr.outputs.synthesize_merge == 'true'");
    expect(synth).toContain("AUTHORITATIVE_BASE_SHA: ${{ steps.live_pr.outputs.base_sha }}");
    expect(synth).toContain('git merge --no-ff --no-edit "${AUTHORITATIVE_BASE_SHA}"');
  });

  it.each([
    ["missing ref", { object: {} }],
    ["malformed ref", { object: { sha: "not-a-sha" } }],
  ])(
    "fails closed when the authoritative base API returns %s",
    (_label, baseJson) => {
      expect(() =>
        executeLivePrShell(
          {
            head: { sha: "1".repeat(40) },
            base: {
              sha: "2".repeat(40),
              ref: "main",
              repo: { full_name: "carson-see/ArkovaCarson" },
            },
            user: { login: "author" },
            mergeable_state: "clean",
            body: "evidence",
          },
          baseJson,
        ),
      ).toThrow();
    },
  );

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
    // Read the real checkout line out of the workflow instead of hardcoding the
    // pinned action SHA — see the comment in assertWorkflowContract (GH #2396).
    const checkoutLine =
      /^ {6}- uses: actions\/checkout@.*$/mu.exec(workflow)?.[0] ?? "";
    expect(
      checkoutLine,
      "staging-evidence must keep a root `- uses: actions/checkout@…` step for this mutation to be meaningful",
    ).not.toBe("");
    const anchored = workflow.replace(
      checkoutLine,
      [
        "      - &staging_checkout",
        checkoutLine.replace(/^ {6}- /u, "        "),
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
 * SCRUM-3812: the merge-queue skip must require the Mergify bot AUTHOR, never
 * the branch name alone. `github.head_ref` is fully author-controlled — any PR
 * opened from a branch literally named `mergify/merge-queue/<anything>` used to
 * skip every enforcement step, and a job whose steps all skip still posts
 * SUCCESS, satisfying `check-success = Staging Soak Evidence Gate` in every
 * .mergify.yml queue. The PR author (`github.event.pull_request.user.login`) is
 * assigned by GitHub and cannot be forged by an author, so requiring
 * `mergify[bot]` alongside the branch prefix leaves only genuine Mergify
 * speculative queue PRs able to skip — which they must (their body carries
 * Mergify's own text, not the original PR's evidence block, so re-checking
 * them deadlocks every queued merge). Deliberately NOT `github.actor`: a human
 * re-running a genuine queue PR's checks becomes the actor, which would
 * un-skip the gate mid-queue and deadlock it; the PR author is immutable.
 * Keep the constant in lockstep with the same constant in
 * soak-integrity-gates-failclosed.test.ts (ci.yml evidence-identity, same
 * class, same fix).
 */
const MERGE_QUEUE_SKIP_EXPRESSION =
  "startsWith(github.head_ref, 'mergify/merge-queue/') && github.event.pull_request.user.login == 'mergify[bot]'";

function assertMergeQueueSkipActorContract(workflow: string): void {
  // These canonical predicates govern evidence steps. The job-level
  // metadata routing is evaluated separately with the GitHub expression engine.
  const values = workflow
    .split("\n")
    .filter((line) => /^ {8}if:/u.test(line))
    .filter(
      (line) =>
        line.includes("github.head_ref") ||
        line.includes("mergify/merge-queue/"),
    )
    .map((line) => {
      const raw = line.replace(/^\s*if:\s*/u, "").trim();
      const quoted = /^"(.*)"$/u.exec(raw) ?? /^'(.*)'$/u.exec(raw);
      return quoted ? quoted[1] : raw;
    });

  // The skip must still exist — removing it outright deadlocks every queued
  // merge, because Mergify's speculative PRs cannot carry the original PR's
  // evidence block and this gate is fail-closed.
  expect(
    values,
    "the merge-queue skip-notice condition must exist in its canonical actor-pinned shape",
  ).toContain(MERGE_QUEUE_SKIP_EXPRESSION);
  // And the enforcement steps must carry its exact negation.
  expect(
    values,
    "enforcement steps must carry the exact negation of the compound skip",
  ).toContain(`!(${MERGE_QUEUE_SKIP_EXPRESSION})`);
  // No `if` in this workflow may consult the author-controlled head ref in any
  // other shape — a branch-only predicate is exactly how the gate became
  // skippable, and a `||` variant would skip on the branch name alone again.
  for (const value of values) {
    expect(
      [MERGE_QUEUE_SKIP_EXPRESSION, `!(${MERGE_QUEUE_SKIP_EXPRESSION})`],
      `every merge-queue \`if\` must be one of the two canonical actor-pinned shapes (got: \`${value}\`)`,
    ).toContain(value);
  }
}

describe("staging-evidence merge-queue skip actor contract (SCRUM-3812)", () => {
  it("requires the Mergify bot author in addition to the merge-queue branch prefix", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    assertMergeQueueSkipActorContract(workflow);
  });

  it("rejects an enforcement step whose skip keys on the branch name alone", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      `        if: "!(${MERGE_QUEUE_SKIP_EXPRESSION})"`,
      "        if: \"!startsWith(github.head_ref, 'mergify/merge-queue/')\"",
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertMergeQueueSkipActorContract(mutated)).toThrow();
  });

  it("rejects a skip-notice condition that keys on the branch name alone", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      `        if: ${MERGE_QUEUE_SKIP_EXPRESSION}`,
      "        if: startsWith(github.head_ref, 'mergify/merge-queue/')",
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertMergeQueueSkipActorContract(mutated)).toThrow();
  });

  it("rejects weakening the compound skip's conjunction to a disjunction", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replaceAll(
      MERGE_QUEUE_SKIP_EXPRESSION,
      MERGE_QUEUE_SKIP_EXPRESSION.replace(" && ", " || "),
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertMergeQueueSkipActorContract(mutated)).toThrow();
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
  const soakGateEnvLine =
    /^ {10}SOAK_GATE_DISABLED:\s*\$\{\{\s*vars\.SOAK_GATE_DISABLED\s*\}\}\s*$/mu;

  it("threads SOAK_GATE_DISABLED into the check step from the live vars context", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    expect(soakGateEnvLine.test(workflow)).toBe(true);
  });

  it("binds the bypass beside DEPLOY_WORKER_PAUSED on the evidence-check step", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const checkStep = rootSteps(workflow).find((step) =>
      /check-staging-evidence\.ts/u.test(step),
    );
    expect(checkStep).toBeDefined();
    expect(soakGateEnvLine.test(checkStep!)).toBe(true);
    expect(
      /DEPLOY_WORKER_PAUSED:\s*\$\{\{\s*vars\.DEPLOY_WORKER_PAUSED\s*\}\}/u.test(
        checkStep!,
      ),
    ).toBe(true);
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
      const mutated = workflow.replace(
        soakGateEnvLine,
        `          SOAK_GATE_DISABLED: ${forged}`,
      );
      expect(mutated).not.toBe(workflow);
      expect(soakGateEnvLine.test(mutated)).toBe(false);
    }
  });
});
