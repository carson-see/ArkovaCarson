// PR #2912 — Connectors page: Google Drive folder picker worker endpoint +
// PATCH /api/rules/:id action_type pairing (SCRUM-5121, branch
// feat/connectors-page, head c77cf25ea).
//
// SCOPE OF THIS MODULE. The PR is mostly frontend (a new ConnectorsPage +
// components) — nothing this rig can render or click. The two REAL worker
// behavior changes are: (1) a brand-new endpoint, `GET
// /api/v1/integrations/google_drive/folders` (drive-folders.ts), and (2) an
// additive `action_type` field on `PATCH /api/rules/:id` with a paired-field
// validation rule (D4, rules-crud.ts). This module proves both against the
// real deployed worker — session-JWT auth (`signInMfa`, per CLAUDE.md
// mandatory MFA), never an API key (the endpoint has no API-key path at
// all — asserted below).
//
// WHAT THIS RIG CAN AND CANNOT PROVE for the Drive folder picker. This rig
// has no real Google OAuth credential (SCRUM-5082 — the same gap #2903's and
// #2846's modules document), so the actual Google Drive `files.list` call
// can never succeed here. What IS fully provable, deterministically, every
// cycle, WITHOUT calling Google at all:
//   - org-admin gating (403 for a member)
//   - the "not connected" 404 for an org with no google_drive row
//   - D3's fail-closed `insufficient_drive_scope` 409 for a connection whose
//     stored scope lacks a folder-listing scope (checked BEFORE any token
//     load or Drive call — drive-folders.ts's own comment: "Checked BEFORE
//     any Drive call")
//   - that widening the stored scope to a real listing scope (`drive`,
//     `drive.readonly`, `drive.metadata.readonly`) moves the failure one
//     step deeper, to `reconnect_required` 409 (loadDriveAccessToken's
//     `no_encrypted_tokens` DriveRunnerError on a token-less row) — proving
//     the scope gate is a real, ordered check and not a single collapsed
//     "any problem -> some 409" branch.
// NOT provable here: a real `200 {folders: [...]}` response — that needs a
// live Google grant this rig does not have. If a future rig gains one, this
// module's negative-path assertions remain valid; a positive-path assertion
// would need a new module or an extension here.
//
// DISCOVERED DURING MANUAL VERIFICATION (2026-09-13, against
// train-7---arkova-worker-cto-train-b-0912-staging): `ENABLE_DRIVE_OAUTH` is
// currently OFF on this rig. It is a real, pre-existing security kill switch
// (`middleware/integrationKillSwitch.ts`: "C1-C4: webhook URL mismatch,
// falls-open auth, dead disconnect") mounted ahead of EVERY Drive route,
// including this PR's new one, so every call to the folder-picker endpoint
// currently 503s `integration_disabled` before auth, schema validation, or
// scope logic ever runs — this is an environment precondition, not a defect
// in this PR's drive-folders.ts. The module below probes the kill-switch
// state first, every cycle, and only asserts the org-admin/not_connected/
// insufficient_drive_scope/reconnect_required branches when it observes the
// flag on; while it is off it records that fact once instead of red-ing on a
// condition the PR does not control. RESIDUAL RISK: as long as
// ENABLE_DRIVE_OAUTH stays off, the Drive folder-picker's own authz/scope
// logic (D3, the org-admin gate) is UNVERIFIED by this soak — only D4 (the
// PATCH /api/rules/:id action_type pairing) is exercised. The PR body should
// carry this as an explicit residual-risk note rather than implying full
// worker-side coverage.
//
// D4 (PATCH /api/rules/:id action_type) needs no external service at all —
// fully provable every cycle: the paired-field validation (`action_type`
// without `action_config` -> 400 `invalid_config`) and a successful paired
// PATCH landing in the DB (read back via service-role, not trusted from the
// `{ok:true}` response alone).

import { signInMfa } from '../common.mjs';

export const pr = '#2912';

export const changedBehavior = [
  'GET /api/v1/integrations/google_drive/folders (new endpoint): session-JWT',
  'only (no API-key path), org-admin gated, fails CLOSED on an insufficient',
  "stored OAuth scope (409 insufficient_drive_scope) rather than ever",
  'returning {folders: []} for a denial (D3). ENABLE_DRIVE_OAUTH is OFF on',
  'this rig (a pre-existing security kill switch, not a PR defect) — the',
  'module records that fact every cycle and, only while the flag is off,',
  'skips the branches below rather than red-ing on an environment condition',
  'the PR does not control. When the flag is observed on: a member gets 403;',
  'an org with no Drive connection gets 404 not_connected; a',
  'connection with only drive.file scope gets 409 insufficient_drive_scope',
  'BEFORE any token load or Drive API call; widening the stored scope to a',
  'real listing scope moves the failure to 409 reconnect_required (a token-',
  'less row), proving the scope check and the token-load check are two',
  'distinct, correctly-ordered gates, not one collapsed catch-all. PATCH',
  '/api/rules/:id gained an optional action_type, REQUIRED to be paired with',
  'action_config in the same request (D4) — action_type alone 400s',
  'invalid_config; paired, the write lands and is verified via a service-',
  "role DB read-back, not the {ok:true} response alone.",
].join(' ');

const NAME_PREFIX = 'cto-train-b5b-2912';
const INSUFFICIENT_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SUFFICIENT_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const CONNECTOR_TAG = 'connector-google_drive';
const RULE_NAME = `${NAME_PREFIX}-rule`;

async function ensureDriveIntegration(admin, orgId, accountId) {
  const { data: existing, error: findErr } = await admin
    .from('org_integrations')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', 'google_drive')
    .eq('account_id', accountId)
    .maybeSingle();
  if (findErr) throw new Error(`#2912 integration lookup: ${findErr.message}`);
  const row = {
    org_id: orgId,
    provider: 'google_drive',
    account_id: accountId,
    scope: INSUFFICIENT_SCOPE,
    encrypted_tokens: null,
    token_kms_key_id: null,
    revoked_at: null,
  };
  if (existing) {
    const { error } = await admin.from('org_integrations').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2912 integration re-arm: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await admin.from('org_integrations').insert(row).select('id').single();
  if (error) throw new Error(`#2912 integration insert: ${error.message}`);
  return data.id;
}

async function ensureRule(admin, orgId, createdBy) {
  const { data: existing, error: findErr } = await admin
    .from('organization_rules')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', RULE_NAME)
    .maybeSingle();
  if (findErr) throw new Error(`#2912 rule lookup: ${findErr.message}`);
  const row = {
    org_id: orgId,
    name: RULE_NAME,
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    trigger_config: {},
    action_type: 'AUTO_ANCHOR',
    action_config: { tag: CONNECTOR_TAG },
    enabled: false,
    created_by_user_id: createdBy ?? null,
  };
  if (existing) {
    // Re-arm to AUTO_ANCHOR at the top of every cycle so the PATCH assertions
    // below are exercised fresh each time, not inherited from a prior pass
    // left in INSTANT_SECURE.
    const { error } = await admin.from('organization_rules').update(row).eq('id', existing.id);
    if (error) throw new Error(`#2912 rule re-arm: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await admin.from('organization_rules').insert(row).select('id').single();
  if (error) throw new Error(`#2912 rule insert: ${error.message}`);
  return data.id;
}

export async function seed(admin, state) {
  const orgA = state.orgA;
  const adminAUserId = state.adminA?.userId;
  if (!orgA || !adminAUserId) throw new Error('#2912 seed: state.orgA/adminA missing — run setup.mjs base fixtures first');
  const integrationId = await ensureDriveIntegration(admin, orgA, `${NAME_PREFIX}-orgA`);
  const ruleId = await ensureRule(admin, orgA, adminAUserId);
  return { integrationId, ruleId };
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch } = ctx;
  const s = state['#2912'] ?? {};
  const out = [];

  if (!s.integrationId || !s.ruleId) {
    out.push(probe('2912_fixtures_seeded', true, false, { pass: false, detail: { reason: 'no #2912 fixture state — run setup.mjs', have: Object.keys(s) } }));
    return out;
  }
  out.push(probe('2912_fixtures_seeded', true, true, { detail: s }));

  // ── Re-arm every cycle (2903-style): scope back to insufficient, rule
  // back to AUTO_ANCHOR — so every assertion below is proven fresh, not
  // inherited from whatever state the previous cycle left behind. ────────
  const { error: rearmScopeErr } = await admin.from('org_integrations').update({ scope: INSUFFICIENT_SCOPE, encrypted_tokens: null, token_kms_key_id: null }).eq('id', s.integrationId);
  out.push(probe('2912_integration_rearmed', true, !rearmScopeErr, { detail: rearmScopeErr?.message ?? null }));
  const { error: rearmRuleErr } = await admin.from('organization_rules').update({ action_type: 'AUTO_ANCHOR', action_config: { tag: CONNECTOR_TAG } }).eq('id', s.ruleId);
  out.push(probe('2912_rule_rearmed', true, !rearmRuleErr, { detail: rearmRuleErr?.message ?? null }));

  const adminSigned = await signInMfa(ctx, 'adminA');
  out.push(probe('2912_admin_signin', true, Boolean(adminSigned.token), { detail: { status: adminSigned.status, error: adminSigned.error } }));
  const memberSigned = await signInMfa(ctx, 'memberA');
  out.push(probe('2912_member_signin', true, Boolean(memberSigned.token), { detail: { status: memberSigned.status, error: memberSigned.error } }));
  const adminBSigned = state.adminB ? await signInMfa(ctx, 'adminB') : null;
  out.push(probe('2912_adminB_signin', true, Boolean(adminBSigned?.token), { detail: { status: adminBSigned?.status, error: adminBSigned?.error } }));

  const adminJwt = adminSigned.token;
  const memberJwt = memberSigned.token;
  const adminBJwt = adminBSigned?.token;
  if (!adminJwt || !memberJwt || !adminBJwt) return out;

  // ═══════════════════ Drive folder picker endpoint ═══════════════════
  const FOLDERS_PATH = '/api/v1/integrations/google_drive/folders';

  // ENABLE_DRIVE_OAUTH is a real, documented security kill switch
  // (integrationKillSwitch.ts: "C1-C4: webhook URL mismatch, falls-open
  // auth, dead disconnect") mounted BEFORE this router and every other
  // Drive route in index.ts — it is checked ahead of auth, schema
  // validation, and everything else, so when it is off EVERY call below
  // gets the SAME 503 `integration_disabled` regardless of what we send.
  // Probe it FIRST and once: if it is off, that is a real environmental
  // fact (observed here, every cycle — not asserted as PR-correctness),
  // and asserting the individual 401/400/403/404/409 branches beneath it
  // would either red every cycle for a condition the PR does not control,
  // or (worse) silently degrade into 20 copies of the same one bit of
  // information. Record the fact once and skip the gated assertions this
  // cycle; if a future cycle observes the flag flip on, this module starts
  // asserting the real branches automatically (branches on the OBSERVED
  // response, not a hard-coded assumption — same pattern #2903 uses for its
  // credential-less-rig branch).
  const probeReq = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}`, { jwt: adminJwt });
  const killSwitchClosed = probeReq.status === 503 && probeReq.body?.error === 'integration_disabled' && probeReq.body?.flag === 'ENABLE_DRIVE_OAUTH';

  out.push(probe('2912_drive_folders_kill_switch_state_observed', true, true, {
    detail: {
      note: killSwitchClosed
        ? 'ENABLE_DRIVE_OAUTH is OFF on this rig (integrationKillSwitch.ts, a real security kill switch — not a PR defect). Every request to GET /api/v1/integrations/google_drive/folders 503s before auth/schema/scope logic runs, so the org-admin gate, not_connected 404, insufficient_drive_scope 409, and reconnect_required 409 branches below are UNVERIFIED in this environment this cycle — recorded as a residual-risk gap, not faked as passing.'
        : 'ENABLE_DRIVE_OAUTH is ON — asserting the real gated branches below.',
      killSwitchClosed, sampleResponse: probeReq.body,
    },
  }));

  if (killSwitchClosed) {
    out.push(probe('2912_drive_folders_endpoint_gated_off_this_cycle', 'integration_disabled', probeReq.body?.error, { detail: probeReq.body }));
  } else {
    const noAuth = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}`);
    out.push(probe('2912_folders_no_jwt_401', 401, noAuth.status, { detail: noAuth.body }));

    // No API-key path at all — an Arkova API key must fail exactly like no auth.
    if (state.apiKey?.raw) {
      const apiKeyAttempt = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}`, { apiKeyRaw: state.apiKey.raw });
      out.push(probe('2912_folders_api_key_rejected', true, apiKeyAttempt.status === 401 || apiKeyAttempt.status === 403, {
        detail: { status: apiKeyAttempt.status, body: apiKeyAttempt.body },
      }));
    }

    const missingOrgId = await workerFetch(FOLDERS_PATH, { jwt: adminJwt });
    out.push(probe('2912_folders_missing_org_id_400', 400, missingOrgId.status, { detail: missingOrgId.body }));

    const sharedDriveRejected = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}&drive=some-shared-drive-id`, { jwt: adminJwt });
    out.push(probe('2912_folders_shared_drive_param_400', 400, sharedDriveRejected.status, { detail: sharedDriveRejected.body }));

    const nonAdmin = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}`, { jwt: memberJwt });
    out.push(probe('2912_folders_member_403', 403, nonAdmin.status, { detail: nonAdmin.body }));
    out.push(probe('2912_folders_member_403_code', 'forbidden', nonAdmin.body?.error?.code, { detail: nonAdmin.body }));

    const notConnected = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgB}`, { jwt: adminBJwt });
    out.push(probe('2912_folders_not_connected_404', 404, notConnected.status, { detail: notConnected.body }));
    out.push(probe('2912_folders_not_connected_code', 'not_connected', notConnected.body?.error?.code, { detail: notConnected.body }));

    const insufficientScope = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}`, { jwt: adminJwt });
    out.push(probe('2912_folders_insufficient_scope_409', 409, insufficientScope.status, { detail: insufficientScope.body }));
    out.push(probe('2912_folders_insufficient_scope_code', 'insufficient_drive_scope', insufficientScope.body?.error?.code, { detail: insufficientScope.body }));

    // Widen the scope but leave tokens null: the scope gate must now PASS and
    // the failure must move one step deeper (token load), not disappear.
    const { error: widenErr } = await admin.from('org_integrations').update({ scope: SUFFICIENT_SCOPE }).eq('id', s.integrationId);
    out.push(probe('2912_scope_widened', true, !widenErr, { detail: widenErr?.message ?? null }));
    const reconnectRequired = await workerFetch(`${FOLDERS_PATH}?org_id=${state.orgA}`, { jwt: adminJwt });
    out.push(probe('2912_folders_reconnect_required_409', 409, reconnectRequired.status, { detail: reconnectRequired.body }));
    out.push(probe('2912_folders_reconnect_required_code', 'reconnect_required', reconnectRequired.body?.error?.code, { detail: reconnectRequired.body }));
    out.push(probe('2912_folders_never_empty_array_on_denial', false, Array.isArray(reconnectRequired.body?.folders) && reconnectRequired.body.folders.length === 0, {
      detail: 'D3: a denial must never look like {folders: []} — every denial branch above must carry error.code, not an empty folders array.',
    }));
  }

  // ═══════════════════ PATCH /api/rules/:id action_type (D4) ═══════════════════
  const RULES_PATH = `/api/rules/${s.ruleId}`;

  const unpaired = await workerFetch(RULES_PATH, { method: 'PATCH', jwt: adminJwt, body: { action_type: 'INSTANT_SECURE' } });
  out.push(probe('2912_patch_unpaired_action_type_400', 400, unpaired.status, { detail: unpaired.body }));
  out.push(probe('2912_patch_unpaired_action_type_code', 'invalid_config', unpaired.body?.error?.code, { detail: unpaired.body }));

  const { data: beforePatch } = await admin.from('organization_rules').select('action_type').eq('id', s.ruleId).maybeSingle();
  out.push(probe('2912_rule_unchanged_after_rejected_patch', 'AUTO_ANCHOR', beforePatch?.action_type, { detail: beforePatch }));

  const paired = await workerFetch(RULES_PATH, {
    method: 'PATCH', jwt: adminJwt, body: { action_type: 'INSTANT_SECURE', action_config: { tag: CONNECTOR_TAG } },
  });
  out.push(probe('2912_patch_paired_action_type_200', 200, paired.status, { detail: paired.body }));

  const { data: afterPatch, error: afterErr } = await admin.from('organization_rules').select('action_type, action_config').eq('id', s.ruleId).maybeSingle();
  out.push(probe('2912_rule_read_back_ok', true, !afterErr && Boolean(afterPatch), { detail: afterErr?.message ?? null }));
  out.push(probe('2912_rule_action_type_updated_in_db', 'INSTANT_SECURE', afterPatch?.action_type, {
    detail: 'D4: buildRuleUpdate() must include action_type in the allowlist — verified via a service-role read-back, not the {ok:true} response alone.',
  }));
  out.push(probe('2912_rule_action_config_paired_correctly', CONNECTOR_TAG, afterPatch?.action_config?.tag, { detail: afterPatch?.action_config }));

  return out;
}
