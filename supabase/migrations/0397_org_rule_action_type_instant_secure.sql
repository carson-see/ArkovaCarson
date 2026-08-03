-- 0397_org_rule_action_type_instant_secure.sql
--
-- Founder directive (2026-08-03): "The 'Auto Secure' rule doesn't secure.
-- ... we need to be able to instantly secure or add to queue and we need
-- rules to work." AUTO_ANCHOR's UI label ("Secure the document" / "Anchor it
-- on the network automatically") implies immediacy, but its dispatcher
-- behavior (services/worker/src/jobs/rule-action-dispatcher.ts
-- dispatchAutoAnchor, SCRUM-1649 DS-07) only ever creates a PENDING anchor
-- that joins the normal batch queue (nightly 3am drain or the 10k/3k+3h
-- triggers) — same as every other queued document. None of the six existing
-- org_rule_action_type values (AUTO_ANCHOR, FAST_TRACK_ANCHOR,
-- QUEUE_FOR_REVIEW, FLAG_COLLISION, NOTIFY, FORWARD_TO_URL) causes a
-- synchronous/immediate securing outcome.
--
-- Adds INSTANT_SECURE: a rule action that reuses the SAME credit-funded,
-- idempotent anchor-materialization path FAST_TRACK_ANCHOR already uses
-- (deduct_org_credit, keyed on organization_rule_executions.id so a
-- dispatcher retry cannot double-charge — see migration 0326), and
-- additionally kicks an immediate per-org batch-anchor pass
-- (processBatchAnchors({ force: true, orgId })) instead of only relying on
-- the standard triggers, so the "instant" framing is actually true rather
-- than a same-queue rename. Falls back to the free queue path
-- (AUTO_ANCHOR-equivalent) on insufficient credits — the document is never
-- silently dropped, and the fallback is logged + notified to the org so the
-- gap is visible. See services/worker/src/jobs/rule-action-dispatcher.ts and
-- services/worker/src/rules/schemas.ts (this PR) for the application-layer
-- wiring; this migration is schema-only.
--
-- Purely additive: existing AUTO_ANCHOR / FAST_TRACK_ANCHOR / QUEUE_FOR_REVIEW
-- / FLAG_COLLISION / NOTIFY / FORWARD_TO_URL rows and their dispatcher
-- behavior are UNCHANGED. No existing rule starts consuming credits it did
-- not already consume.
--
-- Verified on an isolated throwaway Postgres 17 container (never prod, never
-- shared local/staging state): baseline 6-value enum created, this file
-- applied clean (BEGIN/ALTER TYPE/COMMENT/COMMIT), re-applied a second time
-- to confirm `IF NOT EXISTS` makes it a safe no-op retry (NOTICE, not an
-- error), `enum_range()` shows all 7 values, and an explicit
-- 'INSTANT_SECURE'::org_rule_action_type cast succeeds.
--
-- ROLLBACK:
--   PostgreSQL does not support removing a value from an ENUM type directly
--   (it would require rebuilding the type and every column/function that
--   references it). The safe rollback for an additive enum value is to
--   leave it unused rather than attempt a destructive rebuild:
--     1. Confirm no `organization_rules` row has action_type = 'INSTANT_SECURE'
--        (`SELECT count(*) FROM public.organization_rules WHERE action_type = 'INSTANT_SECURE'`)
--        and no `organization_rule_executions` row references a rule with
--        that action_type, before ever attempting a true rollback.
--     2. Revert the application-layer PR (dispatcher/schemas/UI) so
--        'INSTANT_SECURE' can no longer be selected or dispatched.
--     3. If the value must be physically removed, rebuild the type:
--        `ALTER TYPE public.org_rule_action_type RENAME TO org_rule_action_type_old;`
--        `CREATE TYPE public.org_rule_action_type AS ENUM ('AUTO_ANCHOR','FAST_TRACK_ANCHOR','QUEUE_FOR_REVIEW','FLAG_COLLISION','NOTIFY','FORWARD_TO_URL');`
--        `ALTER TABLE public.organization_rules ALTER COLUMN action_type TYPE public.org_rule_action_type USING action_type::text::public.org_rule_action_type;`
--        `DROP TYPE public.org_rule_action_type_old;`
--        (requires step 1's zero-rows precondition to hold, or the USING cast fails).

BEGIN;

-- New enum value only — cannot be referenced by another statement in this
-- same transaction (Postgres restriction on ALTER TYPE ... ADD VALUE), and
-- this migration does not attempt to.
ALTER TYPE public.org_rule_action_type ADD VALUE IF NOT EXISTS 'INSTANT_SECURE';

COMMENT ON TYPE public.org_rule_action_type IS
  'Action an organization_rules row takes when its trigger matches an event. AUTO_ANCHOR and QUEUE_FOR_REVIEW/FLAG_COLLISION/NOTIFY/FORWARD_TO_URL never consume credits and join the normal batch queue. FAST_TRACK_ANCHOR and INSTANT_SECURE are credit-funded (1 credit, deduct_org_credit, idempotent per organization_rule_executions.id) and fall back to the free queue path on insufficient credits rather than failing or dropping the document.';

COMMIT;
