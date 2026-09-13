// PR #2846 — Drive source link-back on the anonymous verification response
// (SCRUM-4507).
//
// WHAT THIS PR CHANGED, AND THE EXACT LINE THIS MODULE DRAWS.
//
// `GET /api/v1/verify/:publicId` now additively emits `source: {provider}`
// when `mapAnchorRow` resolves a RECOGNISED connector marker off
// `anchors.metadata.connector_source` (verify.ts:691-692,
// `resolveConnectorFetchSource` / `isConnectorFetchSource` in
// constants/connectorFingerprint.ts — a closed 4-member set: docusign,
// google_drive, microsoft_365, connector). Unrecognised free text and absent
// markers both OMIT the key entirely (never null, never `{}`) — the same
// discipline as `proof_availability` / `fingerprint_rederivability`.
// Separately, `jobs/drive-file-changed.ts`'s `enqueueArtifact` carries four
// new optional `_drive_*` fields (shared_drive_id, folder_id, folder_path,
// revision_kind) from the job payload into `p_metadata` on the
// `enqueue_connector_artifact` RPC (migration 0343), each written `?? null`
// so a legacy payload that predates this PR (none of the four present) still
// produces a parseable, fully-keyed metadata object rather than a thrown
// error or a silently absent key.
//
// PROVEN HERE, both without any Google credential (SCRUM-5082 — no rig has
// one) and without needing the real Drive fetch path at all:
//
//   (c)/(d) `source.provider` projection — seeded directly on `anchors.metadata`
//     (service_role; migration 0423 strips `connector_source` from any other
//     write, so a user-role fixture would silently test nothing). Four
//     anchors: 'google_drive', 'docusign', no marker, and the free-text
//     look-alike 'google_drive_totally_real'. Each is read back through the
//     REAL anonymous endpoint, never asserted against `mapAnchorRow` in
//     isolation.
//   (a)/(b) payload carriage — driven at the exact seam the producer itself
//     uses: `enqueue_connector_artifact` (0343) is called directly with two
//     `p_metadata` shapes (all four `_drive_*` fields present; all four
//     absent, mirroring a legacy pre-SCRUM-4507 job payload) and the
//     PERSISTED `connector_artifact.metadata` row is read back. This
//     exercises the identical write this PR added to
//     `jobs/drive-file-changed.ts:248-251` — the RPC does not care whether
//     the caller is the real job or this probe — with zero Drive fetch
//     involved anywhere in the module.
//   Leak checks — the public response body (raw text, not just parsed JSON
//   keys) is asserted to contain NONE of: the Drive file id, any `_drive_`
//   prefixed key, `drive.google.com`, an email-shaped `account_label` planted
//   on the fixture's metadata (defense-in-depth: prod never writes this key
//   there, per drive-file-changed.ts's own comment that `account_label` is
//   deliberately excluded from `p_metadata` — this fixture plants it anyway
//   to prove a legacy/malformed row still cannot leak it), or the raw org_id
//   (§6 public projection).
//   Cache — `verifyCache` `KEY_PREFIX` ('verify:v8:') is unchanged by this
//   PR; two back-to-back reads of a publicId this module just created (so it
//   cannot be riding a pre-deploy-cached, `source`-less entry) must both
//   carry `source`.
//
// NOT PROVEN HERE, stated rather than implied:
//   - The real Drive fetch path (headRevisionId presence/absence, real
//     driveId/parents, the folder-path walk) — no rig has a Google
//     credential (SCRUM-5082), and prod has 0 Drive-sourced
//     `connector_artifact` rows as of this review. This module proves
//     CARRIAGE and PROJECTION, never that a real Drive change was read
//     correctly.
//   - The further hop from `connector_artifact.metadata` into
//     `anchors.metadata` via `connector-artifact-drain.ts`'s
//     `materialize_connector_artifact_anchor` + `debit_and_enqueue_anchor`.
//     That drain is a separate, flag-gated (`ENABLE_CONNECTOR_ARTIFACT_DRAIN`,
//     default false — services/worker/src/config.ts:352), org-fanout cron
//     that charges REAL credits at SECURING and is triggered rig-wide via
//     `POST /jobs/drain-connector-artifacts` or an in-process schedule this
//     module does not control and has no way to confirm is even enabled on
//     this train's rig. Forcing it from a single PR's probe would spend this
//     shared fixture org's credits and touch every other org's pending
//     `connector_artifact` rows on the rig for a claim (the producer's own
//     write) already fully provable one layer down, at the RPC boundary the
//     producer itself calls. So this module stops at `connector_artifact`,
//     per the CTO review's own instruction to "cover only what is real —
//     do not fake it" rather than assert coverage of a hop it cannot safely
//     drive. See memory/project_connector_pipeline_consumer_gap.md.
import { createHash } from 'node:crypto';

export const pr = '#2846';

export const changedBehavior = [
  'Proven here: (1) GET /api/v1/verify/:publicId emits additive source:',
  '{provider} for an anchor whose metadata.connector_source is a recognised',
  'marker (google_drive, docusign) and OMITS the key entirely (never null,',
  'never {}) for a plain anchor and for the free-text look-alike',
  "'google_drive_totally_real' — asserted via Object.hasOwn on the live",
  'response, not a bare status. (2) The response body (raw text) never',
  'contains the Drive file id, any _drive_-prefixed key, drive.google.com, an',
  "email-shaped account_label, or the anchor's raw org_id, even when all of",
  'those are present on the seeded metadata (defense-in-depth: prod never',
  "writes account_label there at all). (3) A publicId this module just",
  'created is read twice; both reads carry source (verifyCache KEY_PREFIX is',
  'unchanged by this PR — correct for an additive field). (4) The producer',
  'seam this PR touches — enqueue_connector_artifact (0343) — is called',
  'directly with all four new _drive_* fields present, and again with all',
  'four absent (mirroring a legacy pre-SCRUM-4507 job payload); the persisted',
  'connector_artifact.metadata row is read back and shown non-null-and-keyed',
  'in the first case and present-key-with-null-value (never missing) in the',
  'second — proving the exact `?? null` carriage jobs/drive-file-changed.ts',
  'added, with no Drive fetch anywhere in this module.',
  'NOT proven here: the real Drive fetch path (no rig holds a Google',
  'credential, SCRUM-5082) and the further hop from connector_artifact into',
  'anchors.metadata via connector-artifact-drain.ts — that drain is a',
  'separate, flag-gated (ENABLE_CONNECTOR_ARTIFACT_DRAIN, default false),',
  'credit-charging, rig-wide cron this module has no way to confirm is',
  'enabled here and will not force, since doing so would spend the shared',
  'fixture org’s credits and touch every other org’s pending rows for a claim',
  'already provable one layer down at the RPC boundary. This module proves',
  'carriage and projection, not producer correctness against a live change.',
].join(' ');

const NAME_PREFIX = 'cto-train-b-0912-2846';

// Fixed 64-char fixture fingerprints, unique to this PR's probes (character(64)
// column — see memory/project_bpchar_text_index_defeat.md: cast the PARAMETER,
// never the column, but these are plain equality lookups so no cast is needed).
const FP_DRIVE = '284628462846284628462846284628462846284628462846284628462846dddd';
const FP_DOCUSIGN = '284628462846284628462846284628462846284628462846284628462846cccc';
const FP_PLAIN = '284628462846284628462846284628462846284628462846284628462846aaaa';
const FP_UNKNOWN_MARKER = '284628462846284628462846284628462846284628462846284628462846bbbb';

// An email-SHAPED value at a fixture-owned, non-routable domain — not a real
// person's address. Planted on the Drive anchor's metadata to prove the leak
// check is discriminating: real code never writes `account_label` into
// `anchors.metadata` (drive-file-changed.ts says so explicitly), so this is
// deliberately a worse-than-real-life row.
const FIXTURE_ACCOUNT_LABEL = `${NAME_PREFIX}-owner@personal-gmail-fixture.example`;
const FIXTURE_FILE_ID = `${NAME_PREFIX}-file-id-must-never-leak`;
const FIXTURE_REVISION_ID = `${NAME_PREFIX}-revision-id-must-never-leak`;

/** The six Drive-shaped keys the PII-projection test (61cf74b74) pins as never-leak. */
function driveLeakMetadata() {
  return {
    file_id: FIXTURE_FILE_ID,
    revision_id: FIXTURE_REVISION_ID,
    _drive_shared_drive_id: `${NAME_PREFIX}-shared-drive-id`,
    _drive_folder_id: `${NAME_PREFIX}-folder-id`,
    _drive_folder_path: '/HR/Fixtures/2846-record-page',
    _drive_revision_kind: 'head_revision',
  };
}

/** One anchor per fixture, looked up by its fixed fingerprint (idempotent re-run). */
async function ensureAnchor(admin, { orgId, userId, fingerprint, filename, metadata }) {
  const { data: existing, error: findErr } = await admin
    .from('anchors')
    .select('id, public_id')
    .eq('fingerprint', fingerprint)
    .maybeSingle();
  if (findErr) throw new Error(`#2846 lookup anchor ${filename}: ${findErr.message}`);
  if (existing) return { id: existing.id, publicId: existing.public_id };

  const { data, error } = await admin
    .from('anchors')
    .insert({
      org_id: orgId,
      user_id: userId,
      filename,
      fingerprint,
      status: 'SECURED',
      credential_type: 'CERTIFICATE',
      chain_tx_id: fingerprint.slice(0, 63) + '1',
      chain_block_height: 900046,
      chain_timestamp: '2026-09-01T00:00:00.000Z',
      metadata,
    })
    .select('id, public_id')
    .single();
  if (error) throw new Error(`#2846 insert anchor ${filename}: ${error.message}`);
  return { id: data.id, publicId: data.public_id };
}

/**
 * Call the REAL producer seam directly — the same `enqueue_connector_artifact`
 * RPC `jobs/drive-file-changed.ts` calls after its (unexercisable here) Drive
 * fetch — with a deterministic external_ref so re-runs are idempotent
 * (ON CONFLICT DO NOTHING; the RPC resolves and returns the existing id).
 */
async function ensureConnectorArtifact(admin, { orgId, externalRef, driveFields }) {
  const fingerprint = createHash('sha256').update(`${NAME_PREFIX}-${externalRef}`).digest('hex');
  const { data: artifactId, error } = await admin.rpc('enqueue_connector_artifact', {
    p_org_id: orgId,
    p_source: 'google_drive',
    p_external_ref: externalRef,
    p_external_revision: `${externalRef}-rev`,
    p_fingerprint_sha256: fingerprint,
    p_byte_length: 2048,
    p_source_timestamp: '2026-09-01T00:00:00.000Z',
    p_metadata: {
      file_id: externalRef,
      revision_id: `${externalRef}-rev`,
      integration_id: null,
      rule_event_id: null,
      mime_type: 'application/pdf',
      export_mime_type: null,
      content_type: 'application/pdf',
      // Mirrors jobs/drive-file-changed.ts:248-251 exactly: `?? null`, never
      // `?? undefined` — a legacy caller that never had these fields must
      // still produce present, null-valued keys, not missing ones.
      _drive_shared_drive_id: driveFields?.sharedDriveId ?? null,
      _drive_folder_id: driveFields?.folderId ?? null,
      _drive_folder_path: driveFields?.folderPath ?? null,
      _drive_revision_kind: driveFields?.revisionKind ?? null,
    },
  });
  if (error) throw new Error(`#2846 enqueue_connector_artifact ${externalRef}: ${error.message}`);
  return artifactId;
}

export async function seed(admin, state, ctx) {
  const orgId = state.orgA;
  const userId = state.adminA.userId;

  const drive = await ensureAnchor(admin, {
    orgId, userId, fingerprint: FP_DRIVE, filename: `${NAME_PREFIX}-drive.pdf`,
    metadata: {
      connector_source: 'google_drive',
      connector_artifact_id: `${NAME_PREFIX}-artifact-drive`,
      account_label: FIXTURE_ACCOUNT_LABEL,
      ...driveLeakMetadata(),
    },
  });
  const docusign = await ensureAnchor(admin, {
    orgId, userId, fingerprint: FP_DOCUSIGN, filename: `${NAME_PREFIX}-docusign.pdf`,
    metadata: { connector_source: 'docusign', connector_artifact_id: `${NAME_PREFIX}-artifact-docusign` },
  });
  const plain = await ensureAnchor(admin, {
    orgId, userId, fingerprint: FP_PLAIN, filename: `${NAME_PREFIX}-plain.pdf`,
    metadata: {},
  });
  // Pre-0423-shaped row: a marker string that is NOT in the closed vocabulary.
  // isConnectorFetchSource must reject it exactly like it rejects org-authored
  // free text on a legacy row (verify.ts's own "RESIDUAL, disclosed" comment).
  const unknown = await ensureAnchor(admin, {
    orgId, userId, fingerprint: FP_UNKNOWN_MARKER, filename: `${NAME_PREFIX}-unknown-marker.pdf`,
    metadata: { connector_source: 'google_drive_totally_real' },
  });

  const artifactFull = await ensureConnectorArtifact(admin, {
    orgId,
    externalRef: `${NAME_PREFIX}-carriage-full`,
    driveFields: {
      sharedDriveId: `${NAME_PREFIX}-carriage-shared-drive`,
      folderId: `${NAME_PREFIX}-carriage-folder`,
      folderPath: '/HR/Fixtures/2846-carriage-full',
      revisionKind: 'head_revision',
    },
  });
  const artifactLegacy = await ensureConnectorArtifact(admin, {
    orgId,
    externalRef: `${NAME_PREFIX}-carriage-legacy`,
    driveFields: null, // all four `?? null` — the pre-SCRUM-4507 shape.
  });

  return {
    anchors: { drive, docusign, plain, unknown },
    connectorArtifact: { full: artifactFull, legacy: artifactLegacy },
  };
}

/** GET /api/v1/verify/:publicId and hand back both the parsed body and raw text (leak checks need the text). */
async function getVerify(workerFetch, publicId) {
  return workerFetch(`/api/v1/verify/${publicId}`);
}

const FORBIDDEN_SUBSTRING_LABELS = [
  ['file_id', FIXTURE_FILE_ID],
  ['underscore_drive_prefix', '_drive_'],
  ['drive_domain', 'drive.google.com'],
  ['account_label_email', FIXTURE_ACCOUNT_LABEL],
];

function pushLeakProbes(out, probe, label, text, orgId) {
  for (const [tag, needle] of FORBIDDEN_SUBSTRING_LABELS) {
    const leaked = text.includes(needle);
    out.push(probe(`2846_${label}_no_leak_${tag}`, false, leaked, {
      pass: !leaked,
      detail: leaked ? { needle, note: 'response body text contained a forbidden substring' } : null,
    }));
  }
  const orgLeaked = text.includes(orgId);
  out.push(probe(`2846_${label}_no_leak_org_id`, false, orgLeaked, {
    pass: !orgLeaked,
    detail: orgLeaked ? { note: 'response body text contained the raw org_id (§6 public projection)' } : null,
  }));
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch } = ctx;
  const s = state['#2846'] ?? {};
  const out = [];

  if (!s.anchors?.drive?.publicId || !s.anchors?.docusign?.publicId || !s.anchors?.plain?.publicId
    || !s.anchors?.unknown?.publicId || !s.connectorArtifact?.full || !s.connectorArtifact?.legacy) {
    out.push(probe('2846_fixtures_seeded', true, false, {
      pass: false,
      detail: { reason: 'no #2846 fixture state — run setup.mjs', have: Object.keys(s) },
    }));
    return out;
  }

  // ── (c) source.provider emitted for recognised markers ───────────────────
  const driveRes = await getVerify(workerFetch, s.anchors.drive.publicId);
  out.push(probe('2846_drive_verify_200', 200, driveRes.status, { detail: { error: driveRes.body?.error } }));
  out.push(probe('2846_drive_source_provider', { provider: 'google_drive' }, driveRes.body?.source, {
    pass: JSON.stringify(driveRes.body?.source ?? null) === JSON.stringify({ provider: 'google_drive' }),
    detail: { source: driveRes.body?.source ?? null },
  }));
  pushLeakProbes(out, probe, 'drive_verify', driveRes.text ?? '', state.orgA);

  const docusignRes = await getVerify(workerFetch, s.anchors.docusign.publicId);
  out.push(probe('2846_docusign_verify_200', 200, docusignRes.status, { detail: { error: docusignRes.body?.error } }));
  out.push(probe('2846_docusign_source_provider', { provider: 'docusign' }, docusignRes.body?.source, {
    pass: JSON.stringify(docusignRes.body?.source ?? null) === JSON.stringify({ provider: 'docusign' }),
    detail: { source: docusignRes.body?.source ?? null },
  }));

  // ── (d) source key OMITTED — absent, never null — for plain + unknown marker ──
  const plainRes = await getVerify(workerFetch, s.anchors.plain.publicId);
  out.push(probe('2846_plain_verify_200', 200, plainRes.status, { detail: { error: plainRes.body?.error } }));
  out.push(probe('2846_plain_source_omitted', false, Object.hasOwn(plainRes.body ?? {}, 'source'), {
    pass: plainRes.body != null && !Object.hasOwn(plainRes.body, 'source'),
    detail: { hasBody: plainRes.body != null },
  }));

  const unknownRes = await getVerify(workerFetch, s.anchors.unknown.publicId);
  out.push(probe('2846_unknown_marker_verify_200', 200, unknownRes.status, { detail: { error: unknownRes.body?.error } }));
  out.push(probe('2846_unknown_marker_source_omitted', false, Object.hasOwn(unknownRes.body ?? {}, 'source'), {
    pass: unknownRes.body != null && !Object.hasOwn(unknownRes.body, 'source'),
    detail: { note: "'google_drive_totally_real' is not in the closed marker set — must not key source", hasBody: unknownRes.body != null },
  }));

  // ── Cache probe — a publicId THIS run just created cannot be riding a
  // pre-deploy, source-less cache entry, so both reads must agree. ─────────
  const cacheRead2 = await getVerify(workerFetch, s.anchors.drive.publicId);
  out.push(probe('2846_drive_verify_cached_read_200', 200, cacheRead2.status));
  out.push(probe('2846_drive_verify_cache_still_carries_source', { provider: 'google_drive' }, cacheRead2.body?.source, {
    pass: JSON.stringify(cacheRead2.body?.source ?? null) === JSON.stringify({ provider: 'google_drive' }),
    detail: { note: 'verifyCache KEY_PREFIX (verify:v8:) is unchanged by this PR — correct for an additive field.', source: cacheRead2.body?.source ?? null },
  }));

  // ── (a)/(b) payload carriage at the producer's own RPC boundary ──────────
  // No Drive fetch anywhere below: enqueue_connector_artifact is called
  // directly by seed(), exactly like jobs/drive-file-changed.ts calls it
  // after its own (unexercisable-here) fetch+hash step.
  const { data: fullRow, error: fullErr } = await admin
    .from('connector_artifact')
    .select('metadata')
    .eq('id', s.connectorArtifact.full)
    .maybeSingle();
  out.push(probe('2846_carriage_full_row_readable', true, !fullErr && Boolean(fullRow), { detail: fullErr?.message ?? null }));
  const fullMeta = fullRow?.metadata ?? {};
  for (const key of ['_drive_shared_drive_id', '_drive_folder_id', '_drive_folder_path', '_drive_revision_kind']) {
    out.push(probe(`2846_carriage_full_${key}_present_non_null`, true, Object.hasOwn(fullMeta, key) && fullMeta[key] != null, {
      detail: { key, value: fullMeta[key] ?? null, present: Object.hasOwn(fullMeta, key) },
    }));
  }

  const { data: legacyRow, error: legacyErr } = await admin
    .from('connector_artifact')
    .select('metadata')
    .eq('id', s.connectorArtifact.legacy)
    .maybeSingle();
  out.push(probe('2846_carriage_legacy_row_readable', true, !legacyErr && Boolean(legacyRow), { detail: legacyErr?.message ?? null }));
  const legacyMeta = legacyRow?.metadata ?? {};
  for (const key of ['_drive_shared_drive_id', '_drive_folder_id', '_drive_folder_path', '_drive_revision_kind']) {
    // Present-AND-null, never missing: `?? null` in jobs/drive-file-changed.ts
    // is the whole point of claim (b) — a legacy payload must still parse and
    // must still produce a keyed-but-null field, not an absent one.
    out.push(probe(`2846_carriage_legacy_${key}_present_and_null`, true, Object.hasOwn(legacyMeta, key) && legacyMeta[key] === null, {
      detail: { key, value: legacyMeta[key], present: Object.hasOwn(legacyMeta, key) },
    }));
  }

  return out;
}
