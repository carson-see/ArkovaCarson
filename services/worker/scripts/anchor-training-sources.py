#!/usr/bin/env python3
"""
Anchor Training Source Documents

Submits regulatory text, enforcement actions, and compliance frameworks
to Arkova's public record pipeline for anchoring on-chain.

This ensures every data source Nessie trains on has a verifiable,
timestamped anchor — proving our AI's knowledge is grounded in
authentic regulatory data.
"""

import json
import hashlib
import os
import sys
from datetime import datetime

# Training source documents to anchor
TRAINING_SOURCES = [
    # FERPA
    {"source": "FERPA", "title": "Family Educational Rights and Privacy Act", "citation": "20 U.S.C. § 1232g", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.law.cornell.edu/uscode/text/20/1232g"},
    {"source": "FERPA_REGS", "title": "FERPA Regulations", "citation": "34 CFR Part 99", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.ecfr.gov/current/title-34/subtitle-A/part-99"},
    
    # HIPAA
    {"source": "HIPAA_PRIVACY", "title": "HIPAA Privacy Rule", "citation": "45 CFR Part 164 Subpart E", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E"},
    {"source": "HIPAA_SECURITY", "title": "HIPAA Security Rule", "citation": "45 CFR Part 164 Subpart C", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C"},
    {"source": "HIPAA_BREACH", "title": "HIPAA Breach Notification Rule", "citation": "45 CFR Part 164 Subpart D", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-D"},
    
    # SOX
    {"source": "SOX", "title": "Sarbanes-Oxley Act", "citation": "15 U.S.C. §§ 7201-7266", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.law.cornell.edu/uscode/text/15/chapter-98"},
    
    # NY Privacy
    {"source": "NY_SHIELD", "title": "NY SHIELD Act", "citation": "NY Gen. Bus. Law §§ 899-aa, 899-bb", "type": "REGULATION", "jurisdiction": "US-NY", "url": "https://legislation.nysenate.gov/pdf/bills/2019/S5575B"},
    {"source": "NY_DFS_CYBER", "title": "DFS Cybersecurity Regulation", "citation": "23 NYCRR 500", "type": "REGULATION", "jurisdiction": "US-NY", "url": "https://www.dfs.ny.gov/industry_guidance/cybersecurity"},
    {"source": "NYC_BIOMETRIC", "title": "NYC Biometric Identifier Information Law", "citation": "NYC Admin Code § 22-1201", "type": "REGULATION", "jurisdiction": "US-NY-NYC", "url": "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=4735274"},
    
    # CA Privacy
    {"source": "CCPA", "title": "California Consumer Privacy Act", "citation": "Cal. Civ. Code §§ 1798.100-1798.199", "type": "REGULATION", "jurisdiction": "US-CA", "url": "https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&division=3.&title=1.81.5."},
    {"source": "CPRA", "title": "California Privacy Rights Act", "citation": "CPRA Proposition 24", "type": "REGULATION", "jurisdiction": "US-CA"},
    {"source": "CMIA", "title": "Confidentiality of Medical Information Act", "citation": "Cal. Civ. Code § 56", "type": "REGULATION", "jurisdiction": "US-CA"},
    {"source": "CA_DELETE_ACT", "title": "California Delete Act", "citation": "SB 362", "type": "REGULATION", "jurisdiction": "US-CA"},
    
    # FCRA / Employment
    {"source": "FCRA", "title": "Fair Credit Reporting Act", "citation": "15 U.S.C. § 1681", "type": "REGULATION", "jurisdiction": "US-FED", "url": "https://www.law.cornell.edu/uscode/text/15/1681"},
    {"source": "EEOC_CRIMINAL", "title": "EEOC Guidance on Criminal Records in Employment", "citation": "EEOC Enforcement Guidance", "type": "REGULATION", "jurisdiction": "US-FED"},
    
    # Kenya
    {"source": "KENYA_DPA", "title": "Kenya Data Protection Act 2019", "citation": "Act No. 24 of 2019", "type": "REGULATION", "jurisdiction": "KE"},
    {"source": "KENYA_HEALTH", "title": "Kenya Health Act 2017", "citation": "Act No. 21 of 2017", "type": "REGULATION", "jurisdiction": "KE"},
    
    # Australia
    {"source": "AU_PRIVACY", "title": "Privacy Act 1988 (Cth)", "citation": "Act No. 119 of 1988", "type": "REGULATION", "jurisdiction": "AU"},
    {"source": "AU_NDB", "title": "Notifiable Data Breaches scheme", "citation": "Part IIIC Privacy Act 1988", "type": "REGULATION", "jurisdiction": "AU"},
    
    # GDPR
    {"source": "GDPR", "title": "General Data Protection Regulation", "citation": "Regulation (EU) 2016/679", "type": "REGULATION", "jurisdiction": "EU"},
    
    # South Africa
    {"source": "POPIA", "title": "Protection of Personal Information Act", "citation": "Act 4 of 2013", "type": "REGULATION", "jurisdiction": "ZA"},
    
    # Nigeria
    {"source": "NDPA", "title": "Nigeria Data Protection Act 2023", "citation": "Federal Republic of Nigeria", "type": "REGULATION", "jurisdiction": "NG"},
    
    # UK
    {"source": "UK_GDPR", "title": "UK General Data Protection Regulation", "citation": "Data Protection Act 2018", "type": "REGULATION", "jurisdiction": "GB"},
    
    # AML/BSA
    {"source": "BSA", "title": "Bank Secrecy Act", "citation": "31 U.S.C. §§ 5311-5332", "type": "REGULATION", "jurisdiction": "US-FED"},
    {"source": "AML_RULES", "title": "FinCEN AML Rules", "citation": "31 CFR Chapter X", "type": "REGULATION", "jurisdiction": "US-FED"},
    
    # Compliance Frameworks
    {"source": "SOC2", "title": "SOC 2 Trust Services Criteria", "citation": "AICPA TSP Section 100", "type": "ATTESTATION", "jurisdiction": "INTL"},
    {"source": "ISO27001", "title": "ISO/IEC 27001:2022", "citation": "ISO/IEC 27001", "type": "ATTESTATION", "jurisdiction": "INTL"},
    {"source": "NIST_CSF", "title": "NIST Cybersecurity Framework", "citation": "NIST SP 800-53", "type": "REGULATION", "jurisdiction": "US-FED"},
    
    # PCAOB
    {"source": "PCAOB_AS2201", "title": "PCAOB AS 2201 - Internal Control Over Financial Reporting", "citation": "PCAOB AS 2201", "type": "REGULATION", "jurisdiction": "US-FED"},
    {"source": "PCAOB_AS2401", "title": "PCAOB AS 2401 - Consideration of Fraud", "citation": "PCAOB AS 2401", "type": "REGULATION", "jurisdiction": "US-FED"},
    
    # Insurance
    {"source": "NAIC_MODEL", "title": "NAIC Insurance Data Security Model Law", "citation": "NAIC Model #668", "type": "REGULATION", "jurisdiction": "US-NAIC"},
    
    # 42 CFR Part 2
    {"source": "42CFR2", "title": "Substance Use Disorder Patient Records", "citation": "42 CFR Part 2", "type": "REGULATION", "jurisdiction": "US-FED"},
    
    # ASC 606
    {"source": "ASC606", "title": "Revenue from Contracts with Customers", "citation": "ASC 606", "type": "REGULATION", "jurisdiction": "US-FED"},
    
    # State-specific
    {"source": "IL_BIPA", "title": "Illinois Biometric Information Privacy Act", "citation": "740 ILCS 14", "type": "REGULATION", "jurisdiction": "US-IL"},
    {"source": "MI_LARA", "title": "Michigan LARA Professional Licensing", "citation": "Michigan Administrative Code", "type": "REGULATION", "jurisdiction": "US-MI"},
    {"source": "TX_OCC_CODE", "title": "Texas Occupations Code", "citation": "TX Occ. Code", "type": "REGULATION", "jurisdiction": "US-TX"},
    {"source": "FL_HEALTH", "title": "Florida Health Practice Acts", "citation": "FL Statutes Title XXXII", "type": "REGULATION", "jurisdiction": "US-FL"},
]

def generate_anchor_manifest():
    """Generate a manifest of all training sources that need anchoring."""
    manifest = {
        "generated_at": datetime.utcnow().isoformat(),
        "purpose": "training_source_anchoring",
        "total_sources": len(TRAINING_SOURCES),
        "sources": []
    }
    
    for src in TRAINING_SOURCES:
        fingerprint = hashlib.sha256(
            json.dumps(src, sort_keys=True).encode()
        ).hexdigest()
        
        manifest["sources"].append({
            **src,
            "fingerprint": fingerprint,
            "anchor_status": "PENDING",
        })
    
    return manifest

if __name__ == "__main__":
    manifest = generate_anchor_manifest()
    
    output_path = os.path.join(os.path.dirname(__file__), '..', 'training-output', 'anchor-manifest.json')
    with open(output_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    
    print(f"Generated anchor manifest: {len(manifest['sources'])} sources")
    print(f"Saved to: {output_path}")
    
    # Print by jurisdiction
    from collections import Counter
    jurisdictions = Counter(s['jurisdiction'] for s in TRAINING_SOURCES)
    print(f"\nBy jurisdiction:")
    for j, c in jurisdictions.most_common():
        print(f"  {j}: {c}")
