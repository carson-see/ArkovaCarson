# UAT-17 native harness

`native-pg-verified-domain-member-add.sh` creates and drops a uniquely named database on an installed loopback PostgreSQL 17 server. It never targets hosted/shared Supabase. It applies migration 0470, races two exact-email member adds, verifies one membership/audit with idempotent replay, exercises null-role denial and verified-domain fail-closed behavior, and compares the native catalog RPC fields with both checked-in generated type surfaces.
