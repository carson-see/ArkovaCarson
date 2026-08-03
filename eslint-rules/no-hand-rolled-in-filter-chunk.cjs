/**
 * ESLint Rule: arkova/no-hand-rolled-in-filter-chunk
 *
 * The PostgREST `.in()` filter-width defect class, made unwritable.
 *
 * supabase-js serializes `.in('col', values)` into the URL query string. The
 * proxy in front of PostgREST rejects oversized request lines with 400 — and
 * postgrest-js **resolves** that as `{ data: null, error }` rather than
 * throwing, so a call site that discards the error reads a hard failure as
 * "nothing matched". That combination has reached production three times:
 *
 *   #1795  `fetchAnchorRows`      — 70-hour silent public-record anchoring outage
 *   #1812  `revertClaimedAnchors` — a failed submission released nothing
 *   #1853  `anchor-bulk` dedup    — duplicate anchors created AND billed
 *
 * Every one was a call site choosing its own chunk width by hand. #1839
 * replaced that with `chunkForInFilter(values)` in
 * `services/worker/src/utils/postgrest-filter.ts`, which takes NO size
 * parameter and bounds each chunk by the real encoded wire bytes (measured
 * with `URLSearchParams`, the serializer postgrest-js actually uses) as well as
 * by count. This rule is what stops a new call site from re-introducing the
 * hand-rolled form.
 *
 * Why this rule did not ship with #1839: a rule broad enough to catch the
 * then-existing 500-wide cohort would have failed the build, and `npm run lint`
 * from `services/worker/` IS the deploy gate (CLAUDE.md rule 9). It ships now
 * that the cohort is gone (#1866, #1867).
 *
 * WHAT IT FLAGS
 *
 *  1. An index-stepped loop containing a `.in(...)` call:
 *         for (let i = 0; i < ids.length; i += CHUNK) {
 *           await db.from('t').select('*').in('id', ids.slice(i, i + CHUNK));
 *         }
 *     Detected on the loop's update expression (`i += <step>` or
 *     `i = i + <step>`) where the step is not the literal `1`. A step of `1` is
 *     an ordinary iteration, not chunking, so it is left alone.
 *
 *  2. A `for...of` over a NON-`chunkForInFilter` chunking helper whose body
 *     contains `.in(...)`:
 *         for (const chunk of chunk(ids, 500)) { ... .in('id', chunk) }
 *     `proofJobScan.chunk(items, size)` is for request-BODY batches (RPC
 *     payloads, insert rows), which have no URL budget at all — reaching for it
 *     to size a `.in()` filter is the exact conflation that caused #1795.
 *
 * WHAT IT DOES NOT FLAG
 *
 *  - `for (const { values } of chunkForInFilter(ids))` — the supported form.
 *  - Any loop with no `.in()` call in its body.
 *  - A `.in()` with no loop around it. Deliberate: an unchunked `.in()` over a
 *    genuinely small, statically-bounded list (a status enum, a 3-element
 *    literal) is correct and common, and a rule that flagged those would be
 *    disabled at dozens of honest call sites — which is how a rule stops being
 *    read. This rule targets the case where the author KNEW width mattered,
 *    hand-rolled a bound, and picked the wrong one.
 *
 * KNOWN BLIND SPOT (accepted): a chunk loop split across functions — one
 * helper producing slices, another issuing the `.in()` — is not tracked, since
 * the worker eslint config has no `parserOptions.project` and therefore no type
 * information for cross-function flow. `chunkForInFilter`'s own tests
 * (`utils/postgrest-filter.test.ts`) are the backstop for width itself; this
 * rule covers the shape that actually recurred.
 *
 * Severity: error (scoped to the worker source in eslint.config.js).
 */

/** Chunk helpers that are NOT valid for a `.in()` filter (body-batch splitters). */
const NON_FILTER_CHUNK_HELPERS = new Set(['chunk', 'chunkArray', 'chunked', 'splitIntoChunks', 'batch']);

/** The one supported producer. */
const SUPPORTED_CHUNKER = 'chunkForInFilter';

/** Defensive bound when walking a loop body. */
const WALK_DEPTH_CAP = 12;

function memberPropName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (node.computed) {
    return node.property.type === 'Literal' && typeof node.property.value === 'string'
      ? node.property.value
      : null;
  }
  return node.property.type === 'Identifier' ? node.property.name : null;
}

function calleeName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberPropName(node);
  return null;
}

/**
 * Is this loop update a CHUNK step (`i += SIZE`, `i = i + SIZE`) rather than an
 * ordinary `i++` / `i += 1`?
 */
function isChunkStep(update) {
  if (!update) return false;

  const isLiteralOne = (n) => n && n.type === 'Literal' && n.value === 1;

  if (update.type === 'UpdateExpression') return false; // i++ / i--

  if (update.type === 'AssignmentExpression') {
    if (update.operator === '+=') return !isLiteralOne(update.right);
    if (update.operator === '=') {
      const r = update.right;
      if (r && r.type === 'BinaryExpression' && r.operator === '+') {
        return !isLiteralOne(r.right) && !isLiteralOne(r.left);
      }
    }
  }
  return false;
}

/** Find the first `.in(...)` CallExpression inside a subtree. */
function findInFilterCall(root) {
  const seen = new Set();

  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > WALK_DEPTH_CAP) return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      memberPropName(node.callee) === 'in' &&
      node.arguments.length >= 1
    ) {
      return node;
    }

    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') {
            const hit = walk(child, depth + 1);
            if (hit) return hit;
          }
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        const hit = walk(value, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  return walk(root, 0);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'PostgREST `.in()` filters must be sized by `chunkForInFilter`, never by a hand-rolled chunk loop. A hand-picked width caused three production defects (#1795, #1812, #1853).',
      category: 'Correctness',
    },
    messages: {
      handRolledChunk:
        "postgrest-in-filter: don't hand-roll a chunk loop around `.in()` — use `chunkForInFilter(values)` from `utils/postgrest-filter.js`. It takes no size parameter (picking one is the mistake that reached prod 3x) and bounds each chunk by real encoded wire bytes, not just count.",
      wrongChunker:
        "postgrest-in-filter: `{{helper}}()` splits request-BODY batches, which have no URL budget — using it to size an `.in()` filter is the exact conflation behind the 70-hour outage in #1795. Use `chunkForInFilter(values)` from `utils/postgrest-filter.js`.",
    },
    schema: [],
  },

  create(context) {
    return {
      ForStatement(node) {
        if (!isChunkStep(node.update)) return;
        const inCall = findInFilterCall(node.body);
        if (!inCall) return;
        context.report({ node: inCall, messageId: 'handRolledChunk' });
      },

      ForOfStatement(node) {
        const right = node.right;
        if (!right || right.type !== 'CallExpression') return;

        const name = calleeName(right.callee);
        if (!name || name === SUPPORTED_CHUNKER) return;
        if (!NON_FILTER_CHUNK_HELPERS.has(name)) return;

        const inCall = findInFilterCall(node.body);
        if (!inCall) return;
        context.report({ node: inCall, messageId: 'wrongChunker', data: { helper: name } });
      },
    };
  },
};
