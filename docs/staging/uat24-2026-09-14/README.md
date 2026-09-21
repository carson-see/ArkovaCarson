# UAT-24 isolated database evidence

This directory is a reproducible **minimal-fixture** proof for migrations 0462
and the additive SCRUM-5252 read-parity repair in 0464.
It does not claim a full migration replay or a staging soak. The repository's
complete native replay is currently blocked on the Homebrew Postgres instance
because the baseline requires the Supabase `http` extension.

Run from any checkout:

```sh
docs/staging/uat24-2026-09-14/run-native-check.sh
```

The script creates a unique `arkova_uat24_...` database (override with a unique
prefixed `UAT24_DATABASE`), refuses to touch an existing database, and removes
only the database it created when the run ends. It
applies a small pre-0462 schema plus the actual canonical 0445 and 0365 migrations, seeds
the legacy mixed-context edge, applies the exact candidate 0462 file, executes
the dependency-ordered rollback, confirms the baseline row/assignment survived,
restores 0445/0365, reapplies the exact 0462 candidate, and applies 0464 before
the adverse assertions. Migration 0464 replaces only the service-role list RPC
and keeps its SQL signature unchanged. The checked-in types now carry the
verbatim scoped B4 generator output for the folder RPCs introduced by 0462;
the unrelated full B4 output is deliberately not copied.

## SCRUM-5252 corrected B4 parity probe (prepared, not executed)

Apply `scrum5252-hosted-fixture.sql` once through an authorized SQL channel;
that setup is not qualifying evidence. Then run the exact-host driver first
with `SCRUM5252_PHASE=diagnostic`. It checks the deployed worker SHA, stable
fixture shape, and live 0464 RPC behavior. Only after that succeeds, run one or
more `SCRUM5252_PHASE=qualifying` cycles:

```bash
STAGING_SUPABASE_URL=https://dlfcwhljvkomeouykcwk.supabase.co \
STAGING_SUPABASE_ANON_KEY=... \
STAGING_SUPABASE_SERVICE_ROLE_KEY=... \
STAGING_WORKER_URL=https://arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app \
B4_WORKER_ID_TOKEN=<exact-worker-audience-token> \
SCRUM5252_EXPECTED_WORKER_SHA=<deployed-candidate-sha> \
SCRUM5252_PHASE=diagnostic \
npx tsx scripts/staging/targeted/scrum5252-platform-folder-parity.ts
```

Each qualifying cycle uses real AAL2 JWTs through the deployed router and
production adapter. It emits a bounded result only after its API key and MFA
factors are removed and verified absent. The stable synthetic identities,
organizations, folders, and audit rows remain for repeated cycles. After the
authorized window, retire those identities through supported Auth soft-delete,
remove only their owned memberships, and mark their profiles deleted.

The bounded hosted full-schema feature probe is
`scripts/staging/targeted/uat24-folder-feature-driver.ts`. Run it only after
0462 is present on the reserved `vaarxclqdxnwoxziolmp` rig:

```bash
STAGING_SUPABASE_URL=https://vaarxclqdxnwoxziolmp.supabase.co \
STAGING_SUPABASE_SERVICE_ROLE_KEY=... \
UAT24_ACTOR_USER_ID=... UAT24_ORG_ID=... \
UAT24_UNFILED_ANCHOR_ID=... UAT24_CONNECTOR_CONNECTION_ID=... \
npx tsx scripts/staging/targeted/uat24-folder-feature-driver.ts
```

The supplied actor must be the exact org administrator and owner of the
supplied unfiled anchor. The connector id must be an active organization
connection in that org. The driver refuses every other Supabase host, restores
the anchor to unfiled, and deletes only folders created by its invocation.
It then opens two real Postgres sessions for concurrent
`A -> B` / `B -> A` moves and requires the second transaction to fail with
`folder hierarchy cycle` after waiting for the owner-scoped advisory lock.

The SQL assertions cover:

- AAL1 denial and AAL2 owner access;
- approved parent-admin contextual visibility and ordinary-member denial;
- platform-admin contextual-personal and organization reads through the service
  RPC, with global-personal, ordinary-member, platform-write, and API-key-bound denials;
- preservation of global personal folders and their existing org records;
- org-key denial for issuer-owned global and other-org folders/records;
- org-only key exact-org list/create/update/move and API-key creator audit;
- personal-principal access to global personal folders;
- mixed-org bulk moves suppressing a misleading single-tenant event;
- authenticated connector-binding squatting denial;
- revoked-connection denial and active-connection acceptance;
- connector-created canonical destinations despite a similar ordinary name;
- actual 0445 explicit and unique-conflict reuse, with existing folders preserved;
- DS-04 member ownership, member-context placement, and ordinary-peer denial;
- historical cross-owner envelope reuse without cross-user filing;
- revoked connection replacement refreshing the reused destination.
