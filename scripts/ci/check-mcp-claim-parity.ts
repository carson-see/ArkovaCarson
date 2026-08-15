#!/usr/bin/env tsx
/**
 * CI gate: MCP tool-claim parity across the five published surfaces (BUG-026).
 *
 * ## The defect this closes
 *
 * The MCP tool descriptions are published in five places and NOTHING compared
 * the description TEXT between them:
 *
 *   1. `services/edge/src/mcp-tools.ts`            TOOL_DEFINITIONS (canonical)
 *   2. `public/.well-known/mcp/server-card.json`   hand-copied duplicates
 *   3. `public/AGENTS.md`                          hand-copied prose
 *   4. `public/llms.txt` / `public/llms-full.txt`  per-tool one-liners
 *   5. `docs/api/mcp-tools.md`                     per-tool sections
 *
 * `tests/infra/mcp-manifest-parity.test.ts` already pins the NAME set, the
 * required-argument contract, the property names, banned UI terminology
 * (Constitution 1.3) and registry over-claims between (1) and (2). It
 * explicitly does not compare description text. That was the hole: BUG-026 —
 * `search_credentials` advertising "semantic (vector) similarity matching"
 * when the only served path is an ILIKE substring scan — survived on SIX
 * surfaces at once, and no check could see it.
 *
 * ## Why this is two different checks, not one
 *
 * Parity and truth are orthogonal, and BUG-026 needed both:
 *
 *   - PARITY catches DIVERGENCE. It cannot catch a claim that is false in
 *     every copy — five identical lies are in perfect parity.
 *   - CLAIM RULES catch the false claim itself, on every surface, whether or
 *     not the copies agree.
 *
 * ## Rules
 *
 * 1. `card-description-parity` — server-card.json's description must, after
 *    normalisation, START WITH the canonical TOOL_DEFINITIONS description.
 *    Prefix, not equality: 8 of the 16 live tools deliberately append
 *    discovery-only guidance to the card (aliasing notes, conditional
 *    availability, item caps). Requiring equality would either delete that
 *    guidance or force it into the live `tools/list` payload. What prefix
 *    forbids is exactly the BUG-026 shape — the canonical text being
 *    REWRITTEN on one side rather than extended.
 *
 * 2. `reference-coverage` — `docs/api/mcp-tools.md` is the designated complete
 *    reference and must name every registered tool. Strict, no baseline: it
 *    is 16/16 today and a new tool must be documented in the same PR.
 *
 * 3. `prose-coverage` — `public/AGENTS.md` and `public/llms*.txt` are CURATED
 *    subsets (4 of 16 today, which is its own finding — see the baseline
 *    file). Ratcheted shrink-only: a tool documented on one of those surfaces
 *    may not silently disappear from it.
 *
 * 4. Claim rules (`CLAIM_RULES`) — a declared, reviewable table of assertions
 *    a description may not make about a given tool, each with an optional
 *    QUALIFIER that makes the claim honest. Checked against all five surfaces.
 *    The qualifier is what generalises this past one phrase: "semantic" is not
 *    banned outright, it is banned UNQUALIFIED — the canonical source's own
 *    wording, which discloses `search_mode` and the `lexical_substring`
 *    fallback in the same breath, passes.
 *
 * ## Scoping
 *
 * Structured surfaces (1, 2) are checked per-tool against their description
 * field. Prose surfaces are checked per REGION: the single line naming the
 * tool (table row, llms.txt bullet) plus any markdown section whose heading
 * names it. Region scoping is why a semantic claim in the `nessie_query`
 * section is not blamed on `search_credentials`.
 *
 * KNOWN BOUNDARY, stated rather than papered over: module-level comments and
 * free prose that never name a tool are out of scope. `mcp-tools.ts`'s own
 * header summary was one of BUG-026's six surfaces and this gate would NOT
 * have caught that one. Naming the tool is what puts text in scope.
 *
 * ## The baseline
 *
 * `mcp-claim-parity-baseline.json` records violations that are live on `main`
 * today and are owned by an in-flight PR. New violations fail. A baselined
 * violation that no longer occurs is reported as a `::notice::` and PASSES —
 * deliberately, so that the PR which finally corrects the text does not turn
 * `main` red the moment it merges. That is a knowing gap in the ratchet, not
 * an oversight: the cost of a stale entry is a stale entry, and the cost of
 * the alternative is a blocked repository.
 *
 * Exit 0 = pass. Exit 1 = an unbaselined violation.
 * Override label: `mcp-claim-parity-reviewed`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainModule, hasLabel } from './lib/ciContext';
// Static, not dynamic: the canonical registry is a compile-time dependency, so
// a rename or a shape change fails `tsc` here instead of at CI runtime.
import { TOOL_DEFINITIONS } from '../../services/edge/src/mcp-tools';

const ROOT = resolve(import.meta.dirname, '..', '..');

export const OVERRIDE_LABEL = 'mcp-claim-parity-reviewed';

export const CANONICAL_SOURCE = 'services/edge/src/mcp-tools.ts';
export const MACHINE_SURFACE = 'public/.well-known/mcp/server-card.json';
export const COMPLETE_REFERENCE = 'docs/api/mcp-tools.md';
export const PROSE_SURFACES = [
  'public/AGENTS.md',
  'public/llms.txt',
  'public/llms-full.txt',
  COMPLETE_REFERENCE,
] as const;

export const BASELINE_FILE = 'scripts/ci/mcp-claim-parity-baseline.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  name: string;
  description: string;
}

/** A published surface. Structured surfaces carry per-tool descriptions;
 *  prose surfaces carry raw text that gets region-scoped per tool. */
export interface ClaimSurface {
  path: string;
  descriptions?: Record<string, string>;
  text?: string;
}

export interface ClaimRule {
  id: string;
  /** Tools the claim is about. Empty = applies to every tool. */
  tools: string[];
  /** The assertion that may not be made. */
  pattern: RegExp;
  /** When this ALSO matches the same region, the claim is honest and allowed. */
  qualifier?: RegExp;
  /** Quoted verbatim in the failure message — why the claim is false. */
  reason: string;
}

export interface Violation {
  rule: string;
  surface: string;
  /** Tool name (all current rules are per-tool). */
  subject: string;
  detail: string;
  key: string;
}

export interface BaselineEntry {
  key: string;
  owner: string;
  reason: string;
}

export interface Baseline {
  proseCoverage: Record<string, string[]>;
  knownViolations: BaselineEntry[];
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/**
 * Normalise for comparison ONLY. Collapses whitespace and folds the unicode
 * punctuation the TS source and the hand-copied JSON disagree on (curly
 * quotes, em/en dashes). Those differences are transcription artefacts, not
 * claim changes, and reporting them as drift would train reviewers to ignore
 * this gate.
 */
export function normalizeClaimText(input: string): string {
  return input
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function violationKey(v: { rule: string; surface: string; subject: string }): string {
  return `${v.rule}::${v.surface}::${v.subject}`;
}

function violation(rule: string, surface: string, subject: string, detail: string): Violation {
  return { rule, surface, subject, detail, key: violationKey({ rule, surface, subject }) };
}

/**
 * Matches a mention of `toolName` — and nothing else. Two forms, because the
 * 16 tool names are not equally distinctive:
 *
 *   - MULTI-TOKEN names (`search_credentials`, `get_anchor`) match on a
 *     boundary that excludes `_` and `-` on BOTH sides. Plain `\b` is not
 *     enough: `\bverify\b` matches inside `verify_batch` (because `_` is a
 *     word character on the far side of the boundary), and `verify-anchor` —
 *     a REST path in `public/llms-full.txt` — would otherwise count as
 *     documenting the `verify` MCP tool.
 *
 *   - SINGLE-TOKEN names (`search`, `verify`) are ordinary English words that
 *     appear all over these documents. They must be written as a code
 *     identifier (backticked) to count. Without this, `toolRegions` would
 *     attribute every sentence containing the word "search" to the `search`
 *     tool, and a claim rule would blame it for a neighbouring tool's prose.
 */
function mentionRegex(toolName: string): RegExp {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return toolName.includes('_')
    ? new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`)
    : new RegExp('`' + escaped + '`');
}

export function mentionsTool(text: string, toolName: string): boolean {
  return mentionRegex(toolName).test(text);
}

/** Test without mutating `lastIndex` — a rule declared with /g would
 *  otherwise return alternating results across surfaces. */
function matches(re: RegExp, text: string): boolean {
  return new RegExp(re.source, re.flags.replace(/g/g, '')).test(text);
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * The regions of a prose surface attributable to `toolName`:
 *   - any markdown section whose HEADING names the tool, running to the next
 *     heading of the same or higher level (deeper sub-headings stay inside);
 *   - any other single line that names the tool (table row, bullet, one-liner).
 */
export function toolRegions(text: string, toolName: string): string[] {
  const re = mentionRegex(toolName);
  const lines = text.split('\n');
  const regions: string[] = [];
  const claimed = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING_RE.exec(lines[i]);
    if (!heading || !re.test(lines[i])) continue;
    const level = heading[1].length;
    let end = i + 1;
    while (end < lines.length) {
      const next = HEADING_RE.exec(lines[end]);
      if (next && next[1].length <= level) break;
      end++;
    }
    for (let j = i; j < end; j++) claimed.add(j);
    regions.push(lines.slice(i, end).join('\n'));
  }

  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i) || !re.test(lines[i])) continue;
    regions.push(lines[i]);
  }

  return regions;
}

// ---------------------------------------------------------------------------
// Rule 1 — machine-surface description parity
// ---------------------------------------------------------------------------

export function checkCardDescriptionParity(
  canonical: ToolDescriptor[],
  card: { name: string; description?: string }[],
  cardPath: string = MACHINE_SURFACE,
): Violation[] {
  const RULE = 'card-description-parity';
  const byName = new Map(card.map((t) => [t.name, t]));
  const out: Violation[] = [];

  for (const tool of canonical) {
    const entry = byName.get(tool.name);
    if (!entry) {
      out.push(violation(RULE, cardPath, tool.name, 'tool is absent from the discovery manifest'));
      continue;
    }
    const cardText = normalizeClaimText(typeof entry.description === 'string' ? entry.description : '');
    if (cardText === '') {
      out.push(violation(RULE, cardPath, tool.name, 'manifest description is missing or empty (fail-closed)'));
      continue;
    }
    const canonicalText = normalizeClaimText(tool.description);
    if (cardText.startsWith(canonicalText)) continue;

    out.push(violation(
      RULE,
      cardPath,
      tool.name,
      `manifest description does not start with the canonical text.\n`
      + `      canonical (${CANONICAL_SOURCE}): ${canonicalText}\n`
      + `      manifest  (${cardPath}): ${cardText}`,
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2 — complete-reference coverage
// ---------------------------------------------------------------------------

export function checkReferenceCoverage(
  canonical: ToolDescriptor[],
  reference: ClaimSurface,
): Violation[] {
  const text = reference.text ?? '';
  return canonical
    .filter((tool) => !mentionsTool(text, tool.name))
    .map((tool) => violation(
      'reference-coverage',
      reference.path,
      tool.name,
      `registered tool is not documented in the complete MCP reference`,
    ));
}

// ---------------------------------------------------------------------------
// Rule 3 — curated prose coverage (shrink-only ratchet)
// ---------------------------------------------------------------------------

export function checkProseCoverageRatchet(
  prose: ClaimSurface[],
  ratchet: Record<string, string[]>,
): Violation[] {
  const byPath = new Map(prose.map((s) => [s.path, s]));
  const out: Violation[] = [];

  for (const [path, tools] of Object.entries(ratchet)) {
    const surface = byPath.get(path);
    for (const tool of tools) {
      if (surface && mentionsTool(surface.text ?? '', tool)) continue;
      out.push(violation(
        'prose-coverage',
        path,
        tool,
        surface
          ? 'tool was documented on this surface and no longer is'
          : 'ratcheted surface could not be read (fail-closed)',
      ));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 4 — claim rules
// ---------------------------------------------------------------------------

export function checkClaimRules(
  rules: ClaimRule[],
  toolNames: string[],
  surfaces: ClaimSurface[],
): Violation[] {
  const out: Violation[] = [];

  for (const surface of surfaces) {
    for (const rule of rules) {
      const scope = rule.tools.length > 0 ? rule.tools : toolNames;
      for (const tool of scope) {
        const regions: string[] = [];
        const structured = surface.descriptions?.[tool];
        if (typeof structured === 'string') regions.push(structured);
        if (typeof surface.text === 'string') regions.push(...toolRegions(surface.text, tool));

        // One violation per rule/surface/tool, not per occurrence: the
        // baseline must not have to enumerate every line, and must not churn
        // when an unrelated sentence moves inside the same section.
        const hit = regions.find((r) => matches(rule.pattern, r) && !(rule.qualifier && matches(rule.qualifier, r)));
        if (hit === undefined) continue;

        out.push(violation(
          rule.id,
          surface.path,
          tool,
          `${rule.reason}\n      offending text: ${normalizeClaimText(hit).slice(0, 240)}`,
        ));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function applyBaseline(
  violations: Violation[],
  baseline: BaselineEntry[],
): { unbaselined: Violation[]; stale: BaselineEntry[] } {
  const baselined = new Set(baseline.map((b) => b.key));
  const observed = new Set(violations.map((v) => v.key));
  return {
    unbaselined: violations.filter((v) => !baselined.has(v.key)),
    stale: baseline.filter((b) => !observed.has(b.key)),
  };
}

// ---------------------------------------------------------------------------
// The declared claim rules
// ---------------------------------------------------------------------------

/**
 * Each rule states a claim that is FALSE for the named tools, and (where the
 * claim is only false when bare) the qualifier that makes it honest.
 *
 * Adding a rule is the intended way to close the next instance of this class.
 * Deleting one asserts that the underlying behaviour changed — say so in the
 * PR, with the code that changed.
 */
export const CLAIM_RULES: ClaimRule[] = [
  {
    id: 'retrieval-mechanism-claim',
    tools: ['search_credentials'],
    pattern: /\bsemantic(?:ally)?\b|\bvector\b|\bembeddings?\b|\brelevance scores?\b|\bnearest[- ]neighbou?rs?\b/i,
    qualifier: /\bsearch_mode\b|\blexical\b|\bsubstring\b/i,
    reason:
      'search_credentials serves LEXICAL SUBSTRING matching, not vector retrieval '
      + `(see SEARCH_MODE_LEXICAL in ${CANONICAL_SOURCE}; the worker answers 503 when semantic search is disabled). `
      + 'A semantic/vector/relevance-ranking claim is allowed only when the same region also discloses '
      + '`search_mode` or the lexical/substring fallback.',
  },
  {
    id: 'disabled-capability-claim',
    tools: ['nessie_query'],
    pattern: /\bsearches\b|\bqueries\b|\bsynthesized answer\b|\bsemantic\b|\bRAG\b/i,
    qualifier: /\bdisabled\b|\bnot currently enabled\b|\bnot available\b/i,
    reason:
      'Nessie is off by standing founder directive and is off in production. Describing it in the '
      + 'present tense as searching or answering is a capability claim we do not hold; the region must '
      + 'mark it DISABLED.',
  },
];

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface CheckInput {
  canonical: ToolDescriptor[];
  card: { name: string; description?: string }[];
  surfaces: ClaimSurface[];
  baseline: Baseline;
  rules?: ClaimRule[];
}

export function collectViolations(input: CheckInput): Violation[] {
  const { canonical, card, surfaces, baseline } = input;
  const rules = input.rules ?? CLAIM_RULES;
  const byPath = new Map(surfaces.map((s) => [s.path, s]));
  const reference = byPath.get(COMPLETE_REFERENCE) ?? { path: COMPLETE_REFERENCE };
  const prose = surfaces.filter((s) => typeof s.text === 'string');

  return [
    ...checkCardDescriptionParity(canonical, card),
    ...checkReferenceCoverage(canonical, reference),
    ...checkProseCoverageRatchet(prose, baseline.proseCoverage),
    ...checkClaimRules(rules, canonical.map((t) => t.name), surfaces),
  ];
}

function readSurface(path: string): ClaimSurface {
  return { path, text: readFileSync(resolve(ROOT, path), 'utf-8') };
}

export function loadRepoInput(): CheckInput {
  const card = JSON.parse(readFileSync(resolve(ROOT, MACHINE_SURFACE), 'utf-8')) as {
    tools: { name: string; description?: string }[];
  };
  const baseline = JSON.parse(readFileSync(resolve(ROOT, BASELINE_FILE), 'utf-8')) as Baseline;

  const canonical = TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description }));

  return {
    canonical,
    card: card.tools,
    baseline,
    surfaces: [
      { path: MACHINE_SURFACE, descriptions: Object.fromEntries(card.tools.map((t) => [t.name, t.description ?? ''])) },
      { path: CANONICAL_SOURCE, descriptions: Object.fromEntries(canonical.map((t) => [t.name, t.description])) },
      ...PROSE_SURFACES.map(readSurface),
    ],
  };
}

export function main(): number {
  let input: CheckInput;
  try {
    input = loadRepoInput();
  } catch (err) {
    // Fail closed: a gate that passes when it cannot read what it guards is
    // worse than no gate.
    console.error(`::error::MCP claim parity could not read its inputs: ${(err as Error).message}`);
    return 1;
  }

  const violations = collectViolations(input);
  const { unbaselined, stale } = applyBaseline(violations, input.baseline.knownViolations);

  for (const entry of stale) {
    console.log(
      `::notice::MCP claim parity: baselined violation no longer occurs — remove it from `
      + `${BASELINE_FILE}: ${entry.key} (owner: ${entry.owner})`,
    );
  }

  if (unbaselined.length === 0) {
    console.log(
      `MCP claim parity OK — ${input.canonical.length} tools across ${input.surfaces.length} surfaces; `
      + `${input.baseline.knownViolations.length - stale.length} baselined violation(s) still outstanding.`,
    );
    return 0;
  }

  for (const v of unbaselined) {
    console.error(`::error file=${v.surface}::[${v.rule}] ${v.subject} — ${v.detail}`);
  }
  console.error(
    `\n${unbaselined.length} unbaselined MCP claim violation(s).\n`
    + `Fix: correct the surface, or — only when the text is owned by another in-flight PR — add the\n`
    + `violation key to ${BASELINE_FILE} with an owner and a reason. Never baseline a claim you just wrote.\n`
    + `Override label (needs a claims-review rationale in the PR): ${OVERRIDE_LABEL}`,
  );

  if (hasLabel(OVERRIDE_LABEL)) {
    console.log(`::notice::${OVERRIDE_LABEL} present — downgrading ${unbaselined.length} violation(s) to a warning.`);
    return 0;
  }
  return 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main());
}
