// scripts/staging/wave3-drive-eligibility-probe.ts
//
// Wave 3 soak-driver probe for #2230/#2236's Drive connect deny-reason fix
// (services/worker/src/integrations/connectors/drive-connect-eligibility.ts).
// Imports the REAL, shipped `resolveDriveConnectEligibility` (no
// reimplementation) and runs it against real seeded rows on the
// arkova-wave3-2026-08 rig, via the worker's own `db` singleton (so this
// must run with the full worker env, same as the deployed service).
//
// This exists because the HTTP route (POST /api/v1/integrations/google_drive/
// oauth/start) requires a Supabase user JWT in `Authorization`, which collides
// with Cloud Run's own IAM identity-token check on the SAME header on an
// IAM-protected (--no-allow-unauthenticated) rig — a known, pre-existing
// limitation documented in docs/reference/STAGING_RIG.md ("JWT-protected
// client paths aren't load-tested by the soak harness"). This script proves
// the underlying eligibility LOGIC against real rig data instead.

import { resolveDriveConnectEligibility } from '../../services/worker/src/integrations/connectors/drive-connect-eligibility.js';
import { db } from '../../services/worker/src/utils/db.js';

const SEED_FIXTURE_ORG = '5eed0000-0000-0000-0000-0000000000b1'; // Seed Fixture Org (VERIFIED? no — UNVERIFIED)
const SEED_FIXTURE_ADMIN = '5eed0000-0000-0000-0000-0000000000a1'; // ORG_ADMIN of the org above
const MEMBER_FIXTURE_USER = '5eed0003-0000-0000-0000-0000000000a4'; // ORG_MEMBER of the same org, no admin row

async function getOrganization(orgId: string) {
  const { data, error } = await db
    .from('organizations')
    .select('verification_status, suspended')
    .eq('id', orgId)
    .single();
  return { row: data as { verification_status?: string; suspended?: boolean | null } | null, error: !!error };
}

async function getProfileEntitlement(_userId: string) {
  return { row: null, error: false };
}

async function main() {
  console.log('=== not_admin: ORG_MEMBER calling org path on their own org ===');
  const notAdmin = await resolveDriveConnectEligibility({
    userId: MEMBER_FIXTURE_USER,
    orgId: SEED_FIXTURE_ORG,
    db: { getOrganization, getProfileEntitlement },
  });
  console.log(JSON.stringify(notAdmin));

  console.log('=== org_scope_required: ORG_ADMIN calling the personal path (no org_id) ===');
  const orgScopeRequired = await resolveDriveConnectEligibility({
    userId: SEED_FIXTURE_ADMIN,
    orgId: null,
    db: { getOrganization, getProfileEntitlement },
  });
  console.log(JSON.stringify(orgScopeRequired));

  console.log('=== control: ORG_ADMIN calling org path on their own (UNVERIFIED) org ===');
  const orgUnverified = await resolveDriveConnectEligibility({
    userId: SEED_FIXTURE_ADMIN,
    orgId: SEED_FIXTURE_ORG,
    db: { getOrganization, getProfileEntitlement },
  });
  console.log(JSON.stringify(orgUnverified));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
