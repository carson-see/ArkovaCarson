-- 0190 RLS per-statement caching — all DROP IF EXISTS + CREATE, idempotent.
DROP POLICY IF EXISTS profiles_select_own ON profiles;
CREATE POLICY profiles_select_own ON profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS profiles_update_own ON profiles;
CREATE POLICY profiles_update_own ON profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS audit_events_select ON audit_events;
CREATE POLICY audit_events_select ON audit_events FOR SELECT TO authenticated USING (actor_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS audit_events_insert ON audit_events;
CREATE POLICY audit_events_insert ON audit_events FOR INSERT TO authenticated WITH CHECK (actor_id IS NULL OR actor_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS credit_transactions_select ON credit_transactions;
CREATE POLICY credit_transactions_select ON credit_transactions FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS reports_read_own_or_admin ON reports;
CREATE POLICY reports_read_own_or_admin ON reports FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()) OR (org_id = get_user_org_id() AND is_org_admin()));

DROP POLICY IF EXISTS anchor_recipients_select ON anchor_recipients;
CREATE POLICY anchor_recipients_select ON anchor_recipients FOR SELECT TO authenticated USING (recipient_user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS extraction_feedback_select ON extraction_feedback;
CREATE POLICY extraction_feedback_select ON extraction_feedback FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()) OR org_id = get_user_org_id());

DROP POLICY IF EXISTS extraction_feedback_insert ON extraction_feedback;
CREATE POLICY extraction_feedback_insert ON extraction_feedback FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

NOTIFY pgrst, 'reload schema';;
