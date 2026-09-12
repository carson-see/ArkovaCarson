// PR #2835 — fail-closed tenant scoping on the AI reads, PostgREST filter
// injection on /verify/entity, the anchor-revoke role check, and the
// concurrent-invitation 23505 (SCRUM-4984 / 4985 / 4986 / 4991).
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated plainly so the evidence is not
// read as more than it is.
//
// PROVEN HERE. Three of the four changes are pure request/response behaviour
// over rows this module seeds, so they are exactly what a rig is good at:
//   1. SCRUM-4984 — the AI reads are behind `requireAuth` (router.ts:436,439),
//      so this is a real cross-tenant read, not the by-design cross-tenant
//      behaviour of a public endpoint (memory/feedback_public_endpoints_are_by
//      _design.md does NOT apply here). Pre-fix, `ai-provenance` never selected
//      `org_id`, so its guard `row.org_id && orgId && row.org_id !== orgId` was
//      dead code and any authenticated user could read any org's extraction
//      manifests by fingerprint. The seed puts an org-B manifest that is NEWER
//      on the same fingerprint as org A's, so a regression to `manifests[0]`
//      surfaces B's `manifest_hash` to A and is caught by name, not by count.
//   2. SCRUM-4985 — the injected identifier `x,attester_name.neq.zzz` matches
//      every ACTIVE attestation through the old `.or()` payload. The seed
//      guarantees at least one such row exists AND asserts that it does
//      (`..._injection_is_discriminating`), so "total 0" can never pass because
//      the table happened to be empty.
//   3. The `anchor_id` select fix — `anchor_proof` was `null` on every row of a
//      paid endpoint; probed against the DB row it must mirror, plus a
//      NULL-anchor row so the fix cannot pass by populating unconditionally.
//   4. SCRUM-4991 — two genuinely concurrent accepts of one token.
//
// NOT PROVEN HERE, and no probe below pretends otherwise:
//   - SCRUM-4986's ORG_ADMIN check is UNREACHABLE IN PROD. It reads
//     `public.memberships`, which holds 0 rows in prod (org_members holds the
//     real memberships, 17 rows), nothing in the repo writes it, and this is
//     the only worker call site that reads it — so the `!membership` 404 fires
//     first for every caller and revoke is already non-functional. A rig whose
//     `memberships` is likewise empty would return 404 for the RIGHT ANSWER FOR
//     THE WRONG REASON. `seed()` therefore writes `memberships` rows for
//     member-A and admin-A deliberately, and `..._role_branch_is_reachable`
//     asserts they are there, so the 404 below is attributable to the role
//     check. That makes this defence-in-depth evidence, NOT evidence that
//     revoke works in prod. SCRUM-5004 owns the repair (org_members is the
//     ruled source of truth) and it is a migration, hence T3, hence not here.
//   - The ORG_ADMIN branch cannot reach a successful revoke on ANY rig: the
//     route calls `revoke_anchor` under service_role, so `auth.uid()` is NULL
//     and the RPC's own `SELECT ... FROM profiles WHERE id = auth.uid()` raises
//     'Profile not found' (P0001) -> 500. The probe asserts the INVARIANT that
//     holds either way (200 iff REVOKED + audit row; anything else iff still
//     SECURED + no audit row) rather than pinning a status the repair will
//     legitimately change.
//   - The x402 payment path on /verify/entity. Those probes carry org A's API
//     key, which bypasses the gate by design (x402PaymentGate.ts:507).
//
// Every probe pairs its HTTP result with a ctx.admin read-back; no probe
// asserts a bare status. Audit assertions are scoped by `target_id` — the
// invitation id / anchor id for THIS cycle — not by a time window, so the
// rig's own cron and the sibling train probes cannot perturb them.
// audit_events are immutable: nothing here deletes one.
export const pr = '#2835';

export const changedBehavior = [
  'Proven here: (1) GET /api/v1/ai/provenance/:fingerprint and POST',
  '/api/v1/ai-accountability-report are fail-closed — a caller sees only rows in',
  'their org or rows they own, an INDIVIDUAL owner still sees their own, and a',
  'cross-tenant miss is 404 (never 403) so neither endpoint is an existence',
  'oracle; on a fingerprint two orgs share, each caller gets their OWN manifest',
  "even when the other org's row is newer. (2) GET /api/v1/verify/entity builds",
  'attestation filters with the query builder, so an identifier carrying',
  'PostgREST filter grammar returns exact matches only instead of enumerating',
  'every ACTIVE attestation. (3) The same endpoint now selects anchor_id, so',
  'anchor_proof carries the real anchor for a record that has one and stays null',
  'for one that does not. (4) A concurrent invitation accept is an idempotent',
  'no-op: one org_members row, one MEMBER_JOINED audit row, no 500.',
  'NOT proven here: that anchor revoke works. Its ORG_ADMIN check is defence in',
  'depth and unreachable in prod (public.memberships is empty; the service_role',
  'RPC raises Profile not found regardless) — the rig seeds memberships rows so',
  'the role branch is reachable at all, and SCRUM-5004 owns the repair onto',
  'org_members. Also not proven: the x402 payment path (probes carry an API key,',
  'which bypasses the gate by design).',
].join(' ');

// Deterministic, prefix-derived fixtures so a re-run finds its own rows.
const FP_SHARED = 'a2835a2835a2835a2835a2835a2835a2835a2835a2835a2835a2835a2835aaaa';
const FP_ONLY_A = 'b2835b2835b2835b2835b2835b2835b2835b2835b2835b2835b2835b2835bbbb';
const FP_INDIVIDUAL = 'c2835c2835c2835c2835c2835c2835c2835c2835c2835c2835c2835c2835cccc';
const FP_PROOF_ANCHOR = 'd2835d2835d2835d2835d2835d2835d2835d2835d2835d2835d2835d2835dddd';
const FP_REVOKE_ANCHOR = 'e2835e2835e2835e2835e2835e2835e2835e2835e2835e2835e2835e2835eeee';
const HASH_A = '1'.repeat(64);
const HASH_B = '2'.repeat(64);
const HASH_INDIVIDUAL = '3'.repeat(64);
/** The payload that turned a targeted lookup into enumeration through `.or()`. */
const INJECTED_IDENTIFIER = 'x,attester_name.neq.zzz';

/** GoTrue password grant -> access_token for a rig user. */
async function signIn(supabaseUrl, anonKey, email, password) {
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, token: body?.access_token ?? null, error: body?.error_description ?? body?.msg ?? null };
}

async function findOne(admin, table, column, value, select = 'id') {
  const { data } = await admin.from(table).select(select).eq(column, value).limit(1).maybeSingle();
  return data ?? null;
}

/**
 * Idempotent fixtures. Every row is `cto-train-b-0912-2835-` prefixed or keyed
 * by one of the constants above, and is looked up before insert.
 *
 * Ordering matters in two places and both are load-bearing:
 *  - org B's manifest on FP_SHARED is written with a LATER
 *    `created_at`/`extraction_timestamp` than org A's. Both endpoints order
 *    `created_at desc`, so a regression to "check manifests[0]" hands B's row
 *    to A and the hash probes catch it. Equal timestamps would make the probe
 *    a coin flip.
 *  - the INDIVIDUAL's manifest carries `org_id: null` with `user_id` set. That
 *    is the exact shape the old expression fell open on and the exact caller
 *    the fix could plausibly have locked out, so it is seeded, not assumed.
 */
export async function seed(admin, state) {
  const P = `${state.prefix ?? 'cto-train-b-0912'}-2835`;
  const out = { prefix: P };

  const manifest = async (key, row) => {
    const existing = await findOne(admin, 'extraction_manifests', 'manifest_hash', row.manifest_hash, 'id, fingerprint, org_id, user_id, manifest_hash');
    if (existing) { out[key] = existing.id; return; }
    const { data, error } = await admin.from('extraction_manifests').insert(row).select('id').single();
    if (error) throw new Error(`#2835 seed manifest ${key}: ${error.message}`);
    out[key] = data.id;
  };

  const base = {
    model_id: 'gemini-2.0-flash', model_version: '2026-01-01', prompt_version: 'v1',
    extracted_fields: { issuer: `${P}-fixture` }, confidence_scores: { overall: 0.97 },
  };
  // Org A on the shared fingerprint — OLDER, so it is NOT manifests[0].
  await manifest('manifestSharedA', {
    ...base, fingerprint: FP_SHARED, manifest_hash: HASH_A, org_id: state.orgA, user_id: state.adminA.userId,
    created_at: '2026-09-01T00:00:00.000Z', extraction_timestamp: '2026-09-01T00:00:00.000Z',
  });
  // Org B on the same fingerprint — NEWER. Pre-fix this is what org A received.
  await manifest('manifestSharedB', {
    ...base, fingerprint: FP_SHARED, manifest_hash: HASH_B, org_id: state.orgB, user_id: state.adminB.userId,
    created_at: '2026-09-02T00:00:00.000Z', extraction_timestamp: '2026-09-02T00:00:00.000Z',
  });
  // Org A only — the headline cross-org 404.
  await manifest('manifestOnlyA', {
    ...base, fingerprint: FP_ONLY_A, manifest_hash: '4'.repeat(64), org_id: state.orgA, user_id: state.adminA.userId,
  });
  // No org, owned by the INDIVIDUAL — the former fail-open shape.
  await manifest('manifestIndividual', {
    ...base, fingerprint: FP_INDIVIDUAL, manifest_hash: HASH_INDIVIDUAL, org_id: null, user_id: state.individual.userId,
  });

  // Two SECURED anchors: one the accountability report is exported for (on the
  // SHARED fingerprint, so the report's manifest choice is discriminating), one
  // the revoke probes target (kept separate so a revoke that ever succeeds
  // cannot break the report probe).
  const anchor = async (key, fingerprint, filename) => {
    const existing = await findOne(admin, 'anchors', 'fingerprint', fingerprint, 'id, public_id, status, chain_tx_id, chain_block_height');
    if (existing) { out[key] = { id: existing.id, publicId: existing.public_id }; return; }
    const { data, error } = await admin.from('anchors').insert({
      org_id: state.orgA, user_id: state.adminA.userId, filename, fingerprint,
      status: 'SECURED', credential_type: 'CERTIFICATE',
      chain_tx_id: `${'f'.repeat(63)}${key === 'proofAnchor' ? '1' : '2'}`,
      chain_block_height: key === 'proofAnchor' ? 900001 : 900002,
      chain_timestamp: '2026-09-01T00:00:00.000Z',
    }).select('id, public_id').single();
    if (error) throw new Error(`#2835 seed anchor ${key}: ${error.message}`);
    out[key] = { id: data.id, publicId: data.public_id };
  };
  await anchor('reportAnchor', FP_SHARED, `${P}-report-anchor.pdf`);
  await anchor('proofAnchor', FP_PROOF_ANCHOR, `${P}-proof-anchor.pdf`);
  await anchor('revokeAnchor', FP_REVOKE_ANCHOR, `${P}-revoke-anchor.pdf`);

  // public_records: one carrying anchor_id (anchor_proof must be populated),
  // one with anchor_id NULL (it must stay null — the fix must not populate
  // unconditionally). `identifier` filters these by `source_id`.
  const record = async (key, sourceId, anchorId) => {
    const existing = await findOne(admin, 'public_records', 'source_id', sourceId, 'id, anchor_id');
    if (existing) { out[key] = { id: existing.id, sourceId }; return; }
    const { data, error } = await admin.from('public_records').insert({
      source: 'CTO_TRAIN_B', source_id: sourceId, record_type: 'FIXTURE',
      title: `${P} entity fixture`, source_url: `https://example.invalid/${sourceId}`,
      content_hash: '5'.repeat(64), anchor_id: anchorId,
    }).select('id').single();
    if (error) throw new Error(`#2835 seed public_record ${key}: ${error.message}`);
    out[key] = { id: data.id, sourceId };
  };
  await record('recordWithAnchor', `${P}-src-anchored`, out.proofAnchor.id);
  await record('recordWithoutAnchor', `${P}-src-no-anchor`, null);

  // One ACTIVE attestation. Its existence is what makes the injection probe
  // discriminating: `attester_name.neq.zzz` matches it, so a regression to the
  // `.or()` payload returns it and `total_attestations: 0` fails.
  const subjectIdentifier = `${P}-subject`;
  const existingAtt = await findOne(admin, 'attestations', 'subject_identifier', subjectIdentifier, 'id, public_id, status');
  if (existingAtt) {
    out.attestation = { id: existingAtt.id, subjectIdentifier };
  } else {
    const { data, error } = await admin.from('attestations').insert({
      public_id: `${P}-att-1`.toUpperCase().slice(0, 40),
      attestation_type: 'VERIFICATION', attester_type: 'INSTITUTION',
      attester_name: `${P}-attester`, attester_user_id: state.adminA.userId, attester_org_id: state.orgA,
      subject_identifier: subjectIdentifier, subject_type: 'organization',
      status: 'ACTIVE', claims: { fixture: true }, summary: `${P} attestation fixture`,
    }).select('id').single();
    if (error) throw new Error(`#2835 seed attestation: ${error.message}`);
    out.attestation = { id: data.id, subjectIdentifier };
  }

  // `memberships` rows — see the header. Without these the revoke probes would
  // 404 at the `!membership` branch and prove nothing about the role check.
  // `memberships.role` is the `user_role` enum (INDIVIDUAL|ORG_ADMIN|ORG_MEMBER),
  // NOT `org_members`' lowercase `org_member_role`.
  out.memberships = {};
  for (const [key, user, role] of [['memberA', state.memberA, 'ORG_MEMBER'], ['adminA', state.adminA, 'ORG_ADMIN']]) {
    const { data: existing } = await admin.from('memberships').select('id, role').eq('user_id', user.userId).eq('org_id', state.orgA).maybeSingle();
    if (existing) { out.memberships[key] = existing.id; continue; }
    const { data, error } = await admin.from('memberships').insert({ user_id: user.userId, org_id: state.orgA, role }).select('id').single();
    if (error) throw new Error(`#2835 seed membership ${key}: ${error.message}`);
    out.memberships[key] = data.id;
  }

  // A pending invitation so the fixture is complete after setup. run() seeds a
  // FRESH one every cycle (accepting consumes it), so this one is the
  // coverage-gate copy only.
  out.seedInvitation = await ensurePendingInvitation(admin, state, `${P}-invitee-seed`);
  return out;
}

/** A pending invitation + its raw UUID token. `loadInvitationByToken` matches the raw value. */
async function ensurePendingInvitation(admin, state, local) {
  const email = `${local}@staging.invalid.test`;
  const { data: existing } = await admin.from('invitations').select('id, token, status').eq('email', email).eq('status', 'pending').maybeSingle();
  if (existing?.token) return { id: existing.id, token: existing.token, email };
  const token = globalThis.crypto.randomUUID();
  const { data, error } = await admin.from('invitations').insert({
    email, org_id: state.orgA, invited_by: state.adminA.userId, role: 'ORG_MEMBER',
    status: 'pending', token, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  }).select('id').single();
  if (error) throw new Error(`#2835 invitation ${email}: ${error.message}`);
  return { id: data.id, token, email };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, ANON_KEY, SUPABASE_URL, cycleId } = ctx;
  const seeded = state['#2835'] ?? {};
  const out = [];

  const fixturesOk = Boolean(
    seeded.manifestSharedA && seeded.manifestSharedB && seeded.manifestIndividual
    && seeded.reportAnchor?.publicId && seeded.proofAnchor?.id && seeded.revokeAnchor?.id
    && seeded.recordWithAnchor && seeded.recordWithoutAnchor && seeded.attestation,
  );
  out.push(probe('2835_fixtures_present', true, fixturesOk, { detail: { seeded: Object.keys(seeded) } }));
  if (!fixturesOk) return out;

  // ── JWTs. The AI routes are requireAuth (JWT-only); an API key is rejected. ─
  const tokens = {};
  for (const [key, user] of [['adminA', state.adminA], ['adminB', state.adminB], ['individual', state.individual], ['memberA', state.memberA]]) {
    const { status, token, error } = await signIn(SUPABASE_URL, ANON_KEY, user.email, state.password);
    tokens[key] = token;
    out.push(probe(`2835_jwt_${key}_acquired`, true, Boolean(token), { detail: { status, error } }));
  }
  if (!tokens.adminA || !tokens.adminB || !tokens.individual || !tokens.memberA) return out;

  const provenance = (fp, jwt) => workerFetch(`/api/v1/ai/provenance/${fp}`, { jwt });
  const hashesOf = (res) => (res.body?.provenanceChain ?? []).map((c) => c.manifestHash ?? c.manifest_hash ?? null);

  // ── 1. SCRUM-4984, provenance ────────────────────────────────────────────
  // Org B against a fingerprint only org A holds. Pre-fix: 200 with A's
  // manifest. 404 (not 403) so B cannot learn the document was extracted.
  const crossOrg = await provenance(FP_ONLY_A, tokens.adminB);
  out.push(probe('2835_provenance_cross_org_404', 404, crossOrg.status, { detail: { body: crossOrg.body } }));
  out.push(probe('2835_provenance_cross_org_is_not_an_existence_oracle', true, crossOrg.status !== 403, {
    detail: 'A 403 would confirm to org B that another tenant extracted this fingerprint.',
  }));
  const { count: onlyACount } = await admin.from('extraction_manifests').select('id', { count: 'exact', head: true }).eq('fingerprint', FP_ONLY_A);
  out.push(probe('2835_provenance_cross_org_404_is_discriminating', true, (onlyACount ?? 0) > 0, {
    detail: { rowsOnFingerprint: onlyACount, note: 'The 404 must be a denial, not an empty table.' },
  }));

  const ownOrg = await provenance(FP_ONLY_A, tokens.adminA);
  out.push(probe('2835_provenance_own_org_200', 200, ownOrg.status, { detail: { manifestCount: ownOrg.body?.manifestCount } }));

  // The shared fingerprint: each caller gets their OWN row even though org B's
  // is newer and would be manifests[0].
  const sharedA = await provenance(FP_SHARED, tokens.adminA);
  const sharedB = await provenance(FP_SHARED, tokens.adminB);
  out.push(probe('2835_provenance_shared_fp_org_a_sees_only_own', JSON.stringify([HASH_A]), JSON.stringify(hashesOf(sharedA)), {
    detail: { status: sharedA.status, manifestCount: sharedA.body?.manifestCount, note: "org B's row is NEWER; pre-fix it was manifests[0]" },
  }));
  out.push(probe('2835_provenance_shared_fp_org_b_sees_only_own', JSON.stringify([HASH_B]), JSON.stringify(hashesOf(sharedB)), {
    detail: { status: sharedB.status, manifestCount: sharedB.body?.manifestCount },
  }));
  out.push(probe('2835_provenance_manifest_count_matches_visible_rows', true,
    sharedA.body?.manifestCount === 1 && sharedB.body?.manifestCount === 1, {
      detail: { a: sharedA.body?.manifestCount, b: sharedB.body?.manifestCount, note: 'manifestCount must count visible rows, not fetched rows.' },
    }));

  // The INDIVIDUAL (profiles.org_id NULL) owning a manifest — the caller the
  // fail-closed rewrite could plausibly have locked out.
  const indOwn = await provenance(FP_INDIVIDUAL, tokens.individual);
  out.push(probe('2835_provenance_individual_owner_200', 200, indOwn.status, { detail: { hashes: hashesOf(indOwn) } }));
  out.push(probe('2835_provenance_individual_sees_own_hash', JSON.stringify([HASH_INDIVIDUAL]), JSON.stringify(hashesOf(indOwn)), {}));
  const indCross = await provenance(FP_ONLY_A, tokens.individual);
  out.push(probe('2835_provenance_individual_cross_org_404', 404, indCross.status, {
    detail: 'No org on the caller AND not the owner — the exact shape the old expression fell open on.',
  }));
  // Org A must not be able to read the INDIVIDUAL's orphan-org manifest either.
  const orgAvsIndividual = await provenance(FP_INDIVIDUAL, tokens.adminA);
  out.push(probe('2835_provenance_org_caller_cannot_read_orphan_org_row', 404, orgAvsIndividual.status, {
    detail: { body: orgAvsIndividual.body },
  }));

  // ── 2. SCRUM-4984, accountability report ─────────────────────────────────
  const report = (publicId, jwt) => workerFetch('/api/v1/ai-accountability-report', { method: 'POST', jwt, body: { anchorId: publicId, format: 'json' } });
  const reportPublicId = seeded.reportAnchor.publicId;
  const reportCross = await report(reportPublicId, tokens.adminB);
  out.push(probe('2835_report_cross_org_404', 404, reportCross.status, { detail: { body: reportCross.body } }));
  out.push(probe('2835_report_cross_org_is_not_403', true, reportCross.status !== 403, {
    detail: 'public_id enumeration must not confirm which anchors exist in other orgs.',
  }));
  const reportOwn = await report(reportPublicId, tokens.adminA);
  out.push(probe('2835_report_own_org_200', 200, reportOwn.status, { detail: { status: reportOwn.status } }));
  // The anchor sits on the SHARED fingerprint, so latestManifest is a real choice.
  out.push(probe('2835_report_manifest_is_callers_own_org', HASH_A,
    reportOwn.body?.provenanceChain?.aiExtraction?.manifestHash ?? null, {
      detail: { note: "org B's manifest on this fingerprint is newer; it must never surface as latestManifest" },
    }));

  // Read-back: an export is a read. Nothing may have been written.
  const { count: sharedRows } = await admin.from('extraction_manifests').select('id', { count: 'exact', head: true }).eq('fingerprint', FP_SHARED);
  out.push(probe('2835_report_wrote_nothing', 2, sharedRows ?? null, {
    detail: 'The two seeded manifests on the shared fingerprint, unchanged by two report exports.',
  }));

  // ── 3. SCRUM-4985, filter injection (public endpoint; API key bypasses x402) ─
  const entity = (qs) => workerFetch(`/api/v1/verify/entity?${qs}`, { apiKeyRaw: state.apiKey.raw });
  const injected = await entity(`identifier=${encodeURIComponent(INJECTED_IDENTIFIER)}`);
  out.push(probe('2835_entity_injection_status_200', 200, injected.status, { detail: { body: injected.body } }));
  out.push(probe('2835_entity_injection_returns_no_attestations', 0, injected.body?.total_attestations ?? null, {
    detail: { injected: INJECTED_IDENTIFIER, note: 'Pre-fix the appended OR clause matched every ACTIVE attestation.' },
  }));
  const { count: activeAttestations } = await admin.from('attestations').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE');
  out.push(probe('2835_entity_injection_is_discriminating', true, (activeAttestations ?? 0) > 0, {
    detail: { activeAttestations, note: '`attester_name.neq.zzz` matches all of these; total 0 must be a denial, not an empty table.' },
  }));
  const exact = await entity(`identifier=${encodeURIComponent(seeded.attestation.subjectIdentifier)}`);
  const exactRows = exact.body?.attestations ?? [];
  out.push(probe('2835_entity_exact_identifier_still_matches', true, exactRows.length >= 1, {
    detail: { total: exact.body?.total_attestations, note: 'The fix must narrow, not break, the legitimate lookup.' },
  }));
  out.push(probe('2835_entity_exact_match_only', true,
    exactRows.length > 0 && exactRows.every((a) => a.subject_identifier === seeded.attestation.subjectIdentifier), {
      detail: { identifiers: exactRows.map((a) => a.subject_identifier) },
    }));

  // ── 4. anchor_proof (the CTO-folded select fix) ──────────────────────────
  const { data: proofAnchorRow } = await admin.from('anchors')
    .select('id, status, chain_tx_id, chain_block_height').eq('id', seeded.proofAnchor.id).maybeSingle();
  const anchored = await entity(`identifier=${encodeURIComponent(seeded.recordWithAnchor.sourceId)}`);
  const anchoredRecord = (anchored.body?.records ?? [])[0] ?? null;
  out.push(probe('2835_entity_anchored_record_returned', 1, anchored.body?.total_records ?? null, {
    detail: { sourceId: seeded.recordWithAnchor.sourceId },
  }));
  out.push(probe('2835_entity_anchor_proof_matches_db_row',
    JSON.stringify({ status: proofAnchorRow?.status ?? null, chain_tx_id: proofAnchorRow?.chain_tx_id ?? null, block_height: proofAnchorRow?.chain_block_height ?? null }),
    JSON.stringify({
      status: anchoredRecord?.anchor_proof?.status ?? null,
      chain_tx_id: anchoredRecord?.anchor_proof?.chain_tx_id ?? null,
      block_height: anchoredRecord?.anchor_proof?.block_height ?? null,
    }), {
      detail: 'Pre-fix anchor_id was never selected, so this was null on every row of a $0.005/request endpoint.',
    }));
  out.push(probe('2835_entity_anchor_id_absent_from_payload', false,
    anchoredRecord ? Object.prototype.hasOwnProperty.call(anchoredRecord, 'anchor_id') : null, {
      detail: 'anchor_id is an internal id; only the derived anchor_proof may be public (Constitution §6).',
    }));
  const unanchored = await entity(`identifier=${encodeURIComponent(seeded.recordWithoutAnchor.sourceId)}`);
  const unanchoredRecord = (unanchored.body?.records ?? [])[0] ?? null;
  // `?? 'MISSING_RECORD'` would be wrong here: a null anchor_proof is the PASS
  // condition, and `??` fires on it. The absent record is a distinct failure.
  const unanchoredProof = unanchoredRecord === null ? 'MISSING_RECORD' : unanchoredRecord.anchor_proof;
  out.push(probe('2835_entity_anchor_proof_null_without_anchor', null, unanchoredProof, {
    detail: { total_records: unanchored.body?.total_records, note: 'The fix must not populate anchor_proof unconditionally.' },
  }));

  // ── 5. SCRUM-4986, revoke role check (defence in depth — see header) ─────
  const revokeAnchorId = seeded.revokeAnchor.id;
  const { data: membershipRows } = await admin.from('memberships').select('id, role, user_id').eq('org_id', state.orgA);
  const memberRow = (membershipRows ?? []).find((m) => m.user_id === state.memberA.userId) ?? null;
  const adminRow = (membershipRows ?? []).find((m) => m.user_id === state.adminA.userId) ?? null;
  out.push(probe('2835_revoke_role_branch_is_reachable', 'ORG_MEMBER+ORG_ADMIN',
    `${memberRow?.role ?? 'MISSING'}+${adminRow?.role ?? 'MISSING'}`, {
      detail: 'Without seeded memberships rows the route 404s at !membership and the role check proves nothing. prod holds 0 rows here.',
    }));

  const cycleStart = new Date().toISOString();
  const revoke = (jwt) => workerFetch(`/api/anchor/${revokeAnchorId}/revoke`, { method: 'POST', jwt, body: { reason: `${cycleId} probe` } });
  const auditCount = async () => {
    const { count } = await admin.from('audit_events').select('id', { count: 'exact', head: true })
      .eq('event_type', 'ANCHOR_REVOKED').eq('target_id', revokeAnchorId).gte('created_at', cycleStart);
    return count ?? 0;
  };
  const anchorStatus = async () => (await admin.from('anchors').select('status, revoked_at').eq('id', revokeAnchorId).maybeSingle()).data ?? null;

  const memberRevoke = await revoke(tokens.memberA);
  out.push(probe('2835_revoke_org_member_404', 404, memberRevoke.status, { detail: { body: memberRevoke.body } }));
  out.push(probe('2835_revoke_org_member_no_audit_row', 0, await auditCount(), {
    detail: { scopedBy: { target_id: revokeAnchorId, since: cycleStart } },
  }));
  const afterMember = await anchorStatus();
  out.push(probe('2835_revoke_org_member_anchor_still_secured', 'SECURED', afterMember?.status ?? null, {
    detail: { revoked_at: afterMember?.revoked_at ?? null },
  }));

  // ORG_ADMIN: the status is expected to be 500 today (service_role => auth.uid()
  // NULL => the RPC raises 'Profile not found'), and SCRUM-5004 will legitimately
  // change it. So assert the INVARIANT, not the status: a 200 must come with a
  // REVOKED anchor and an audit row; anything else must leave both untouched.
  const adminRevoke = await revoke(tokens.adminA);
  const adminAudit = await auditCount();
  const afterAdmin = await anchorStatus();
  const consistent = adminRevoke.status === 200
    ? afterAdmin?.status === 'REVOKED' && adminAudit === 1
    : afterAdmin?.status === 'SECURED' && adminAudit === 0;
  out.push(probe('2835_revoke_org_admin_no_half_applied_state', true, consistent, {
    detail: {
      status: adminRevoke.status, body: adminRevoke.body, anchorStatus: afterAdmin?.status, auditRows: adminAudit,
      note: '500 expected today (SCRUM-5004: the service_role RPC path cannot resolve auth.uid()); a 200 is the repair landing, not a failure.',
    },
  }));
  out.push(probe('2835_revoke_org_admin_status_recorded', [200, 500], adminRevoke.status, {
    detail: 'Fails only on an unexpected shape (403/404 would mean the role check rejected a seeded ORG_ADMIN).',
  }));

  // ── 6. SCRUM-4991, concurrent invitation accept ──────────────────────────
  // A FRESH invitation per cycle: accepting consumes it. The account this
  // creates is removed at the end so the fixture does not drift over a 48h
  // soak — audit_events are immutable and are never touched.
  const inviteLocal = `${seeded.prefix}-invitee-${cycleId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const invitation = await ensurePendingInvitation(admin, state, inviteLocal);
  const acceptStart = new Date().toISOString();
  const accept = () => workerFetch('/api/invitations/accept', { method: 'POST', body: { token: invitation.token, password: state.password, fullName: inviteLocal } });
  const [r1, r2] = await Promise.all([accept(), accept()]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);

  out.push(probe('2835_invite_concurrent_accept_no_500', true, r1.status !== 500 && r2.status !== 500, {
    detail: { statuses, bodies: [r1.body, r2.body], note: "Pre-fix the race loser's 23505 surfaced as a 500 to a user whose join succeeded." },
  }));
  const { data: newProfile } = await admin.from('profiles').select('id').eq('email', invitation.email).maybeSingle();
  out.push(probe('2835_invite_account_provisioned', true, Boolean(newProfile?.id), { detail: { email: invitation.email } }));
  const { count: memberRowCount } = await admin.from('org_members').select('id', { count: 'exact', head: true })
    .eq('org_id', state.orgA).eq('user_id', newProfile?.id ?? '00000000-0000-0000-0000-000000000000');
  out.push(probe('2835_invite_exactly_one_org_members_row', 1, memberRowCount ?? null, {
    detail: 'UNIQUE(user_id, org_id) makes >1 impossible; 0 would mean both accepts failed.',
  }));
  const { count: joinedAudit } = await admin.from('audit_events').select('id', { count: 'exact', head: true })
    .eq('event_type', 'MEMBER_JOINED').eq('target_id', invitation.id).gte('created_at', acceptStart);
  out.push(probe('2835_invite_exactly_one_member_joined_audit', 1, joinedAudit ?? null, {
    detail: { scopedBy: { target_id: invitation.id, since: acceptStart }, note: 'The race loser must not emit a second MEMBER_JOINED.' },
  }));
  const { data: invAfter } = await admin.from('invitations').select('status, accepted_at').eq('id', invitation.id).maybeSingle();
  out.push(probe('2835_invite_marked_accepted', true, invAfter?.status === 'accepted' || Boolean(invAfter?.accepted_at), {
    detail: { status: invAfter?.status ?? null, accepted_at: invAfter?.accepted_at ?? null },
  }));

  // Per-cycle cleanup: our own invitee only. Never audit_events.
  if (newProfile?.id) {
    await admin.from('org_members').delete().eq('user_id', newProfile.id).eq('org_id', state.orgA);
    await admin.auth.admin.deleteUser(newProfile.id).catch(() => {});
  }

  return out;
}
