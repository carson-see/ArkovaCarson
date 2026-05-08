-- Migration 0219: NCA-FU3 partial — Tier 2 regulation seed
--
-- PURPOSE: Close the credibility gap where JurisdictionPrivacyNotices
-- advertises support for LGPD, Thailand PDPA, Malaysia PDPA, Mexico LFPDPPP,
-- and Colombia Law 1581 but the scorecard had zero rules for those
-- jurisdictions. The scorecard would render misleadingly sparse for customers
-- in those five regions.
--
-- This migration seeds ≥4 representative rules per regulation, each mirroring
-- a statute section already cited on the public privacy page.
--
-- Follow-up work in SCRUM-907 NCA-FU3 will layer per-statute packs on top.
--
-- Jira: SCRUM-907 (NCA-FU3)
-- Dependency: migration 0194 (jurisdiction_rules table)
--
-- All additions are ON CONFLICT DO NOTHING so re-running is safe.
--
-- ROLLBACK:
--   DELETE FROM jurisdiction_rules WHERE jurisdiction_code IN ('BR','TH','MY','MX','CO')
--     AND rule_name LIKE '%NCA-FU3%';

-- ─────────────────────────────────────────────────────────────────────────
-- Brazil: LGPD (Lei Geral de Proteção de Dados) — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('BR', 'data_protection', 'LGPD: Lawful Basis for Processing (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE','LICENSE'],
 'LGPD (Law 13.709/2018) Art. 7 + Art. 11',
 '{"lawful_bases": 10, "sensitive_data_separate_bases": true, "consent_specificity_required": true}'),
('BR', 'data_protection', 'LGPD: Data Subject Rights — ARCO+ (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'LGPD Art. 18',
 '{"response_days": 15, "rights": ["confirmation","access","correction","anonymization","portability","erasure","information","revocation"]}'),
('BR', 'data_protection', 'LGPD: DPO (Encarregado) Appointment (NCA-FU3)',
 ARRAY['LICENSE','ATTESTATION'], ARRAY['CERTIFICATE'],
 'LGPD Art. 41',
 '{"dpo_required_for_controllers": true, "contact_published": true, "anpd_coordination_role": true}'),
('BR', 'data_protection', 'LGPD: Cross-Border Transfer Basis (NCA-FU3)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY[]::TEXT[],
 'LGPD Art. 33 + ANPD Resolution CD/ANPD No. 4/2023',
 '{"anpd_sccs_required": true, "adequacy_decision_path": true, "consent_path": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Thailand: PDPA 2019 — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('TH', 'data_protection', 'Thailand PDPA: Lawful Basis + Consent (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Thailand PDPA B.E. 2562 §24 + §26 + §27',
 '{"specific_consent_required": true, "withdrawal_mechanism_required": true, "sensitive_data_explicit_consent": true}'),
('TH', 'data_protection', 'Thailand PDPA: Data Subject Rights (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Thailand PDPA §§30-35',
 '{"response_days": 30, "rights": ["access","portability","object","deletion","restriction","rectification"]}'),
('TH', 'data_protection', 'Thailand PDPA: Cross-Border Transfer (NCA-FU3)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY[]::TEXT[],
 'Thailand PDPA §28',
 '{"adequacy_path_pdpc": true, "sccs_aligned_with_asean_mcc": true, "pdpc_approval_for_other_mechanisms": true}'),
('TH', 'data_protection', 'Thailand PDPA: Breach Notification (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 'Thailand PDPA §37(4) + PDPC Notification on Breach',
 '{"pdpc_notification_hours": 72, "individual_notification_if_high_risk": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Malaysia: PDPA 2010 as amended 2024 — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('MY', 'data_protection', 'Malaysia PDPA: General + Notice + Choice Principles (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Malaysia PDPA 2010 §§5-7 (as amended 2024)',
 '{"written_notice_required": true, "bilingual_malay_english": true, "purpose_specified": true}'),
('MY', 'data_protection', 'Malaysia PDPA: Cross-Border Transfer (NCA-FU3)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY[]::TEXT[],
 'Malaysia PDPA §129 (as amended 2024)',
 '{"risk_based_tia_required": true, "scc_style_contract_terms": true, "white_list_mechanism_removed_2024": true}'),
('MY', 'data_protection', 'Malaysia PDPA: Breach Notification (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY[]::TEXT[],
 'Malaysia PDPA 2025 Breach Notification Regulations',
 '{"pdp_commissioner_notification_hours": 72, "significant_harm_threshold": true}'),
('MY', 'data_protection', 'Malaysia PDPA: Data Portability — 2025 (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Malaysia PDPA §43A (effective 2025)',
 '{"structured_machine_readable_format": true, "response_within_21_days": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Mexico: LFPDPPP (2025 reform) — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('MX', 'data_protection', 'Mexico LFPDPPP: Privacy Notice (Aviso de Privacidad) (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'LFPDPPP Art. 15-18 + Regulations Art. 23-33',
 '{"integral_notice_required": true, "simplified_notice_required_at_collection": true, "sensitive_data_express_consent": true}'),
('MX', 'data_protection', 'Mexico LFPDPPP: ARCO Rights (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'LFPDPPP Art. 22-32',
 '{"response_days": 20, "rights": ["access","rectification","cancellation","opposition"], "extension_possible_to_40": true}'),
('MX', 'data_protection', 'Mexico LFPDPPP: Cross-Border Transfer — 2025 Reform (NCA-FU3)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY[]::TEXT[],
 'LFPDPPP Art. 36 (as reformed 2025)',
 '{"consent_based_required": true, "specify_countries_recipients_purposes": true, "sabg_supervision": true}'),
('MX', 'data_protection', 'Mexico LFPDPPP: Security Measures (NCA-FU3)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY['LICENSE'],
 'LFPDPPP Art. 19 + Regulations Art. 57-66',
 '{"administrative_technical_physical_measures": true, "risk_proportionate": true, "documented_security_policy_required": true}')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Colombia: Law 1581 / 2012 + Decree 1377 / 2013 — 4 rules
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO jurisdiction_rules (jurisdiction_code, industry_code, rule_name, required_credential_types, optional_credential_types, regulatory_reference, details) VALUES
('CO', 'data_protection', 'Colombia Law 1581: Consent + Purpose Limitation (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Law 1581/2012 Art. 9 + Decree 1377/2013 Art. 7',
 '{"prior_informed_express_consent": true, "specific_purpose_required": true, "sensitive_data_explicit_consent": true}'),
('CO', 'data_protection', 'Colombia Law 1581: Data Subject Rights (NCA-FU3)',
 ARRAY['ATTESTATION'], ARRAY['CERTIFICATE'],
 'Law 1581/2012 Art. 8',
 '{"response_days": 10, "extension_to_5_business_days_possible": true, "rights": ["access","rectification","deletion","consent_revocation","complaint"]}'),
('CO', 'data_protection', 'Colombia Law 1581: Cross-Border Transfer (NCA-FU3)',
 ARRAY['ATTESTATION','CERTIFICATE'], ARRAY[]::TEXT[],
 'Law 1581/2012 Art. 26 + SIC Circular Externa 3/2018 + SIC Model Clauses Dec 2025',
 '{"sic_adequacy_list_includes_us": true, "sic_model_contractual_clauses_available": true, "consent_exception_path": true}'),
('CO', 'data_protection', 'Colombia Law 1581: SIC Registration — RNBD (NCA-FU3)',
 ARRAY['LICENSE','ATTESTATION'], ARRAY['CERTIFICATE'],
 'Decree 1377/2013 Art. 25 + Decree 886/2014 + Circular 2/2015',
 '{"rnbd_registration_required_above_threshold": true, "annual_update_required": true, "sic_oversight": true}')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
