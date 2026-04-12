-- Migration 0194: Jurisdiction rules table for compliance scoring engine (NCE-06)
--
-- PURPOSE: Define per-jurisdiction, per-industry document requirements.
-- Backbone of Nessie's compliance score calculator.
--
-- Jira: SCRUM-596
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS jurisdiction_rules;

CREATE TABLE jurisdiction_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_code TEXT NOT NULL,
  industry_code TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  required_credential_types TEXT[] NOT NULL DEFAULT '{}',
  optional_credential_types TEXT[] DEFAULT '{}',
  regulatory_reference TEXT,
  effective_date DATE,
  expiry_date DATE,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: public read, platform-admin-only write
ALTER TABLE jurisdiction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read jurisdiction rules"
  ON jurisdiction_rules FOR SELECT USING (true);

CREATE POLICY "Platform admins can manage rules"
  ON jurisdiction_rules FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'PLATFORM_ADMIN')
  );

CREATE INDEX idx_jurisdiction_rules_lookup
  ON jurisdiction_rules (jurisdiction_code, industry_code);

-- ─── Seed: 10 US states × 3 industries ───

-- California
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-CA', 'accounting', 'California CPA Requirements', ARRAY['LICENSE','CERTIFICATE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'CA Bus & Prof Code §5026', '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4, "ethics_cycle_years": 2}'),
('US-CA', 'legal', 'California Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION','CERTIFICATE'], ARRAY['DEGREE'], 'CA Bus & Prof Code §6060; State Bar Rules', '{"mcle_hours": 25, "mcle_cycle_years": 1, "competence_hours": 1, "ethics_hours": 1}'),
('US-CA', 'nursing', 'California RN Requirements', ARRAY['LICENSE','CERTIFICATE','CONTINUING_EDUCATION'], ARRAY[], 'CA Bus & Prof Code §2732; BRN Regulations', '{"ce_hours": 30, "ce_cycle_years": 2, "bls_required": true}');

-- New York
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-NY', 'accounting', 'New York CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE','CERTIFICATE'], 'NY Educ Law §7404; 8 NYCRR §70.9', '{"ce_hours": 40, "ce_cycle_years": 1, "ethics_hours": 4, "ethics_cycle_years": 3}'),
('US-NY', 'legal', 'New York Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'NY CLE Board Rules §1500', '{"cle_hours": 24, "cle_cycle_years": 2, "ethics_hours": 4, "skills_hours": 6}'),
('US-NY', 'nursing', 'New York RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION','CERTIFICATE'], ARRAY[], 'NY Educ Law §6905; 8 NYCRR §64.5', '{"ce_hours": 0, "infection_control_required": true, "child_abuse_training": true}');

-- Texas
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-TX', 'accounting', 'Texas CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'TX Occ Code §901; TSBPA Rules §523', '{"ce_hours": 40, "ce_cycle_years": 1, "ethics_hours": 4, "ethics_cycle_years": 2}'),
('US-TX', 'legal', 'Texas Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'TX State Bar MCLE Rules', '{"mcle_hours": 15, "mcle_cycle_years": 1, "ethics_hours": 3, "ethics_cycle_years": 1}'),
('US-TX', 'engineering', 'Texas PE Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'TX Occ Code §1001; TBPE Rules §137', '{"pdh_hours": 15, "pdh_cycle_years": 1, "ethics_hours": 1, "ethics_cycle_years": 1}');

-- Florida
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-FL', 'accounting', 'Florida CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'FL Stat §473; Rule 61H1-33', '{"ce_hours": 80, "ce_cycle_years": 2, "accounting_hours": 20, "ethics_hours": 4}'),
('US-FL', 'legal', 'Florida Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'FL Bar Rules Ch. 6', '{"cle_hours": 33, "cle_cycle_years": 3, "ethics_hours": 5, "technology_hours": 3}'),
('US-FL', 'real_estate', 'Florida Real Estate Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'FL Stat §475; Rule 61J2', '{"ce_hours": 14, "ce_cycle_years": 2, "post_license_hours": 45}');

-- Illinois
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-IL', 'accounting', 'Illinois CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'IL Public Accounting Act §20.1; 23 IAC 1420', '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 4, "ethics_cycle_years": 3}'),
('US-IL', 'legal', 'Illinois Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'IL Supreme Court Rule 794', '{"mcle_hours": 30, "mcle_cycle_years": 2, "professionalism_hours": 6, "mental_health_hours": 1}'),
('US-IL', 'nursing', 'Illinois RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'IL Nurse Practice Act §225 ILCS 65', '{"ce_hours": 20, "ce_cycle_years": 2}');

-- Pennsylvania
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-PA', 'accounting', 'Pennsylvania CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'PA CPA Law §9.2; 49 Pa Code §11', '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4}'),
('US-PA', 'legal', 'Pennsylvania Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'PA CLE Board Rules §105', '{"cle_hours": 12, "cle_cycle_years": 1, "ethics_hours": 2}'),
('US-PA', 'nursing', 'Pennsylvania RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'PA Nurse Practice Act §21.29', '{"ce_hours": 30, "ce_cycle_years": 2}');

-- Ohio
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-OH', 'accounting', 'Ohio CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'OH Rev Code §4701; OAC 4701-9', '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 3}'),
('US-OH', 'legal', 'Ohio Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'OH Gov Bar R X', '{"cle_hours": 24, "cle_cycle_years": 2, "professionalism_hours": 2.5}'),
('US-OH', 'nursing', 'Ohio RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'OH Rev Code §4723', '{"ce_hours": 24, "ce_cycle_years": 2}');

-- Georgia
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-GA', 'accounting', 'Georgia CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'GA Code §43-3; Rule 20-11-.04', '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 2}'),
('US-GA', 'legal', 'Georgia Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'GA State Bar Rule 8-104', '{"cle_hours": 12, "cle_cycle_years": 1, "ethics_hours": 1, "professionalism_hours": 1}'),
('US-GA', 'nursing', 'Georgia RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'GA Code §43-26', '{"ce_hours": 0, "competency_requirements": true}');

-- North Carolina
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-NC', 'accounting', 'North Carolina CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'NC Gen Stat §93-12; 21 NCAC 08N', '{"ce_hours": 40, "ce_cycle_years": 1, "ethics_hours": 2}'),
('US-NC', 'legal', 'North Carolina Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'NC State Bar CLE Rules', '{"cle_hours": 12, "cle_cycle_years": 1, "ethics_hours": 2, "substance_abuse_hours": 1}'),
('US-NC', 'nursing', 'North Carolina RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'NC Gen Stat §90-171; 21 NCAC 36', '{"ce_hours": 0, "competency_assessment": true}');

-- Michigan
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-MI', 'accounting', 'Michigan CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'MI Comp Laws §339.727; R 338.5161', '{"ce_hours": 40, "ce_cycle_years": 1, "ethics_hours": 2}'),
('US-MI', 'legal', 'Michigan Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'MI State Bar CLE Rules', '{"cle_hours": 0, "voluntary_cle": true}'),
('US-MI', 'nursing', 'Michigan RN Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'], 'MI Comp Laws §333.17211', '{"ce_hours": 25, "ce_cycle_years": 2}');

NOTIFY pgrst, 'reload schema';
