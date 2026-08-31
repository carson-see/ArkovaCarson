/**
 * DocuSign metadata write-authority GUARD PROBE — CTO Decision Record R9
 * (docusign-bilateral-2026-08), targeting PR #2472 ("DocuSign metadata key
 * write-authority guard trigger [T3]", migration ~0423, OPEN/unmerged at the
 * time this probe was written — verify with `gh pr view 2472` before relying
 * on exact trigger/migration numbering).
 *
 * This is a standalone Node script, NOT part of the k6 HTTP load harness —
 * it is a direct PostgREST/Supabase-client probe, not a webhook POST, per the
 * task brief ("a direct (non-service_role) attempt to write anchors.metadata
 * ... put it in a separate probe script if the harness is webhook-only").
 *
 * THREAT MODEL: `anchors.metadata` legitimately carries underscore-prefixed,
 * server-authored provenance markers (`connector_source`, `_signers`,
 * `_direction`, `_sending_account_id`, ...) written ONLY by the connector-
 * artifact drain (service_role). If a non-service_role actor — a regular
 * authenticated user editing their own anchor's metadata via the normal API,
 * or a compromised API key — could forge those SAME keys directly, they could
 * fabricate a fake DocuSign provenance record (fake signer GUIDs, a fake
 * "this came from DocuSign account X" claim) on an anchor that never actually
 * went through the DocuSign pipeline at all. Migration 0423 (per PR #2472) is
 * expected to add a guard that strips/rejects those keys on any non-
 * service_role write.
 *
 * This probe:
 *   1. Authenticates as a REGULAR user (never service_role — asserted below,
 *      never even accepts a service-role-shaped env var).
 *   2. Attempts to UPDATE one of that user's own anchors' `metadata` with a
 *      forged `connector_source: 'docusign'` + `account_id` (a SENTINEL
 *      value, see GUARD_PROBE_SENTINEL below) + `_signers` array.
 *   3. Reads back the persisted row (fresh SELECT, not the UPDATE response —
 *      some clients echo the request payload rather than the stored row) and
 *      asserts the forged keys are ABSENT. An outright-rejected UPDATE
 *      (RLS/trigger raises) is ALSO a pass — even stronger enforcement than
 *      silent stripping.
 *
 * The sentinel value is deliberately distinctive so the companion evidence
 * script (docusign-bilateral-evidence.sql, "guard-strip success" query) can
 * independently confirm it never landed anywhere in `anchors.metadata` across
 * the WHOLE table, not just the one row this probe touched — defense in
 * depth against a guard that strips on this exact shape but not a related one.
 *
 * Required envs:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, DOCUSIGN_GUARD_PROBE_USER_EMAIL,
 *   DOCUSIGN_GUARD_PROBE_USER_PASSWORD, DOCUSIGN_GUARD_PROBE_ANCHOR_ID (an
 *   anchor id already owned by that user's org on the rig — this probe never
 *   creates one itself; use a rig-seeded fixture anchor so a real
 *   DocuSign-sourced anchor is never mutated by this probe).
 *
 * Usage: node scripts/load-test/docusign-guard-probe.js
 */
import { createClient } from '@supabase/supabase-js';

export const GUARD_PROBE_SENTINEL = 'GUARD-PROBE-FORGED-ACCOUNT-DO-NOT-PERSIST';
const FORGED_SIGNER_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`docusign-guard-probe.js requires ${name}`);
  }
  return value;
}

/**
 * Attempt the forged write and report what actually persisted. Pure of any
 * process/env concerns so it is independently exercisable (see the harness
 * test file's structural assertions on this function).
 * @param {import('@supabase/supabase-js').SupabaseClient} authedClient
 *   A client authenticated as a REGULAR user — never service_role.
 * @param {string} anchorId
 * @returns {Promise<{ updateError: unknown, persistedMetadata: Record<string, unknown> | null }>}
 */
export async function attemptForgedMetadataWrite(authedClient, anchorId) {
  const { error: updateError } = await authedClient
    .from('anchors')
    .update({
      metadata: {
        // A legitimate-looking, user-ownable field, so this write would
        // otherwise be an unremarkable metadata edit if not for the forged
        // keys below.
        note: 'guard probe run',
        connector_source: 'docusign',
        account_id: GUARD_PROBE_SENTINEL,
        _signers: [{ recipient_id_guid: FORGED_SIGNER_GUID, status: 'completed' }],
      },
    })
    .eq('id', anchorId);

  // Fresh SELECT — never trust an UPDATE response's echoed payload as proof
  // of what was actually stored.
  const { data, error: selectError } = await authedClient
    .from('anchors')
    .select('metadata')
    .eq('id', anchorId)
    .maybeSingle();

  if (selectError) {
    throw new Error(`docusign-guard-probe.js: read-back failed: ${selectError.message}`);
  }

  return {
    updateError,
    persistedMetadata: (data && data.metadata) || null,
  };
}

/**
 * @param {Record<string, unknown> | null} metadata
 * @returns {{ pass: boolean, findings: string[] }}
 */
export function assessGuardResult({ updateError, persistedMetadata }) {
  const findings = [];

  if (updateError) {
    findings.push(`UPDATE itself was rejected (${updateError.message ?? updateError}) — strongest possible enforcement.`);
    return { pass: true, findings };
  }

  if (!persistedMetadata) {
    findings.push('No row read back after the write — cannot assess (treat as inconclusive, not a pass).');
    return { pass: false, findings };
  }

  const forgedAccountIdLeaked = persistedMetadata.account_id === GUARD_PROBE_SENTINEL;
  const connectorSourceLeaked = persistedMetadata.connector_source === 'docusign';
  const signersLeaked = Array.isArray(persistedMetadata._signers) && persistedMetadata._signers.length > 0;

  if (forgedAccountIdLeaked) findings.push('FAIL: forged account_id sentinel PERSISTED into anchors.metadata.');
  if (connectorSourceLeaked) findings.push('FAIL: forged connector_source="docusign" PERSISTED into anchors.metadata.');
  if (signersLeaked) findings.push('FAIL: forged _signers array PERSISTED into anchors.metadata.');

  if (!forgedAccountIdLeaked && !connectorSourceLeaked && !signersLeaked) {
    findings.push('PASS: all three forged keys were stripped; benign fields (if any) were preserved.');
    return { pass: true, findings };
  }
  return { pass: false, findings };
}

async function main() {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const email = requireEnv('DOCUSIGN_GUARD_PROBE_USER_EMAIL');
  const password = requireEnv('DOCUSIGN_GUARD_PROBE_USER_PASSWORD');
  const anchorId = requireEnv('DOCUSIGN_GUARD_PROBE_ANCHOR_ID');

  // Deliberately the ANON key + a real sign-in — never a service-role key.
  // There is no code path in this file that reads a service-role-shaped env
  // var at all, so a misconfigured environment cannot silently downgrade this
  // probe into a meaningless service_role write.
  const client = createClient(supabaseUrl, anonKey);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`docusign-guard-probe.js: sign-in failed: ${signInError.message}`);
  }

  const result = await attemptForgedMetadataWrite(client, anchorId);
  const assessment = assessGuardResult(result);

  for (const line of assessment.findings) {
    // eslint-disable-next-line no-console -- standalone CLI probe, this IS its report
    console.log(line);
  }
  // eslint-disable-next-line no-console -- standalone CLI probe, this IS its report
  console.log(assessment.pass ? 'GUARD PROBE: PASS' : 'GUARD PROBE: FAIL');

  await client.auth.signOut();
  process.exitCode = assessment.pass ? 0 : 1;
}

// Only run when invoked directly (`node docusign-guard-probe.js`), not when
// imported for its exported helpers (e.g. from a future test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console -- standalone CLI probe, this IS its report
    console.error(err);
    process.exitCode = 1;
  });
}
