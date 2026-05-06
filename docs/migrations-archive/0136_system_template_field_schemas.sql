-- Migration: 0136_system_template_field_schemas.sql
-- Description: Add proper field schemas to all system credential templates so
--   AI extraction results can be mapped to template-defined field structures.
--   Also seeds system templates for credential types added after 0070.
-- ROLLBACK: Run the UPDATE statements below with default_metadata = '{"category":"..."}' to revert.

-- ─── Update original 6 system templates with field schemas ───

UPDATE credential_templates SET default_metadata = '{
  "category": "academic",
  "fields": [
    {"key": "issuerName", "label": "Institution", "type": "text", "required": true},
    {"key": "recipientIdentifier", "label": "Recipient", "type": "text", "required": true},
    {"key": "degreeLevel", "label": "Degree Level", "type": "select", "options": ["Associate", "Bachelor", "Master", "Doctorate", "Professional"], "required": true},
    {"key": "fieldOfStudy", "label": "Field of Study", "type": "text", "required": true},
    {"key": "issuedDate", "label": "Date Conferred", "type": "date", "required": true},
    {"key": "accreditingBody", "label": "Accrediting Body", "type": "text"},
    {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
  ]
}'::jsonb
WHERE is_system = true AND credential_type = 'DEGREE';

UPDATE credential_templates SET default_metadata = '{
  "category": "professional",
  "fields": [
    {"key": "issuerName", "label": "Issuing Organization", "type": "text", "required": true},
    {"key": "recipientIdentifier", "label": "Recipient", "type": "text", "required": true},
    {"key": "fieldOfStudy", "label": "Certification Area", "type": "text", "required": true},
    {"key": "issuedDate", "label": "Issue Date", "type": "date", "required": true},
    {"key": "expiryDate", "label": "Expiry Date", "type": "date"},
    {"key": "accreditingBody", "label": "Accrediting Body", "type": "text"},
    {"key": "licenseNumber", "label": "Certificate Number", "type": "text"}
  ]
}'::jsonb
WHERE is_system = true AND credential_type = 'CERTIFICATE' AND name = 'Certificate';

UPDATE credential_templates SET default_metadata = '{
  "category": "regulatory",
  "fields": [
    {"key": "issuerName", "label": "Licensing Authority", "type": "text", "required": true},
    {"key": "recipientIdentifier", "label": "Licensee", "type": "text", "required": true},
    {"key": "licenseNumber", "label": "License Number", "type": "text", "required": true},
    {"key": "fieldOfStudy", "label": "License Type", "type": "text", "required": true},
    {"key": "issuedDate", "label": "Issue Date", "type": "date", "required": true},
    {"key": "expiryDate", "label": "Expiry Date", "type": "date", "required": true},
    {"key": "jurisdiction", "label": "Jurisdiction", "type": "text", "required": true},
    {"key": "accreditingBody", "label": "Regulatory Body", "type": "text"}
  ]
}'::jsonb
WHERE is_system = true AND credential_type = 'LICENSE';

UPDATE credential_templates SET default_metadata = '{
  "category": "academic",
  "fields": [
    {"key": "issuerName", "label": "Institution", "type": "text", "required": true},
    {"key": "recipientIdentifier", "label": "Student", "type": "text", "required": true},
    {"key": "fieldOfStudy", "label": "Program / Major", "type": "text"},
    {"key": "issuedDate", "label": "Date Issued", "type": "date", "required": true},
    {"key": "degreeLevel", "label": "Degree Level", "type": "text"},
    {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
  ]
}'::jsonb
WHERE is_system = true AND credential_type = 'TRANSCRIPT';

UPDATE credential_templates SET default_metadata = '{
  "category": "professional",
  "fields": [
    {"key": "issuerName", "label": "Issuing Body", "type": "text", "required": true},
    {"key": "recipientIdentifier", "label": "Credential Holder", "type": "text", "required": true},
    {"key": "fieldOfStudy", "label": "Specialty / Designation", "type": "text", "required": true},
    {"key": "licenseNumber", "label": "Credential ID", "type": "text"},
    {"key": "issuedDate", "label": "Issue Date", "type": "date", "required": true},
    {"key": "expiryDate", "label": "Expiry Date", "type": "date"},
    {"key": "accreditingBody", "label": "Accrediting Body", "type": "text"},
    {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
  ]
}'::jsonb
WHERE is_system = true AND credential_type = 'PROFESSIONAL';

UPDATE credential_templates SET default_metadata = '{
  "category": "general",
  "fields": [
    {"key": "issuerName", "label": "Issuer / Source", "type": "text"},
    {"key": "recipientIdentifier", "label": "Subject / Recipient", "type": "text"},
    {"key": "issuedDate", "label": "Date", "type": "date"},
    {"key": "fieldOfStudy", "label": "Description", "type": "text"},
    {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
  ]
}'::jsonb
WHERE is_system = true AND credential_type = 'OTHER';

-- ─── Seed system templates for newer credential types ───

INSERT INTO credential_templates (name, description, credential_type, is_system, default_metadata) VALUES
  ('Digital Badge', 'Digital badge or micro-credential from online platforms', 'BADGE', true, '{
    "category": "digital",
    "fields": [
      {"key": "issuerName", "label": "Issuing Platform", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Earner", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Badge Name / Skill", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Issue Date", "type": "date", "required": true},
      {"key": "expiryDate", "label": "Expiry Date", "type": "date"},
      {"key": "licenseNumber", "label": "Badge ID / Credential ID", "type": "text"},
      {"key": "accreditingBody", "label": "Validation Authority", "type": "text"}
    ]
  }'::jsonb),
  ('Attestation', 'Employment verification, reference letter, or attestation document', 'ATTESTATION', true, '{
    "category": "verification",
    "fields": [
      {"key": "issuerName", "label": "Attester / Organization", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Subject", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Attestation Type", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Date Issued", "type": "date", "required": true},
      {"key": "expiryDate", "label": "Valid Until", "type": "date"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('Financial Document', 'Audit report, tax document, financial statement, or grant award', 'FINANCIAL', true, '{
    "category": "financial",
    "fields": [
      {"key": "issuerName", "label": "Issuing Entity", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Subject / Entity", "type": "text"},
      {"key": "fieldOfStudy", "label": "Document Type", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Date / Period", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "Reference Number", "type": "text"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('Legal Document', 'Contract, agreement, court order, or legal filing', 'LEGAL', true, '{
    "category": "legal",
    "fields": [
      {"key": "issuerName", "label": "Issuing Authority / Party", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Subject / Party", "type": "text"},
      {"key": "fieldOfStudy", "label": "Document Type", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Date", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "Case / Reference Number", "type": "text"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text", "required": true}
    ]
  }'::jsonb),
  ('Insurance Certificate', 'Certificate of insurance, surety bond, or policy document', 'INSURANCE', true, '{
    "category": "insurance",
    "fields": [
      {"key": "issuerName", "label": "Insurance Carrier", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Named Insured", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Coverage Type", "type": "text", "required": true},
      {"key": "licenseNumber", "label": "Policy Number", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Effective Date", "type": "date", "required": true},
      {"key": "expiryDate", "label": "Expiration Date", "type": "date", "required": true},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('SEC Filing', 'Securities and Exchange Commission filing (10-K, 8-K, etc.)', 'SEC_FILING', true, '{
    "category": "regulatory",
    "fields": [
      {"key": "issuerName", "label": "Filer / Company", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Filing Type", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Filing Date", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "Accession Number", "type": "text"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('Patent', 'Patent or intellectual property document', 'PATENT', true, '{
    "category": "intellectual_property",
    "fields": [
      {"key": "issuerName", "label": "Patent Office", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Inventor / Assignee", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Title / Subject", "type": "text", "required": true},
      {"key": "licenseNumber", "label": "Patent Number", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Grant / Filing Date", "type": "date", "required": true},
      {"key": "expiryDate", "label": "Expiry Date", "type": "date"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('Regulation', 'Federal register notice, regulatory document, or government rule', 'REGULATION', true, '{
    "category": "regulatory",
    "fields": [
      {"key": "issuerName", "label": "Issuing Agency", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Rule / Regulation Title", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Effective Date", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "Docket / Citation Number", "type": "text"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text", "required": true}
    ]
  }'::jsonb),
  ('Publication', 'Academic paper, research publication, or journal article', 'PUBLICATION', true, '{
    "category": "academic",
    "fields": [
      {"key": "issuerName", "label": "Publisher / Journal", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Author(s)", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Title", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Publication Date", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "DOI / ISSN", "type": "text"}
    ]
  }'::jsonb),
  ('Charity Registration', 'Nonprofit or charity registration document', 'CHARITY', true, '{
    "category": "regulatory",
    "fields": [
      {"key": "issuerName", "label": "Registering Authority", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Organization Name", "type": "text", "required": true},
      {"key": "licenseNumber", "label": "Registration Number", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Registration Date", "type": "date", "required": true},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text", "required": true}
    ]
  }'::jsonb),
  ('Financial Advisor', 'Financial advisor registration or qualification', 'FINANCIAL_ADVISOR', true, '{
    "category": "regulatory",
    "fields": [
      {"key": "issuerName", "label": "Regulatory Body", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Advisor Name", "type": "text", "required": true},
      {"key": "licenseNumber", "label": "Registration / CRD Number", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Registration Date", "type": "date", "required": true},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"},
      {"key": "fieldOfStudy", "label": "License Type", "type": "text"}
    ]
  }'::jsonb),
  ('Business Entity', 'Business registration, ABN, or incorporation document', 'BUSINESS_ENTITY', true, '{
    "category": "regulatory",
    "fields": [
      {"key": "issuerName", "label": "Registering Authority", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Business Name", "type": "text", "required": true},
      {"key": "licenseNumber", "label": "Registration / ABN Number", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Registration Date", "type": "date", "required": true},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Entity Type", "type": "text"}
    ]
  }'::jsonb),
  ('Resume', 'Resume or curriculum vitae', 'RESUME', true, '{
    "category": "personal",
    "fields": [
      {"key": "recipientIdentifier", "label": "Name", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Title / Role", "type": "text"},
      {"key": "issuerName", "label": "Current Organization", "type": "text"},
      {"key": "issuedDate", "label": "Date", "type": "date"}
    ]
  }'::jsonb),
  ('Medical Record', 'Medical certificate, vaccination record, or health document', 'MEDICAL', true, '{
    "category": "medical",
    "fields": [
      {"key": "issuerName", "label": "Healthcare Provider / Facility", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Patient / Subject", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Document Type", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Date", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "Reference Number", "type": "text"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('Military Document', 'Military service record, DD-214, or military credential', 'MILITARY', true, '{
    "category": "military",
    "fields": [
      {"key": "issuerName", "label": "Branch / Authority", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Service Member", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Document Type", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Date", "type": "date", "required": true},
      {"key": "licenseNumber", "label": "Service Number", "type": "text"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text"}
    ]
  }'::jsonb),
  ('Identity Document', 'Government-issued identity document', 'IDENTITY', true, '{
    "category": "identity",
    "fields": [
      {"key": "issuerName", "label": "Issuing Authority", "type": "text", "required": true},
      {"key": "recipientIdentifier", "label": "Holder", "type": "text", "required": true},
      {"key": "fieldOfStudy", "label": "Document Type", "type": "text", "required": true},
      {"key": "licenseNumber", "label": "Document Number", "type": "text", "required": true},
      {"key": "issuedDate", "label": "Issue Date", "type": "date", "required": true},
      {"key": "expiryDate", "label": "Expiry Date", "type": "date"},
      {"key": "jurisdiction", "label": "Jurisdiction", "type": "text", "required": true}
    ]
  }'::jsonb)
ON CONFLICT DO NOTHING;
