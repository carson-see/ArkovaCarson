import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..", "..");
const WORKFLOW_PATH = resolve(REPO, ".github/workflows/ci.yml");

/**
 * Split a workflow into its individual `- name:` / `- uses:` step blocks,
 * regardless of which job they belong to. ci.yml is a multi-job workflow, so
 * unlike the single-job staging-evidence contract we do not anchor to a fixed
 * indentation depth for the job — only to the step-list bullet shape.
 */
function workflowSteps(workflow: string): string[] {
  const lines = workflow.split("\n");
  const steps: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const bullet = /^(\s+)- \S/u.exec(lines[index]);
    if (!bullet) continue;

    const bulletIndent = bullet[1].length;
    const block = [lines[index]];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === "") {
        block.push(line);
        cursor += 1;
        continue;
      }
      const indent = /^(\s*)/u.exec(line)?.[1].length ?? 0;
      // A sibling bullet or a dedent out of this step's body ends the block.
      if (indent <= bulletIndent) break;
      block.push(line);
      cursor += 1;
    }
    steps.push(block.join("\n"));
    index = cursor - 1;
  }

  return steps;
}

/**
 * Every heredoc that writes a NAMED key into $GITHUB_OUTPUT / $GITHUB_ENV
 * looks like `echo "key<<DELIM"` (or the single-quoted / unquoted variants).
 * This deliberately does NOT match plain shell heredocs such as
 * `node <<'NODE'`, which feed a static script into a program rather than
 * framing an attacker-controlled value inside a key/value file.
 */
const OUTPUT_HEREDOC_OPENER =
  /^[^\S\n]*echo[^\S\n]+(["']?)([A-Za-z_][A-Za-z0-9_-]*)<<(.+?)\1[^\S\n]*$/gmu;

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/gu, "");
}

/**
 * The delimiter must be a shell-variable expansion — i.e. derived at runtime —
 * never a fixed literal an attacker can embed in the content being framed.
 */
const RUNTIME_DELIMITER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

function assertWorkflowContract(workflow: string): void {
  // ── Every $GITHUB_OUTPUT heredoc delimiter must be runtime-derived ──
  // Content framed inside these heredocs (commit messages, PR bodies, titles)
  // is PR-author-controlled. A FIXED delimiter lets an author put that exact
  // string on its own line inside the content to terminate the heredoc early,
  // after which the remainder is parsed as literal `key=value` lines appended
  // to $GITHUB_OUTPUT — including a forged duplicate of the very key being
  // written, since GitHub Actions resolves a duplicate output name to its LAST
  // occurrence. A per-run random delimiter (GitHub's own documented remedy)
  // closes this off: the attacker cannot know it in advance.
  const openers = [...workflow.matchAll(OUTPUT_HEREDOC_OPENER)].map(
    (match) => ({
      key: match[2],
      delimiter: stripQuotes(match[3]),
    }),
  );

  expect(
    openers.length,
    "ci.yml must still contain at least one $GITHUB_OUTPUT heredoc for this contract to be meaningful",
  ).toBeGreaterThan(0);

  for (const { key, delimiter } of openers) {
    expect(
      delimiter,
      `the '${key}' heredoc delimiter must be a shell-variable expansion (derived at runtime), never a fixed literal string an attacker could pre-empt by embedding it in the author-controlled content being framed`,
    ).toMatch(RUNTIME_DELIMITER);
  }

  // ── The commit-message aggregation step specifically ──
  const commitSteps = workflowSteps(workflow).filter((step) =>
    /^\s+id:\s*["']?commits["']?\s*$/mu.test(step),
  );
  expect(
    commitSteps,
    "ci.yml must have exactly one step with id 'commits' — the aggregated commit messages feed the HANDOFF-claims and Confluence-coverage gates, and a second producer would make the winning value ambiguous",
  ).toHaveLength(1);
  const [commitsStep] = commitSteps;

  const msgsOpeners = [...workflow.matchAll(OUTPUT_HEREDOC_OPENER)].filter(
    (match) => match[2] === "msgs",
  );
  expect(
    msgsOpeners,
    "the 'msgs' heredoc must appear exactly once across ci.yml — a duplicate write of the same output key would silently win via last-occurrence resolution",
  ).toHaveLength(1);

  const msgsDelimiterToken = stripQuotes(msgsOpeners[0][3]);
  expect(
    msgsDelimiterToken,
    "the commit-message heredoc delimiter must be a shell-variable expansion (derived at runtime), never a fixed literal string a PR author could pre-empt by putting it on its own line in a commit message",
  ).toMatch(RUNTIME_DELIMITER);

  const msgsDelimiterVarName = msgsDelimiterToken.slice(2, -1);

  // The variable must come from a command substitution — a runtime-random
  // source — not a static string that is merely spelled as a variable.
  const delimiterAssignment = new RegExp(
    `\\b${msgsDelimiterVarName}=.*\\$\\(`,
    "u",
  );
  expect(
    commitsStep,
    "the delimiter variable must be assigned from a command substitution (a runtime-random source), not a static string",
  ).toMatch(delimiterAssignment);

  // The closing line must reuse the SAME variable that opened the heredoc.
  const closingDelimiters = [
    ...commitsStep.matchAll(/^\s+echo "\$\{([A-Za-z_][A-Za-z0-9_]*)\}"\s*$/gmu),
  ].map((match) => match[1]);
  expect(
    closingDelimiters,
    "the heredoc's closing line must reuse the exact same delimiter variable that opened it",
  ).toContain(msgsDelimiterVarName);

  // ── The governance gates must keep consuming the sanitized step output ──
  // PR_COMMITS_MSGS is what check-handoff-claims.ts and
  // check-confluence-coverage.ts read. Re-plumbing it to a raw
  // author-controlled context would reintroduce the same forgery surface from
  // the other end.
  const commitsMsgsBindings = [
    ...workflow.matchAll(
      /^\s+(?:PR_COMMITS_MSGS|"PR_COMMITS_MSGS"|'PR_COMMITS_MSGS'):\s*(.+)$/gmu,
    ),
  ].map((match) => match[1].trim());
  expect(
    commitsMsgsBindings.length,
    "PR_COMMITS_MSGS must still be wired into the governance gates",
  ).toBeGreaterThan(0);
  for (const binding of commitsMsgsBindings) {
    expect(
      binding,
      "PR_COMMITS_MSGS must source from the sanitized commits step output, never from a raw author-controlled context",
    ).toMatch(/^\$\{\{\s*steps\.commits\.outputs\.msgs\s*\}\}$/u);
  }
}

describe("ci.yml commit-message heredoc delimiter contract", () => {
  it("frames PR-author-controlled commit messages with a per-run random delimiter", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    assertWorkflowContract(workflow);
  });

  it("rejects reverting the commit-message heredoc to a fixed, predictable delimiter", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const randomizedHeredoc =
      /echo "msgs<<\$\{[A-Za-z_][A-Za-z0-9_]*\}"\n(?:.*\n)*?\s+echo "\$\{[A-Za-z_][A-Za-z0-9_]*\}"\n/mu;
    expect(workflow).toMatch(randomizedHeredoc);

    const mutated = workflow.replace(
      randomizedHeredoc,
      [
        "echo 'msgs<<EOF'",
        '            echo "$MSGS"',
        "            echo 'EOF'",
        "",
      ].join("\n"),
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a delimiter variable assigned from a static string instead of a runtime-random source", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      /MSGS_DELIM="ghadelim_\$\(openssl rand -hex 16\)"/u,
      'MSGS_DELIM="ghadelim_static_value"',
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a closing delimiter that does not reuse the opening variable", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      /^(\s+)echo "\$\{MSGS_DELIM\}"$/mu,
      '$1echo "${OTHER_DELIM}"',
    );
    expect(mutated).not.toBe(workflow);

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a second step re-writing the same 'msgs' output with a fixed delimiter", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadow commit messages",
      "        id: commits_shadow",
      "        run: |",
      "          {",
      "            echo 'msgs<<EOF'",
      '            echo "$SOMETHING"',
      "            echo 'EOF'",
      '          } >> "$GITHUB_OUTPUT"',
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects re-plumbing a governance gate to a raw author-controlled commit-message context", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadowed HANDOFF lint",
      "        env:",
      "          PR_COMMITS_MSGS: ${{ github.event.pull_request.body }}",
      "        run: node_modules/.bin/tsx scripts/ci/check-handoff-claims.ts",
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("rejects a fixed delimiter introduced on any other $GITHUB_OUTPUT heredoc", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Aggregate PR title",
      "        id: pr_title",
      "        run: |",
      "          {",
      '            echo "title<<EOF"',
      '            echo "$TITLE"',
      '            echo "EOF"',
      '          } >> "$GITHUB_OUTPUT"',
    ].join("\n")}\n`;

    expect(() => assertWorkflowContract(mutated)).toThrow();
  });

  it("does not flag a plain shell heredoc feeding a static script into a program", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    // ci.yml embeds `node <<'NODE'` for the golden-audit summary. That frames a
    // static, repo-authored script rather than an author-controlled value in a
    // key/value file, so it is out of scope for this contract.
    expect(workflow).toMatch(/node <<'NODE'/u);
    expect(() => assertWorkflowContract(workflow)).not.toThrow();
  });
});

/**
 * Every suite CI claims to run must actually be invoked by a required job.
 *
 * services/edge has had a working vitest harness since 2026-06-05
 * (services/edge/vitest.config.ts), but for ~10 weeks NOTHING in CI ran it:
 * the only edge step was `tsc --noEmit` in typecheck-lint, which compiles the
 * tests without executing them. The root suite could not collect them either —
 * root vitest.config.ts globs `tests/**`, `src/**`, `scripts/**` relative to the
 * REPO ROOT, and `services/edge/` matches none of those. So
 * services/edge/src/mcp-tools.test.ts (36 assertions over the MCP tool surface)
 * ran nowhere and could sit red indefinitely without failing a PR.
 *
 * Wired into the `Tests` job on 2026-08-15. These assertions are the ratchet:
 * deleting the step, dropping the install, or forgetting the aggregate wiring
 * puts the suite back to gating nothing — silently, which is exactly how it went
 * unnoticed the first time. A step that runs but is absent from the aggregate map
 * is the same class of bug the aggregate gate was built for.
 */
function edgeStep(workflow: string, name: string): string {
  const step = workflowSteps(workflow).find((block) =>
    new RegExp(`^\\s+- name: ${name}\\s*$`, "mu").test(block),
  );
  expect(step, `ci.yml must keep a '${name}' step — the edge suite gates nothing without it`).toBeDefined();
  return step as string;
}

describe("ci.yml edge-worker suite is actually invoked", () => {
  it("runs the services/edge vitest suite, not just its typecheck", () => {
    const step = edgeStep(readFileSync(WORKFLOW_PATH, "utf8"), "Run edge worker tests");
    expect(step, "the edge suite must run from services/edge").toMatch(
      /working-directory:\s*services\/edge/u,
    );
    expect(step, "the edge step must execute the suite (npm test), not merely typecheck it").toMatch(
      /run:\s*npm test\b/u,
    );
  });

  it("installs services/edge deps with lifecycle scripts suppressed", () => {
    // services/edge has its OWN package-lock.json and is not in the root npm
    // workspace, so without a dedicated install the suite cannot run at all.
    const step = edgeStep(readFileSync(WORKFLOW_PATH, "utf8"), "Install edge dependencies");
    expect(step).toMatch(/working-directory:\s*services\/edge/u);
    expect(step, "supply-chain: CI installs must pass --ignore-scripts").toMatch(
      /npm ci --ignore-scripts/u,
    );
  });

  it("wires both edge steps into the aggregate gate's map AND its iteration list", () => {
    const aggregate = edgeStep(readFileSync(WORKFLOW_PATH, "utf8"), "Aggregate test suite results");
    const loop = /for name in ([^;]+);/u.exec(aggregate)?.[1].trim().split(/\s+/u) ?? [];

    for (const id of ["edge-deps", "edge-tests"]) {
      expect(aggregate, `aggregate map must read steps.${id}.outcome`).toContain(
        `[${id}]="\${{ steps.${id}.outcome }}"`,
      );
      // A key present in the map but absent from the loop is never evaluated —
      // it looks wired while failing open.
      expect(loop, `'${id}' must be iterated, or its outcome is collected and never checked`).toContain(id);
    }
  });

  it("keeps the edge lockfile in the Tests job npm cache key", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const setupNode = workflowSteps(workflow).filter(
      (block) => /cache-dependency-path:/u.test(block) && /services\/worker\/package-lock\.json/u.test(block),
    );
    expect(setupNode.length, "expected the Tests job setup-node cache block").toBeGreaterThan(0);
    expect(
      setupNode.some((block) => /services\/edge\/package-lock\.json/u.test(block)),
      "services/edge/package-lock.json must be in cache-dependency-path so the edge install is cached and cache-busted correctly",
    ).toBe(true);
  });
});

/**
 * The same blind spot, one language over — BUG-2026-08-12-007.
 *
 * `packages/arkova-py` is the ONLY Arkova SDK actually published (all three npm
 * packages 404), and until 2026-08-15 nothing ran its pytest/ruff suite on a
 * pull request. Its only invocation lived in publish-python-sdk.yml, which fires
 * on an `arkova-py-v*` tag — after the release decision, never before it. So the
 * published 2.2.0 wheel shipped a `compliance_controls` type that contradicted
 * the API (breaking `verify()` for every record carrying controls), and the
 * source fix then sat unreleased for two weeks with no PR ever executing the
 * tests that would have shown source and artifact disagreeing.
 *
 * These assertions are the ratchet. A suite that gates nothing fails silently,
 * which is precisely how this went unnoticed twice.
 */
describe("ci.yml Python SDK suite is actually invoked", () => {
  const pythonJob = (): string => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const job = /\n {2}python-sdk-tests:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/u.exec(workflow)?.[0];
    expect(
      job,
      "ci.yml must keep a 'python-sdk-tests' job — packages/arkova-py gates nothing without it",
    ).toBeDefined();
    return job as string;
  };

  it("runs pytest against packages/arkova-py", () => {
    const job = pythonJob();
    expect(job, "the Python suite must run from packages/arkova-py").toMatch(
      /working-directory:\s*packages\/arkova-py/u,
    );
    expect(job, "the job must execute the suite, not merely install it").toMatch(
      /run:\s*pytest\b/u,
    );
  });

  it("keeps the ruff gate at PR time, not only at publish time", () => {
    // publish-python-sdk.yml gates the PyPI upload on `ruff check src tests`.
    // A finding that only surfaces there blocks a release instead of a review —
    // exactly the ordering that let 2.2.0 ship unchecked.
    expect(pythonJob()).toMatch(/run:\s*ruff check src tests/u);
  });

  it("installs the dev extras, which is where pytest and the pinned ruff live", () => {
    expect(pythonJob()).toMatch(/pip install -e "\.\[dev\]"/u);
  });

  it("matches the publish workflow's interpreter", () => {
    // Parity argument of CLAUDE.md §0.9: if the publish gate would reject it, a
    // PR must reject it first. Different interpreters make that untrue.
    const publish = readFileSync(
      resolve(REPO, ".github/workflows/publish-python-sdk.yml"),
      "utf8",
    );
    const publishVersion = /python-version:\s*["']?([\d.]+)["']?/u.exec(publish)?.[1];
    const ciVersion = /python-version:\s*["']?([\d.]+)["']?/u.exec(pythonJob())?.[1];
    expect(publishVersion, "publish-python-sdk.yml must pin a python-version").toBeDefined();
    expect(ciVersion, "the CI job must pin a python-version").toBe(publishVersion);
  });
});

/**
 * FD-GATE-2 — the frozen event base must never be a diff anchor.
 *
 * ci.yml (9 sites) and merge-authority.yml (:47) pass
 * `BASE_REF_SHA: ${{ github.event.pull_request.base.sha }}` — a sha GitHub
 * FREEZES at the base tip as of the PR's last head push — while their
 * checkouts pin no `ref:`, so HEAD is the live refs/pull/N/merge preview that
 * GitHub recomputes against current main. Diffing `frozenBase..HEAD` therefore
 * charges every main commit landed since the last push to the PR itself:
 * measured 2026-08-22, #2219 (6 real files) presented as 162 to the tier
 * detector and the feedback-rules scans, and 15 of 28 open PRs were desynced.
 *
 * The fix is deliberately in scripts/ci/lib/ciContext.ts, not the workflows:
 * `changedFiles` anchors its diff at the PR's own changeset (HEAD^1 for the
 * merge preview, merge-base(base, HEAD) for raw heads) so the frozen env value
 * is harmless everywhere at once. These pins keep that anchoring from
 * regressing to a raw `base..HEAD`; the behavioral matrix lives in
 * scripts/ci/lib/ciContext.test.ts.
 */
describe("changedFiles diff anchoring neutralizes the frozen event base (FD-GATE-2)", () => {
  const CI_CONTEXT_PATH = resolve(REPO, "scripts/ci/lib/ciContext.ts");

  it("changedFiles routes its diff range through resolveDiffBase, never the raw env base", () => {
    const source = readFileSync(CI_CONTEXT_PATH, "utf8");
    expect(
      source,
      "ciContext.changedFiles must compute its anchor via resolveDiffBase(base) — see FD-GATE-2",
    ).toMatch(/const diffBase = resolveDiffBase\(base\)/u);
    expect(
      source,
      "the diff range must start at the resolved anchor, not the (possibly frozen) env base",
    ).toMatch(/`\$\{diffBase\}\.\.HEAD`/u);
    expect(
      source,
      "a raw `${base}..HEAD` two-dot range is the FD-GATE-2 bug shape and must not return",
    ).not.toMatch(/`\$\{base\}\.\.HEAD`/u);
  });

  it("resolveDiffBase keeps both anchoring strategies: HEAD^1 for the merge preview, merge-base for raw heads", () => {
    const source = readFileSync(CI_CONTEXT_PATH, "utf8");
    expect(source).toMatch(/refs\\\/pull\\\/\\d\+\\\/merge/u);
    expect(source).toMatch(/HEAD\^1/u);
    expect(source).toMatch(/tryMergeBase\(base, 'HEAD'\)/u);
  });

  it("compute-merge-authority (merge-authority.yml's consumer) reads its file set through ciContext.changedFiles", () => {
    // merge-authority.yml also passes the frozen base; its tier/label math is
    // only correct because it consumes the anchored changedFiles.
    const source = readFileSync(resolve(REPO, "scripts/ci/compute-merge-authority.ts"), "utf8");
    expect(source).toMatch(/import \{[^}]*\bchangedFiles\b[^}]*\} from '\.\/lib\/ciContext\.js'/u);
  });
});

/**
 * The commit-message payload must not travel as one oversized env string.
 *
 * PR #2346 (run 32666797304, job 97261336883, 2026-08-23): the `Aggregate
 * commit messages` step wrote 153 commits / 138,166 bytes into the `msgs`
 * output, ci.yml injected it as the PR_COMMITS_MSGS **environment variable**,
 * and the next step died at spawn:
 *
 *   ##[error]An error occurred trying to start process '/usr/bin/bash' …
 *   Argument list too long
 *
 * That is E2BIG against Linux's MAX_ARG_STRLEN (131,072 bytes per single
 * argv/envp string) — raised by execve BEFORE any script logic runs, so no
 * override label can clear it and the "failure" carries no lint diagnosis at
 * all. Two things put it over the line and both are pinned here:
 *
 *   1. Transport. The payload now goes to a file under $RUNNER_TEMP, which has
 *      no per-string ceiling; PR_COMMITS_MSGS remains only as a `head -c`
 *      capped fallback that is spawnable by construction.
 *   2. Range. `github.event.pull_request.base.sha` is refreshed by
 *      `synchronize` but NOT by close/reopen, so #2346 sat pinned at its
 *      2026-08-22 creation base and inherited a long-lived branch's history
 *      when #2219 merged. Aggregation now delegates to the shared
 *      ciContext anchoring (FD-GATE-2) instead of a raw `$BASE_SHA..HEAD`.
 */
const MAX_ARG_STRLEN = 131_072;

/**
 * A step's body with comment-only lines removed. The ratchets below are about
 * what the runner EXECUTES; the step's own comments quote the bug shape they
 * exist to prevent, and matching those would make the ratchet self-tripping.
 */
function executableLines(step: string): string {
  return step
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

function commitsStepOf(workflow: string): string {
  const steps = workflowSteps(workflow).filter((step) =>
    /^\s+id:\s*["']?commits["']?\s*$/mu.test(step),
  );
  expect(steps, "ci.yml must have exactly one step with id 'commits'").toHaveLength(1);
  return steps[0];
}

function assertCommitPayloadContract(workflow: string): void {
  const commitsStep = commitsStepOf(workflow);

  // ── 1. The full payload is written to a file, not an output value ──
  expect(
    commitsStep,
    'the commits step must declare PR_COMMITS_MSGS_FILE under $RUNNER_TEMP — the file is the only transport without a MAX_ARG_STRLEN ceiling',
  ).toMatch(/PR_COMMITS_MSGS_FILE:\s*\$\{\{\s*runner\.temp\s*\}\}\//u);

  expect(
    commitsStep,
    'the commits step must publish the file path as the `msgs_file` output so the gates can bind it',
  ).toMatch(/msgs_file=/u);

  // ── 2. Aggregation delegates to the shared, anchored implementation ──
  expect(
    executableLines(commitsStep),
    'aggregation must run scripts/ci/aggregate-commit-messages.ts, which anchors the range via ciContext.resolveDiffBase (FD-GATE-2) instead of re-deriving it in shell',
  ).toMatch(/scripts\/ci\/aggregate-commit-messages\.ts/u);

  expect(
    executableLines(commitsStep),
    'a raw `$BASE_SHA..HEAD` range in shell is the FD-GATE-2 bug shape that inflated #2346 from 6 commits to 153 — it must not return',
  ).not.toMatch(/\$\{?BASE_SHA\}?"?\.\.HEAD/u);

  // ── 3. The surviving env fallback is capped below MAX_ARG_STRLEN ──
  const cap = /head -c (\d+) "\$PR_COMMITS_MSGS_FILE"/u.exec(commitsStep)?.[1];
  expect(
    cap,
    'the PR_COMMITS_MSGS env fallback must be size-capped with `head -c` — an uncapped read reintroduces the exact E2BIG that killed #2346',
  ).toBeDefined();
  expect(
    Number(cap),
    `the cap must sit below Linux MAX_ARG_STRLEN (${MAX_ARG_STRLEN}) with headroom for the rest of the environment`,
  ).toBeLessThan(MAX_ARG_STRLEN);

  // ── 4. Every gate that reads the messages binds the FILE ──
  // A step left on the env var alone is a step that can still hit E2BIG.
  const consumerSteps = workflowSteps(workflow).filter((step) =>
    /^\s+PR_COMMITS_MSGS:/mu.test(step),
  );
  expect(
    consumerSteps.length,
    'PR_COMMITS_MSGS must still be wired into the governance gates',
  ).toBeGreaterThan(0);

  for (const step of consumerSteps) {
    const binding = /^\s+PR_COMMITS_MSGS_FILE:\s*(.+)$/mu.exec(step)?.[1]?.trim();
    expect(
      binding,
      'every step reading PR_COMMITS_MSGS must ALSO bind PR_COMMITS_MSGS_FILE, or it is still spawning with the uncapped payload as its only source',
    ).toBeDefined();
    expect(
      binding,
      'PR_COMMITS_MSGS_FILE must source from the commits step output, never from a raw author-controlled context',
    ).toMatch(/^\$\{\{\s*steps\.commits\.outputs\.msgs_file\s*\}\}$/u);
  }
}

describe('ci.yml commit-message payload transport (E2BIG, PR #2346)', () => {
  it('ships the aggregate by file and caps the env fallback below MAX_ARG_STRLEN', () => {
    assertCommitPayloadContract(readFileSync(WORKFLOW_PATH, "utf8"));
  });

  it('rejects removing the `head -c` cap from the env fallback', () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      /head -c \d+ "\$PR_COMMITS_MSGS_FILE"/u,
      'cat "$PR_COMMITS_MSGS_FILE"',
    );
    expect(mutated).not.toBe(workflow);
    expect(() => assertCommitPayloadContract(mutated)).toThrow();
  });

  it('rejects a cap raised to or above MAX_ARG_STRLEN', () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      /head -c \d+ "\$PR_COMMITS_MSGS_FILE"/u,
      `head -c ${MAX_ARG_STRLEN} "$PR_COMMITS_MSGS_FILE"`,
    );
    expect(mutated).not.toBe(workflow);
    expect(() => assertCommitPayloadContract(mutated)).toThrow();
  });

  it('rejects a gate that reads PR_COMMITS_MSGS without also binding the file', () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Env-only HANDOFF lint",
      "        env:",
      "          PR_COMMITS_MSGS: ${{ steps.commits.outputs.msgs }}",
      "        run: node_modules/.bin/tsx scripts/ci/check-handoff-claims.ts",
    ].join("\n")}\n`;
    expect(() => assertCommitPayloadContract(mutated)).toThrow();
  });

  it('rejects re-plumbing the file binding to a raw author-controlled context', () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = `${workflow}\n${[
      "      - name: Shadowed Confluence coverage",
      "        env:",
      "          PR_COMMITS_MSGS: ${{ steps.commits.outputs.msgs }}",
      "          PR_COMMITS_MSGS_FILE: ${{ github.event.pull_request.body }}",
      "        run: node_modules/.bin/tsx scripts/ci/check-confluence-coverage.ts",
    ].join("\n")}\n`;
    expect(() => assertCommitPayloadContract(mutated)).toThrow();
  });

  it('rejects reverting aggregation to a raw $BASE_SHA..HEAD range in shell', () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const commitsStep = commitsStepOf(workflow);
    // The aggregator call is deliberately KEPT so this isolates the RANGE
    // ratchet: a step that shells out to the anchored script and then quietly
    // re-derives the range itself is exactly the regression worth catching.
    const mutated = workflow.replace(
      commitsStep,
      commitsStep.replace(
        /(node_modules\/\.bin\/tsx scripts\/ci\/aggregate-commit-messages\.ts)/u,
        '$1\n          MSGS=$(git log --format=%B "$BASE_SHA"..HEAD)',
      ),
    );
    expect(mutated).not.toBe(workflow);
    expect(() => assertCommitPayloadContract(mutated)).toThrow(/FD-GATE-2/u);
  });

  it('rejects satisfying the aggregator requirement with a mere comment mention', () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const mutated = workflow.replace(
      /( +)node_modules\/\.bin\/tsx scripts\/ci\/aggregate-commit-messages\.ts/u,
      '$1# node_modules/.bin/tsx scripts/ci/aggregate-commit-messages.ts',
    );
    expect(mutated).not.toBe(workflow);
    expect(() => assertCommitPayloadContract(mutated)).toThrow();
  });

  it('keeps the aggregator and the file-reader on the same env-var name', () => {
    // A rename on one side alone degrades every gate to the capped fallback,
    // silently, with green checks.
    const aggregator = readFileSync(
      resolve(REPO, "scripts/ci/aggregate-commit-messages.ts"),
      "utf8",
    );
    const context = readFileSync(resolve(REPO, "scripts/ci/lib/ciContext.ts"), "utf8");
    expect(aggregator).toMatch(/PR_COMMITS_MSGS_FILE/u);
    expect(context).toMatch(/PR_COMMITS_MSGS_FILE/u);
  });
});
