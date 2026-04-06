-- Migration: 0168_rls_restrict_flag_history_reports.sql
-- Description: RLS-06 restrict switchboard_flag_history to admins; RLS-07 restrict reports to owner/admin
-- ROLLBACK: DROP POLICY IF EXISTS switchboard_flag_history_admin_read ON switchboard_flag_history; CREATE POLICY switchboard_flag_history_read ON switchboard_flag_history FOR SELECT TO authenticated USING (true); DROP POLICY IF EXISTS reports_read_own_or_admin ON reports; CREATE POLICY reports_read_own ON reports FOR SELECT TO authenticated USING (user_id = auth.uid() OR org_id = get_user_org_id()); DROP POLICY IF EXISTS report_artifacts_read_own_or_admin ON report_artifacts; CREATE POLICY report_artifacts_read_own ON report_artifacts FOR SELECT TO authenticated USING (report_id IN (SELECT id FROM reports WHERE user_id = auth.uid() OR org_id = get_user_org_id()));

-- ---------------------------------------------------------------------------
-- RLS-06: Restrict switchboard_flag_history to org admins only
-- Previously USING (true) — exposed operational decisions to all users
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS switchboard_flag_history_read ON switchboard_flag_history;

CREATE POLICY switchboard_flag_history_admin_read ON switchboard_flag_history
  FOR SELECT
  TO authenticated
  USING (is_org_admin());

-- ---------------------------------------------------------------------------
-- RLS-07: Restrict reports to owner or org admin
-- Previously any org member could read all org reports
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS reports_read_own ON reports;

CREATE POLICY reports_read_own_or_admin ON reports
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR (org_id = get_user_org_id() AND is_org_admin())
  );

DROP POLICY IF EXISTS report_artifacts_read_own ON report_artifacts;

CREATE POLICY report_artifacts_read_own_or_admin ON report_artifacts
  FOR SELECT
  TO authenticated
  USING (
    report_id IN (
      SELECT id FROM reports
      WHERE user_id = auth.uid()
        OR (org_id = get_user_org_id() AND is_org_admin())
    )
  );
