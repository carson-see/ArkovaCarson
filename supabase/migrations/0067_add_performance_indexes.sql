-- Migration: 0067_add_performance_indexes.sql
-- Purpose: AUDIT-17 — Add missing composite indexes for frequently queried columns.
-- These indexes target common WHERE + ORDER BY patterns identified in hooks and worker jobs.
--
-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_anchors_org_status_created;
-- DROP INDEX IF EXISTS idx_anchors_user_status_created;
-- DROP INDEX IF EXISTS idx_anchors_fingerprint_deleted;
-- DROP INDEX IF EXISTS idx_audit_events_org_created;
-- DROP INDEX IF EXISTS idx_audit_events_actor_created;
-- DROP INDEX IF EXISTS idx_webhook_delivery_logs_webhook_created;
-- DROP INDEX IF EXISTS idx_verification_events_anchor_created;
-- DROP INDEX IF EXISTS idx_subscriptions_user_status;
-- DROP INDEX IF EXISTS idx_ai_usage_events_org_created;
-- DROP INDEX IF EXISTS idx_review_queue_org_status_priority;
-- DROP INDEX IF EXISTS idx_ai_reports_org_status_created;
-- DROP INDEX IF EXISTS idx_extraction_feedback_credential_type;

-- =========================================================================
-- Anchors — most queried table: org listing, user listing, verification
-- =========================================================================

-- Org admin listing: WHERE org_id = X AND deleted_at IS NULL ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_anchors_org_status_created
  ON anchors (org_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

-- Individual user listing: WHERE user_id = X AND deleted_at IS NULL ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_anchors_user_status_created
  ON anchors (user_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

-- Verification lookup: WHERE fingerprint = X AND deleted_at IS NULL
CREATE INDEX IF NOT EXISTS idx_anchors_fingerprint_deleted
  ON anchors (fingerprint)
  WHERE deleted_at IS NULL;

-- =========================================================================
-- Audit events — append-only, queried by org and actor
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON audit_events (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_created
  ON audit_events (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- =========================================================================
-- Webhook delivery logs — queried for retry processing and history
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_webhook_created
  ON webhook_delivery_logs (webhook_id, created_at DESC);

-- =========================================================================
-- Verification events — queried by anchor for verification history
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_verification_events_anchor_created
  ON verification_events (anchor_id, created_at DESC);

-- =========================================================================
-- Subscriptions — looked up by user + status for billing flows
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions (user_id, status);

-- =========================================================================
-- P8 AI tables — queried by org in admin dashboards
-- =========================================================================

-- AI usage events: credit tracking queries
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_org_created
  ON ai_usage_events (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

-- Review queue: admin dashboard filtering by org + status + priority
CREATE INDEX IF NOT EXISTS idx_review_queue_org_status_priority
  ON ai_review_queue (org_id, status, priority DESC);

-- AI reports: dashboard listing by org + status
CREATE INDEX IF NOT EXISTS idx_ai_reports_org_status_created
  ON ai_reports (org_id, status, created_at DESC);

-- Extraction feedback: accuracy queries by credential type
CREATE INDEX IF NOT EXISTS idx_extraction_feedback_credential_type
  ON extraction_feedback (credential_type, created_at DESC);
