// PR #2909 — Lexical fallback for GET /api/v1/verify/search when
// ENABLE_SEMANTIC_SEARCH is off or the semantic embed/RPC path fails
// (SCRUM-3906, branch fix/verify-search-lexical-fallback, head 206ca7e43).
//
// THE GAP THIS CLOSES. Before this PR, `/verify/search` was mounted behind
// `aiSemanticSearchGate()` in router.ts, so with ENABLE_SEMANTIC_SEARCH off
// (the production default, and the default on every rig this train has
// access to — see project memory `switchboard_flags_dark_api`) EVERY call
// 503'd before the handler ever ran, including every direct API-key caller
// (npm `arkova-mcp-server`'s `arkova_search_anchors`, the TS/Python SDK
// `search()` methods). This PR moves the fallback INTO the route:
// `resolveSearch()` in ai-verify-search.ts now tries semantic (when the flag
// is on) and falls back to `runLexicalSearch()` — the same anon-callable
// `search_public_credentials` ILIKE RPC the edge MCP tool already uses —
// whenever the flag is off, the embed call throws/times out, or the
// semantic RPC errors for any reason. Every response carries an additive
// `search_mode` field (`semantic_vector` | `lexical_substring`) so a caller
// can tell which path answered. The PR's own pre-mortem #2 warns that an
// operator watching only HTTP status codes will not see the flag being off
// as an outage anymore — this module is what makes that visible instead of
// trusting the 200.
//
// WHAT THIS RIG CAN AND CANNOT PROVE. ENABLE_SEMANTIC_SEARCH is off on both
// the standing rig and every isolated train rig this session has access to
// (unverified per-cycle here — see 2909_semantic_flag_state below, which
// reads the fact FROM the response's own search_mode rather than assuming
// it). That means the "normal path" a caller with the flag on would see
// (semantic_vector) is not exercisable from this rig today; what IS
// exercisable, every cycle, against the real deployed route, is exactly the
// case the PR body says needs proving: the flag-off/degraded fallback
// engaging and returning REAL, correctly-shaped results — not a silent
// empty 200 masquerading as "the endpoint is healthy". Both a query that
// SHOULD match a seeded fixture and a query that should NOT match anything
// are run every cycle, specifically so a fallback that silently returns
// `results: []` for everything (the exact regression this PR fixes one
// layer up from — the old RPC-not-found branch already did this) cannot
// pass by accident: only the marker query is required to be non-empty, and
// the true-negative query is required to be exactly empty.
//
// If a future rig ever has ENABLE_SEMANTIC_SEARCH=true, this module still
// runs correctly against it: mode assertions below branch on the OBSERVED
// `search_mode`, not a hard-coded expectation, and would additionally prove
// the semantic-specific response shape (similarity present, richer fields).

export const pr = '#2909';

export const changedBehavior = [
  'GET /api/v1/verify/search no longer 503s when ENABLE_SEMANTIC_SEARCH is',
  'off (or the semantic embed/RPC path fails) — it falls back to a lexical',
  "search_public_credentials ILIKE match and returns search_mode:",
  "'lexical_substring' instead. Proven here, every cycle, against the real",
  'deployed route: a marker query seeded into a public (org_id NULL) SECURED',
  'anchor returns a non-empty, correctly-shaped result (not a silent empty',
  '200); a true-negative query returns a genuinely empty result (so the',
  'positive result is not just an unconditional pass-through); search_mode,',
  'query, count and threshold are all present and consistent; a lexical',
  'result never carries similarity/issuer_name/issued_date/expiry_date/',
  'anchor_timestamp (those are semantic-only fields per the PR); org_id is',
  'never present anywhere in the response body (Constitution 4A / CLAUDE.md',
  '§6); missing q still 400s and a missing API key still 401s (the',
  'lexical fallback did not loosen either gate).',
].join(' ');

const NAME_PREFIX = 'cto-train-b5b-2909';
// Distinctive, PII-scanner-safe (no @, no NNN-NN-NNNN-shaped digit runs) —
// see private.contains_high_confidence_pii in
// supabase/migrations/0385_public_anchor_academic_record_pii_projection.sql.
// Fixed (not per-cycle random) so re-seeding is idempotent and the marker
// stays stable across the whole soak window.
const MARKER = `${NAME_PREFIX}-lexicalprobe-f00dcafe`;
const FILENAME = `${MARKER}.pdf`;
const TRUE_NEGATIVE_QUERY = `${NAME_PREFIX}-no-such-credential-zzqxv`;

function fakeFingerprint(seed) {
  // 64 lowercase hex chars — anchors_fingerprint_format CHECK.
  const hex = Buffer.from(seed).toString('hex').padEnd(64, '0').slice(0, 64);
  return hex;
}

export async function seed(admin, state) {
  const userId = state.individual?.userId;
  if (!userId) throw new Error('#2909 seed: state.individual.userId missing — run setup.mjs base fixtures first');

  const { data: existing, error: findErr } = await admin
    .from('anchors')
    .select('id, public_id, status, deleted_at')
    .eq('user_id', userId)
    .eq('filename', FILENAME)
    .maybeSingle();
  if (findErr) throw new Error(`#2909 seed lookup: ${findErr.message}`);

  if (existing && existing.status === 'SECURED' && !existing.deleted_at) {
    return { anchorId: existing.id, publicId: existing.public_id, marker: MARKER };
  }

  const row = {
    user_id: userId,
    org_id: null, // public search's org-scoping join is bypassed entirely for org_id IS NULL rows
    fingerprint: fakeFingerprint(MARKER),
    filename: FILENAME,
    credential_type: 'OTHER', // NOT an academic-record type (0385) — those are excluded from matching entirely
    status: 'SECURED',
    chain_tx_id: `${NAME_PREFIX}-fake-tx`,
    deleted_at: null,
  };

  if (existing) {
    const { data, error } = await admin.from('anchors').update(row).eq('id', existing.id).select('id, public_id').single();
    if (error) throw new Error(`#2909 seed update: ${error.message}`);
    return { anchorId: data.id, publicId: data.public_id, marker: MARKER };
  }

  const { data, error } = await admin.from('anchors').insert(row).select('id, public_id').single();
  if (error) throw new Error(`#2909 seed insert: ${error.message}`);
  return { anchorId: data.id, publicId: data.public_id, marker: MARKER };
}

export async function run(ctx) {
  const { state, probe, workerFetch } = ctx;
  const s = state['#2909'] ?? {};
  const apiKeyRaw = state.apiKey?.raw;
  const out = [];

  if (!s.publicId || !s.marker) {
    out.push(probe('2909_fixtures_seeded', true, false, {
      pass: false, detail: { reason: 'no #2909 fixture state — run setup.mjs', have: Object.keys(s) },
    }));
    return out;
  }
  if (!apiKeyRaw) {
    out.push(probe('2909_api_key_present', true, false, { pass: false, detail: 'state.apiKey.raw missing' }));
    return out;
  }
  out.push(probe('2909_fixtures_seeded', true, true, { detail: { anchorId: s.anchorId, publicId: s.publicId } }));

  // ── Regression: gates the lexical fallback did NOT loosen ──────────────
  const noKey = await workerFetch(`/api/v1/verify/search?q=${encodeURIComponent(s.marker)}`);
  out.push(probe('2909_no_api_key_401', 401, noKey.status, { detail: { body: noKey.body } }));

  const missingQ = await workerFetch('/api/v1/verify/search', { apiKeyRaw });
  out.push(probe('2909_missing_q_400', 400, missingQ.status, { detail: { body: missingQ.body } }));

  // ── The real, changed behavior: a marker query that must return a real,
  // non-empty, correctly-shaped result via whichever path is live. ───────
  const positive = await workerFetch(`/api/v1/verify/search?q=${encodeURIComponent(s.marker)}&limit=5`, { apiKeyRaw });
  out.push(probe('2909_search_200', 200, positive.status, { detail: { body: positive.body } }));
  if (positive.status !== 200 || !positive.body) return out;

  const mode = positive.body.search_mode;
  out.push(probe('2909_search_mode_present', true, mode === 'semantic_vector' || mode === 'lexical_substring', {
    detail: { search_mode: mode },
  }));
  out.push(probe('2909_query_echoed', s.marker, positive.body.query));
  out.push(probe('2909_threshold_field_present', 'number', typeof positive.body.threshold));
  out.push(probe('2909_count_matches_results_length', Array.isArray(positive.body.results) ? positive.body.results.length : -1, positive.body.count));

  const results = Array.isArray(positive.body.results) ? positive.body.results : [];
  // The load-bearing assertion: NOT a silent empty 200. A caller cannot
  // distinguish "the fallback is broken and always returns []" from "healthy"
  // by status code alone — this is exactly the gap the PR body's pre-mortem
  // #2 names. A real, seeded, matching row MUST come back.
  out.push(probe('2909_results_nonempty_not_silent_empty', true, results.length >= 1, {
    detail: { count: positive.body.count, mode },
  }));

  const match = results.find((r) => typeof r?.record_uri === 'string' && r.record_uri.endsWith(`/verify/${s.publicId}`));
  out.push(probe('2909_seeded_anchor_found_in_results', true, Boolean(match), {
    detail: { publicId: s.publicId, recordUris: results.map((r) => r.record_uri) },
  }));

  // ── org_id must never appear anywhere in the response body — the lexical
  // RPC row carries it, but ai-verify-search.ts's LexicalCredentialRow
  // mapper deliberately never reads it (CLAUDE.md §6). ────────────────────
  const bodyText = JSON.stringify(positive.body);
  out.push(probe('2909_no_org_id_leak', true, !bodyText.includes('"org_id"'), { detail: { bodyKeys: Object.keys(positive.body) } }));

  if (match) {
    if (mode === 'lexical_substring') {
      out.push(probe('2909_lexical_result_shape_verified_status_bool', 'boolean', typeof match.verified));
      out.push(probe('2909_lexical_result_has_status', true, typeof match.status === 'string' && match.status.length > 0, { detail: match.status }));
      // Per ai-verify-search.ts's runLexicalSearch: these are OMITTED (never
      // backfilled from created_at) on a lexical row — asserting their
      // absence, not just non-null, so a future regression that starts
      // filling them with the WRONG value (e.g. created_at as anchor_timestamp,
      // which would misstate what was measured per §1.5) is still caught.
      for (const field of ['similarity', 'issuer_name', 'issued_date', 'expiry_date', 'anchor_timestamp']) {
        out.push(probe(`2909_lexical_result_omits_${field}`, false, Object.hasOwn(match, field), { detail: match[field] }));
      }
    } else {
      out.push(probe('2909_semantic_result_has_similarity', 'number', typeof match.similarity, { detail: match.similarity }));
    }
  }

  // ── True negative: a query that cannot match anything must come back
  // genuinely empty, not error, and not accidentally match everything. ───
  const negative = await workerFetch(`/api/v1/verify/search?q=${encodeURIComponent(TRUE_NEGATIVE_QUERY)}&limit=5`, { apiKeyRaw });
  out.push(probe('2909_true_negative_200', 200, negative.status, { detail: { body: negative.body } }));
  if (negative.status === 200 && negative.body) {
    out.push(probe('2909_true_negative_empty', 0, negative.body.count, {
      detail: { resultsLength: negative.body.results?.length, mode: negative.body.search_mode },
    }));
  }

  out.push(probe('2909_semantic_flag_state_observed', true, true, {
    detail: { note: 'Not asserted — recorded from the live response. Observed search_mode this cycle:', search_mode: mode },
  }));

  return out;
}
