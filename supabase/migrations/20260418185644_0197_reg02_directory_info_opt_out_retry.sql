ALTER TABLE anchors ADD COLUMN IF NOT EXISTS directory_info_opt_out boolean NOT NULL DEFAULT false;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS directory_info_fields text[] NOT NULL DEFAULT ARRAY['name','degree_type','dates_of_attendance','enrollment_status','honors']::text[];
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hipaa_mfa_required boolean NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS session_timeout_minutes integer NOT NULL DEFAULT 0;;
