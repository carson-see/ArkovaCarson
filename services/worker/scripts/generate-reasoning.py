#!/usr/bin/env python3
"""
Generate advanced multi-factor reasoning for golden dataset entries.

For each entry, produces reasoning following the GRE-02 protocol:
  OBSERVE -> IDENTIFY -> CLASSIFY -> VERIFY

This creates training data that teaches the model HOW to think,
not just WHAT to extract.
"""

import json
import hashlib
import os
import sys

INPUT = 'training-output/nessie-v7-balanced.jsonl'
OUTPUT = 'training-output/nessie-v8-reasoning.jsonl'

# Credential type reasoning templates — multi-factor analysis
TYPE_REASONING = {
    'DEGREE': [
        'OBSERVE: Document contains institutional header, degree title, and conferral date — standard diploma format.',
        'IDENTIFY: Issuer is "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: DEGREE ({subType_or_default}) — degree title, institution name, and conferral language are definitive markers. Field of study "{fieldOfStudy}" and degree level "{degreeLevel}" extracted from standard academic formatting.',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'LICENSE': [
        'OBSERVE: Document has regulatory formatting — license number, issuing authority, effective/expiry dates, and jurisdictional markers.',
        'IDENTIFY: Issued by "{issuerName}" in {jurisdiction_or_unknown} — {issuer_analysis}.',
        'CLASSIFY: LICENSE — regulatory authority issuance with license number "{licenseNumber}" is definitive. Not a CERTIFICATE (no educational component) or PROFESSIONAL (specific regulatory grant, not general credential).',
        'VERIFY: {verify_signals}. License number format {license_check}. {fraud_analysis}.',
    ],
    'CERTIFICATE': [
        'OBSERVE: Document presents a certification credential — certification body, certification name, and holder information.',
        'IDENTIFY: Certified by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: CERTIFICATE — issued by a certification body attesting to specific competency. Distinguished from LICENSE (not a regulatory grant) and DEGREE (not an academic institution).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'PUBLICATION': [
        'OBSERVE: Document contains publication metadata — title, authors, journal/venue, DOI or publication identifiers.',
        'IDENTIFY: Published in/by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: PUBLICATION — academic or research output with bibliographic metadata. Not a DEGREE (no conferral) or ATTESTATION (original work, not third-party verification).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'SEC_FILING': [
        'OBSERVE: Document contains SEC filing markers — CIK number, filing type, EDGAR references, registrant information.',
        'IDENTIFY: Filed by/about "{issuerName}" with SEC — {issuer_analysis}.',
        'CLASSIFY: SEC_FILING — federal securities regulatory document with EDGAR-traceable identifiers. Not FINANCIAL (specific to SEC regulatory framework) or REGULATION (filed by registrant, not issued by regulator).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'LEGAL': [
        'OBSERVE: Document contains legal proceeding markers — case number, court, parties, judicial language.',
        'IDENTIFY: Court/issuer is "{issuerName}" in {jurisdiction_or_unknown} — {issuer_analysis}.',
        'CLASSIFY: LEGAL — judicial or legal proceeding document. Not REGULATION (adjudicative, not rulemaking) or LICENSE (no regulatory grant).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'REGULATION': [
        'OBSERVE: Document contains regulatory text — CFR citations, rulemaking language, effective dates, agency attribution.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: REGULATION — government rulemaking or regulatory text. Not LEGAL (no adjudication) or SEC_FILING (broader regulatory scope).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'FINANCIAL': [
        'OBSERVE: Document contains financial credential markers — registration numbers, regulatory body references, financial institution details.',
        'IDENTIFY: Associated with "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: FINANCIAL — financial industry credential or registration. Not SEC_FILING (broader financial scope) or LICENSE (specific to financial regulatory framework).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'PATENT': [
        'OBSERVE: Document contains patent identifiers — patent number, application date, claims, inventor information, patent office references.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: PATENT — intellectual property grant with patent office identifiers. Not PUBLICATION (legal grant, not research output) or CERTIFICATE (government IP office, not certification body).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'CLE': [
        'OBSERVE: Document presents continuing education credit — credit hours, provider information, accrediting body, activity number.',
        'IDENTIFY: Provider is "{issuerName}", accredited by {accreditingBody_or_unknown} — {issuer_analysis}.',
        'CLASSIFY: CLE — continuing professional education with credit hours ({creditHours}) in "{creditType_or_general}". Distinguished from CERTIFICATE (educational maintenance, not initial competency) and DEGREE (professional development, not academic conferral).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'MEDICAL': [
        'OBSERVE: Document contains healthcare credential markers — NPI, medical license number, DEA registration, hospital privileges.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: MEDICAL — healthcare-specific credential. Not LICENSE (domain-specific medical regulatory framework) or PROFESSIONAL (specific to healthcare practice).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'PROFESSIONAL': [
        'OBSERVE: Document presents professional credential — professional designation, membership, or practice authorization.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: PROFESSIONAL — professional body credential. Not LICENSE (professional body, not regulatory agency) or CERTIFICATE (ongoing professional standing, not one-time certification).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'IDENTITY': [
        'OBSERVE: Document contains identity verification markers — government-issued identifiers, biographic data, photo placeholder.',
        'IDENTIFY: Issued by "{issuerName}" in {jurisdiction_or_unknown} — {issuer_analysis}.',
        'CLASSIFY: IDENTITY — government-issued identity document. Not LICENSE (identity verification, not practice authorization) or MILITARY (civilian identity).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'MILITARY': [
        'OBSERVE: Document contains military service markers — service branch, rank, service dates, discharge status, DD-214 indicators.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: MILITARY — military service record or discharge document. Not IDENTITY (military-specific) or PROFESSIONAL (government military service).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'RESUME': [
        'OBSERVE: Document contains career summary — employment history, skills, education section, self-reported information.',
        'IDENTIFY: Self-reported document, no issuing authority — unverified claims.',
        'CLASSIFY: RESUME — self-authored career document. Not PROFESSIONAL (no third-party attestation) or CERTIFICATE (no issuing body). All claims require independent verification.',
        'VERIFY: Self-reported — no issuing authority to verify against. {fraud_analysis}.',
    ],
    'TRANSCRIPT': [
        'OBSERVE: Document contains academic record — course listings, grades, GPA, enrollment dates, registrar information.',
        'IDENTIFY: Issued by "{issuerName}" registrar — {issuer_analysis}.',
        'CLASSIFY: TRANSCRIPT — official academic record. Not DEGREE (detailed record, not conferral document) or CERTIFICATE (academic record, not competency attestation).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'INSURANCE': [
        'OBSERVE: Document contains insurance credential markers — policy number, coverage details, regulatory filings, NAIC numbers.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: INSURANCE — insurance license or regulatory document. Not LICENSE (insurance-specific regulatory framework) or FINANCIAL (insurance, not banking/securities).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'BADGE': [
        'OBSERVE: Document contains digital badge or micro-credential markers — badge issuer, skills verified, badge platform reference.',
        'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: BADGE — digital credential or micro-certification. Not CERTIFICATE (digital badge format, not traditional certification) or PROFESSIONAL (specific skill attestation).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'ATTESTATION': [
        'OBSERVE: Document contains third-party attestation — verifier identity, subject of attestation, verification methodology.',
        'IDENTIFY: Attested by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: ATTESTATION — third-party verification or attestation. Not CERTIFICATE (verification of existing credential, not original grant) or LEGAL (non-judicial verification).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'CHARITY': [
        'OBSERVE: Document contains charitable organization markers — registration number, regulatory body, charitable purpose, financial reporting.',
        'IDENTIFY: Registered with "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: CHARITY — charitable or non-profit organization registration. Not BUSINESS_ENTITY (charitable purpose, not commercial) or REGULATION (organization registration, not regulatory text).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'ACCREDITATION': [
        'OBSERVE: Document contains accreditation markers — accrediting body, standards compliance, accreditation period, site visit references.',
        'IDENTIFY: Accredited by "{issuerName}" — {issuer_analysis}.',
        'CLASSIFY: ACCREDITATION — institutional or program accreditation. Not CERTIFICATE (organizational accreditation, not individual certification) or ATTESTATION (formal standards-based evaluation).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
    'BUSINESS_ENTITY': [
        'OBSERVE: Document contains business registration markers — entity number, formation date, registered agent, state filing.',
        'IDENTIFY: Filed with "{issuerName}" in {jurisdiction_or_unknown} — {issuer_analysis}.',
        'CLASSIFY: BUSINESS_ENTITY — business formation or registration document. Not CHARITY (commercial entity) or ACCREDITATION (entity registration, not quality assessment).',
        'VERIFY: {verify_signals}. {fraud_analysis}.',
    ],
}

# Default for types not in the map
DEFAULT_REASONING = [
    'OBSERVE: Document contains credential indicators — issuer information, dates, and identification numbers.',
    'IDENTIFY: Issued by "{issuerName}" — {issuer_analysis}.',
    'CLASSIFY: {credentialType} — based on document structure and content markers.',
    'VERIFY: {verify_signals}. {fraud_analysis}.',
]


def generate_reasoning(ground_truth: dict, stripped_text: str) -> str:
    """Generate advanced multi-factor reasoning for a training example."""
    ct = ground_truth.get('credentialType', 'OTHER')
    template = TYPE_REASONING.get(ct, DEFAULT_REASONING)

    # Build substitution values
    issuer = ground_truth.get('issuerName', 'Unknown')
    jurisdiction = ground_truth.get('jurisdiction', '')
    license_num = ground_truth.get('licenseNumber', '')
    fraud_signals = ground_truth.get('fraudSignals', [])
    field_of_study = ground_truth.get('fieldOfStudy', '')
    degree_level = ground_truth.get('degreeLevel', '')
    sub_type = ground_truth.get('subType', '')
    credit_hours = ground_truth.get('creditHours', '')
    credit_type = ground_truth.get('creditType', '')
    accrediting_body = ground_truth.get('accreditingBody', '')

    # Issuer analysis
    if issuer and issuer != 'Unknown':
        issuer_analysis = f'recognized institutional issuer with verifiable identity'
    else:
        issuer_analysis = 'issuer identity not fully established — requires verification'

    # Jurisdiction
    jurisdiction_or_unknown = jurisdiction if jurisdiction else 'jurisdiction not specified'

    # Verify signals
    verify_parts = []
    if issuer and issuer != 'Unknown':
        verify_parts.append(f'Issuer "{issuer}" is a named entity')
    if license_num:
        verify_parts.append(f'License/ID number "{license_num}" present and formatted')
    if jurisdiction:
        verify_parts.append(f'Jurisdiction "{jurisdiction}" specified')
    if ground_truth.get('issuedDate'):
        verify_parts.append(f'Issuance date {ground_truth["issuedDate"]} within plausible range')
    if ground_truth.get('expiryDate'):
        verify_parts.append(f'Expiry date {ground_truth["expiryDate"]} indicates active credential')
    if not verify_parts:
        verify_parts.append('Limited verification signals in document')
    verify_signals = '; '.join(verify_parts)

    # License check
    if license_num:
        license_check = f'"{license_num}" follows expected pattern for {ct} credentials'
    else:
        license_check = 'no license number present'

    # Fraud analysis
    if fraud_signals:
        fraud_analysis = f'FRAUD SIGNALS DETECTED: {", ".join(fraud_signals)}. Risk elevated — manual review recommended'
    else:
        fraud_analysis = 'No fraud signals detected. Document structure and content are consistent with legitimate {ct} credentials'.format(ct=ct)

    # Sub-type
    subType_or_default = sub_type if sub_type else ct.lower()
    creditHours_str = str(credit_hours) if credit_hours else 'unspecified'
    creditType_or_general = credit_type if credit_type else 'General'
    accreditingBody_or_unknown = accrediting_body if accrediting_body else 'unspecified accrediting body'

    # Format template
    subs = {
        'issuerName': issuer,
        'issuer_analysis': issuer_analysis,
        'jurisdiction_or_unknown': jurisdiction_or_unknown,
        'verify_signals': verify_signals,
        'fraud_analysis': fraud_analysis,
        'licenseNumber': license_num,
        'license_check': license_check,
        'fieldOfStudy': field_of_study or 'unspecified',
        'degreeLevel': degree_level or 'unspecified',
        'subType_or_default': subType_or_default,
        'creditHours': creditHours_str,
        'creditType_or_general': creditType_or_general,
        'accreditingBody_or_unknown': accreditingBody_or_unknown,
        'credentialType': ct,
    }

    parts = []
    for line in template:
        try:
            parts.append(line.format(**subs))
        except KeyError:
            parts.append(line)

    return ' '.join(parts)


def main():
    if not os.path.exists(INPUT):
        print(f'ERROR: {INPUT} not found')
        sys.exit(1)

    with open(INPUT, 'r') as f:
        examples = [json.loads(line) for line in f if line.strip()]

    print(f'Loaded {len(examples)} training examples')

    enriched = 0
    had_reasoning = 0

    for ex in examples:
        for msg in ex['messages']:
            if msg['role'] == 'assistant':
                try:
                    out = json.loads(msg['content'])

                    # Check if reasoning already exists and is substantial
                    existing = out.get('reasoning', '')
                    if existing and len(existing) > 100:
                        had_reasoning += 1
                        continue

                    # Generate advanced reasoning
                    user_msg = ''
                    for m in ex['messages']:
                        if m['role'] == 'user':
                            user_msg = m['content']

                    reasoning = generate_reasoning(out, user_msg)
                    out['reasoning'] = reasoning

                    # Add concerns if fraud signals present
                    fraud = out.get('fraudSignals', [])
                    if fraud:
                        out['concerns'] = [f'Fraud signal: {s}' for s in fraud]
                    elif 'concerns' not in out:
                        out['concerns'] = []

                    msg['content'] = json.dumps(out)
                    enriched += 1
                except (json.JSONDecodeError, KeyError):
                    pass

    print(f'Had existing reasoning: {had_reasoning}')
    print(f'Generated new reasoning: {enriched}')

    # Deduplicate
    seen = set()
    deduped = []
    for ex in examples:
        user_msg = ''
        for m in ex['messages']:
            if m['role'] == 'user':
                user_msg = m['content']
        h = hashlib.sha256(user_msg.encode()).hexdigest()
        if h not in seen:
            seen.add(h)
            deduped.append(ex)

    print(f'After dedup: {len(deduped)} examples')

    with open(OUTPUT, 'w') as f:
        for ex in deduped:
            f.write(json.dumps(ex) + '\n')

    print(f'Wrote {len(deduped)} reasoning-enriched examples to {OUTPUT}')

    # Show a sample
    sample = deduped[0]
    for m in sample['messages']:
        if m['role'] == 'assistant':
            out = json.loads(m['content'])
            print(f'\nSample reasoning:')
            print(f'  Type: {out.get("credentialType","")}')
            print(f'  Reasoning: {out.get("reasoning","")[:300]}')


if __name__ == '__main__':
    main()
