-- AI-003: Training metrics table for synthetic data quality tracking
-- Tracks generation volume, cross-model agreement, human review scores,
-- and downstream eval impact for Nessie's training pipeline.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS training_metrics;

CREATE TABLE IF NOT EXISTS training_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Metric identification
  metric_date DATE NOT NULL,
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'generation_volume',
    'cross_model_agreement',
    'human_review',
    'eval_impact',
    'export_stats'
  )),

  -- Core metric values
  value NUMERIC NOT NULL DEFAULT 0,
  count INT NOT NULL DEFAULT 0,

  -- Breakdown metadata (JSON for flexibility)
  -- e.g., { "credential_type": "DEGREE", "provider": "gemini" }
  breakdown JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent duplicate entries per date+type+breakdown
  CONSTRAINT training_metrics_unique UNIQUE (metric_date, metric_type, breakdown)
);

-- Index for date-range queries (dashboard)
CREATE INDEX idx_training_metrics_date ON training_metrics (metric_date DESC);

-- Index for metric type filtering
CREATE INDEX idx_training_metrics_type ON training_metrics (metric_type, metric_date DESC);

-- RLS: service_role only (worker writes, admin reads)
ALTER TABLE training_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_metrics FORCE ROW LEVEL SECURITY;

-- Admin read-only policy
CREATE POLICY training_metrics_admin_read ON training_metrics
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_platform_admin = true
    )
  );

COMMENT ON TABLE training_metrics IS 'AI-003: Synthetic training data quality metrics for Nessie pipeline';
