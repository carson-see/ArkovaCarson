CREATE TABLE IF NOT EXISTS jurisdiction_rules (
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

ALTER TABLE jurisdiction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read jurisdiction rules" ON jurisdiction_rules;
CREATE POLICY "Anyone can read jurisdiction rules"
  ON jurisdiction_rules FOR SELECT USING (true);

CREATE INDEX IF NOT EXISTS idx_jurisdiction_rules_lookup
  ON jurisdiction_rules (jurisdiction_code, industry_code);

INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-CA', 'accounting', 'California CPA Requirements', ARRAY['LICENSE','CERTIFICATE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'CA Bus & Prof Code §5026', '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4}'),
('US-CA', 'legal', 'California Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION','CERTIFICATE'], ARRAY['DEGREE'], 'CA Bus & Prof Code §6060', '{"mcle_hours": 25}'),
('US-NY', 'accounting', 'New York CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE','CERTIFICATE'], 'NY Educ Law §7404', '{"ce_hours": 40}'),
('US-NY', 'legal', 'New York Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'NY CLE Board Rules §1500', '{"cle_hours": 24}'),
('US-TX', 'accounting', 'Texas CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'TX Occ Code §901', '{"ce_hours": 40}'),
('US-TX', 'legal', 'Texas Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'TX State Bar MCLE Rules', '{"mcle_hours": 15}'),
('US-FL', 'accounting', 'Florida CPA Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'FL Stat §473', '{"ce_hours": 80}'),
('US-FL', 'legal', 'Florida Attorney Requirements', ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'], 'FL Bar Rules Ch. 6', '{"cle_hours": 33}')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';;
