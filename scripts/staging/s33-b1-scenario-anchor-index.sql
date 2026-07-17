-- RIG-B1 operator-only index. This file is intentionally outside migrations:
-- the production-bound migration must not take a write-blocking table lock on
-- the global anchors corpus. The isolated B1 provisioner runs and verifies it
-- after schema replay and before any fixture/scenario seed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS s33_rig_b1_anchors_scenario_namespace_status_idx
  ON public.anchors (
    ((metadata->'s33_rig_b1')->>'scenarioLeaseId'),
    ((metadata->'s33_rig_b1')->>'namespaceId'),
    status
  )
  WHERE deleted_at IS NULL AND metadata ? 's33_rig_b1';
