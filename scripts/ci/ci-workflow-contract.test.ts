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
