# PR #841 Migration Ledger Remediation

## Why this exists

PR #841 merged on 2026-05-21 with `0313_legally_binding_attestations.sql`
and `0314_professional_education_foundations.sql`, but production already
used migration version `0313` for SCRUM-1286 anchors index consolidation.

That made the ledgers disagree:

- Production: `0313 / anchors_index_consolidation`
- Main before this remediation: `0313_legally_binding_attestations.sql`
- Staging before cleanup: `0313 / legally_binding_attestations`,
  `0314 / professional_education_foundations`

The remediation order is:

1. Keep `0313_anchors_index_consolidation.sql` as the repo migration matching
   production reality.
2. Move PR #841 schema work to `0314_legally_binding_attestations.sql` and
   `0315_professional_education_foundations.sql`.
3. Treat the old #841 staging soak as diagnostic only.
4. Re-run staging from this cleaned migration order before any prod
   reconciliation.

## Operator steps

Do not use this runbook from CI. It is for a human/operator window.

1. Verify production still has `0313 / anchors_index_consolidation`.
2. Verify production does not already have the #841 tables/columns:
   `legally_binding_attestations`, `cpe_provider_registry`,
   `cle_provider_registry`, `anchors.cpe_metadata`, `anchors.cle_metadata`,
   and `credential_type = CPE`.
3. Apply the renumbered #841 schema migrations only after the remediation PR
   has fresh staging evidence:
   `0314_legally_binding_attestations.sql`, then
   `0315_professional_education_foundations.sql`.
4. Confirm production ledger rows record `0314 / legally_binding_attestations`
   and `0315 / professional_education_foundations`.
5. Remove the temporary 0314/0315 migration-drift exemptions in a follow-up
   PR after production reconciliation is verified.

## Staging cleanup

The previous staging state is not reusable evidence because staging already
recorded #841 as `0313 / legally_binding_attestations` and
`0314 / professional_education_foundations`.

Before new soak evidence, restore staging by one of these explicitly approved
paths, then verify the migration ledger matches the cleaned order:

- **Isolated rebuild:** create an operator-approved isolated Supabase project,
  replay this branch's migrations from an empty database, and wire the matching
  isolated worker service to that project.
- **Shared-staging rebuild:** only after explicit approval naming
  `ujtlwnoqfhtitcmsnrpq` and the active PR evidence being invalidated, wipe and
  reinitialize shared staging using `docs/reference/STAGING_RIG.md`.
- **Targeted operator repair:** only after written operator approval for the
  exact ledger rows and objects being repaired. Do not run `migration repair`,
  insert/delete ledger rows, or apply rollback SQL as an agent shortcut.

Required cleaned ledger order:

- `0313 / anchors_index_consolidation`
- `0314 / legally_binding_attestations`
- `0315 / professional_education_foundations`

Ledger parity is not enough by itself. Because
`0313_anchors_index_consolidation.sql` is a ledger marker with manual
`DROP INDEX CONCURRENTLY` instructions, a reset database can record the
correct `0313` row while still retaining indexes that production already
dropped. Before claiming merge-grade staging evidence, capture one of these
explicit states:

- **Index-parity evidence:** run the 0313 concurrent index drops manually
  against the staging project, then verify the drop-target indexes are absent
  before applying or repairing the `0314` and `0315` rows.

  ```sql
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'idx_anchors_status',
      'idx_anchors_user_created',
      'idx_anchors_credential_type_btree',
      'idx_anchors_sub_type',
      'idx_anchors_pipeline_source_id'
    );
  ```

  Expected result for index-parity evidence: zero rows.
- **Schema-order-only evidence:** state clearly in the PR evidence that the
  soak validates only the #841 schema order and does not validate SCRUM-1286
  anchor-index parity. Do not use this narrower evidence to unblock PR #838's
  index behavior.

Then run the required T2/T3 staging soak from the cleaned and accurately scoped
state.

## #838 follow-up

After this remediation lands, PR #838 should rebase onto main, drop its
duplicate `0313_anchors_index_consolidation.sql` file, and keep only the
SCRUM-1976 API/search changes plus the anchor-index justification guard.
