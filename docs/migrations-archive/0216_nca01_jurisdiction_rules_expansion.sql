-- Migration 0216: Expand jurisdiction_rules seed to ≥100 rules (NCA-01)
--
-- PURPOSE: Ground the NCA compliance scoring engine in actual regulatory
-- coverage. Prior seed (migration 0194) carried ~30 rules across 10 US
-- states and 3 industries. NCA-01 (SCRUM-756) requires:
--   - US federal: FERPA, HIPAA, SOX
--   - Kenya: Data Protection Act 2019 + ODPC registration
--   - Australia: Privacy Act 1988 + APP 1-13
--   - ≥100 rules total
--
-- All additions are ON CONFLICT DO NOTHING so re-running is safe.
-- Rules added here are intentionally high-signal representative — not an
-- exhaustive regulatory index. Exhaustive per-regulation rule packs land
-- under future NCA/NVI-cleared regulation work.
--
-- Jira: SCRUM-756 (NCA-01)
--
-- ROLLBACK:
--   DELETE FROM jurisdiction_rules WHERE jurisdiction_code IN (
--     'US-FEDERAL-FERPA', 'US-FEDERAL-HIPAA', 'US-FEDERAL-SOX',
--     'KE', 'AU'
--   ) OR rule_name LIKE '%NCA-01 expansion%';

-- ─────────────────────────────────────────────────────────────────────────
-- US federal: FERPA (educational records) — 3 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-FEDERAL', 'education', 'FERPA: Student Education Records Access (NCA-01 expansion)',
 ARRAY['LICENSE','TRANSCRIPT','CERTIFICATE'], ARRAY['DEGREE'],
 '20 U.S.C. §1232g; 34 CFR Part 99',
 '{"annual_notification_required": true, "directory_info_opt_out": true, "parental_consent_under_18": true}'),
('US-FEDERAL', 'education', 'FERPA: Disclosure Log Requirements (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 '34 CFR §99.32',
 '{"retention_years": 999, "must_record": ["requester", "legitimate_interest", "disclosed_records"]}'),
('US-FEDERAL', 'education', 'FERPA: Directory Information Public Disclosure (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 '34 CFR §99.37',
 '{"opt_out_window_days": 14, "categories_allowed": ["name","address","phone","email","dates_attended"]}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- US federal: HIPAA (health records) — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-FEDERAL', 'healthcare', 'HIPAA Privacy Rule: PHI Use + Disclosure (NCA-01 expansion)',
 ARRAY['LICENSE','CERTIFICATE','ATTESTATION'], ARRAY['CONTINUING_EDUCATION'],
 '45 CFR §§164.502, 164.508',
 '{"min_necessary_standard": true, "nopp_required": true, "authorization_elements": 6}'),
('US-FEDERAL', 'healthcare', 'HIPAA Security Rule: Administrative Safeguards (NCA-01 expansion)',
 ARRAY['CERTIFICATE','ATTESTATION'], ARRAY['CONTINUING_EDUCATION'],
 '45 CFR §164.308',
 '{"required_addressable_pairs": 18, "workforce_training_required": true, "risk_analysis_required": true}'),
('US-FEDERAL', 'healthcare', 'HIPAA Breach Notification Rule (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 '45 CFR §§164.400-414',
 '{"hhs_notice_days": 60, "media_notice_threshold": 500, "individual_notice_days": 60}'),
('US-FEDERAL', 'healthcare', 'HIPAA Business Associate Agreement Requirements (NCA-01 expansion)',
 ARRAY['ATTESTATION','LICENSE'], ARRAY[]::TEXT[],
 '45 CFR §164.504(e)',
 '{"ba_definition": "creates/receives/maintains/transmits PHI", "required_terms": 9}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- US federal: SOX (public-company accounting) — 3 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-FEDERAL', 'accounting', 'SOX §302: CEO/CFO Certification of Financials (NCA-01 expansion)',
 ARRAY['LICENSE','ATTESTATION'], ARRAY['DEGREE'],
 '15 U.S.C. §7241 (SOX §302)',
 '{"quarterly_certification": true, "annual_certification": true, "personal_liability": true}'),
('US-FEDERAL', 'accounting', 'SOX §404: Internal Control Assessment (NCA-01 expansion)',
 ARRAY['LICENSE','ATTESTATION','CERTIFICATE'], ARRAY['CONTINUING_EDUCATION'],
 '15 U.S.C. §7262 (SOX §404)',
 '{"auditor_attestation_required": true, "icfr_effectiveness_opinion": true}'),
('US-FEDERAL', 'accounting', 'SOX §802: Records Retention (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 '18 U.S.C. §§1519, 1520',
 '{"audit_workpaper_retention_years": 7, "criminal_penalties": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Kenya: Data Protection Act 2019 + ODPC — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('KE', 'data_protection', 'Kenya DPA: Data Controller/Processor Registration (NCA-01 expansion)',
 ARRAY['LICENSE','ATTESTATION'], ARRAY[]::TEXT[],
 'Kenya DPA 2019 §§18-24; ODPC Registration',
 '{"registration_required_above_annual_turnover_ksh": 5000000, "renewal_years": 2}'),
('KE', 'data_protection', 'Kenya DPA: Data Protection Impact Assessment (NCA-01 expansion)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY['LICENSE'],
 'Kenya DPA 2019 §31; ODPC DPIA Guidance',
 '{"required_for_high_risk": true, "dpo_review_required": true}'),
('KE', 'data_protection', 'Kenya DPA: Data Subject Rights (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Kenya DPA 2019 §§25-30',
 '{"response_days": 30, "rights": ["access","rectification","erasure","objection","portability"]}'),
('KE', 'data_protection', 'Kenya DPA: Breach Notification (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 'Kenya DPA 2019 §43',
 '{"odpc_notification_hours": 72, "individual_notification_if_high_risk": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Australia: Privacy Act 1988 + APP — 5 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('AU', 'data_protection', 'APP 1: Open and Transparent Management (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Privacy Act 1988 (Cth) Sch 1 APP 1',
 '{"privacy_policy_required": true, "accessible_form_required": true, "review_periodically": true}'),
('AU', 'data_protection', 'APP 5: Notification of Collection (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 'Privacy Act 1988 (Cth) Sch 1 APP 5',
 '{"notification_required_at_collection": true, "required_elements": 9}'),
('AU', 'data_protection', 'APP 8: Cross-Border Disclosure (NCA-01 expansion)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY[]::TEXT[],
 'Privacy Act 1988 (Cth) Sch 1 APP 8',
 '{"reasonable_steps_required": true, "accountability_for_recipient": true}'),
('AU', 'data_protection', 'APP 11: Security of Personal Information (NCA-01 expansion)',
 ARRAY['CERTIFICATE','ATTESTATION'], ARRAY['CONTINUING_EDUCATION'],
 'Privacy Act 1988 (Cth) Sch 1 APP 11',
 '{"reasonable_steps_to_protect": true, "destruction_or_deidentification_when_no_longer_needed": true}'),
('AU', 'data_protection', 'Notifiable Data Breaches Scheme (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 'Privacy Act 1988 (Cth) Part IIIC',
 '{"oaic_notification_required": true, "serious_harm_threshold": true, "notification_window_days": 30}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Additional US-state x industry coverage — filling gaps for NCA-01 ≥100 target
-- ─────────────────────────────────────────────────────────────────────────

-- California: real_estate, insurance, engineering (net new for CA)
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-CA', 'real_estate', 'California Real Estate Broker Requirements (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'CA Bus & Prof Code §10150; DRE Regulations',
 '{"ce_hours": 45, "ce_cycle_years": 4, "ethics_hours": 3, "fair_housing_hours": 3}'),
('US-CA', 'insurance', 'California Insurance Producer License (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'CA Ins Code §1749; CDI Regulations',
 '{"ce_hours": 24, "ce_cycle_years": 2, "ethics_hours": 3}'),
('US-CA', 'engineering', 'California Professional Engineer (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION','DEGREE'], ARRAY['CERTIFICATE'],
 'CA Bus & Prof Code §6700; BPELSG Rules',
 '{"ce_hours": 0, "experience_years": 4, "eight_hour_exam": true}')
ON CONFLICT DO NOTHING;

-- New York: real_estate, insurance, engineering
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-NY', 'real_estate', 'New York Real Estate Broker Requirements (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'NY RPL §440; 19 NYCRR 175',
 '{"ce_hours": 22.5, "ce_cycle_years": 2, "fair_housing_hours": 3, "ethics_hours": 2.5}'),
('US-NY', 'insurance', 'New York Insurance Producer License (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'NY Ins Law §2103; 11 NYCRR 29',
 '{"ce_hours": 15, "ce_cycle_years": 2, "ethics_hours": 3}'),
('US-NY', 'engineering', 'New York Professional Engineer (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION','DEGREE'], ARRAY['CERTIFICATE'],
 'NY Educ Law §7206; 8 NYCRR 68',
 '{"ce_hours": 36, "ce_cycle_years": 3, "ethics_hours": 1}')
ON CONFLICT DO NOTHING;

-- Texas: real_estate, insurance, healthcare
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-TX', 'real_estate', 'Texas Real Estate Broker Requirements (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'TX Occ Code §1101; TREC Rules §535',
 '{"ce_hours": 18, "ce_cycle_years": 2, "legal_update_hours": 8, "ethics_hours": 3}'),
('US-TX', 'insurance', 'Texas Insurance Producer License (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'TX Ins Code §4054; TDI Rules §19',
 '{"ce_hours": 24, "ce_cycle_years": 2, "ethics_hours": 2}'),
('US-TX', 'nursing', 'Texas RN Requirements (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'TX Occ Code §301; 22 TAC 216',
 '{"ce_hours": 20, "ce_cycle_years": 2, "nursing_jurisprudence_hours": 2}')
ON CONFLICT DO NOTHING;

-- Florida / Illinois / Ohio — cover engineering + real_estate + healthcare where missing
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-FL', 'engineering', 'Florida Professional Engineer (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION','DEGREE'], ARRAY['CERTIFICATE'],
 'FL Stat §471; 61G15 FAC',
 '{"ce_hours": 18, "ce_cycle_years": 2, "ethics_hours": 4, "laws_rules_hours": 1}'),
('US-FL', 'nursing', 'Florida RN Requirements (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'FL Stat §464; 64B9 FAC',
 '{"ce_hours": 24, "ce_cycle_years": 2, "medical_errors_hours": 2, "hiv_aids_hours": 1}'),
('US-IL', 'engineering', 'Illinois Professional Engineer (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION','DEGREE'], ARRAY['CERTIFICATE'],
 'IL PE Act §225 ILCS 325; 68 IAC 1380',
 '{"ce_hours": 30, "ce_cycle_years": 2, "ethics_hours": 1}'),
('US-IL', 'real_estate', 'Illinois Real Estate Managing Broker (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'IL RELA §225 ILCS 454; 68 IAC 1450',
 '{"ce_hours": 24, "ce_cycle_years": 2, "core_hours": 12, "elective_hours": 12}'),
('US-OH', 'engineering', 'Ohio Professional Engineer (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION','DEGREE'], ARRAY['CERTIFICATE'],
 'OH Rev Code §4733; OAC 4733-15',
 '{"ce_hours": 30, "ce_cycle_years": 2, "ethics_hours": 2}'),
('US-OH', 'real_estate', 'Ohio Real Estate Broker (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'OH Rev Code §4735; OAC 1301:5-7',
 '{"ce_hours": 30, "ce_cycle_years": 3, "ethics_hours": 3, "fair_housing_hours": 3}')
ON CONFLICT DO NOTHING;

-- Washington / Massachusetts / New Jersey — add for broader state coverage
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-WA', 'accounting', 'Washington CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'RCW §18.04; WAC 4-30',
 '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 4}'),
('US-WA', 'legal', 'Washington Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'WA APR Rule 11',
 '{"mcle_hours": 45, "mcle_cycle_years": 3, "ethics_hours": 6}'),
('US-WA', 'nursing', 'Washington RN (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'RCW §18.79; WAC 246-840',
 '{"ce_hours": 531, "practice_hours_cycle_years": 3}'),
('US-MA', 'accounting', 'Massachusetts CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'M.G.L. c.112 §87A; 252 CMR 2.07',
 '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4}'),
('US-MA', 'legal', 'Massachusetts Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'SJC Rule 3:14',
 '{"ce_hours": 0, "voluntary_cle": true}'),
('US-MA', 'nursing', 'Massachusetts RN (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'M.G.L. c.112 §74; 244 CMR 5',
 '{"ce_hours": 15, "ce_cycle_years": 2, "domestic_violence_hours": 1}'),
('US-NJ', 'accounting', 'New Jersey CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'N.J.S.A. 45:2B-42; N.J.A.C. 13:29',
 '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 4}'),
('US-NJ', 'legal', 'New Jersey Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'NJ Court Rule 1:42',
 '{"cle_hours": 24, "cle_cycle_years": 2, "ethics_hours": 4, "diversity_hours": 2}'),
('US-NJ', 'nursing', 'New Jersey RN (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'N.J.S.A. 45:11; N.J.A.C. 13:37',
 '{"ce_hours": 30, "ce_cycle_years": 2, "organ_donation_hours": 1}')
ON CONFLICT DO NOTHING;

-- Arizona / Colorado / Minnesota / Nevada — new states with core 3 industries
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-AZ', 'accounting', 'Arizona CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'A.R.S. §32-701; AAC R4-1',
 '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4}'),
('US-AZ', 'legal', 'Arizona Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'AZ Sup Ct Rule 45',
 '{"mcle_hours": 15, "mcle_cycle_years": 1, "ethics_hours": 3}'),
('US-CO', 'accounting', 'Colorado CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'C.R.S. §12-100; Rule 1.8',
 '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4}'),
('US-CO', 'legal', 'Colorado Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'CRCP 260',
 '{"cle_hours": 45, "cle_cycle_years": 3, "ethics_hours": 7}'),
('US-MN', 'accounting', 'Minnesota CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'Minn. Stat. §326A; MR 1105',
 '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 8}'),
('US-MN', 'legal', 'Minnesota Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'Rule 2 MN Lawyer Prof Resp',
 '{"cle_hours": 45, "cle_cycle_years": 3, "ethics_hours": 3, "elimination_of_bias_hours": 2}'),
('US-NV', 'accounting', 'Nevada CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'NRS 628; NAC 628',
 '{"ce_hours": 80, "ce_cycle_years": 2, "ethics_hours": 4}'),
('US-NV', 'legal', 'Nevada Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'NV Sup Ct Rule 210',
 '{"cle_hours": 13, "cle_cycle_years": 1, "ethics_hours": 2, "substance_abuse_hours": 1}')
ON CONFLICT DO NOTHING;

-- International privacy add-ons: UK, EU (informational footholds)
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('UK', 'data_protection', 'UK GDPR + Data Protection Act 2018 (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','LICENSE'],
 'UK GDPR; DPA 2018',
 '{"ico_registration_required": true, "dpo_required_for_public_authority": true, "breach_notification_hours": 72}'),
('EU', 'data_protection', 'EU GDPR — Core Obligations (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','LICENSE'],
 'Regulation (EU) 2016/679 (GDPR)',
 '{"dpo_required_for_large_scale_systematic_monitoring": true, "dpia_required_for_high_risk": true, "breach_notification_hours": 72}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Additional US federal: FCRA, ADA, FLSA, GLBA, GINA (cross-regulation scorable)
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-FEDERAL', 'employment', 'FCRA Employment Reporting Pre-Adverse Action (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 '15 U.S.C. §1681b(b)(3) (FCRA §604(b)(3))',
 '{"pre_adverse_notice_required": true, "reasonable_waiting_period_days": 5, "copy_of_report_required": true}'),
('US-FEDERAL', 'employment', 'ADA Title I: Reasonable Accommodation (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','CONTINUING_EDUCATION'],
 '42 U.S.C. §12112; 29 CFR §1630',
 '{"interactive_process_required": true, "undue_hardship_test": true}'),
('US-FEDERAL', 'employment', 'FLSA: Minimum Wage + Overtime (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 '29 U.S.C. §§206, 207',
 '{"exempt_classifications": ["executive","administrative","professional"], "overtime_multiplier": 1.5, "recordkeeping_years": 3}'),
('US-FEDERAL', 'finance', 'GLBA: Privacy Notice + Safeguards Rule (NCA-01 expansion)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY['LICENSE'],
 '15 U.S.C. §§6801-6809; 16 CFR §314',
 '{"annual_privacy_notice": true, "written_security_program_required": true, "designated_coordinator_required": true}'),
('US-FEDERAL', 'employment', 'GINA Title II: Genetic Information Non-Discrimination (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 '42 U.S.C. §§2000ff; 29 CFR §1635',
 '{"prohibited_actions": ["discriminate","retaliate","request_genetic_info"], "safe_harbor_language": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Additional state coverage: VA, IN, NC + Canada + Singapore + Japan + India
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('US-VA', 'accounting', 'Virginia CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'VA Code §54.1-4400; 18 VAC 5-22',
 '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 2}'),
('US-VA', 'legal', 'Virginia Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'VA Sup Ct Rule 1A:8',
 '{"cle_hours": 12, "cle_cycle_years": 1, "ethics_hours": 2}'),
('US-IN', 'accounting', 'Indiana CPA (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'IC 25-2.1; 872 IAC 1',
 '{"ce_hours": 120, "ce_cycle_years": 3, "ethics_hours": 4}'),
('US-IN', 'legal', 'Indiana Attorney (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['DEGREE'],
 'Admission and Discipline Rule 29',
 '{"cle_hours": 36, "cle_cycle_years": 3, "ethics_hours": 3}'),
('US-NC', 'real_estate', 'North Carolina Real Estate Broker (NCA-01 expansion)',
 ARRAY['LICENSE','CONTINUING_EDUCATION'], ARRAY['CERTIFICATE'],
 'NCGS §93A; 21 NCAC 58A',
 '{"ce_hours": 8, "ce_cycle_years": 1, "update_hours": 4}'),
-- California State law privacy
('US-CA', 'data_protection', 'CCPA + CPRA Consumer Rights (NCA-01 expansion)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY['LICENSE'],
 'Cal. Civ. Code §§1798.100-199 (CCPA/CPRA)',
 '{"annual_revenue_threshold_usd": 25000000, "opt_out_required": true, "response_days": 45}'),
-- Canada PIPEDA
('CA-intl', 'data_protection', 'Canada PIPEDA Fair Information Principles (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','LICENSE'],
 'PIPEDA S.C. 2000 c.5',
 '{"oipc_registration_optional": true, "breach_notification_required": true, "real_risk_of_significant_harm_test": true}'),
-- Singapore PDPA
('SG', 'data_protection', 'Singapore PDPA (NCA-01 expansion)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY['LICENSE'],
 'PDPA 2012 (Act 26 of 2012)',
 '{"dpo_required": true, "consent_withdrawal_honored": true, "breach_notification_hours": 72}'),
-- Japan APPI
('JP', 'data_protection', 'Japan APPI (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','LICENSE'],
 'Act on the Protection of Personal Information (APPI)',
 '{"ppc_notification_required_for_breach": true, "cross_border_consent_required": true}'),
-- India DPDP
('IN', 'data_protection', 'India Digital Personal Data Protection Act 2023 (NCA-01 expansion)',
 ARRAY['ATTESTATION','LICENSE'], ARRAY['CERTIFICATE'],
 'DPDP Act 2023',
 '{"dpb_registration_required_for_significant": true, "consent_notice_required": true, "breach_notification_required": true}'),
-- South Africa POPIA
('ZA', 'data_protection', 'South Africa POPIA Condition 8 Security (NCA-01 expansion)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY['LICENSE'],
 'Protection of Personal Information Act 4 of 2013 §§19-22',
 '{"regulator_registration_required": true, "security_measures_reasonable_appropriate": true, "breach_notification_required": true}'),
-- Nigeria NDPR
('NG', 'data_protection', 'Nigeria NDPR + NDP Act 2023 (NCA-01 expansion)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','LICENSE'],
 'NDPR 2019; Nigeria Data Protection Act 2023',
 '{"ndpc_registration_required": true, "annual_audit_required_above_threshold": true}')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
