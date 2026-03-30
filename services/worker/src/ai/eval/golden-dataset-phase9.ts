/**
 * Golden Dataset Phase 9 — Weak Type Coverage & International Credentials
 *
 * Entries GD-1331 through GD-1480: 150 new entries targeting types with
 * historically lower F1 scores and underrepresented categories.
 *
 * Distribution:
 *   BADGE:          20 entries — Credly, LinkedIn Learning, vendor micro-credentials
 *   ATTESTATION:    25 entries — employment verification, education verification, affidavits, income verification
 *   INSURANCE:      20 entries — COIs, bonds, policy declarations, cyber liability
 *   FINANCIAL:      20 entries — audit reports, tax forms, bank statements, financial statements
 *   International:  25 entries — non-US credentials (UK, EU, India, Japan, Australia, Brazil, Nigeria)
 *   PROFESSIONAL:   15 entries — fellowships, memberships, chartered designations
 *   MEDICAL:        10 entries — vaccination records, lab results, medical clearances
 *   MILITARY:       10 entries — DD-214, service records, veteran status letters
 *   OCR-corrupted:   5 entries — scanned versions of above types with heavy artifacts
 */

import type { GoldenDatasetEntry } from './types.js';

export const GOLDEN_DATASET_PHASE9: GoldenDatasetEntry[] = [
  // ============================================================
  // BADGE (20 entries) — GD-1331 to GD-1350
  // ============================================================
  {
    id: 'GD-1331',
    description: 'AWS Certified Solutions Architect - Associate badge via Credly',
    strippedText: 'Credly Badge Verification. Badge Name: AWS Certified Solutions Architect - Associate. Issuer: Amazon Web Services (AWS). Issued to: [NAME_REDACTED]. Issue Date: January 15, 2026. Expiration Date: January 15, 2029. Badge ID: [REDACTED]. Skills: Cloud Architecture, AWS Services, High Availability, Cost Optimization. This badge certifies that the earner has demonstrated the ability to design distributed systems on AWS.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Amazon Web Services', issuedDate: '2026-01-15', expiryDate: '2029-01-15', fieldOfStudy: 'Cloud Architecture', accreditingBody: 'Amazon Web Services', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'aws', 'credly'],
  },
  {
    id: 'GD-1332',
    description: 'Google Cloud Professional Data Engineer badge',
    strippedText: 'Google Cloud Certification. PROFESSIONAL DATA ENGINEER. Credential Holder: [NAME_REDACTED]. Credential ID: [REDACTED]. Issued: March 10, 2026. Expires: March 10, 2028. This certification validates the ability to design data processing systems, build machine learning models, and ensure quality on Google Cloud Platform.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Google Cloud', issuedDate: '2026-03-10', expiryDate: '2028-03-10', fieldOfStudy: 'Data Engineering', accreditingBody: 'Google Cloud', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'gcp'],
  },
  {
    id: 'GD-1333',
    description: 'LinkedIn Learning completion badge — Project Management',
    strippedText: 'LinkedIn Learning. Certificate of Completion. [NAME_REDACTED] has completed: Project Management Foundations. Instructor: [NAME_REDACTED]. Completion Date: February 22, 2026. Duration: 2 hours 45 minutes. LinkedIn Learning | A LinkedIn Company.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'LinkedIn Learning', issuedDate: '2026-02-22', fieldOfStudy: 'Project Management', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'linkedin'],
  },
  {
    id: 'GD-1334',
    description: 'Microsoft Certified: Azure Fundamentals badge',
    strippedText: 'Microsoft Certified. Azure Fundamentals. Certification Number: [REDACTED]. Awarded to: [NAME_REDACTED]. Achievement Date: November 8, 2025. Microsoft Corporation. This certification validates foundational knowledge of cloud services and how those services are provided with Microsoft Azure.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Microsoft', issuedDate: '2025-11-08', fieldOfStudy: 'Cloud Computing', accreditingBody: 'Microsoft', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'microsoft', 'azure'],
  },
  {
    id: 'GD-1335',
    description: 'Coursera Specialization badge — Machine Learning',
    strippedText: 'Coursera. SPECIALIZATION CERTIFICATE. [NAME_REDACTED] has successfully completed the Machine Learning Specialization offered by Stanford University & DeepLearning.AI on Coursera. Completed: December 1, 2025. Grade Achieved: 97.4%. Certificate URL: [REDACTED]. Verify at coursera.org/verify/[REDACTED].',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Coursera', issuedDate: '2025-12-01', fieldOfStudy: 'Machine Learning', accreditingBody: 'Stanford University', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'coursera'],
  },
  {
    id: 'GD-1336',
    description: 'Cisco CCNA badge via Credly',
    strippedText: 'Credly. Cisco Certified Network Associate (CCNA). Issued by Cisco. Earner: [NAME_REDACTED]. Issued: August 20, 2025. Expires: August 20, 2028. This badge holder has demonstrated knowledge of network fundamentals, network access, IP connectivity, IP services, security fundamentals, and automation.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Cisco', issuedDate: '2025-08-20', expiryDate: '2028-08-20', fieldOfStudy: 'Network Engineering', accreditingBody: 'Cisco', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'cisco', 'credly'],
  },
  {
    id: 'GD-1337',
    description: 'Kubernetes CKA badge from CNCF',
    strippedText: 'The Linux Foundation. CERTIFIED KUBERNETES ADMINISTRATOR (CKA). Certificate ID: [REDACTED]. Issued to [NAME_REDACTED]. Issue Date: 2026-01-03. Expiration Date: 2028-01-03. The Cloud Native Computing Foundation certifies that the above-named individual has passed the CKA exam.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'The Linux Foundation', issuedDate: '2026-01-03', expiryDate: '2028-01-03', fieldOfStudy: 'Container Orchestration', accreditingBody: 'Cloud Native Computing Foundation', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'kubernetes', 'cncf'],
  },
  {
    id: 'GD-1338',
    description: 'HubSpot Inbound Marketing badge',
    strippedText: 'HubSpot Academy. INBOUND MARKETING CERTIFICATION. [NAME_REDACTED] has successfully completed the Inbound Marketing Certification course and examination. Completed: March 15, 2026. Expires: March 15, 2028. Credential ID: [REDACTED]. HubSpot, Inc.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'HubSpot', issuedDate: '2026-03-15', expiryDate: '2028-03-15', fieldOfStudy: 'Inbound Marketing', accreditingBody: 'HubSpot', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'hubspot'],
  },
  {
    id: 'GD-1339',
    description: 'Tableau Desktop Specialist badge',
    strippedText: 'Tableau. Desktop Specialist. [NAME_REDACTED]. Certification Number: [REDACTED]. Date Achieved: October 2025. Tableau Software, LLC, a Salesforce company. This credential validates core skills in Tableau Desktop including connecting to data, simplifying and sorting data, and understanding Tableau concepts.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Tableau Software', issuedDate: '2025-10-01', fieldOfStudy: 'Data Visualization', accreditingBody: 'Tableau Software', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'tableau'],
  },
  {
    id: 'GD-1340',
    description: 'edX MicroMasters badge — Supply Chain Management',
    strippedText: 'edX. MicroMasters Program Certificate. Supply Chain Management. Awarded to [NAME_REDACTED]. MITx — Massachusetts Institute of Technology. Completed: January 28, 2026. This is to certify that [NAME_REDACTED] successfully completed all courses in the MicroMasters program in Supply Chain Management. Program ID: [REDACTED].',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'edX', issuedDate: '2026-01-28', fieldOfStudy: 'Supply Chain Management', accreditingBody: 'Massachusetts Institute of Technology', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'edx', 'mit'],
  },
  {
    id: 'GD-1341',
    description: 'Datadog Fundamentals badge',
    strippedText: 'Datadog Learning Center. Datadog Fundamentals. Badge earned by [NAME_REDACTED]. Date Earned: February 5, 2026. This badge demonstrates knowledge of Datadog platform fundamentals including monitoring, dashboards, alerts, and integrations. Datadog, Inc.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Datadog', issuedDate: '2026-02-05', fieldOfStudy: 'Observability', accreditingBody: 'Datadog', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'datadog'],
  },
  {
    id: 'GD-1342',
    description: 'HashiCorp Terraform Associate badge',
    strippedText: 'HashiCorp Certified: Terraform Associate (003). Certification ID: [REDACTED]. Holder: [NAME_REDACTED]. Issue Date: December 12, 2025. Expiration Date: December 12, 2027. HashiCorp, Inc. Validates the ability to understand Infrastructure as Code concepts and use Terraform Enterprise.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'HashiCorp', issuedDate: '2025-12-12', expiryDate: '2027-12-12', fieldOfStudy: 'Infrastructure as Code', accreditingBody: 'HashiCorp', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'hashicorp', 'terraform'],
  },
  {
    id: 'GD-1343',
    description: 'Snowflake SnowPro Core badge',
    strippedText: 'Snowflake. SnowPro Core Certification. Awarded to: [NAME_REDACTED]. Certification Date: January 20, 2026. Valid Through: January 20, 2028. Credential ID: [REDACTED]. Demonstrates knowledge of Snowflake features and capabilities, data loading, and performance concepts.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Snowflake', issuedDate: '2026-01-20', expiryDate: '2028-01-20', fieldOfStudy: 'Cloud Data Warehousing', accreditingBody: 'Snowflake', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'snowflake'],
  },
  {
    id: 'GD-1344',
    description: 'GitHub Actions badge',
    strippedText: 'GitHub Certification. GitHub Actions. Earner: [NAME_REDACTED]. Issued: March 1, 2026. Expires: March 1, 2029. Issuer: GitHub, Inc. This certification validates proficiency with GitHub Actions including CI/CD workflows, custom actions, and workflow optimization. Verified via Credly.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'GitHub', issuedDate: '2026-03-01', expiryDate: '2029-03-01', fieldOfStudy: 'CI/CD Automation', accreditingBody: 'GitHub', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'github'],
  },
  {
    id: 'GD-1345',
    description: 'Salesforce Platform Developer I badge',
    strippedText: 'Salesforce Certified Platform Developer I. Certificate Holder: [NAME_REDACTED]. Certification Date: September 30, 2025. Maintenance Due: September 30, 2026. Credential ID: [REDACTED]. Salesforce.com, inc. Validates knowledge of the declarative capabilities of the Salesforce Platform and the programmatic capabilities of Apex and Visualforce.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Salesforce', issuedDate: '2025-09-30', expiryDate: '2026-09-30', fieldOfStudy: 'CRM Development', accreditingBody: 'Salesforce', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'salesforce'],
  },
  {
    id: 'GD-1346',
    description: 'IBM Data Science Professional badge',
    strippedText: 'IBM. Professional Certificate. IBM Data Science. Earned by [NAME_REDACTED] on Coursera. Completion Date: November 15, 2025. This professional certificate validates skills in data science methodology, Python, SQL, data analysis, data visualization, and machine learning. Issued by IBM Skills Network.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'IBM', issuedDate: '2025-11-15', fieldOfStudy: 'Data Science', accreditingBody: 'IBM', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'ibm'],
  },
  {
    id: 'GD-1347',
    description: 'OWASP ZAP badge from TryHackMe',
    strippedText: 'TryHackMe. Room Completion Badge. OWASP ZAP. Completed by: [NAME_REDACTED]. Date: February 14, 2026. This badge confirms completion of the OWASP ZAP room, demonstrating knowledge of web application security testing using OWASP ZAP proxy tool. TryHackMe Ltd.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'TryHackMe', issuedDate: '2026-02-14', fieldOfStudy: 'Application Security', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'security'],
  },
  {
    id: 'GD-1348',
    description: 'Stripe Developer badge',
    strippedText: 'Stripe. Developer Certification. Certified Stripe Developer. [NAME_REDACTED]. Certification Date: March 5, 2026. This certification verifies proficiency in implementing Stripe APIs, payment processing, subscriptions, and Connect platform. Stripe, Inc. San Francisco, CA.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Stripe', issuedDate: '2026-03-05', fieldOfStudy: 'Payment Processing', accreditingBody: 'Stripe', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'stripe'],
  },
  {
    id: 'GD-1349',
    description: 'AWS Cloud Practitioner badge (entry-level)',
    strippedText: 'Amazon Web Services. AWS Certified Cloud Practitioner. Holder: [NAME_REDACTED]. Achieved: January 5, 2026. Valid Until: January 5, 2029. Validation Number: [REDACTED]. This credential validates an overall understanding of the AWS Cloud. Amazon Web Services, Inc.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Amazon Web Services', issuedDate: '2026-01-05', expiryDate: '2029-01-05', fieldOfStudy: 'Cloud Computing', accreditingBody: 'Amazon Web Services', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'aws'],
  },
  {
    id: 'GD-1350',
    description: 'Figma Community badge',
    strippedText: 'Figma. Community Contributor Badge. Awarded to [NAME_REDACTED]. Date: March 20, 2026. Recognized for significant contributions to the Figma community including published plugins, community files, and educational content. Figma, Inc.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Figma', issuedDate: '2026-03-20', fieldOfStudy: 'UI/UX Design', fraudSignals: [] },
    source: 'synthetic-badge', category: 'badge', tags: ['synthetic', 'badge', 'figma'],
  },

  // ============================================================
  // ATTESTATION (25 entries) — GD-1351 to GD-1375
  // ============================================================
  {
    id: 'GD-1351',
    description: 'Employment verification letter — tech company',
    strippedText: 'EMPLOYMENT VERIFICATION LETTER. Date: March 10, 2026. To Whom It May Concern: This letter confirms that [NAME_REDACTED] has been employed by [COMPANY_REDACTED] Technologies, Inc. as a Senior Software Engineer since June 1, 2021. Current annual salary: [SALARY_REDACTED]. Employment status: Full-time, active. This letter is issued upon request of the employee for mortgage purposes. Human Resources Department, [COMPANY_REDACTED] Technologies, Inc., San Francisco, CA 94105.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Technologies, Inc.', issuedDate: '2026-03-10', fieldOfStudy: 'Software Engineering', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'employment'],
  },
  {
    id: 'GD-1352',
    description: 'Education verification letter — university registrar',
    strippedText: 'OFFICE OF THE REGISTRAR. [UNIVERSITY_REDACTED] University. Date: February 15, 2026. Re: Education Verification for [NAME_REDACTED]. This is to certify that [NAME_REDACTED] attended [UNIVERSITY_REDACTED] University from August 2018 through May 2022 and was conferred a Bachelor of Science degree in Computer Science on May 15, 2022. GPA: [REDACTED]. This verification is provided by the Office of the Registrar.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[UNIVERSITY_REDACTED] University', issuedDate: '2026-02-15', fieldOfStudy: 'Computer Science', degreeLevel: 'Bachelor', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'education'],
  },
  {
    id: 'GD-1353',
    description: 'Sworn affidavit — notarized immigration support',
    strippedText: 'SWORN AFFIDAVIT. STATE OF NEW YORK. COUNTY OF KINGS. I, [NAME_REDACTED], being duly sworn, depose and say: 1. I am a resident of Brooklyn, New York. 2. I have known [NAME_REDACTED] for over ten (10) years. 3. [NAME_REDACTED] is a person of good moral character. 4. I am aware of their community involvement including volunteering at [ORGANIZATION_REDACTED]. Subscribed and sworn to before me this 5th day of January, 2026. [NAME_REDACTED], Notary Public, State of New York. Commission Expires: December 31, 2028.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuedDate: '2026-01-05', jurisdiction: 'New York, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'affidavit'],
  },
  {
    id: 'GD-1354',
    description: 'Income verification letter — bank requirement',
    strippedText: 'INCOME VERIFICATION. [COMPANY_REDACTED] Financial Group. March 20, 2026. To: [BANK_REDACTED] Mortgage Department. RE: Income Verification for [NAME_REDACTED]. We confirm that [NAME_REDACTED] is employed as Vice President, Investment Banking. Start date: September 2019. Employment type: Full-time. Base compensation: [AMOUNT_REDACTED]. This information is provided in good faith. Director of Human Resources, [COMPANY_REDACTED] Financial Group, New York, NY.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Financial Group', issuedDate: '2026-03-20', fieldOfStudy: 'Investment Banking', jurisdiction: 'New York, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'income'],
  },
  {
    id: 'GD-1355',
    description: 'Letter of good standing — state bar',
    strippedText: 'THE FLORIDA BAR. CERTIFICATE OF GOOD STANDING. This certifies that [NAME_REDACTED], Florida Bar Number: [REDACTED], is a member in good standing of The Florida Bar. Member has been admitted since May 10, 2015 and is currently eligible to practice law in the State of Florida. Date issued: March 1, 2026. [NAME_REDACTED], Executive Director, The Florida Bar.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'The Florida Bar', issuedDate: '2026-03-01', fieldOfStudy: 'Law', jurisdiction: 'Florida, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'good-standing'],
  },
  {
    id: 'GD-1356',
    description: 'Professional reference letter — academic',
    strippedText: 'Department of Electrical Engineering. [UNIVERSITY_REDACTED] Institute of Technology. January 30, 2026. Dear Hiring Committee: I am writing to provide a professional reference for [NAME_REDACTED], who served as a postdoctoral researcher in my laboratory from 2022 to 2025. During this time, [NAME_REDACTED] demonstrated exceptional research abilities in semiconductor physics and published four first-author papers. I give my highest recommendation. Sincerely, [NAME_REDACTED], Ph.D., Professor of Electrical Engineering.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[UNIVERSITY_REDACTED] Institute of Technology', issuedDate: '2026-01-30', fieldOfStudy: 'Electrical Engineering', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'reference'],
  },
  {
    id: 'GD-1357',
    description: 'Enrollment verification letter',
    strippedText: 'ENROLLMENT VERIFICATION. [UNIVERSITY_REDACTED] State University. Date: March 15, 2026. This is to verify that [NAME_REDACTED] is currently enrolled as a full-time student in the Master of Public Health program at [UNIVERSITY_REDACTED] State University. Expected graduation: May 2027. Current semester: Spring 2026. Credit hours enrolled: 15. Registrar Office.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[UNIVERSITY_REDACTED] State University', issuedDate: '2026-03-15', fieldOfStudy: 'Public Health', degreeLevel: 'Master', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'enrollment'],
  },
  {
    id: 'GD-1358',
    description: 'Tenant verification letter — landlord',
    strippedText: 'TENANT VERIFICATION. Date: February 28, 2026. To Whom It May Concern: This letter is to verify that [NAME_REDACTED] has been a tenant at [ADDRESS_REDACTED], Apartment 4B, Chicago, IL 60614, from August 2023 to present. Monthly rent: [AMOUNT_REDACTED]. Payment history: Consistently on-time. [NAME_REDACTED], Property Manager, [COMPANY_REDACTED] Property Management.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Property Management', issuedDate: '2026-02-28', jurisdiction: 'Illinois, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'tenant'],
  },
  {
    id: 'GD-1359',
    description: 'Medical board good standing letter',
    strippedText: 'STATE MEDICAL BOARD OF OHIO. LETTER OF GOOD STANDING. This certifies that [NAME_REDACTED], M.D., License No. [REDACTED], holds a current, unrestricted license to practice medicine in the State of Ohio. No disciplinary actions are pending. License originally issued: July 2017. Current expiration: June 30, 2027. Issued: March 5, 2026. Ohio State Medical Board.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'State Medical Board of Ohio', issuedDate: '2026-03-05', fieldOfStudy: 'Medicine', jurisdiction: 'Ohio, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'medical-board'],
  },
  {
    id: 'GD-1360',
    description: 'Court-ordered community service verification',
    strippedText: 'COMMUNITY SERVICE VERIFICATION. [ORGANIZATION_REDACTED] Homeless Shelter. March 18, 2026. This letter verifies that [NAME_REDACTED] completed 120 hours of community service at [ORGANIZATION_REDACTED] Homeless Shelter between January 15 and March 15, 2026, as ordered by the Municipal Court. Case No.: [REDACTED]. Supervisor: [NAME_REDACTED], Program Director.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[ORGANIZATION_REDACTED] Homeless Shelter', issuedDate: '2026-03-18', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'community-service'],
  },
  {
    id: 'GD-1361',
    description: 'Background check clearance letter',
    strippedText: 'BACKGROUND CHECK CLEARANCE. [COMPANY_REDACTED] Background Services, Inc. Report Date: March 22, 2026. Subject: [NAME_REDACTED]. We have completed a comprehensive background investigation and confirm: Criminal record check: CLEAR. Employment verification: CONFIRMED. Education verification: CONFIRMED. Credit check: SATISFACTORY. Reference checks: POSITIVE (3/3). This report is issued for employment purposes only.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Background Services, Inc.', issuedDate: '2026-03-22', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'background-check'],
  },
  {
    id: 'GD-1362',
    description: 'Volunteer service verification letter',
    strippedText: 'VOLUNTEER SERVICE VERIFICATION. [ORGANIZATION_REDACTED] Foundation. Date: January 15, 2026. This letter confirms that [NAME_REDACTED] has served as a volunteer with [ORGANIZATION_REDACTED] Foundation since September 2023. Role: Youth Mentoring Coordinator. Hours contributed: Approximately 500 hours. [NAME_REDACTED] has been an exceptional volunteer. Volunteer Coordinator, [ORGANIZATION_REDACTED] Foundation, Austin, TX.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[ORGANIZATION_REDACTED] Foundation', issuedDate: '2026-01-15', jurisdiction: 'Texas, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'volunteer'],
  },
  // GD-1363 through GD-1375 — more attestation variants
  {
    id: 'GD-1363',
    description: 'CPA good standing letter',
    strippedText: 'TEXAS STATE BOARD OF PUBLIC ACCOUNTANCY. CERTIFICATE OF GOOD STANDING. This is to certify that [NAME_REDACTED], CPA License No. [REDACTED], is a licensed Certified Public Accountant in good standing with the Texas State Board of Public Accountancy. License issued: January 2018. Expires: December 31, 2026. No disciplinary actions on record. Austin, Texas. March 8, 2026.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'Texas State Board of Public Accountancy', issuedDate: '2026-03-08', fieldOfStudy: 'Accounting', jurisdiction: 'Texas, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'cpa'],
  },
  {
    id: 'GD-1364',
    description: 'Immigration sponsorship letter',
    strippedText: 'EMPLOYER SPONSORSHIP LETTER. [COMPANY_REDACTED] Inc. March 25, 2026. U.S. Citizenship and Immigration Services. Re: H-1B Petition for [NAME_REDACTED]. Dear USCIS Officer: [COMPANY_REDACTED] Inc. hereby sponsors [NAME_REDACTED] for an H-1B visa. Position: Data Scientist. Annual wage: [AMOUNT_REDACTED]. The position requires a minimum of a Master\'s degree in Computer Science, Statistics, or related field. We confirm that [NAME_REDACTED] meets all requirements. [NAME_REDACTED], VP of People, [COMPANY_REDACTED] Inc., Seattle, WA.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Inc.', issuedDate: '2026-03-25', fieldOfStudy: 'Data Science', jurisdiction: 'Washington, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'immigration'],
  },
  {
    id: 'GD-1365',
    description: 'Teaching experience verification',
    strippedText: '[SCHOOL_REDACTED] Independent School District. VERIFICATION OF TEACHING EXPERIENCE. March 12, 2026. This verifies that [NAME_REDACTED] has been employed as a teacher in [SCHOOL_REDACTED] ISD since August 2019. Subjects taught: AP Chemistry, Physics. Certifications held: Texas Teacher Certificate, Chemistry 7-12. Years of service: 7. [NAME_REDACTED], HR Director.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[SCHOOL_REDACTED] Independent School District', issuedDate: '2026-03-12', fieldOfStudy: 'Chemistry', jurisdiction: 'Texas, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'teaching'],
  },
  {
    id: 'GD-1366',
    description: 'Internship completion letter',
    strippedText: 'INTERNSHIP COMPLETION CERTIFICATE. [COMPANY_REDACTED] Consulting Group. Date: December 20, 2025. This certifies that [NAME_REDACTED] successfully completed a 12-week Summer Analyst internship at [COMPANY_REDACTED] Consulting Group, Strategy & Operations practice. Period: June 10, 2025 - September 5, 2025. Performance rating: Exceeds Expectations. Office: Washington, D.C.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Consulting Group', issuedDate: '2025-12-20', fieldOfStudy: 'Strategy & Operations', jurisdiction: 'District of Columbia, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'internship'],
  },
  {
    id: 'GD-1367', description: 'Pharmacy board verification', strippedText: 'CALIFORNIA STATE BOARD OF PHARMACY. VERIFICATION OF LICENSURE. March 28, 2026. This verifies that [NAME_REDACTED] holds an active Pharmacist license (RPH [REDACTED]) in the State of California. Original issue: May 2020. Expiration: May 31, 2027. Status: Active, good standing. No pending disciplinary actions. Sacramento, California.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'California State Board of Pharmacy', issuedDate: '2026-03-28', fieldOfStudy: 'Pharmacy', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'pharmacy'],
  },
  {
    id: 'GD-1368', description: 'Clergy ordination verification', strippedText: 'DIOCESE OF CHICAGO. VERIFICATION OF ORDINATION. To Whom It May Concern: This letter verifies that [NAME_REDACTED] was ordained as a priest in the Episcopal Diocese of Chicago on June 15, 2019. [NAME_REDACTED] currently serves as Rector of [CHURCH_REDACTED] Episcopal Church. This verification is issued March 3, 2026. The Rt. Rev. [NAME_REDACTED], Bishop of Chicago.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'Diocese of Chicago', issuedDate: '2026-03-03', jurisdiction: 'Illinois, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'clergy'],
  },
  {
    id: 'GD-1369', description: 'Security clearance verification', strippedText: 'DEPARTMENT OF DEFENSE. DEFENSE COUNTERINTELLIGENCE AND SECURITY AGENCY. SECURITY CLEARANCE VERIFICATION. Date: March 15, 2026. This verifies that [NAME_REDACTED] holds an active SECRET security clearance. Investigation type: Tier 3. Adjudicated: October 2024. Periodic reinvestigation due: October 2029. This information is For Official Use Only (FOUO).', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'Defense Counterintelligence and Security Agency', issuedDate: '2026-03-15', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'security-clearance'],
  },
  {
    id: 'GD-1370', description: 'Disability accommodation letter', strippedText: 'OFFICE OF DISABILITY SERVICES. [UNIVERSITY_REDACTED] University. March 5, 2026. To Course Instructors: [NAME_REDACTED] is registered with the Office of Disability Services and is approved for the following accommodations: extended testing time (1.5x), distraction-reduced testing environment, and note-taking assistance. These accommodations are effective for the Spring 2026 semester. Director, Office of Disability Services.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[UNIVERSITY_REDACTED] University', issuedDate: '2026-03-05', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'disability'],
  },
  {
    id: 'GD-1371', description: 'Work authorization verification (I-9)', strippedText: 'EMPLOYMENT ELIGIBILITY VERIFICATION (I-9 SUPPLEMENT). [COMPANY_REDACTED] Corp. Date: January 8, 2026. This confirms that [NAME_REDACTED] has provided documentation establishing identity and employment eligibility as required by the Immigration and Nationality Act. Documents reviewed: U.S. Passport (List A). Employment authorized through: Indefinite (U.S. citizen). Verified by: [NAME_REDACTED], HR Manager.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Corp.', issuedDate: '2026-01-08', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'work-auth'],
  },
  {
    id: 'GD-1372', description: 'Board certification verification — ABIM', strippedText: 'AMERICAN BOARD OF INTERNAL MEDICINE. VERIFICATION OF CERTIFICATION. Date: March 18, 2026. We confirm that [NAME_REDACTED], MD is certified by the American Board of Internal Medicine in the specialty of Cardiovascular Disease. Initial certification: 2019. Certification valid through: 2029. Maintaining Certification (MOC) status: Participating. ABIM, Philadelphia, PA 19104.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'American Board of Internal Medicine', issuedDate: '2026-03-18', fieldOfStudy: 'Cardiovascular Disease', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'medical-board'],
  },
  {
    id: 'GD-1373', description: 'Professional engineering reference', strippedText: '[COMPANY_REDACTED] Engineering Associates. March 10, 2026. To the State Board of Professional Engineers: RE: Professional Reference for [NAME_REDACTED], PE Application. I, [NAME_REDACTED], PE, License #[REDACTED], have directly supervised the engineering work of [NAME_REDACTED] for the past four years at [COMPANY_REDACTED] Engineering Associates. [NAME_REDACTED] has demonstrated competence in structural engineering design, including steel and concrete structures. I recommend approval of the PE application. [NAME_REDACTED], PE, Principal Engineer.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Engineering Associates', issuedDate: '2026-03-10', fieldOfStudy: 'Structural Engineering', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'pe-reference'],
  },
  {
    id: 'GD-1374', description: 'Dental license verification', strippedText: 'DENTAL BOARD OF CALIFORNIA. LICENSE VERIFICATION. March 22, 2026. This verifies that [NAME_REDACTED], DDS, holds an active dental license in California. License No.: [REDACTED]. Type: Dentist. Issued: August 2016. Expires: March 31, 2028. Status: Active, current. No disciplinary history. Contact: [PHONE_REDACTED]. Sacramento, CA 95814.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: 'Dental Board of California', issuedDate: '2026-03-22', fieldOfStudy: 'Dentistry', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'dental'],
  },
  {
    id: 'GD-1375', description: 'Audit committee attestation', strippedText: '[COMPANY_REDACTED] Corporation. AUDIT COMMITTEE ATTESTATION. Fiscal Year 2025. The Audit Committee of the Board of Directors of [COMPANY_REDACTED] Corporation hereby attests that: (1) the committee has reviewed the audited financial statements for FY2025; (2) the committee has met with the independent auditors; (3) the committee recommends inclusion of the audited financials in the Annual Report. Date: February 28, 2026. [NAME_REDACTED], Chair, Audit Committee.', credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Corporation', issuedDate: '2026-02-28', fieldOfStudy: 'Financial Audit', fraudSignals: [] },
    source: 'synthetic-attestation', category: 'attestation', tags: ['synthetic', 'attestation', 'audit-committee'],
  },

  // ============================================================
  // INSURANCE (20 entries) — GD-1376 to GD-1395
  // ============================================================
  {
    id: 'GD-1376',
    description: 'Commercial General Liability COI',
    strippedText: 'CERTIFICATE OF LIABILITY INSURANCE. DATE (MM/DD/YYYY): 03/01/2026. THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY. PRODUCER: [AGENT_REDACTED] Insurance Agency. INSURED: [COMPANY_REDACTED] Construction LLC. INSURER A: Hartford Fire Insurance Company. POLICY NUMBER: [REDACTED]. EFFECTIVE DATE: 01/01/2026. EXPIRATION DATE: 01/01/2027. TYPE OF INSURANCE: COMMERCIAL GENERAL LIABILITY. EACH OCCURRENCE: $1,000,000. GENERAL AGGREGATE: $2,000,000.',
    credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Hartford Fire Insurance Company', issuedDate: '2026-01-01', expiryDate: '2027-01-01', fieldOfStudy: 'Commercial General Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'coi', 'cgl'],
  },
  {
    id: 'GD-1377',
    description: 'Professional Liability (E&O) insurance',
    strippedText: 'CERTIFICATE OF INSURANCE. Professional Liability / Errors & Omissions. Insurer: Chubb Insurance Company. Policy No.: [REDACTED]. Named Insured: [COMPANY_REDACTED] Consulting Group. Effective Date: April 1, 2026. Expiration Date: April 1, 2027. Limit of Liability: $5,000,000 each claim / $10,000,000 aggregate. Deductible: $25,000. Retroactive Date: April 1, 2020. Certificate Holder: [COMPANY_REDACTED] Financial Corp.',
    credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Chubb Insurance Company', issuedDate: '2026-04-01', expiryDate: '2027-04-01', fieldOfStudy: 'Professional Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'eo'],
  },
  {
    id: 'GD-1378',
    description: 'Workers Compensation insurance certificate',
    strippedText: 'WORKERS COMPENSATION CERTIFICATE. Insurer: Liberty Mutual Insurance Company. Policy Number: [REDACTED]. Employer: [COMPANY_REDACTED] Manufacturing, Inc. Effective: July 1, 2025. Expires: July 1, 2026. State: Ohio. WC STATUTORY LIMITS. EMPLOYERS LIABILITY: $1,000,000 EACH ACCIDENT / $1,000,000 DISEASE-EA EMPLOYEE / $1,000,000 DISEASE-POLICY LIMIT.',
    credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Liberty Mutual Insurance Company', issuedDate: '2025-07-01', expiryDate: '2026-07-01', fieldOfStudy: 'Workers Compensation', jurisdiction: 'Ohio, USA', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'workers-comp'],
  },
  {
    id: 'GD-1379',
    description: 'Cyber Liability insurance',
    strippedText: 'CYBER LIABILITY INSURANCE CERTIFICATE. Insurer: Beazley Insurance Company, Inc. Policy #: [REDACTED]. Named Insured: [COMPANY_REDACTED] Tech, Inc. Policy Period: 01/01/2026 to 01/01/2027. Aggregate Limit: $10,000,000. Coverage includes: Data Breach Response, Network Security Liability, Regulatory Defense & Penalties, PCI Fines & Assessments, Media Liability. Retention: $50,000.',
    credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Beazley Insurance Company', issuedDate: '2026-01-01', expiryDate: '2027-01-01', fieldOfStudy: 'Cyber Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'cyber'],
  },
  {
    id: 'GD-1380',
    description: 'Surety bond — contractor license',
    strippedText: 'CONTRACTOR LICENSE BOND. Bond Number: [REDACTED]. Principal: [COMPANY_REDACTED] Builders, Inc. Surety: Travelers Casualty and Surety Company of America. Obligee: California Contractors State License Board. Bond Amount: $25,000. Effective Date: February 15, 2026. This bond is conditioned upon the faithful performance by the principal of all obligations under California Business and Professions Code Section 7071.6.',
    credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Travelers Casualty and Surety Company of America', issuedDate: '2026-02-15', fieldOfStudy: 'License Bond', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'surety-bond'],
  },
  {
    id: 'GD-1381', description: 'Directors & Officers (D&O) insurance', strippedText: 'D&O INSURANCE CERTIFICATE. Insurer: AIG (American International Group). Policy #: [REDACTED]. Named Entity: [COMPANY_REDACTED] Inc. Policy Period: 03/01/2026 - 03/01/2027. Side A DIC Limit: $10,000,000. Side A/B/C Limit: $25,000,000. Retention: $500,000. Coverage: Directors and Officers Liability, Entity Coverage, Employment Practices Liability.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'American International Group', issuedDate: '2026-03-01', expiryDate: '2027-03-01', fieldOfStudy: 'Directors & Officers Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'do'],
  },
  {
    id: 'GD-1382', description: 'Auto fleet insurance', strippedText: 'COMMERCIAL AUTOMOBILE INSURANCE. Insurer: Progressive Commercial. Policy: [REDACTED]. Named Insured: [COMPANY_REDACTED] Delivery Services, LLC. Effective: 06/15/2025. Expires: 06/15/2026. COMBINED SINGLE LIMIT: $1,000,000. UNINSURED MOTORIST: $1,000,000. Hired autos: YES. Non-owned autos: YES. Number of vehicles: 45.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Progressive Commercial', issuedDate: '2025-06-15', expiryDate: '2026-06-15', fieldOfStudy: 'Commercial Automobile', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'auto'],
  },
  {
    id: 'GD-1383', description: 'Umbrella liability policy', strippedText: 'COMMERCIAL UMBRELLA LIABILITY. Insurer: Zurich Insurance Company Ltd. Policy Number: [REDACTED]. Insured: [COMPANY_REDACTED] Corp. Effective: 01/01/2026. Expiration: 01/01/2027. Each Occurrence: $5,000,000. Aggregate: $5,000,000. Underlying policies: CGL, Auto, Employers Liability. Self-insured retention: $10,000.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Zurich Insurance Company', issuedDate: '2026-01-01', expiryDate: '2027-01-01', fieldOfStudy: 'Umbrella Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'umbrella'],
  },
  {
    id: 'GD-1384', description: 'Health insurance ID card', strippedText: 'HEALTH INSURANCE. Blue Cross Blue Shield of Illinois. Member: [NAME_REDACTED]. Member ID: [REDACTED]. Group Number: [REDACTED]. Plan: PPO Blue Choice. Effective Date: 01/01/2026. PCP Copay: $30. Specialist Copay: $50. ER Copay: $250. Pharmacy: $10/$30/$50. Customer Service: 1-800-XXX-XXXX.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Blue Cross Blue Shield of Illinois', issuedDate: '2026-01-01', fieldOfStudy: 'Health Insurance', jurisdiction: 'Illinois, USA', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'health'],
  },
  {
    id: 'GD-1385', description: 'Property insurance declaration', strippedText: 'PROPERTY INSURANCE DECLARATIONS PAGE. Insurer: State Farm Fire and Casualty Company. Policy: [REDACTED]. Named Insured: [NAME_REDACTED]. Property: [ADDRESS_REDACTED], Austin, TX 78704. Policy Period: 08/15/2025 to 08/15/2026. Dwelling Coverage (A): $450,000. Personal Property (C): $225,000. Loss of Use (D): $90,000. Deductible: $2,500 wind/hail, $1,000 all other.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'State Farm Fire and Casualty Company', issuedDate: '2025-08-15', expiryDate: '2026-08-15', fieldOfStudy: 'Property Insurance', jurisdiction: 'Texas, USA', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'property'],
  },
  // GD-1386 through GD-1395 — more insurance variants
  {
    id: 'GD-1386', description: 'Marine cargo insurance', strippedText: 'MARINE CARGO INSURANCE CERTIFICATE. Certificate No.: [REDACTED]. Insurer: Lloyd\'s of London. Assured: [COMPANY_REDACTED] Import/Export LLC. Voyage: Shanghai to Los Angeles. Vessel: M/V [VESSEL_REDACTED]. Sailing Date: March 15, 2026. Sum Insured: $2,500,000. Conditions: Institute Cargo Clauses (A). War Risks: Included.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Lloyd\'s of London', issuedDate: '2026-03-15', fieldOfStudy: 'Marine Cargo', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'marine'],
  },
  {
    id: 'GD-1387', description: 'Builder\'s risk insurance', strippedText: 'BUILDER\'S RISK INSURANCE. Insurer: Nationwide Mutual Insurance Company. Policy: [REDACTED]. Named Insured: [COMPANY_REDACTED] Development Corp. Project: [ADDRESS_REDACTED] Mixed-Use Development. Policy Period: 02/01/2026 - 02/01/2028. Building Limit: $35,000,000. Soft Costs: $5,000,000. Deductible: $25,000.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Nationwide Mutual Insurance Company', issuedDate: '2026-02-01', expiryDate: '2028-02-01', fieldOfStudy: 'Builder\'s Risk', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'builders-risk'],
  },
  {
    id: 'GD-1388', description: 'Medical malpractice insurance', strippedText: 'MEDICAL PROFESSIONAL LIABILITY INSURANCE. Insurer: The Doctors Company. Policy No.: [REDACTED]. Insured: [NAME_REDACTED], M.D. Specialty: Orthopedic Surgery. Effective: 07/01/2025. Expires: 07/01/2026. Limits: $1,000,000 / $3,000,000. Occurrence Form. State: California. Tail coverage available upon retirement.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'The Doctors Company', issuedDate: '2025-07-01', expiryDate: '2026-07-01', fieldOfStudy: 'Medical Professional Liability', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'malpractice'],
  },
  {
    id: 'GD-1389', description: 'Fidelity bond (employee dishonesty)', strippedText: 'FIDELITY BOND. Bond Type: Commercial Crime / Employee Dishonesty. Surety: Great American Insurance Company. Principal: [COMPANY_REDACTED] Credit Union. Bond Amount: $5,000,000. Effective Date: 01/01/2026. Coverage: Employee theft, forgery or alteration, computer fraud, funds transfer fraud. Deductible: $50,000.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Great American Insurance Company', issuedDate: '2026-01-01', fieldOfStudy: 'Fidelity Bond', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'fidelity-bond'],
  },
  {
    id: 'GD-1390', description: 'Life insurance policy summary', strippedText: 'TERM LIFE INSURANCE — POLICY SUMMARY. Insurer: MetLife Insurance Company. Policy Number: [REDACTED]. Insured: [NAME_REDACTED]. Issue Date: September 1, 2023. Term: 20 years. Face Amount: $1,000,000. Premium: [AMOUNT_REDACTED]/month. Beneficiary: [NAME_REDACTED]. Underwriting Class: Preferred Non-Tobacco.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'MetLife Insurance Company', issuedDate: '2023-09-01', fieldOfStudy: 'Life Insurance', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'life'],
  },
  {
    id: 'GD-1391', description: 'Disability insurance', strippedText: 'LONG-TERM DISABILITY INSURANCE. Carrier: Unum Group. Group Policy: [REDACTED]. Certificate Holder: [NAME_REDACTED]. Employer: [COMPANY_REDACTED] Inc. Effective Date: January 1, 2026. Elimination Period: 90 days. Benefit: 60% of monthly earnings to max $15,000. Maximum Benefit Period: To age 65. Own Occupation Period: 24 months.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Unum Group', issuedDate: '2026-01-01', fieldOfStudy: 'Disability Insurance', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'disability'],
  },
  {
    id: 'GD-1392', description: 'Product liability insurance', strippedText: 'PRODUCTS LIABILITY INSURANCE CERTIFICATE. Insurer: ACE American Insurance Company (Chubb). Policy: [REDACTED]. Insured: [COMPANY_REDACTED] Electronics, Inc. Period: 04/01/2026 - 04/01/2027. Products/Completed Operations Aggregate: $5,000,000. Each Occurrence: $2,000,000. Coverage Territory: Worldwide.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'ACE American Insurance Company', issuedDate: '2026-04-01', expiryDate: '2027-04-01', fieldOfStudy: 'Product Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'product-liability'],
  },
  {
    id: 'GD-1393', description: 'Pollution liability insurance', strippedText: 'ENVIRONMENTAL / POLLUTION LIABILITY. Insurer: Ironshore Specialty Insurance Company. Policy No.: [REDACTED]. Named Insured: [COMPANY_REDACTED] Chemical Processing, LLC. Policy Period: 05/01/2025 to 05/01/2028. Limit of Liability: $10,000,000. Self-Insured Retention: $100,000. Coverage: Pollution conditions, transportation, non-owned disposal sites.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Ironshore Specialty Insurance Company', issuedDate: '2025-05-01', expiryDate: '2028-05-01', fieldOfStudy: 'Environmental Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'pollution'],
  },
  {
    id: 'GD-1394', description: 'EPLI insurance', strippedText: 'EMPLOYMENT PRACTICES LIABILITY INSURANCE. Insurer: Hiscox Insurance Company. Policy Number: [REDACTED]. Named Insured: [COMPANY_REDACTED] Tech Startup, Inc. Effective: 01/01/2026. Expiration: 01/01/2027. Each Claim Limit: $2,000,000. Aggregate: $2,000,000. Retention: $15,000. Covers: Wrongful termination, discrimination, harassment, retaliation.', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Hiscox Insurance Company', issuedDate: '2026-01-01', expiryDate: '2027-01-01', fieldOfStudy: 'Employment Practices Liability', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'epli'],
  },
  {
    id: 'GD-1395', description: 'Commercial property insurance', strippedText: 'COMMERCIAL PROPERTY POLICY. Insurer: Travelers Property Casualty Company of America. Policy No.: [REDACTED]. Named Insured: [COMPANY_REDACTED] Retail Corp. Location: [ADDRESS_REDACTED], Miami, FL 33130. Effective: 09/01/2025. Expires: 09/01/2026. Building: $8,000,000. Business Personal Property: $2,000,000. Business Income: $1,500,000. Deductible: $5,000 ($25,000 named storm).', credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Travelers Property Casualty Company of America', issuedDate: '2025-09-01', expiryDate: '2026-09-01', fieldOfStudy: 'Commercial Property', jurisdiction: 'Florida, USA', fraudSignals: [] },
    source: 'synthetic-insurance', category: 'insurance', tags: ['synthetic', 'insurance', 'commercial-property'],
  },

  // ============================================================
  // INTERNATIONAL CREDENTIALS (25 entries) — GD-1396 to GD-1420
  // ============================================================
  {
    id: 'GD-1396',
    description: 'UK solicitor practicing certificate — SRA',
    strippedText: 'SOLICITORS REGULATION AUTHORITY. PRACTISING CERTIFICATE. This certifies that [NAME_REDACTED] holds a current practising certificate issued by the Solicitors Regulation Authority. SRA ID: [REDACTED]. Period: 1 November 2025 to 31 October 2026. Conditions: None. Practising status: In practice. Type of practice: Solicitor. The SRA is the independent regulatory body of the Law Society of England and Wales.',
    credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Solicitors Regulation Authority', issuedDate: '2025-11-01', expiryDate: '2026-10-31', fieldOfStudy: 'Law', jurisdiction: 'United Kingdom', accreditingBody: 'Law Society of England and Wales', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'uk', 'license'],
  },
  {
    id: 'GD-1397',
    description: 'German engineering degree — TU Munich',
    strippedText: 'TECHNISCHE UNIVERSITÄT MÜNCHEN. URKUNDE. Die Technische Universität München verleiht [NAME_REDACTED] den akademischen Grad Master of Science (M.Sc.) im Studiengang Informatik. München, den 15. Juli 2025. Der Präsident der Technischen Universität München. [NAME_REDACTED], Dekan der Fakultät für Informatik.',
    credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Technische Universität München', issuedDate: '2025-07-15', fieldOfStudy: 'Computer Science', degreeLevel: 'Master', jurisdiction: 'Germany', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'germany', 'degree'],
  },
  {
    id: 'GD-1398',
    description: 'Indian engineering degree — IIT Bombay',
    strippedText: 'INDIAN INSTITUTE OF TECHNOLOGY BOMBAY. This is to certify that [NAME_REDACTED] has been conferred the degree of Bachelor of Technology (B.Tech.) in Electrical Engineering at the [NUMBER_REDACTED]th Convocation held on August 10, 2025. Roll No.: [REDACTED]. CPI: [REDACTED]. Director, IIT Bombay. Registrar.',
    credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Indian Institute of Technology Bombay', issuedDate: '2025-08-10', fieldOfStudy: 'Electrical Engineering', degreeLevel: 'Bachelor', jurisdiction: 'India', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'india', 'degree'],
  },
  {
    id: 'GD-1399',
    description: 'Japanese language proficiency certificate — JLPT N1',
    strippedText: 'JAPAN FOUNDATION. THE JAPAN EDUCATIONAL EXCHANGES AND SERVICES. JAPANESE-LANGUAGE PROFICIENCY TEST. CERTIFICATE. This is to certify that [NAME_REDACTED] passed Level N1 of the Japanese-Language Proficiency Test held on July 6, 2025. Score: [REDACTED]/180. Certificate No.: [REDACTED]. December 2025.',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: { credentialType: 'CERTIFICATE', issuerName: 'Japan Foundation', issuedDate: '2025-12-01', fieldOfStudy: 'Japanese Language', jurisdiction: 'Japan', accreditingBody: 'Japan Educational Exchanges and Services', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'japan', 'language'],
  },
  {
    id: 'GD-1400',
    description: 'Australian nursing registration — AHPRA',
    strippedText: 'NURSING AND MIDWIFERY BOARD OF AUSTRALIA. REGISTRATION CERTIFICATE. Registrant: [NAME_REDACTED]. Registration Type: Registered Nurse — Division 1. Registration Number: [REDACTED]. Status: Registered. Conditions: Nil. Undertakings: Nil. Reprimands: Nil. Expiry: 31 May 2027. This registration is regulated by the Australian Health Practitioner Regulation Agency (AHPRA).',
    credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Nursing and Midwifery Board of Australia', expiryDate: '2027-05-31', fieldOfStudy: 'Nursing', jurisdiction: 'Australia', accreditingBody: 'AHPRA', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'australia', 'nursing'],
  },
  {
    id: 'GD-1401',
    description: 'Brazilian law degree — USP',
    strippedText: 'UNIVERSIDADE DE SÃO PAULO. FACULDADE DE DIREITO. DIPLOMA. A Universidade de São Paulo confere a [NAME_REDACTED] o grau de Bacharel em Direito, tendo concluído o curso em 15 de dezembro de 2025. São Paulo, 20 de janeiro de 2026. Reitor da Universidade de São Paulo. Diretor da Faculdade de Direito.',
    credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Universidade de São Paulo', issuedDate: '2026-01-20', fieldOfStudy: 'Law', degreeLevel: 'Bachelor', jurisdiction: 'Brazil', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'brazil', 'degree'],
  },
  {
    id: 'GD-1402',
    description: 'Nigerian medical license — MDCN',
    strippedText: 'MEDICAL AND DENTAL COUNCIL OF NIGERIA. CERTIFICATE OF FULL REGISTRATION. This is to certify that [NAME_REDACTED], having fulfilled all requirements prescribed by the Medical and Dental Practitioners Act, has been registered as a Medical Practitioner. Registration No.: [REDACTED]. Date of Registration: March 1, 2023. Valid until: February 28, 2026. Registrar, MDCN. Abuja, Nigeria.',
    credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Medical and Dental Council of Nigeria', issuedDate: '2023-03-01', expiryDate: '2026-02-28', fieldOfStudy: 'Medicine', jurisdiction: 'Nigeria', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'nigeria', 'medical'],
  },
  {
    id: 'GD-1403',
    description: 'French diploma — Sorbonne University',
    strippedText: 'SORBONNE UNIVERSITÉ. DIPLÔME. Le Président de Sorbonne Université certifie que [NAME_REDACTED] a obtenu le diplôme de Master Sciences et Technologies, mention Mathématiques et Applications, spécialité Probabilités et Modèles Aléatoires. Délivré à Paris, le 30 septembre 2025. Le Président, Le Directeur de la Formation.',
    credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Sorbonne Université', issuedDate: '2025-09-30', fieldOfStudy: 'Mathematics and Applications', degreeLevel: 'Master', jurisdiction: 'France', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'france', 'degree'],
  },
  {
    id: 'GD-1404',
    description: 'Canadian CPA designation — CPA Ontario',
    strippedText: 'CPA ONTARIO. CHARTERED PROFESSIONAL ACCOUNTANT. This certifies that [NAME_REDACTED] has met all requirements and is granted the designation of Chartered Professional Accountant (CPA). Member Number: [REDACTED]. Effective Date: October 1, 2025. CPA Ontario is the regulator of the accounting profession in Ontario, Canada. Chief Executive Officer, CPA Ontario. Toronto, Ontario.',
    credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'CPA Ontario', issuedDate: '2025-10-01', fieldOfStudy: 'Chartered Accountancy', jurisdiction: 'Canada', accreditingBody: 'CPA Ontario', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'canada', 'cpa'],
  },
  {
    id: 'GD-1405',
    description: 'Singapore medical registration — SMC',
    strippedText: 'SINGAPORE MEDICAL COUNCIL. CERTIFICATE OF REGISTRATION. This is to certify that [NAME_REDACTED] has been registered as a Medical Practitioner under the Medical Registration Act. MCR No.: [REDACTED]. Date of Registration: 15 January 2024. Practicing Certificate Valid: 1 January 2026 to 31 December 2026. Specialty: General Surgery. Singapore Medical Council.',
    credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Singapore Medical Council', issuedDate: '2024-01-15', expiryDate: '2026-12-31', fieldOfStudy: 'General Surgery', jurisdiction: 'Singapore', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'singapore', 'medical'],
  },
  {
    id: 'GD-1406', description: 'Korean university degree — KAIST', strippedText: 'KOREA ADVANCED INSTITUTE OF SCIENCE AND TECHNOLOGY (KAIST). DIPLOMA. This is to certify that [NAME_REDACTED] has completed the prescribed course of study and has been conferred the degree of Doctor of Philosophy in Artificial Intelligence. Date of Conferment: February 20, 2026. President, KAIST. Daejeon, Republic of Korea.', credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Korea Advanced Institute of Science and Technology', issuedDate: '2026-02-20', fieldOfStudy: 'Artificial Intelligence', degreeLevel: 'Doctor', jurisdiction: 'South Korea', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'korea', 'phd'],
  },
  {
    id: 'GD-1407', description: 'UK chartered accountant — ICAEW', strippedText: 'THE INSTITUTE OF CHARTERED ACCOUNTANTS IN ENGLAND AND WALES. CERTIFICATE OF MEMBERSHIP. This certifies that [NAME_REDACTED] has been admitted as a member of The Institute of Chartered Accountants in England and Wales and is entitled to use the designatory letters ACA. Membership No.: [REDACTED]. Date of Admission: November 15, 2025. Chief Executive, ICAEW. Chartered Accountants\' Hall, London.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'The Institute of Chartered Accountants in England and Wales', issuedDate: '2025-11-15', fieldOfStudy: 'Chartered Accountancy', jurisdiction: 'United Kingdom', accreditingBody: 'ICAEW', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'uk', 'accountant'],
  },
  {
    id: 'GD-1408', description: 'Dutch engineering degree — TU Delft', strippedText: 'TECHNISCHE UNIVERSITEIT DELFT. DIPLOMA. De Technische Universiteit Delft verklaart dat [NAME_REDACTED] de graad van Master of Science in de studierichting Civil Engineering heeft behaald. Uitgereikt te Delft op 30 januari 2026. De Rector Magnificus. De Secretaris.', credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Technische Universiteit Delft', issuedDate: '2026-01-30', fieldOfStudy: 'Civil Engineering', degreeLevel: 'Master', jurisdiction: 'Netherlands', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'netherlands', 'degree'],
  },
  {
    id: 'GD-1409', description: 'Israeli bar admission — Israel Bar Association', strippedText: 'THE ISRAEL BAR ASSOCIATION. CERTIFICATE OF ADMISSION. This is to certify that [NAME_REDACTED] has been admitted as a member of the Israel Bar Association pursuant to the Bar Association Law. Member No.: [REDACTED]. Date of Admission: December 1, 2025. The Israel Bar Association, Tel Aviv, Israel.', credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'The Israel Bar Association', issuedDate: '2025-12-01', fieldOfStudy: 'Law', jurisdiction: 'Israel', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'israel', 'bar'],
  },
  {
    id: 'GD-1410', description: 'Mexican medical degree — UNAM', strippedText: 'UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO. TÍTULO PROFESIONAL. La Universidad Nacional Autónoma de México, por medio de la Dirección General de Incorporación y Revalidación de Estudios, certifica que [NAME_REDACTED] ha concluido los estudios correspondientes a la carrera de Médico Cirujano. Cédula Profesional No.: [REDACTED]. Ciudad de México, 15 de marzo de 2026.', credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Universidad Nacional Autónoma de México', issuedDate: '2026-03-15', fieldOfStudy: 'Medicine', degreeLevel: 'Doctor', jurisdiction: 'Mexico', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'mexico', 'medical'],
  },
  {
    id: 'GD-1411', description: 'Swiss banking certification — SBVg/SBA', strippedText: 'SWISS BANKERS ASSOCIATION. CERTIFICATE. This certifies that [NAME_REDACTED] has successfully completed the Certified Wealth Management Advisor (CWMA) program administered by the Swiss Bankers Association in cooperation with the Swiss Finance Institute. Certificate No.: [REDACTED]. Date: October 2025. Zurich, Switzerland.', credentialTypeHint: 'CERTIFICATE',
    groundTruth: { credentialType: 'CERTIFICATE', issuerName: 'Swiss Bankers Association', issuedDate: '2025-10-01', fieldOfStudy: 'Wealth Management', jurisdiction: 'Switzerland', accreditingBody: 'Swiss Finance Institute', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'switzerland', 'banking'],
  },
  {
    id: 'GD-1412', description: 'South African chartered accountant — SAICA', strippedText: 'THE SOUTH AFRICAN INSTITUTE OF CHARTERED ACCOUNTANTS. MEMBERSHIP CERTIFICATE. This certifies that [NAME_REDACTED] is a member in good standing of the South African Institute of Chartered Accountants (SAICA) and is entitled to use the designation CA(SA). Membership No.: [REDACTED]. Date of Admission: March 2025. Johannesburg, South Africa.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'The South African Institute of Chartered Accountants', issuedDate: '2025-03-01', fieldOfStudy: 'Chartered Accountancy', jurisdiction: 'South Africa', accreditingBody: 'SAICA', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'south-africa', 'accountant'],
  },
  {
    id: 'GD-1413', description: 'UAE engineering license — Abu Dhabi DOE', strippedText: 'ABU DHABI DEPARTMENT OF ECONOMIC DEVELOPMENT. PROFESSIONAL LICENSE. License Type: Engineering Consultancy. License No.: [REDACTED]. Company: [COMPANY_REDACTED] Engineering Consultants LLC. Activities: Civil Engineering Consultancy, Structural Engineering. Issue Date: 01/01/2026. Expiry Date: 31/12/2026. Abu Dhabi, United Arab Emirates.', credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Abu Dhabi Department of Economic Development', issuedDate: '2026-01-01', expiryDate: '2026-12-31', fieldOfStudy: 'Civil Engineering', jurisdiction: 'United Arab Emirates', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'uae', 'engineering'],
  },
  {
    id: 'GD-1414', description: 'Hong Kong CPA — HKICPA', strippedText: 'HONG KONG INSTITUTE OF CERTIFIED PUBLIC ACCOUNTANTS. PRACTISING CERTIFICATE. This certifies that [NAME_REDACTED] holds a valid practising certificate issued by the Hong Kong Institute of Certified Public Accountants. CPA No.: [REDACTED]. Valid from: 1 January 2026 to 31 December 2026. HKICPA, Hong Kong SAR.', credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Hong Kong Institute of Certified Public Accountants', issuedDate: '2026-01-01', expiryDate: '2026-12-31', fieldOfStudy: 'Certified Public Accountancy', jurisdiction: 'Hong Kong', accreditingBody: 'HKICPA', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'hong-kong', 'cpa'],
  },
  {
    id: 'GD-1415', description: 'Indian CA — ICAI', strippedText: 'THE INSTITUTE OF CHARTERED ACCOUNTANTS OF INDIA. MEMBERSHIP CERTIFICATE. This certifies that [NAME_REDACTED] has been admitted as a Fellow Member of The Institute of Chartered Accountants of India and is entitled to use the designation FCA. Membership No.: [REDACTED]. Date of Fellowship: August 15, 2025. New Delhi, India.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'The Institute of Chartered Accountants of India', issuedDate: '2025-08-15', fieldOfStudy: 'Chartered Accountancy', jurisdiction: 'India', accreditingBody: 'ICAI', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'india', 'ca'],
  },
  {
    id: 'GD-1416', description: 'Swedish medical license — Socialstyrelsen', strippedText: 'SOCIALSTYRELSEN (NATIONAL BOARD OF HEALTH AND WELFARE). LEGITIMATION. [NAME_REDACTED] har legitimation som läkare (Medical Doctor). Legitimationsnummer: [REDACTED]. Utfärdad: 2025-06-15. Specialistkompetens: Allmänmedicin (General Practice). Stockholm, Sverige.', credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Socialstyrelsen', issuedDate: '2025-06-15', fieldOfStudy: 'General Practice', jurisdiction: 'Sweden', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'sweden', 'medical'],
  },
  {
    id: 'GD-1417', description: 'Italian architecture degree — Politecnico di Milano', strippedText: 'POLITECNICO DI MILANO. DIPLOMA DI LAUREA MAGISTRALE. Si certifica che [NAME_REDACTED] ha conseguito la Laurea Magistrale in Architettura — Architettura delle Costruzioni. Votazione: 110/110 e lode. Data di laurea: 22 dicembre 2025. Il Rettore, Politecnico di Milano. Milano, Italia.', credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Politecnico di Milano', issuedDate: '2025-12-22', fieldOfStudy: 'Architecture', degreeLevel: 'Master', jurisdiction: 'Italy', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'italy', 'architecture'],
  },
  {
    id: 'GD-1418', description: 'Philippine nursing license — PRC', strippedText: 'REPUBLIC OF THE PHILIPPINES. PROFESSIONAL REGULATION COMMISSION. CERTIFICATE OF REGISTRATION / LICENSE. This certifies that [NAME_REDACTED] is a duly registered and licensed NURSE. Registration No.: [REDACTED]. Date of Registration: March 2024. Valid Until: March 2027. Manila, Philippines. Chairman, Professional Regulation Commission.', credentialTypeHint: 'LICENSE',
    groundTruth: { credentialType: 'LICENSE', issuerName: 'Professional Regulation Commission', issuedDate: '2024-03-01', expiryDate: '2027-03-01', fieldOfStudy: 'Nursing', jurisdiction: 'Philippines', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'philippines', 'nursing'],
  },
  {
    id: 'GD-1419', description: 'UK Royal College fellowship — FRCS', strippedText: 'THE ROYAL COLLEGE OF SURGEONS OF ENGLAND. FELLOWSHIP. This is to certify that [NAME_REDACTED], having complied with the conditions required by the Charter and Bye-Laws, has been admitted as a Fellow of the Royal College of Surgeons of England (FRCS). Specialty: Trauma and Orthopaedic Surgery. Date of Election: February 1, 2026. Lincoln\'s Inn Fields, London WC2A 3PE.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'The Royal College of Surgeons of England', issuedDate: '2026-02-01', fieldOfStudy: 'Trauma and Orthopaedic Surgery', jurisdiction: 'United Kingdom', accreditingBody: 'Royal College of Surgeons of England', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'uk', 'frcs'],
  },
  {
    id: 'GD-1420', description: 'Chinese degree — Tsinghua University', strippedText: '清华大学毕业证书 (TSINGHUA UNIVERSITY DIPLOMA). This is to certify that [NAME_REDACTED] has completed the prescribed course of study in the Department of Computer Science and Technology and has been awarded the degree of Master of Engineering. Date: June 30, 2025. President, Tsinghua University. Beijing, People\'s Republic of China. Certificate No.: [REDACTED].', credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Tsinghua University', issuedDate: '2025-06-30', fieldOfStudy: 'Computer Science', degreeLevel: 'Master', jurisdiction: 'China', fraudSignals: [] },
    source: 'synthetic-international', category: 'international', tags: ['synthetic', 'international', 'china', 'degree'],
  },

  // ============================================================
  // FINANCIAL (20 entries) — GD-1421 to GD-1440
  // ============================================================
  {
    id: 'GD-1421', description: 'Independent auditor report', strippedText: 'INDEPENDENT AUDITOR\'S REPORT. To the Board of Directors of [COMPANY_REDACTED] Inc. Opinion: We have audited the consolidated financial statements of [COMPANY_REDACTED] Inc. which comprise the balance sheet as of December 31, 2025, and the related statements of income, comprehensive income, stockholders\' equity, and cash flows. In our opinion, the financial statements present fairly, in all material respects, the financial position. [FIRM_REDACTED] LLP. Certified Public Accountants. February 15, 2026.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[FIRM_REDACTED] LLP', issuedDate: '2026-02-15', fieldOfStudy: 'Financial Audit', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'audit'],
  },
  {
    id: 'GD-1422', description: 'W-2 wage and tax statement', strippedText: 'FORM W-2. WAGE AND TAX STATEMENT 2025. Employee: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Employer: [COMPANY_REDACTED] Corp. EIN: [REDACTED]. Wages: [AMOUNT_REDACTED]. Federal income tax withheld: [AMOUNT_REDACTED]. Social security wages: [AMOUNT_REDACTED]. Medicare wages: [AMOUNT_REDACTED]. State: California. State income tax: [AMOUNT_REDACTED]. Copy B — To Be Filed With Employee\'s FEDERAL Tax Return.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Corp.', issuedDate: '2025-12-31', fieldOfStudy: 'Wage and Tax Statement', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'w2', 'tax'],
  },
  {
    id: 'GD-1423', description: 'Bank statement', strippedText: '[BANK_REDACTED] National Bank. ACCOUNT STATEMENT. Account Holder: [NAME_REDACTED]. Account Number: [REDACTED]. Statement Period: February 1 - February 28, 2026. Opening Balance: [AMOUNT_REDACTED]. Total Deposits: [AMOUNT_REDACTED]. Total Withdrawals: [AMOUNT_REDACTED]. Closing Balance: [AMOUNT_REDACTED]. [BANK_REDACTED] National Bank, N.A. Member FDIC.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[BANK_REDACTED] National Bank', issuedDate: '2026-02-28', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'bank-statement'],
  },
  {
    id: 'GD-1424', description: '1099-MISC', strippedText: 'FORM 1099-MISC. MISCELLANEOUS INFORMATION. TAX YEAR 2025. Payer: [COMPANY_REDACTED] LLC. Payer TIN: [REDACTED]. Recipient: [NAME_REDACTED]. Recipient TIN: [SSN_REDACTED]. Box 7 — Nonemployee Compensation: [AMOUNT_REDACTED]. Department of the Treasury — Internal Revenue Service. Copy B — For Recipient.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] LLC', issuedDate: '2025-12-31', fieldOfStudy: 'Miscellaneous Income', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', '1099'],
  },
  {
    id: 'GD-1425', description: 'Annual financial statement — nonprofit', strippedText: '[ORGANIZATION_REDACTED] Foundation. CONSOLIDATED STATEMENT OF FINANCIAL POSITION. As of December 31, 2025. Total Assets: $45,200,000. Total Liabilities: $8,100,000. Net Assets Without Donor Restrictions: $25,600,000. Net Assets With Donor Restrictions: $11,500,000. Total Net Assets: $37,100,000. Prepared by: [FIRM_REDACTED] CPA Group. Report Date: January 31, 2026.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[FIRM_REDACTED] CPA Group', issuedDate: '2026-01-31', fieldOfStudy: 'Financial Statement', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'nonprofit'],
  },
  {
    id: 'GD-1426', description: 'Profit and loss statement — small business', strippedText: '[COMPANY_REDACTED] Coffee Roasters, LLC. PROFIT AND LOSS STATEMENT. Period: January 1 - December 31, 2025. Revenue: $1,250,000. Cost of Goods Sold: $475,000. Gross Profit: $775,000. Operating Expenses: $620,000. Net Income: $155,000. Prepared by: [NAME_REDACTED], CPA. Date: February 10, 2026.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Coffee Roasters, LLC', issuedDate: '2026-02-10', fieldOfStudy: 'Income Statement', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'pnl'],
  },
  {
    id: 'GD-1427', description: 'Mortgage pre-approval letter', strippedText: '[BANK_REDACTED] Mortgage. PRE-APPROVAL LETTER. Date: March 1, 2026. Dear [NAME_REDACTED]: Based on our preliminary review of your credit and income, we are pleased to advise that you have been pre-approved for a mortgage loan. Loan Amount: up to [AMOUNT_REDACTED]. Loan Type: 30-year fixed. Interest Rate: [RATE_REDACTED]% (subject to change). This pre-approval is valid for 90 days. [NAME_REDACTED], Senior Loan Officer. NMLS #[REDACTED].', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[BANK_REDACTED] Mortgage', issuedDate: '2026-03-01', fieldOfStudy: 'Mortgage Pre-Approval', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'mortgage'],
  },
  {
    id: 'GD-1428', description: 'Investment account statement', strippedText: '[BROKERAGE_REDACTED] Investments. QUARTERLY INVESTMENT STATEMENT. Account: [REDACTED]. Account Holder: [NAME_REDACTED]. Period: October 1 - December 31, 2025. Beginning Value: [AMOUNT_REDACTED]. Contributions: [AMOUNT_REDACTED]. Withdrawals: $0. Change in Value: [AMOUNT_REDACTED]. Ending Value: [AMOUNT_REDACTED]. Asset Allocation: Stocks 70%, Bonds 20%, Cash 10%.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[BROKERAGE_REDACTED] Investments', issuedDate: '2025-12-31', fieldOfStudy: 'Investment Statement', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'investment'],
  },
  {
    id: 'GD-1429', description: 'Grant award letter', strippedText: 'NATIONAL SCIENCE FOUNDATION. AWARD LETTER. Award No.: [REDACTED]. PI: [NAME_REDACTED]. Institution: [UNIVERSITY_REDACTED] University. Title: Scalable Quantum Error Correction Architectures. Program: Division of Computing and Communication Foundations. Award Amount: $500,000. Award Period: 09/01/2025 - 08/31/2028. NSF Program Officer: [NAME_REDACTED].', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: 'National Science Foundation', issuedDate: '2025-09-01', fieldOfStudy: 'Research Grant', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'grant'],
  },
  {
    id: 'GD-1430', description: 'Tax return summary — Form 1040', strippedText: 'FORM 1040. U.S. INDIVIDUAL INCOME TAX RETURN 2025. Filing Status: Married Filing Jointly. Taxpayer: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Adjusted Gross Income: [AMOUNT_REDACTED]. Tax: [AMOUNT_REDACTED]. Total Tax: [AMOUNT_REDACTED]. Total Payments: [AMOUNT_REDACTED]. Amount Overpaid: [AMOUNT_REDACTED]. Preparer: [NAME_REDACTED], CPA. PTIN: [REDACTED]. Firm: [FIRM_REDACTED].', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[FIRM_REDACTED]', issuedDate: '2025-12-31', fieldOfStudy: 'Individual Tax Return', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'tax-return'],
  },
  {
    id: 'GD-1431', description: 'Corporate tax return — Form 1120', strippedText: 'FORM 1120. U.S. CORPORATION INCOME TAX RETURN 2025. Corporation: [COMPANY_REDACTED] Inc. EIN: [REDACTED]. Gross Receipts: [AMOUNT_REDACTED]. Total Deductions: [AMOUNT_REDACTED]. Taxable Income: [AMOUNT_REDACTED]. Total Tax: [AMOUNT_REDACTED]. Overpayment: [AMOUNT_REDACTED]. Prepared by: [FIRM_REDACTED] Tax Advisors. PTIN: [REDACTED]. Date: March 15, 2026.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[FIRM_REDACTED] Tax Advisors', issuedDate: '2026-03-15', fieldOfStudy: 'Corporate Tax Return', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'corporate-tax'],
  },
  {
    id: 'GD-1432', description: 'Student loan statement', strippedText: '[SERVICER_REDACTED] Student Loan Services. ACCOUNT STATEMENT. Borrower: [NAME_REDACTED]. Account: [REDACTED]. Statement Date: March 1, 2026. Current Balance: [AMOUNT_REDACTED]. Interest Rate: 5.5% Fixed. Monthly Payment: [AMOUNT_REDACTED]. Next Due Date: April 1, 2026. Loan Type: Direct Unsubsidized. Loan Status: In Repayment.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[SERVICER_REDACTED] Student Loan Services', issuedDate: '2026-03-01', fieldOfStudy: 'Student Loan Statement', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'student-loan'],
  },
  {
    id: 'GD-1433', description: 'Venture capital term sheet', strippedText: 'SUMMARY OF TERMS FOR PROPOSED SERIES A PREFERRED STOCK FINANCING. Company: [COMPANY_REDACTED] AI, Inc. Investor: [FUND_REDACTED] Ventures. Amount: $15,000,000. Pre-Money Valuation: $45,000,000. Price Per Share: [AMOUNT_REDACTED]. Liquidation Preference: 1x non-participating. Board Seats: 2 common, 1 preferred, 1 independent. Date: March 10, 2026.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[FUND_REDACTED] Ventures', issuedDate: '2026-03-10', fieldOfStudy: 'Venture Capital Term Sheet', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'vc'],
  },
  {
    id: 'GD-1434', description: 'Credit report summary', strippedText: 'EXPERIAN CREDIT REPORT SUMMARY. Report Date: February 15, 2026. Consumer: [NAME_REDACTED]. Report Number: [REDACTED]. FICO Score: [REDACTED]. Total Accounts: 12. Open Accounts: 8. Closed Accounts: 4. Total Balance: [AMOUNT_REDACTED]. Payment History: 100% on-time. Inquiries (last 24 months): 3. Public Records: None. Collections: None.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: 'Experian', issuedDate: '2026-02-15', fieldOfStudy: 'Credit Report', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'credit-report'],
  },
  {
    id: 'GD-1435', description: 'SOX compliance attestation', strippedText: 'MANAGEMENT\'S REPORT ON INTERNAL CONTROL OVER FINANCIAL REPORTING. [COMPANY_REDACTED] Corporation. December 31, 2025. Management is responsible for establishing and maintaining adequate internal control over financial reporting as defined in Rule 13a-15(f). Based on our assessment, management has concluded that the Company\'s internal control over financial reporting was effective as of December 31, 2025. [NAME_REDACTED], CEO. [NAME_REDACTED], CFO.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Corporation', issuedDate: '2025-12-31', fieldOfStudy: 'SOX Compliance', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'sox'],
  },
  {
    id: 'GD-1436', description: 'IRS determination letter — 501(c)(3)', strippedText: 'INTERNAL REVENUE SERVICE. DEPARTMENT OF THE TREASURY. Date: January 20, 2026. [ORGANIZATION_REDACTED] Foundation. EIN: [REDACTED]. Dear Applicant: We are pleased to inform you that upon review of your application for tax-exempt status we have determined that you are exempt from Federal income tax under section 501(c)(3) of the Internal Revenue Code. Donors may deduct contributions to you as provided in section 170.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: 'Internal Revenue Service', issuedDate: '2026-01-20', fieldOfStudy: 'Tax-Exempt Status', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'irs', 'nonprofit'],
  },
  {
    id: 'GD-1437', description: 'Balance sheet — startup', strippedText: '[COMPANY_REDACTED] Technologies, Inc. BALANCE SHEET. As of December 31, 2025. ASSETS: Cash and Equivalents: $8,500,000. Accounts Receivable: $2,100,000. Property and Equipment (net): $450,000. Total Assets: $11,050,000. LIABILITIES: Accounts Payable: $350,000. Deferred Revenue: $1,200,000. Total Liabilities: $1,550,000. STOCKHOLDERS EQUITY: $9,500,000. Prepared: January 15, 2026.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Technologies, Inc.', issuedDate: '2026-01-15', fieldOfStudy: 'Balance Sheet', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'balance-sheet'],
  },
  {
    id: 'GD-1438', description: 'Pay stub', strippedText: '[COMPANY_REDACTED] Corp. PAY STATEMENT. Employee: [NAME_REDACTED]. Employee ID: [REDACTED]. Pay Period: 03/01/2026 - 03/15/2026. Pay Date: 03/20/2026. Gross Pay: [AMOUNT_REDACTED]. Federal Tax: [AMOUNT_REDACTED]. State Tax (CA): [AMOUNT_REDACTED]. Social Security: [AMOUNT_REDACTED]. Medicare: [AMOUNT_REDACTED]. 401(k): [AMOUNT_REDACTED]. Net Pay: [AMOUNT_REDACTED]. YTD Gross: [AMOUNT_REDACTED].', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Corp.', issuedDate: '2026-03-20', fieldOfStudy: 'Pay Statement', jurisdiction: 'California, USA', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'paystub'],
  },
  {
    id: 'GD-1439', description: 'Stock option grant letter', strippedText: '[COMPANY_REDACTED] Inc. STOCK OPTION AWARD NOTICE. Participant: [NAME_REDACTED]. Grant Date: January 15, 2026. Number of Shares: [REDACTED]. Exercise Price: [AMOUNT_REDACTED] per share. Vesting Schedule: 4-year vesting with 1-year cliff; 25% vests after 12 months, remaining vests monthly over 36 months. Expiration: January 15, 2036. Plan: 2024 Equity Incentive Plan. VP of People, [COMPANY_REDACTED] Inc.', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Inc.', issuedDate: '2026-01-15', fieldOfStudy: 'Stock Option Grant', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'stock-option'],
  },
  {
    id: 'GD-1440', description: 'K-1 partnership income', strippedText: 'SCHEDULE K-1 (FORM 1065). PARTNER\'S SHARE OF INCOME. TAX YEAR 2025. Partnership: [COMPANY_REDACTED] Ventures, LP. EIN: [REDACTED]. Partner: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Partner\'s share: 15%. Ordinary business income: [AMOUNT_REDACTED]. Net rental income: [AMOUNT_REDACTED]. Interest income: [AMOUNT_REDACTED]. Capital gain: [AMOUNT_REDACTED].', credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Ventures, LP', issuedDate: '2025-12-31', fieldOfStudy: 'Partnership Income', jurisdiction: 'United States', fraudSignals: [] },
    source: 'synthetic-financial', category: 'financial', tags: ['synthetic', 'financial', 'k1'],
  },

  // ============================================================
  // OCR-CORRUPTED VARIANTS (5 entries) — GD-1441 to GD-1445
  // ============================================================
  {
    id: 'GD-1441',
    description: 'OCR-corrupted insurance COI',
    strippedText: 'CERT1F1CATE 0F L1AB1L1TY 1NSURANCE. DATE: O3/O1/2O26. PR0DUCER: [AGENT_REDACTED] 1nsurance. 1NSURED: [C0MPANY_REDACTED] Construct1on LLC. 1NSURER: Hartf0rd F1re 1nsurance C0mpany. P0L1CY: [REDACTED]. EFFECT1VE: O1/O1/2O26. EXP1RAT1ON: O1/O1/2O27. TYPE: C0MMERC1AL GENERAL L1AB1L1TY. EACH 0CCURRENCE: $1,OOO,OOO.',
    credentialTypeHint: 'INSURANCE',
    groundTruth: { credentialType: 'INSURANCE', issuerName: 'Hartford Fire Insurance Company', issuedDate: '2026-01-01', expiryDate: '2027-01-01', fieldOfStudy: 'Commercial General Liability', fraudSignals: [] },
    source: 'synthetic-ocr', category: 'ocr-corrupted', tags: ['synthetic', 'ocr', 'insurance'],
  },
  {
    id: 'GD-1442',
    description: 'OCR-corrupted attestation letter',
    strippedText: 'EMPL0YMENT VER1F1CAT1ON LETTER. Date: March 1O, 2O26. T0 Whorn 1t May C0ncern: Th1s letter conf1rms that [NAME_REDACTED] has been ernployed by [C0MPANY_REDACTED] Techno1og1es as a Sen1or S0ftware Eng1neer s1nce June 2O21. Ernployrnent status: Fu1l-t1rne, act1ve. Hurnan Resources Departrnent.',
    credentialTypeHint: 'ATTESTATION',
    groundTruth: { credentialType: 'ATTESTATION', issuerName: '[COMPANY_REDACTED] Technologies', issuedDate: '2026-03-10', fieldOfStudy: 'Software Engineering', fraudSignals: [] },
    source: 'synthetic-ocr', category: 'ocr-corrupted', tags: ['synthetic', 'ocr', 'attestation'],
  },
  {
    id: 'GD-1443',
    description: 'OCR-corrupted badge certificate',
    strippedText: 'AMAZ0N WEB SERV1CES. AWS Cert1f1ed So1ut1ons Arch1tect - Assoc1ate. Ho1der: [NAME_REDACTED]. Ach1eved: January 15, 2O26. Va11d Unt11: January 15, 2O29. Va11dat1on Nurnber: [REDACTED]. Th1s credent1a1 va11dates ab111ty to des1gn d1str1buted systerns on AWS.',
    credentialTypeHint: 'BADGE',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Amazon Web Services', issuedDate: '2026-01-15', expiryDate: '2029-01-15', fieldOfStudy: 'Cloud Architecture', accreditingBody: 'Amazon Web Services', fraudSignals: [] },
    source: 'synthetic-ocr', category: 'ocr-corrupted', tags: ['synthetic', 'ocr', 'badge'],
  },
  {
    id: 'GD-1444',
    description: 'OCR-corrupted financial statement',
    strippedText: '[C0MPANY_REDACTED] Techno1og1es, 1nc. BA1ANCE SHEET. As of Decernber 31, 2O25. ASSETS: Cash and Equ1va1ents: $8,5OO,OOO. Accounts Rece1vab1e: $2,1OO,OOO. Tota1 Assets: $11,O5O,OOO. L1AB1L1T1ES: $1,55O,OOO. ST0CKH0LDERS EQU1TY: $9,5OO,OOO. Prepared: January 15, 2O26.',
    credentialTypeHint: 'FINANCIAL',
    groundTruth: { credentialType: 'FINANCIAL', issuerName: '[COMPANY_REDACTED] Technologies, Inc.', issuedDate: '2026-01-15', fieldOfStudy: 'Balance Sheet', fraudSignals: [] },
    source: 'synthetic-ocr', category: 'ocr-corrupted', tags: ['synthetic', 'ocr', 'financial'],
  },
  {
    id: 'GD-1445',
    description: 'OCR-corrupted international degree — TU Munich',
    strippedText: 'TECHN1SCHE UN1VERS1TÄT MÜNCHEN. URKUNDE. D1e Techn1sche Un1vers1tät München ver1e1ht [NAME_REDACTED] den akadernschen Grad Master of Sc1ence (M.Sc.) 1rn Stud1engang 1nforrnat1k. München, den 15. Ju11 2O25. Der Präs1dent der Techn1schen Un1vers1tät München.',
    credentialTypeHint: 'DEGREE',
    groundTruth: { credentialType: 'DEGREE', issuerName: 'Technische Universität München', issuedDate: '2025-07-15', fieldOfStudy: 'Computer Science', degreeLevel: 'Master', jurisdiction: 'Germany', fraudSignals: [] },
    source: 'synthetic-ocr', category: 'ocr-corrupted', tags: ['synthetic', 'ocr', 'international', 'degree'],
  },

  // ============================================================
  // PROFESSIONAL (15 entries) — GD-1446 to GD-1460
  // ============================================================
  {
    id: 'GD-1446', description: 'IEEE Senior Member', strippedText: 'THE INSTITUTE OF ELECTRICAL AND ELECTRONICS ENGINEERS. CERTIFICATE OF MEMBERSHIP. This certifies that [NAME_REDACTED] has been elevated to the grade of SENIOR MEMBER of the IEEE. Member Number: [REDACTED]. Effective: January 1, 2026. IEEE — Advancing Technology for Humanity. New York, NY.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'IEEE', issuedDate: '2026-01-01', fieldOfStudy: 'Electrical Engineering', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'ieee'],
  },
  {
    id: 'GD-1447', description: 'CFA Charterholder', strippedText: 'CFA INSTITUTE. CHARTER CERTIFICATE. This certifies that [NAME_REDACTED] has earned the right to use the Chartered Financial Analyst designation, having met the education, examination, and professional experience requirements. Charter Number: [REDACTED]. Awarded: September 2025. CFA Institute, Charlottesville, Virginia, USA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'CFA Institute', issuedDate: '2025-09-01', fieldOfStudy: 'Financial Analysis', jurisdiction: 'United States', accreditingBody: 'CFA Institute', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'cfa'],
  },
  {
    id: 'GD-1448', description: 'Fellow of ACM', strippedText: 'ASSOCIATION FOR COMPUTING MACHINERY. FELLOW. The Association for Computing Machinery recognizes [NAME_REDACTED] as an ACM Fellow for contributions to distributed systems and cloud computing infrastructure. Citation: For fundamental contributions to scalable cloud storage systems. Class of 2025. ACM, New York, NY 10036.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'Association for Computing Machinery', issuedDate: '2025-01-01', fieldOfStudy: 'Distributed Systems', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'acm-fellow'],
  },
  {
    id: 'GD-1449', description: 'PMP certification', strippedText: 'PROJECT MANAGEMENT INSTITUTE. PROJECT MANAGEMENT PROFESSIONAL (PMP). This certifies that [NAME_REDACTED] has met the requirements for the Project Management Professional certification. PMP Number: [REDACTED]. Original Certification: October 15, 2023. Renewal Date: October 15, 2026. PMI Global Operations Center, Newtown Square, PA, USA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'Project Management Institute', issuedDate: '2023-10-15', expiryDate: '2026-10-15', fieldOfStudy: 'Project Management', accreditingBody: 'Project Management Institute', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'pmp'],
  },
  {
    id: 'GD-1450', description: 'SHRM-SCP certification', strippedText: 'SOCIETY FOR HUMAN RESOURCE MANAGEMENT. SHRM SENIOR CERTIFIED PROFESSIONAL (SHRM-SCP). This certifies that [NAME_REDACTED] has demonstrated senior-level HR competency and earned the SHRM-SCP credential. Certification ID: [REDACTED]. Effective: March 1, 2026. Recertification Due: February 28, 2029. SHRM, Alexandria, VA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'Society for Human Resource Management', issuedDate: '2026-03-01', expiryDate: '2029-02-28', fieldOfStudy: 'Human Resource Management', accreditingBody: 'SHRM', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'shrm'],
  },
  {
    id: 'GD-1451', description: 'CISSP certification — (ISC)²', strippedText: 'INTERNATIONAL INFORMATION SYSTEM SECURITY CERTIFICATION CONSORTIUM ((ISC)²). CERTIFIED INFORMATION SYSTEMS SECURITY PROFESSIONAL (CISSP). Member: [NAME_REDACTED]. Member ID: [REDACTED]. Certification Date: June 2024. AMF Due: June 2027. (ISC)² — A nonprofit association of certified cybersecurity professionals. Clearwater, FL, USA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: '(ISC)²', issuedDate: '2024-06-01', expiryDate: '2027-06-01', fieldOfStudy: 'Cybersecurity', accreditingBody: '(ISC)²', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'cissp'],
  },
  {
    id: 'GD-1452', description: 'Board-certified physician — ABFM', strippedText: 'AMERICAN BOARD OF FAMILY MEDICINE. DIPLOMATE CERTIFICATE. This certifies that [NAME_REDACTED], MD has fulfilled the requirements for certification by the American Board of Family Medicine. Certificate Number: [REDACTED]. Initial Certification: 2020. Certification Valid Through: December 31, 2030. Lexington, KY.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'American Board of Family Medicine', issuedDate: '2020-01-01', expiryDate: '2030-12-31', fieldOfStudy: 'Family Medicine', accreditingBody: 'ABFM', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'physician'],
  },
  {
    id: 'GD-1453', description: 'ASQ Six Sigma Black Belt', strippedText: 'AMERICAN SOCIETY FOR QUALITY. CERTIFIED SIX SIGMA BLACK BELT (CSSBB). This certifies that [NAME_REDACTED] has met the requirements for certification as a Six Sigma Black Belt. Certificate Number: [REDACTED]. Certification Date: November 2025. Recertification Due: November 2028. ASQ, Milwaukee, WI.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'American Society for Quality', issuedDate: '2025-11-01', expiryDate: '2028-11-01', fieldOfStudy: 'Quality Management', accreditingBody: 'ASQ', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'six-sigma'],
  },
  {
    id: 'GD-1454', description: 'AICPA membership', strippedText: 'AMERICAN INSTITUTE OF CERTIFIED PUBLIC ACCOUNTANTS. MEMBERSHIP CERTIFICATE. [NAME_REDACTED], CPA is a member in good standing of the American Institute of Certified Public Accountants. Member Since: 2018. Member Number: [REDACTED]. AICPA, Durham, NC 27707.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'American Institute of Certified Public Accountants', issuedDate: '2018-01-01', fieldOfStudy: 'Accounting', accreditingBody: 'AICPA', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'cpa'],
  },
  {
    id: 'GD-1455', description: 'National Board Certified Teacher', strippedText: 'NATIONAL BOARD FOR PROFESSIONAL TEACHING STANDARDS. CERTIFICATE. This certifies that [NAME_REDACTED] has achieved National Board Certification in Early Childhood Generalist. Certificate Number: [REDACTED]. Effective: November 2025. Valid Through: November 2030. NBPTS, Arlington, VA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'National Board for Professional Teaching Standards', issuedDate: '2025-11-01', expiryDate: '2030-11-01', fieldOfStudy: 'Early Childhood Education', accreditingBody: 'NBPTS', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'teacher'],
  },
  {
    id: 'GD-1456', description: 'LEED AP — Green building', strippedText: 'GREEN BUILDING CERTIFICATION INSTITUTE (GBCI). LEED ACCREDITED PROFESSIONAL — BUILDING DESIGN + CONSTRUCTION (LEED AP BD+C). [NAME_REDACTED]. Credential ID: [REDACTED]. Earned: April 2024. CMP Reporting Period End: April 2026. GBCI — Administering LEED certification worldwide. Washington, DC.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'Green Building Certification Institute', issuedDate: '2024-04-01', expiryDate: '2026-04-01', fieldOfStudy: 'Green Building Design', accreditingBody: 'GBCI', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'leed'],
  },
  {
    id: 'GD-1457', description: 'Chartered Engineer — Engineering Council UK', strippedText: 'THE ENGINEERING COUNCIL. CHARTERED ENGINEER (CEng). This is to certify that [NAME_REDACTED] has been registered as a Chartered Engineer by the Engineering Council. Registration No.: [REDACTED]. Date of Registration: March 2025. Licensed Body: Institution of Mechanical Engineers (IMechE). London, United Kingdom.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'The Engineering Council', issuedDate: '2025-03-01', fieldOfStudy: 'Mechanical Engineering', jurisdiction: 'United Kingdom', accreditingBody: 'Institution of Mechanical Engineers', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'ceng', 'uk'],
  },
  {
    id: 'GD-1458', description: 'ASIS CPP — Security professional', strippedText: 'ASIS INTERNATIONAL. CERTIFIED PROTECTION PROFESSIONAL (CPP). Board certified in security management. Holder: [NAME_REDACTED]. Certificate No.: [REDACTED]. Certification Date: August 2025. Recertification: August 2028. ASIS International, Alexandria, VA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'ASIS International', issuedDate: '2025-08-01', expiryDate: '2028-08-01', fieldOfStudy: 'Security Management', accreditingBody: 'ASIS International', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'cpp', 'security'],
  },
  {
    id: 'GD-1459', description: 'CISA — ISACA', strippedText: 'ISACA. CERTIFIED INFORMATION SYSTEMS AUDITOR (CISA). This certifies that [NAME_REDACTED] holds the CISA designation, having met the requirements for knowledge, experience, and ethics. CISA No.: [REDACTED]. Earned: January 2025. CPE Requirement: 120 hours per 3-year period. ISACA, Schaumburg, IL.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'PROFESSIONAL', issuerName: 'ISACA', issuedDate: '2025-01-01', fieldOfStudy: 'Information Systems Auditing', accreditingBody: 'ISACA', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'professional', 'cisa'],
  },
  {
    id: 'GD-1460', description: 'AWS Certified Developer badge via Credly — PROFESSIONAL type', strippedText: 'AMAZON WEB SERVICES. AWS Certified Developer - Associate. Holder: [NAME_REDACTED]. Certificate Date: February 10, 2026. Valid Until: February 10, 2029. This certification validates technical expertise in developing and maintaining applications on AWS. AWS, Seattle, WA.', credentialTypeHint: 'PROFESSIONAL',
    groundTruth: { credentialType: 'BADGE', issuerName: 'Amazon Web Services', issuedDate: '2026-02-10', expiryDate: '2029-02-10', fieldOfStudy: 'Cloud Development', accreditingBody: 'Amazon Web Services', fraudSignals: [] },
    source: 'synthetic-professional', category: 'professional', tags: ['synthetic', 'badge-misclassified', 'aws'],
  },
];
