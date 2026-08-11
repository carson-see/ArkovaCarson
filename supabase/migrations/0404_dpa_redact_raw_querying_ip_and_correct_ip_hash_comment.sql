-- 0404 — DPA data-protection remediation: raw caller IPs in `audit_events`,
-- and a column COMMENT that documents a security control which has never
-- existed.
--
-- CONTEXT. Arkova's DPA Schedules 1 and 2 both warrant that IP addresses are
-- processed in HASHED form. Two `audit_events` writers contradicted that by
-- serialising `req.ip` verbatim into `details.querying_ip`:
--   - services/worker/src/api/v1/verify.ts           (VERIFICATION_QUERIED)
--   - services/worker/src/api/v1/credentials-ctdl.ts (ctdl.requested)
-- Both writers are fixed in the same PR as this migration: they now emit
-- `querying_ip_hash`, a keyed HMAC-SHA256 (services/worker/src/lib/ip-hash.ts).
-- This migration handles the rows already written under the old behaviour, and
-- the separate documentation defect on `verification_events.ip_hash`.
--
-- ============================================================================
-- PART 1 — redact `querying_ip` from historical `audit_events` rows
-- ============================================================================
--
-- WHY REDACT AND NOT RE-HASH. Re-hashing would require the HMAC pepper inside
-- this file, which would commit a production secret to git and to the
-- migration ledger. That trade is never worth it, and the historical rows have
-- no live investigative use. The raw value is therefore removed, not converted.
--
-- WHY A MARKER KEY. The redaction leaves `querying_ip_redacted: true` behind.
-- Silently deleting the key would make a row that DID carry an IP
-- indistinguishable from one that never did — the same "documented control
-- that isn't real" problem Part 2 fixes, in miniature. CLAUDE.md §1.5: state
-- what is asserted and what is not.
--
-- WHY THIS TOUCHES TWO TABLE-LEVEL CONTROLS, AND WHY THE SUSPENSION WRAPS THE
-- *READ* AS WELL AS THE WRITE. `audit_events` is append-only by design (SOC-2
-- CC7.2): `reject_audit_update` BEFORE UPDATE raises. Separately it carries
-- `FORCE ROW LEVEL SECURITY`, which subjects even the table OWNER to the RLS
-- policies — and every policy on this table is `TO authenticated, anon`, so a
-- role that is merely the owner matches no policy at all.
--
-- Verified empirically on an isolated Postgres 17 cluster with a non-superuser
-- owner (NOBYPASSRLS), replicating this exact table/policy/trigger set:
--
--     superuser                        SELECT count(*) -> 5
--     owner, FORCE RLS on              SELECT count(*) -> 0     <-- blind
--     owner, after NO FORCE RLS        SELECT count(*) -> 5
--     owner, FORCE RLS restored        SELECT count(*) -> 0
--
-- So FORCE RLS hides the rows from the migration's own SELECT, not just from
-- its UPDATE. An earlier draft of this file built its candidate set before
-- suspending RLS; it would have found zero candidates and reported "nothing to
-- redact" — a silent no-op that looks exactly like success, on any deployment
-- whose migration role lacks BYPASSRLS. The suspension therefore opens BEFORE
-- the scan and closes after the write, and the migration never assumes the
-- role it runs as has BYPASSRLS.
--
-- Both controls are suspended for the duration of ONE atomic DO block. Any
-- failure rolls them back with the data, and the explicit exception handler
-- restores them too, so a future edit that splits this block cannot leave them
-- off. The `archive_old_audit_events()` retention function already establishes
-- this pattern (it drops and recreates `reject_audit_delete` around its
-- DELETE).
--
-- Operational note: the ALTER TABLE statements take table-level locks on a
-- high-write table. The work between them is bounded to a single-digit row
-- count (16 rows on prod at 2026-08-10), so the write stall is milliseconds.
--
-- SELF-VERIFYING. The block counts candidate rows first and raises if the
-- number actually updated differs. That converts a partial scrub into a loud
-- abort — the property that matters, because a scrub that quietly does nothing
-- is worse than one that fails.
--
-- IDEMPOTENT. Re-running matches zero candidates and is a clean no-op, so a
-- retry after a partial failure is safe.
--
-- ============================================================================
-- PART 2 — correct the `verification_events.ip_hash` COMMENT
-- ============================================================================
--
-- The column COMMENT reads 'SHA-256 hash of requester IP (never raw IP)',
-- which an auditor reads as a populated pseudonymisation control. It is not
-- one. The column has never held a value (0 of 164 prod rows at 2026-08-10)
-- and CANNOT, because its only writer is the browser
-- (`src/lib/logVerificationEvent.ts`) calling the `log_verification_event`
-- RPC, whose signature has no IP parameter and whose body does not reference
-- `ip_hash`. A browser cannot observe its own public egress IP, and adding a
-- caller-supplied IP parameter to an `anon`-granted SECURITY DEFINER RPC would
-- let unauthenticated callers write arbitrary attacker-chosen values — worse
-- than empty. So the column is vestigial.
--
-- This migration corrects only the DOCUMENTATION, which is the part that is
-- actively misleading. Dropping the column is the right end state and is
-- recommended as a follow-up, NOT done here: `verification_events.ip_hash` is
-- referenced by the BigQuery export (`services/worker/src/jobs/
-- bq-export-incremental.ts` selects `verifier_ip_hash:ip_hash`, and
-- `bq-export-schemas.ts` declares the mirror column), so a DROP must land
-- together with those changes and their tests or it breaks a live export job.
-- Splitting a schema drop from its consumer is how an export starts failing in
-- prod for a reason nobody connects back to this file.
--
-- ROLLBACK:
--   -- Part 2 (fully reversible — restores the previous, inaccurate comment):
--   COMMENT ON COLUMN public.verification_events.ip_hash IS
--     'SHA-256 hash of requester IP (never raw IP)';
--
--   -- Part 1 is DELIBERATELY NOT REVERSIBLE. The raw IP addresses are the
--   -- defect; restoring them would re-create the false DPA warranty this
--   -- migration exists to retire, and the values are not retained anywhere to
--   -- restore from. The marker key can be removed if a rollback is ever
--   -- genuinely wanted, but that only erases the evidence that a redaction
--   -- happened — it does not bring the addresses back:
--   --   ALTER TABLE public.audit_events DISABLE TRIGGER reject_audit_update;
--   --   ALTER TABLE public.audit_events NO FORCE ROW LEVEL SECURITY;
--   --   UPDATE public.audit_events
--   --      SET details = (details::jsonb - 'querying_ip_redacted')::text
--   --    WHERE details LIKE '%querying_ip_redacted%';
--   --   ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
--   --   ALTER TABLE public.audit_events ENABLE TRIGGER reject_audit_update;

-- ---------------------------------------------------------------------------
-- Part 1 — redact raw caller IPs from historical audit rows
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r            RECORD;
  v_parsed     jsonb;
  v_candidates bigint  := 0;
  v_updated    bigint  := 0;
  v_suspended  boolean := false;
BEGIN
  CREATE TEMP TABLE _dpa_0404_targets (id uuid PRIMARY KEY, parsed jsonb) ON COMMIT DROP;

  -- Suspension opens BEFORE the scan — see the header: FORCE RLS hides these
  -- rows from the owner's SELECT, so scanning first would find nothing.
  ALTER TABLE public.audit_events DISABLE TRIGGER reject_audit_update;
  ALTER TABLE public.audit_events NO FORCE ROW LEVEL SECURITY;
  v_suspended := true;

  -- Build the candidate set row by row. `details` is `text` and nothing
  -- enforces that every historical row is JSON, so the cast is guarded: one
  -- malformed legacy row must not abort the whole remediation. The LIKE
  -- predicate keeps the scan narrow before any cast is attempted.
  FOR r IN
    SELECT ae.id, ae.details
      FROM public.audit_events ae
     WHERE ae.details LIKE '%"querying_ip"%'
  LOOP
    BEGIN
      v_parsed := r.details::jsonb;
    EXCEPTION WHEN others THEN
      v_parsed := NULL;  -- not JSON; leave the row untouched
    END;

    IF v_parsed IS NOT NULL
       AND jsonb_typeof(v_parsed) = 'object'
       AND v_parsed ? 'querying_ip'
    THEN
      INSERT INTO _dpa_0404_targets (id, parsed) VALUES (r.id, v_parsed);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_candidates FROM _dpa_0404_targets;

  IF v_candidates = 0 THEN
    ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.audit_events ENABLE TRIGGER reject_audit_update;
    v_suspended := false;
    RAISE NOTICE '0404: no audit_events rows carry a raw querying_ip — nothing to redact.';
    RETURN;
  END IF;

  UPDATE public.audit_events ae
     SET details = (
           (t.parsed - 'querying_ip')
           || jsonb_build_object('querying_ip_redacted', true)
         )::text
    FROM _dpa_0404_targets t
   WHERE ae.id = t.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Fail loudly rather than commit a scrub that did not actually happen.
  IF v_updated <> v_candidates THEN
    RAISE EXCEPTION
      '0404: redaction incomplete — % candidate row(s) but % updated. '
      'Raw IPs remain; refusing to commit a partial scrub.',
      v_candidates, v_updated;
  END IF;

  -- Record the redaction in the log it just modified, while RLS is still
  -- suspended (the only INSERT policy is `TO authenticated` and would filter
  -- this row out otherwise). INSERT is permitted by the append-only triggers,
  -- so the immutability story holds: the one mutation this migration performs
  -- is itself auditable.
  INSERT INTO public.audit_events (event_type, event_category, actor_id, details)
  VALUES (
    'PII_REDACTION',
    'SYSTEM',
    NULL,
    jsonb_build_object(
      'migration', '0404',
      'reason', 'DPA Schedules 1 + 2 warrant hashed IP addresses; these rows held raw addresses',
      'field_redacted', 'details.querying_ip',
      'rows_redacted', v_updated,
      'event_types', jsonb_build_array('VERIFICATION_QUERIED', 'ctdl.requested'),
      'reversible', false
    )::text
  );

  ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.audit_events ENABLE TRIGGER reject_audit_update;
  v_suspended := false;

  RAISE NOTICE '0404: redacted raw querying_ip from % audit_events row(s).', v_updated;

EXCEPTION WHEN others THEN
  IF v_suspended THEN
    ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.audit_events ENABLE TRIGGER reject_audit_update;
  END IF;
  RAISE;
END $$;

-- ---------------------------------------------------------------------------
-- Part 2 — stop documenting a control that does not exist
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN public.verification_events.ip_hash IS
  'VESTIGIAL — always NULL. No writer populates this column: the only producer '
  'of verification_events is the browser via log_verification_event(), whose '
  'signature has no IP parameter, and a browser cannot observe its own public '
  'egress IP. Do NOT read this column as evidence of an IP pseudonymisation '
  'control. Caller-IP pseudonymisation lives in '
  'audit_events.details.querying_ip_hash (keyed HMAC-SHA256, see '
  'services/worker/src/lib/ip-hash.ts). Slated for DROP once the BigQuery '
  'export (bq-export-incremental.ts / bq-export-schemas.ts, which alias this '
  'column to verifier_ip_hash) stops selecting it.';
