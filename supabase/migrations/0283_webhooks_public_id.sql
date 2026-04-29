-- SCRUM-1445 (R2-8 sub-C) — add public_id to webhook_endpoints + webhook_delivery_logs
--
-- v1 routes still expose `id` (the internal UUID) per CLAUDE.md §1.8 frozen
-- API contract. v2 routes (SCRUM-1445 follow-up) will surface `public_id`
-- exclusively. This migration is the prerequisite — it adds the column,
-- backfills existing rows, and pins uniqueness so the v2 cutover can be
-- a routing change rather than a schema change.
--
-- Format: WHK-{org_prefix}-{unique_8} for webhook endpoints (mirrors the
-- ARK-{org_prefix}-{type}-{unique_6} format used for anchors / attestations).
-- Delivery logs use DLV-{unique_12} since they aren't org-scoped at the
-- prefix level — uniqueness alone is sufficient.
--
-- ROLLBACK:
--   ALTER TABLE webhook_endpoints DROP COLUMN public_id;
--   ALTER TABLE webhook_delivery_logs DROP COLUMN public_id;

BEGIN;

-- ─── webhook_endpoints.public_id ─────────────────────────────────────────
ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS public_id text;

-- Backfill existing rows. Uses the org's `org_prefix` when available, else
-- falls back to 'IND' (the same convention as attestations.ts /
-- agents.ts public-id generation).
UPDATE webhook_endpoints we
SET public_id = 'WHK-' || COALESCE(o.org_prefix, 'IND') || '-' ||
                upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8))
FROM organizations o
WHERE we.org_id = o.id AND we.public_id IS NULL;

-- Any rows whose org_id no longer resolves get a no-org fallback
UPDATE webhook_endpoints
SET public_id = 'WHK-IND-' ||
                upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8))
WHERE public_id IS NULL;

ALTER TABLE webhook_endpoints
  ALTER COLUMN public_id SET NOT NULL;

-- Pin uniqueness. The (lower-cardinality) unique constraint here also gives
-- us an index for /api/v1/webhooks/:id resolution by public_id once v2 lands.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_public_id_uidx
  ON webhook_endpoints(public_id);

COMMENT ON COLUMN webhook_endpoints.public_id IS
  'Customer-facing identifier (WHK-{org_prefix}-{8}). Stable across v1+v2 — see SCRUM-1445.';

-- ─── webhook_delivery_logs.public_id ─────────────────────────────────────
ALTER TABLE webhook_delivery_logs
  ADD COLUMN IF NOT EXISTS public_id text;

UPDATE webhook_delivery_logs
SET public_id = 'DLV-' ||
                upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 12))
WHERE public_id IS NULL;

ALTER TABLE webhook_delivery_logs
  ALTER COLUMN public_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_logs_public_id_uidx
  ON webhook_delivery_logs(public_id);

COMMENT ON COLUMN webhook_delivery_logs.public_id IS
  'Customer-facing identifier (DLV-{12}). Stable across v1+v2 — see SCRUM-1445.';

-- Reload PostgREST schema cache so the new columns are queryable via REST.
NOTIFY pgrst, 'reload schema';

COMMIT;
