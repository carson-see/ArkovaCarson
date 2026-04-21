-- Migration 0222: Calibration Features View (SCRUM-917)
--
-- Creates a view joining anchors → extraction_manifests → ai_usage_events
-- to surface the confidence + extraction_accuracy fields the calibration-refit
-- job needs. Replaces the cast-through-unknown workaround in calibration-refit.ts.
--
-- ROLLBACK: DROP VIEW IF EXISTS calibration_features;

CREATE OR REPLACE VIEW calibration_features AS
SELECT
  a.id,
  a.credential_type,
  a.created_at,
  (em.confidence_scores->>'overall')::numeric AS confidence,
  aue.confidence AS extraction_accuracy
FROM anchors a
LEFT JOIN extraction_manifests em ON em.anchor_id = a.id
LEFT JOIN ai_usage_events aue
  ON aue.fingerprint = a.fingerprint
  AND aue.event_type = 'extraction'
WHERE em.confidence_scores IS NOT NULL
   OR aue.confidence IS NOT NULL;

COMMENT ON VIEW calibration_features IS
  'Flattened view for the weekly calibration-refit cron (GME7.3). '
  'Joins anchors → extraction_manifests (confidence_scores.overall) '
  'and ai_usage_events (confidence) to avoid querying non-existent '
  'columns on anchors directly.';
