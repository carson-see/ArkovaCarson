# UAT-12 native and hosted checks

`native-pg-credit-retry.sh` creates and drops only a uniquely named local database. It rejects remote PGHOST values. Run from the repository root against PostgreSQL 17; set UAT12_PG_BIN to the local PostgreSQL binary directory when needed.

The harness loads exact 0461/0463 migrations and the canonical 0341 debit helper into a reduced schema. It checks recovery, concurrent retry/job publication, debit conservation, exact child credit scope, denied identities and terminal states. Its final retry/claim test uses a timed overlap, not an instrumented lock barrier. It does not establish full-schema compatibility, API middleware behavior, or timed staging qualification.

The production-adapter tests and actual TLA interpreter/model checks complement this harness. Never use a reduced fixture to generate canonical database types or repair a hosted migration ledger.

`native-pg-credit-conservation.sh` applies the exact 0349, 0461 and 0473 SQL to
a uniquely named local database. It proves the original organization purchase
divergence, exact append-only correction, replay, personal-path preservation,
malformed-row exclusion, NULL fail-closed guards, migration rerun, and a grant
serialized behind the repair locks. It never connects to a remote host.

`native-pg-anchor-quota.sh` applies the exact 0461 and 0474 canonical-create
functions to a uniquely named local database. Two native connections race for
the final FREE-tier daily slot; exactly one creates an anchor/intent/job and the
denied transaction leaves no rows. Same-scope replay and the preserved global
same-user fingerprint conflict consume no quota, while personal scope creates
without inventing an organization counter. It never connects to a remote host.
