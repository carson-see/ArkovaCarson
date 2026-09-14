# UAT-12 native and hosted checks

`native-pg-credit-retry.sh` creates and drops only a uniquely named local database. It rejects remote PGHOST values. Run from the repository root against PostgreSQL 17; set UAT12_PG_BIN to the local PostgreSQL binary directory when needed.

The harness loads exact 0461/0463 migrations and the canonical 0341 debit helper into a reduced schema. It checks recovery, concurrent retry/job publication, debit conservation, exact child credit scope, denied identities and terminal states. Its final retry/claim test uses a timed overlap, not an instrumented lock barrier. It does not establish full-schema compatibility, API middleware behavior, or timed staging qualification.

The production-adapter tests and actual TLA interpreter/model checks complement this harness. Never use a reduced fixture to generate canonical database types or repair a hosted migration ledger.
