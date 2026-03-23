-- Migration: 0088_cle_credential_type.sql
-- Description: Add CLE (Continuing Legal Education) credential type and templates.
--   Supports CLE providers anchoring course completions, attorneys tracking credits,
--   and state bars verifying compliance via API.
-- ROLLBACK: DELETE FROM credential_templates WHERE name LIKE 'CLE%' AND is_system = true; ALTER TYPE credential_type RENAME TO credential_type_old; CREATE TYPE credential_type AS ENUM ('DEGREE','LICENSE','CERTIFICATE','TRANSCRIPT','PROFESSIONAL','OTHER'); ALTER TABLE anchors ALTER COLUMN credential_type TYPE credential_type USING credential_type::text::credential_type; ALTER TABLE credential_templates ALTER COLUMN credential_type TYPE credential_type USING credential_type::text::credential_type; DROP TYPE credential_type_old;

-- =============================================================================
-- 1. Add CLE to credential_type enum
-- =============================================================================

ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CLE';

COMMENT ON TYPE credential_type IS 'Classification of anchored credential documents. CLE = Continuing Legal Education credit.';

-- =============================================================================
-- 2. Seed CLE system templates
-- =============================================================================

INSERT INTO credential_templates (name, description, credential_type, is_system, default_metadata) VALUES
  (
    'CLE Course Completion',
    'Continuing Legal Education course completion certificate. Includes credit hours, category, jurisdiction, and provider details.',
    'CLE',
    true,
    '{
      "category": "legal_education",
      "fields": {
        "credit_hours": {"type": "number", "label": "Credit Hours", "required": true},
        "credit_category": {"type": "select", "label": "Credit Category", "options": ["General", "Ethics", "Professional Responsibility", "Substance Abuse", "Diversity", "Technology", "Mental Health", "Elimination of Bias"], "required": true},
        "jurisdiction": {"type": "text", "label": "Jurisdiction (State)", "required": true},
        "provider_name": {"type": "text", "label": "CLE Provider", "required": true},
        "provider_accreditation_number": {"type": "text", "label": "Provider Accreditation Number"},
        "course_title": {"type": "text", "label": "Course Title", "required": true},
        "course_number": {"type": "text", "label": "Course/Activity Number"},
        "delivery_method": {"type": "select", "label": "Delivery Method", "options": ["Live In-Person", "Live Webcast", "On-Demand", "Self-Study", "Hybrid"]},
        "completion_date": {"type": "date", "label": "Completion Date", "required": true},
        "bar_number": {"type": "text", "label": "Attorney Bar Number"}
      }
    }'::jsonb
  ),
  (
    'CLE Ethics Credit',
    'Ethics-specific CLE credit. Many jurisdictions require minimum ethics hours per reporting period.',
    'CLE',
    true,
    '{
      "category": "legal_education",
      "subcategory": "ethics",
      "fields": {
        "credit_hours": {"type": "number", "label": "Ethics Credit Hours", "required": true},
        "credit_category": {"type": "text", "label": "Credit Category", "default": "Ethics"},
        "jurisdiction": {"type": "text", "label": "Jurisdiction (State)", "required": true},
        "provider_name": {"type": "text", "label": "CLE Provider", "required": true},
        "course_title": {"type": "text", "label": "Course Title", "required": true},
        "completion_date": {"type": "date", "label": "Completion Date", "required": true},
        "bar_number": {"type": "text", "label": "Attorney Bar Number"}
      }
    }'::jsonb
  ),
  (
    'CLE Compliance Report',
    'Summary report of CLE compliance status for a reporting period. Used by attorneys to demonstrate full compliance to their state bar.',
    'CLE',
    true,
    '{
      "category": "legal_education",
      "subcategory": "compliance_report",
      "fields": {
        "reporting_period_start": {"type": "date", "label": "Reporting Period Start", "required": true},
        "reporting_period_end": {"type": "date", "label": "Reporting Period End", "required": true},
        "jurisdiction": {"type": "text", "label": "Jurisdiction (State)", "required": true},
        "total_hours_required": {"type": "number", "label": "Total Hours Required"},
        "total_hours_completed": {"type": "number", "label": "Total Hours Completed", "required": true},
        "ethics_hours_required": {"type": "number", "label": "Ethics Hours Required"},
        "ethics_hours_completed": {"type": "number", "label": "Ethics Hours Completed"},
        "bar_number": {"type": "text", "label": "Attorney Bar Number", "required": true},
        "compliance_status": {"type": "select", "label": "Compliance Status", "options": ["Compliant", "Deficient", "Pending", "Exempt"]}
      }
    }'::jsonb
  )
ON CONFLICT DO NOTHING;
