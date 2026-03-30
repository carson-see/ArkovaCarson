-- Compensating migration for deleted 0122_audit_events_target_id_text.sql
-- (duplicate PK with 0122_idt_kyc_identity_fields.sql)
-- Changes audit_events.target_id from uuid to text.
-- Idempotent: ALTER COLUMN TYPE text is a no-op if already text.
--
-- ROLLBACK:
-- ALTER TABLE audit_events ALTER COLUMN target_id TYPE uuid USING target_id::uuid;
-- ALTER TABLE IF EXISTS audit_events_archive ALTER COLUMN target_id TYPE uuid USING target_id::uuid;

ALTER TABLE audit_events ALTER COLUMN target_id TYPE text USING target_id::text;
ALTER TABLE IF EXISTS audit_events_archive ALTER COLUMN target_id TYPE text USING target_id::text;
