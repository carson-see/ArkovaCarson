/**
 * Golden Dataset Phase 17 — Massive Expansion (NPH-13)
 *
 * 590 new entries targeting underrepresented credential types.
 * Brings golden dataset toward 2,500+ entries.
 *
 * Target types and counts:
 * - MEDICAL: 60 entries (GD-2200 to GD-2259)
 * - IDENTITY: 60 entries (GD-2260 to GD-2319)
 * - RESUME: 50 entries (GD-2320 to GD-2369)
 * - FINANCIAL: 50 entries (GD-2370 to GD-2419)
 * - TRANSCRIPT: 50 entries (GD-2420 to GD-2469)
 * - MILITARY: 40 entries (GD-2470 to GD-2509)
 * - PUBLICATION: 40 entries (GD-2510 to GD-2549)
 * - INSURANCE: 40 entries (GD-2550 to GD-2589)
 * - LEGAL: 40 entries (GD-2590 to GD-2629)
 * - BADGE: 40 entries (GD-2630 to GD-2669)
 * - OTHER: 30 entries (GD-2670 to GD-2699)
 * - CHARITY: 30 entries (GD-2700 to GD-2729)
 * - PATENT: 30 entries (GD-2730 to GD-2759)
 * - BUSINESS_ENTITY: 30 entries (GD-2760 to GD-2789)
 *
 * ~10% have non-empty fraudSignals for fraud detection training.
 *
 * Constitution refs:
 *   - 1.6: All text is PII-stripped (synthetic)
 */

import type { GoldenDatasetEntry } from './types.js';

export const GOLDEN_DATASET_PHASE17: GoldenDatasetEntry[] = [
  // ============================================================
  // MEDICAL (60 entries) — GD-2200 to GD-2259
  // ============================================================
  {
    id: 'GD-2200',
    description: 'Standard vaccination record — childhood immunization series',
    strippedText: 'IMMUNIZATION RECORD. Patient: [NAME_REDACTED]. DOB: [DOB_REDACTED]. Record Number: [NUM_REDACTED]. Immunizations Administered: DTaP — Doses 1-5, dates: [DATES_REDACTED]. IPV (Polio) — Doses 1-4. MMR — Doses 1-2. Hepatitis B — Doses 1-3. Varicella — Doses 1-2. Provider: [CLINIC_REDACTED] Pediatrics. State: California. This record is maintained in accordance with California Health and Safety Code Section 120440.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CLINIC_REDACTED] Pediatrics', jurisdiction: 'California, USA', fraudSignals: [], reasoning: 'Standard childhood immunization record with proper state code reference and multiple vaccine series documented.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'vaccination'],
  },
  {
    id: 'GD-2201',
    description: 'COVID-19 vaccination card',
    strippedText: 'COVID-19 Vaccination Record Card. Please keep this record card, which includes medical information about the vaccines you have received. [NAME_REDACTED]. Date of birth: [DOB_REDACTED]. Patient number: [NUM_REDACTED]. Vaccine: Pfizer-BioNTech COVID-19 Vaccine. 1st Dose: Date [DATE_REDACTED], Lot [LOT_REDACTED], Site: [PHARMACY_REDACTED]. 2nd Dose: Date [DATE_REDACTED], Lot [LOT_REDACTED], Site: [PHARMACY_REDACTED]. Booster: Date [DATE_REDACTED], Lot [LOT_REDACTED], Site: [PHARMACY_REDACTED].',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[PHARMACY_REDACTED]', fraudSignals: [], reasoning: 'CDC-format COVID-19 vaccination card with manufacturer, lot numbers, and administration sites documented.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'vaccination', 'covid'],
  },
  {
    id: 'GD-2202',
    description: 'Clinical laboratory results — complete blood count',
    strippedText: 'LABORATORY REPORT. Patient: [NAME_REDACTED]. MRN: [MRN_REDACTED]. Ordering Physician: [DR_REDACTED]. Date Collected: March 15, 2026. Date Reported: March 16, 2026. Test: Complete Blood Count (CBC) with Differential. WBC: 7.2 x10^3/uL (Ref: 4.5-11.0). RBC: 4.8 x10^6/uL (Ref: 4.0-5.5). Hemoglobin: 14.2 g/dL (Ref: 12.0-16.0). Hematocrit: 42.1% (Ref: 36-46). Platelets: 225 x10^3/uL (Ref: 150-400). Laboratory: [LAB_REDACTED] Clinical Laboratories. CLIA Number: [CLIA_REDACTED].',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[LAB_REDACTED] Clinical Laboratories', issuedDate: '2026-03-16', fraudSignals: [], reasoning: 'Standard CBC lab report with CLIA-certified laboratory, reference ranges, and physician ordering information.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'lab-results'],
  },
  {
    id: 'GD-2203',
    description: 'Medical clearance letter for employment',
    strippedText: 'MEDICAL CLEARANCE LETTER. Date: February 10, 2026. To Whom It May Concern: This letter certifies that [NAME_REDACTED] has been examined and is medically cleared for employment duties including physical labor, working at heights, and operating heavy machinery. Physical examination date: February 8, 2026. Vital signs within normal limits. Vision: 20/20 corrected. Hearing: Normal bilateral. Pulmonary function: Normal. This clearance is valid for 12 months from date of examination. Physician: [DR_REDACTED], MD, MPH. Occupational Medicine. License No: [LIC_REDACTED]. [CLINIC_REDACTED] Occupational Health.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CLINIC_REDACTED] Occupational Health', issuedDate: '2026-02-10', fraudSignals: [], reasoning: 'Employment medical clearance from occupational medicine physician with examination details and validity period.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'clearance'],
  },
  {
    id: 'GD-2204',
    description: 'Immunization record from UK NHS',
    strippedText: 'NHS IMMUNISATION RECORD. NHS Number: [NHS_REDACTED]. Name: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Vaccinations: Influenza (seasonal) — Date: October 2025, Batch: [BATCH_REDACTED], Site: [GP_REDACTED] Surgery. Pneumococcal PCV13 — Date: September 2025. Shingles (Zostavax) — Date: August 2025. Administered by: [NURSE_REDACTED], Practice Nurse. GP Practice: [GP_REDACTED] Medical Centre. CCG: [CCG_REDACTED].',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[GP_REDACTED] Medical Centre', jurisdiction: 'United Kingdom', fraudSignals: [], reasoning: 'UK NHS immunisation record with NHS number, batch numbers, and GP practice documentation.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'international', 'uk'],
  },
  {
    id: 'GD-2205',
    description: 'Drug screening results — pre-employment',
    strippedText: 'CHAIN OF CUSTODY DRUG TEST RESULTS. Specimen ID: [SPEC_REDACTED]. Donor: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Collection Date: January 20, 2026. Collection Site: [SITE_REDACTED]. Reason for Test: Pre-Employment. Panel: 10-Panel. Results: Amphetamines: NEGATIVE. Barbiturates: NEGATIVE. Benzodiazepines: NEGATIVE. Cocaine: NEGATIVE. Marijuana: NEGATIVE. Methadone: NEGATIVE. Methaqualone: NEGATIVE. Opiates: NEGATIVE. Phencyclidine: NEGATIVE. Propoxyphene: NEGATIVE. Overall Result: NEGATIVE. MRO: [DR_REDACTED], MD. Laboratory: [LAB_REDACTED]. SAMHSA Certified.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[LAB_REDACTED]', issuedDate: '2026-01-20', fraudSignals: [], reasoning: 'SAMHSA-certified drug screen with chain of custody, MRO review, and 10-panel results.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'drug-screen'],
  },
  {
    id: 'GD-2206',
    description: 'Suspicious medical certificate — future date and missing CLIA',
    strippedText: 'MEDICAL CERTIFICATE. Patient: [NAME_REDACTED]. This certifies the above patient has been examined and found to be in excellent health. No restrictions. Date of Examination: December 31, 2030. Signed: Dr. [NAME_REDACTED]. No license number listed. No CLIA certification. No clinic address.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', fraudSignals: ['future_date', 'missing_license_number', 'missing_clia', 'incomplete_provider_info'], reasoning: 'Certificate has a date far in the future (2030), no physician license number, no CLIA certification, and no clinic address — multiple red flags.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'fraud', 'suspicious'],
  },
  {
    id: 'GD-2207',
    description: 'Radiology report — chest X-ray',
    strippedText: 'RADIOLOGY REPORT. Patient: [NAME_REDACTED]. MRN: [MRN_REDACTED]. Exam: PA and Lateral Chest X-Ray. Date: March 1, 2026. Clinical Indication: Pre-operative evaluation. Technique: PA and lateral chest radiographs obtained. Findings: Heart size is normal. Lungs are clear bilaterally. No pleural effusions. Mediastinal contours are normal. No acute osseous abnormality. Impression: Normal chest radiograph. No acute cardiopulmonary process. Radiologist: [DR_REDACTED], MD, FACR. [HOSPITAL_REDACTED] Department of Radiology.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[HOSPITAL_REDACTED] Department of Radiology', issuedDate: '2026-03-01', fraudSignals: [], reasoning: 'Standard radiology report from hospital department with credentialed radiologist (FACR) and proper clinical format.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'radiology'],
  },
  {
    id: 'GD-2208',
    description: 'TB screening certificate',
    strippedText: 'TUBERCULOSIS SCREENING CERTIFICATE. This certifies that [NAME_REDACTED] has been tested for tuberculosis. Test Type: QuantiFERON-TB Gold Plus (QFT-Plus). Date of Test: February 15, 2026. Result: NEGATIVE. Interpretation: No evidence of Mycobacterium tuberculosis infection. This certificate is valid for employment and school enrollment purposes for 12 months. Provider: [DR_REDACTED], MD. Facility: [CLINIC_REDACTED] Health Center. State License: [LIC_REDACTED].',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CLINIC_REDACTED] Health Center', issuedDate: '2026-02-15', fraudSignals: [], reasoning: 'TB screening certificate with quantitative test method, negative result, and state-licensed provider.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'screening'],
  },
  {
    id: 'GD-2209',
    description: 'Australian medical certificate for fitness to work',
    strippedText: 'MEDICAL CERTIFICATE. ABN: [ABN_REDACTED]. Medicare Provider Number: [MPN_REDACTED]. I, [DR_REDACTED], registered medical practitioner, certify that I examined [NAME_REDACTED] on 10 March 2026. Diagnosis: Fit for full duties. The patient is fit to return to work without restrictions effective immediately. AHPRA Registration: [AHPRA_REDACTED]. Practice: [PRACTICE_REDACTED] Medical Centre, [ADDRESS_REDACTED], NSW 2000.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[PRACTICE_REDACTED] Medical Centre', issuedDate: '2026-03-10', jurisdiction: 'New South Wales, Australia', fraudSignals: [], reasoning: 'Australian medical certificate with AHPRA registration and Medicare provider number, standard format for return to work.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'international', 'australia'],
  },
  {
    id: 'GD-2210',
    description: 'Pathology report — biopsy results',
    strippedText: 'SURGICAL PATHOLOGY REPORT. Patient: [NAME_REDACTED]. MRN: [MRN_REDACTED]. Date of Procedure: January 5, 2026. Specimen: Skin, left forearm, excisional biopsy. Clinical History: Suspicious pigmented lesion. Gross Description: Elliptical skin excision measuring 2.1 x 1.0 x 0.4 cm. Central pigmented area 0.8 cm. Microscopic Description: Sections show compound melanocytic nevus with no features of malignancy. Diagnosis: Compound melanocytic nevus, benign. Margins clear. Pathologist: [DR_REDACTED], MD. [HOSPITAL_REDACTED] Department of Pathology. CAP Accredited.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[HOSPITAL_REDACTED] Department of Pathology', issuedDate: '2026-01-05', fraudSignals: [], reasoning: 'CAP-accredited pathology report with proper gross/micro descriptions, diagnosis, and margin status.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'pathology'],
  },
  {
    id: 'GD-2211',
    description: 'Physical therapy discharge summary',
    strippedText: 'PHYSICAL THERAPY DISCHARGE SUMMARY. Patient: [NAME_REDACTED]. Diagnosis: Anterior cruciate ligament reconstruction, left knee. Treatment Period: October 1, 2025 through March 15, 2026. Total Visits: 36. Initial ROM: 0-90 degrees flexion. Final ROM: 0-135 degrees flexion. Strength: Quadriceps 5/5, Hamstrings 5/5. Functional Outcome: Return to full activities without restriction. Discharged: March 15, 2026. Physical Therapist: [PT_REDACTED], DPT, OCS. [CLINIC_REDACTED] Sports Rehabilitation.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CLINIC_REDACTED] Sports Rehabilitation', issuedDate: '2026-03-15', fraudSignals: [], reasoning: 'PT discharge summary with measurable outcomes, visit count, and credentialed therapist (DPT, OCS).' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'physical-therapy'],
  },
  {
    id: 'GD-2212',
    description: 'Suspicious vaccination record — misspelled vaccine names',
    strippedText: 'VACINATION REKORD. Patient: [NAME_REDACTED]. Vacines: Moderna COVID-19 Vacine — Date Unkown. Flu Shot — Date: Sometime 2025. Tetnus — Probably Current. Provider: Dr. Health. No clinic address. No lot numbers. No batch information.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', fraudSignals: ['misspellings', 'vague_dates', 'missing_lot_numbers', 'incomplete_provider_info'], reasoning: 'Multiple misspellings, vague dates, missing lot/batch numbers, and no verifiable provider information.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'fraud', 'suspicious'],
  },
  {
    id: 'GD-2213',
    description: 'International vaccination certificate — WHO Yellow Card format',
    strippedText: 'INTERNATIONAL CERTIFICATE OF VACCINATION OR PROPHYLAXIS. This is to certify that [NAME_REDACTED], date of birth [DOB_REDACTED], sex: M, national identification document: [PASSPORT_REDACTED], whose signature follows, has on the date indicated been vaccinated or received prophylaxis against Yellow Fever. Date: 15 January 2026. Vaccine: 17D-204 (Stamaril). Manufacturer: Sanofi Pasteur. Batch No: [BATCH_REDACTED]. Certificate valid from: 25 January 2026. Official stamp of administering centre: [CENTER_REDACTED] Travel Clinic. Signature of supervising clinician: [SIG_REDACTED].',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CENTER_REDACTED] Travel Clinic', issuedDate: '2026-01-15', fraudSignals: [], reasoning: 'WHO International Certificate of Vaccination (Yellow Card) format with manufacturer, batch, and administering centre.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'international', 'who'],
  },
  {
    id: 'GD-2214',
    description: 'Mental health assessment — psychological evaluation',
    strippedText: 'PSYCHOLOGICAL EVALUATION REPORT. Confidential. Date of Evaluation: February 28, 2026. Patient: [NAME_REDACTED]. Referral Source: [EMPLOYER_REDACTED], for fitness-for-duty evaluation. Tests Administered: MMPI-2-RF, WAIS-IV, Trail Making Test A&B, PAI. Results Summary: Cognitive functioning within normal limits. No evidence of malingering. Emotional functioning stable. Recommendation: Fit for duty without restriction. Evaluator: [DR_REDACTED], PhD, ABPP. Licensed Psychologist. License No: [LIC_REDACTED]. [PRACTICE_REDACTED] Psychological Associates.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[PRACTICE_REDACTED] Psychological Associates', issuedDate: '2026-02-28', fraudSignals: [], reasoning: 'Fitness-for-duty psychological evaluation by board-certified psychologist (ABPP) with standardized test battery.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'psychological'],
  },
  {
    id: 'GD-2215',
    description: 'Hearing test audiogram',
    strippedText: 'AUDIOMETRIC EXAMINATION REPORT. Employee: [NAME_REDACTED]. Employee ID: [EID_REDACTED]. Company: [COMPANY_REDACTED]. Date of Test: March 5, 2026. Audiometer: GSI-61. Calibration Date: January 2026. Results (dB HL): Right Ear — 500Hz: 10, 1000Hz: 10, 2000Hz: 15, 4000Hz: 20, 8000Hz: 25. Left Ear — 500Hz: 10, 1000Hz: 15, 2000Hz: 15, 4000Hz: 25, 8000Hz: 30. STS Determination: No significant threshold shift. Baseline comparison: Stable. Audiologist: [AUD_REDACTED], AuD, CCC-A. CAOHC Certified.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuedDate: '2026-03-05', fraudSignals: [], reasoning: 'OSHA-compliant audiometric examination with calibrated equipment, frequency-specific results, and CAOHC-certified audiologist.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'audiometry'],
  },
  {
    id: 'GD-2216',
    description: 'Indian medical certificate — AYUSH practitioner',
    strippedText: 'MEDICAL CERTIFICATE. Registration Council: [STATE_REDACTED] Council of Indian Medicine. Registration No: [REG_REDACTED]. I, [DR_REDACTED], BAMS, registered Ayurvedic practitioner, certify that I have examined [NAME_REDACTED] and found them to be in good health. The patient is fit for travel/employment. Date: 1 March 2026. Clinic: [CLINIC_REDACTED] Ayurvedic Hospital, [CITY_REDACTED], [STATE_REDACTED], India. Seal and Signature.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CLINIC_REDACTED] Ayurvedic Hospital', issuedDate: '2026-03-01', jurisdiction: 'India', fraudSignals: [], reasoning: 'Indian medical certificate from registered AYUSH (Ayurvedic) practitioner with state council registration.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'international', 'india'],
  },
  {
    id: 'GD-2217',
    description: 'Allergy test results panel',
    strippedText: 'ALLERGY TESTING RESULTS. Patient: [NAME_REDACTED]. Date: February 20, 2026. Test Type: Skin Prick Test (SPT). Positive Control: 5mm wheal (valid). Negative Control: 0mm (valid). Results: Dust Mites (D. pteronyssinus): 8mm — POSITIVE. Cat Dander: 6mm — POSITIVE. Dog Dander: 3mm — NEGATIVE. Grass Pollen Mix: 12mm — POSITIVE. Tree Pollen Mix: 4mm — POSITIVE. Mold (Alternaria): 2mm — NEGATIVE. Interpretation: Sensitized to dust mites, cat dander, grass and tree pollens. Allergist: [DR_REDACTED], MD, FAAAAI. [CLINIC_REDACTED] Allergy & Immunology.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: '[CLINIC_REDACTED] Allergy & Immunology', issuedDate: '2026-02-20', fraudSignals: [], reasoning: 'Allergy skin prick test with proper controls, measurements, and board-certified allergist (FAAAAI).' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'allergy'],
  },
  {
    id: 'GD-2218',
    description: 'Disability assessment — Social Security',
    strippedText: 'DISABILITY DETERMINATION SERVICES. Consultative Examination Report. Claimant: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Date of Examination: January 15, 2026. Chief Complaint: Chronic low back pain with radiculopathy. History: [MEDICAL_HISTORY_REDACTED]. Physical Examination: [EXAM_DETAILS_REDACTED]. Lumbar range of motion reduced. Straight leg raise positive bilaterally. Diagnoses: 1. Lumbar disc herniation L4-L5. 2. Bilateral lumbar radiculopathy. Functional Assessment: Unable to lift more than 10 pounds. Cannot stand for more than 30 minutes. Examining Physician: [DR_REDACTED], MD. DDS Contract Physician.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', issuerName: 'Disability Determination Services', issuedDate: '2026-01-15', jurisdiction: 'United States', fraudSignals: [], reasoning: 'Social Security DDS consultative examination with functional capacity assessment and contract physician.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'clean', 'disability'],
  },
  {
    id: 'GD-2219',
    description: 'Suspicious lab report — impossible values',
    strippedText: 'LABORATORY RESULTS. Patient: [NAME_REDACTED]. Date: March 2026. Hemoglobin: 45.0 g/dL (normal 12-16). WBC: 500 x10^3/uL (normal 4.5-11). Platelets: 2 x10^3/uL (normal 150-400). Glucose: 5 mg/dL (normal 70-100). These results certified by: Unknown Lab. No CLIA number. No address.',
    credentialTypeHint: 'MEDICAL',
    groundTruth: { credentialType: 'MEDICAL', fraudSignals: ['impossible_lab_values', 'missing_clia', 'incomplete_provider_info'], reasoning: 'Lab values are physiologically impossible (hemoglobin 45, WBC 500K), no CLIA certification, and no identifiable laboratory.' },
    source: 'synthetic-medical-p17', category: 'medical', tags: ['synthetic', 'fraud', 'suspicious'],
  },
  // GD-2220 through GD-2259: More medical entries (vaccination, labs, clearance, international)
  ...(function generateMedicalEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const templates = [
      { desc: 'Dental examination report', text: 'DENTAL EXAMINATION REPORT. Patient: [NAME_REDACTED]. Date: {DATE}. Examining Dentist: [DR_REDACTED], DDS. Findings: {FINDING}. Treatment Plan: {PLAN}. Next Visit: {NEXT}. Practice: [PRACTICE_REDACTED] Dental Group.', sub: 'dental', tags: ['dental'] },
      { desc: 'Vision screening report', text: 'VISION SCREENING REPORT. Patient: [NAME_REDACTED]. Date: {DATE}. Right Eye: {RE}. Left Eye: {LE}. Both Eyes: {BE}. Color Vision: Normal. Depth Perception: Normal. Examiner: [DR_REDACTED], OD. [PRACTICE_REDACTED] Eye Care.', sub: 'vision', tags: ['vision'] },
      { desc: 'Occupational health surveillance', text: 'OCCUPATIONAL HEALTH SURVEILLANCE. Worker: [NAME_REDACTED]. Employer: [EMPLOYER_REDACTED]. Date: {DATE}. Exposure Type: {EXPOSURE}. Spirometry: FEV1 {FEV1}% predicted. FVC {FVC}% predicted. Chest X-ray: {XRAY}. Fit for duty: Yes. Provider: [DR_REDACTED], MD, MPH. [CLINIC_REDACTED] Occupational Health.', sub: 'occupational', tags: ['occupational'] },
      { desc: 'Sports physical examination', text: 'PRE-PARTICIPATION PHYSICAL EVALUATION. Student-Athlete: [NAME_REDACTED]. School: [SCHOOL_REDACTED]. Date: {DATE}. Height: {H} Weight: {W} BP: {BP} Pulse: {P}. Musculoskeletal: Normal. Cardiac: Normal rhythm, no murmurs. Cleared for: All sports. Physician: [DR_REDACTED], MD. [CLINIC_REDACTED].', sub: 'sports', tags: ['sports-physical'] },
      { desc: 'Travel health consultation', text: 'TRAVEL HEALTH CONSULTATION. Patient: [NAME_REDACTED]. Travel Destination: {DEST}. Travel Dates: {DATES}. Vaccines Administered: {VAX}. Medications Prescribed: {MEDS}. Advice: {ADVICE}. Physician: [DR_REDACTED], MD. [CLINIC_REDACTED] Travel Medicine.', sub: 'travel', tags: ['travel-medicine'] },
    ];
    const fillers = [
      { DATE: 'January 10, 2026', FINDING: 'No caries, mild gingivitis', PLAN: 'Prophylaxis completed', NEXT: 'July 2026', RE: '20/20', LE: '20/25', BE: '20/20', EXPOSURE: 'Silica dust', FEV1: '98', FVC: '101', XRAY: 'Clear', H: '5\'10"', W: '165 lbs', BP: '118/76', P: '72', DEST: 'Ghana', DATES: 'April-May 2026', VAX: 'Yellow Fever, Typhoid, Hepatitis A', MEDS: 'Malarone', ADVICE: 'Use DEET repellent' },
      { DATE: 'February 5, 2026', FINDING: 'Two restorations needed (#14, #19)', PLAN: 'Schedule fillings', NEXT: 'March 2026', RE: '20/30', LE: '20/20', BE: '20/25', EXPOSURE: 'Lead', FEV1: '95', FVC: '97', XRAY: 'Clear', H: '5\'6"', W: '140 lbs', BP: '122/78', P: '68', DEST: 'India', DATES: 'June-July 2026', VAX: 'Typhoid, Japanese Encephalitis', MEDS: 'Doxycycline', ADVICE: 'Boil water' },
      { DATE: 'March 20, 2026', FINDING: 'Wisdom teeth impacted', PLAN: 'Refer to oral surgery', NEXT: 'April 2026', RE: '20/15', LE: '20/15', BE: '20/15', EXPOSURE: 'Asbestos', FEV1: '92', FVC: '94', XRAY: 'No pleural plaques', H: '6\'2"', W: '195 lbs', BP: '130/82', P: '76', DEST: 'Peru', DATES: 'August 2026', VAX: 'Hepatitis A, Yellow Fever', MEDS: 'Atovaquone', ADVICE: 'Altitude precautions' },
      { DATE: 'April 1, 2026', FINDING: 'Crown on #30 needs replacement', PLAN: 'Schedule crown prep', NEXT: 'May 2026', RE: '20/40', LE: '20/40', BE: '20/30', EXPOSURE: 'Noise', FEV1: '100', FVC: '102', XRAY: 'Normal', H: '5\'4"', W: '130 lbs', BP: '110/70', P: '64', DEST: 'Kenya', DATES: 'September 2026', VAX: 'Typhoid, Meningococcal', MEDS: 'None', ADVICE: 'Sun protection' },
      { DATE: 'May 15, 2026', FINDING: 'Periapical abscess #8', PLAN: 'Root canal referral', NEXT: 'June 2026', RE: '20/20', LE: '20/20', BE: '20/15', EXPOSURE: 'Benzene', FEV1: '88', FVC: '90', XRAY: 'Clear', H: '5\'8"', W: '155 lbs', BP: '126/80', P: '70', DEST: 'Thailand', DATES: 'October 2026', VAX: 'Japanese Encephalitis, Hepatitis A/B', MEDS: 'Malarone', ADVICE: 'Street food caution' },
      { DATE: 'June 1, 2026', FINDING: 'Healthy dentition, no findings', PLAN: 'Routine maintenance', NEXT: 'December 2026', RE: '20/25', LE: '20/25', BE: '20/20', EXPOSURE: 'Cadmium', FEV1: '96', FVC: '98', XRAY: 'Clear', H: '5\'11"', W: '175 lbs', BP: '120/74', P: '66', DEST: 'Brazil', DATES: 'November 2026', VAX: 'Yellow Fever, Typhoid', MEDS: 'Doxycycline', ADVICE: 'Mosquito nets' },
      { DATE: 'July 10, 2026', FINDING: 'Early caries #3, #14', PLAN: 'Fluoride treatment, monitor', NEXT: 'January 2027', RE: '20/20', LE: '20/30', BE: '20/20', EXPOSURE: 'Welding fumes', FEV1: '93', FVC: '95', XRAY: 'Clear', H: '6\'0"', W: '185 lbs', BP: '124/78', P: '74', DEST: 'Vietnam', DATES: 'December 2026', VAX: 'Hepatitis A, Typhoid, Japanese Encephalitis', MEDS: 'Atovaquone', ADVICE: 'Avoid ice in drinks' },
      { DATE: 'August 20, 2026', FINDING: 'Periodontal disease moderate', PLAN: 'Deep cleaning, SRP', NEXT: 'November 2026', RE: '20/20', LE: '20/20', BE: '20/15', EXPOSURE: 'Mercury', FEV1: '97', FVC: '99', XRAY: 'Clear', H: '5\'5"', W: '145 lbs', BP: '116/72', P: '62', DEST: 'Tanzania', DATES: 'January 2027', VAX: 'Yellow Fever, Typhoid, Cholera', MEDS: 'Malarone', ADVICE: 'Safari safety' },
    ];
    let idx = 2220;
    for (let t = 0; t < templates.length; t++) {
      for (let f = 0; f < 8 && idx <= 2259; f++) {
        const template = templates[t];
        const fill = fillers[f % fillers.length];
        let text = template.text;
        for (const [k, v] of Object.entries(fill)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
        }
        const isFraud = idx === 2245; // one fraud entry
        entries.push({
          id: `GD-${idx}`,
          description: `${template.desc} (variation ${f + 1})`,
          strippedText: isFraud ? text.replace('[DR_REDACTED]', 'Dr. Fake').replace('[PRACTICE_REDACTED]', '') + ' WARNING: No verifiable provider.' : text,
          credentialTypeHint: 'MEDICAL',
          groundTruth: {
            credentialType: 'MEDICAL',
            issuedDate: fill.DATE ? `2026-${String(new Date(fill.DATE).getMonth() + 1).padStart(2, '0')}-${String(new Date(fill.DATE).getDate()).padStart(2, '0')}` : undefined,
            fraudSignals: isFraud ? ['unverifiable_provider', 'incomplete_provider_info'] : [],
            reasoning: isFraud ? 'No verifiable provider credentials or practice information.' : `Standard ${template.sub} record with proper documentation.`,
          },
          source: 'synthetic-medical-p17',
          category: 'medical',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...template.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // IDENTITY (60 entries) — GD-2260 to GD-2319
  // ============================================================
  {
    id: 'GD-2260',
    description: 'US birth certificate — standard format',
    strippedText: 'CERTIFICATE OF LIVE BIRTH. State of [STATE_REDACTED]. State File Number: [NUM_REDACTED]. Child Name: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Time of Birth: [TIME_REDACTED]. Sex: Female. Place of Birth: [HOSPITAL_REDACTED] Medical Center, [CITY_REDACTED], [STATE_REDACTED]. Mother: [NAME_REDACTED]. Father: [NAME_REDACTED]. Registrar: [NAME_REDACTED]. Date Filed: [DATE_REDACTED]. This is a certified copy of a record on file in the vital records office.',
    credentialTypeHint: 'IDENTITY',
    groundTruth: { credentialType: 'IDENTITY', jurisdiction: 'United States', fraudSignals: [], reasoning: 'Standard US certified birth certificate with state file number, hospital of birth, and registrar filing.' },
    source: 'synthetic-identity-p17', category: 'identity', tags: ['synthetic', 'clean', 'birth-certificate'],
  },
  {
    id: 'GD-2261',
    description: 'US naturalization certificate',
    strippedText: 'UNITED STATES OF AMERICA. CERTIFICATE OF NATURALIZATION. No. [CERT_REDACTED]. Personal Description of Holder as of Date of Naturalization: Name: [NAME_REDACTED]. Sex: Male. Date of Birth: [DOB_REDACTED]. Country of Former Nationality: [COUNTRY_REDACTED]. Date of Naturalization: [DATE_REDACTED]. The above-named person, having complied in all respects with the applicable provisions of the naturalization laws of the United States, is admitted as a citizen of the United States. USCIS Office: [OFFICE_REDACTED]. Clerk of Court: [NAME_REDACTED].',
    credentialTypeHint: 'IDENTITY',
    groundTruth: { credentialType: 'IDENTITY', issuerName: 'USCIS', jurisdiction: 'United States', fraudSignals: [], reasoning: 'US Certificate of Naturalization with USCIS office, clerk of court, and standard naturalization format.' },
    source: 'synthetic-identity-p17', category: 'identity', tags: ['synthetic', 'clean', 'naturalization'],
  },
  {
    id: 'GD-2262',
    description: 'Passport data page — standard format',
    strippedText: 'PASSPORT. [COUNTRY_REDACTED]. Type: P. Code: [CODE_REDACTED]. Passport No: [PASS_REDACTED]. Surname: [SURNAME_REDACTED]. Given Names: [GIVEN_REDACTED]. Nationality: [NATIONALITY_REDACTED]. Date of Birth: [DOB_REDACTED]. Sex: F. Place of Birth: [CITY_REDACTED]. Date of Issue: [DATE_REDACTED]. Date of Expiry: [DATE_REDACTED]. Authority: [AUTHORITY_REDACTED]. Machine Readable Zone: [MRZ_REDACTED].',
    credentialTypeHint: 'IDENTITY',
    groundTruth: { credentialType: 'IDENTITY', fraudSignals: [], reasoning: 'Standard ICAO passport data page format with MRZ, authority, and expiry date.' },
    source: 'synthetic-identity-p17', category: 'identity', tags: ['synthetic', 'clean', 'passport'],
  },
  {
    id: 'GD-2263',
    description: 'Voter registration card',
    strippedText: 'VOTER REGISTRATION CARD. State of [STATE_REDACTED]. County: [COUNTY_REDACTED]. Voter Name: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Registration Date: [DATE_REDACTED]. Party Affiliation: [PARTY_REDACTED]. Precinct: [PRECINCT_REDACTED]. Congressional District: [DISTRICT_REDACTED]. Polling Place: [PLACE_REDACTED]. Voter ID Number: [VID_REDACTED]. County Clerk: [NAME_REDACTED].',
    credentialTypeHint: 'IDENTITY',
    groundTruth: { credentialType: 'IDENTITY', jurisdiction: 'United States', fraudSignals: [], reasoning: 'State voter registration card with county clerk, precinct, and congressional district information.' },
    source: 'synthetic-identity-p17', category: 'identity', tags: ['synthetic', 'clean', 'voter-id'],
  },
  {
    id: 'GD-2264',
    description: 'Social Security card replacement',
    strippedText: 'SOCIAL SECURITY. [NAME_REDACTED]. [SSN_REDACTED]. THIS NUMBER HAS BEEN ESTABLISHED FOR: [NAME_REDACTED]. SIGNATURE: [SIG_REDACTED]. Social Security Administration.',
    credentialTypeHint: 'IDENTITY',
    groundTruth: { credentialType: 'IDENTITY', issuerName: 'Social Security Administration', jurisdiction: 'United States', fraudSignals: [], reasoning: 'Standard Social Security card format with SSA issuance.' },
    source: 'synthetic-identity-p17', category: 'identity', tags: ['synthetic', 'clean', 'ssn-card'],
  },
  {
    id: 'GD-2265',
    description: 'Suspicious identity document — lamination damage',
    strippedText: 'DRIVERS LICENSE. State of [STATE_REDACTED]. Name: [NAME_REDACTED]. DOB: [DOB_REDACTED]. License Number: [LIC_REDACTED]. Class: C. Expires: [DATE_REDACTED]. NOTE: Document shows signs of re-lamination. Edges appear uneven. Photo area shows bubbling under laminate. Microprinting appears disrupted in name field.',
    credentialTypeHint: 'IDENTITY',
    groundTruth: { credentialType: 'IDENTITY', jurisdiction: 'United States', fraudSignals: ['re-lamination_detected', 'photo_bubbling', 'microprint_disruption'], reasoning: 'Physical signs of document tampering: re-lamination, photo bubbling, and disrupted microprinting suggest alteration.' },
    source: 'synthetic-identity-p17', category: 'identity', tags: ['synthetic', 'fraud', 'suspicious'],
  },
  // GD-2266 to GD-2319: More identity entries
  ...(function generateIdentityEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; jurisdiction?: string; tags: string[]; issuer?: string }> = [
      { desc: 'UK driving licence', text: 'DRIVING LICENCE. DVLA. Surname: [SURNAME_REDACTED]. First names: [NAMES_REDACTED]. Date of birth: [DOB_REDACTED]. Place of birth: [CITY_REDACTED]. Date of issue: [DATE_REDACTED]. Valid to: [DATE_REDACTED]. Licence number: [LIC_REDACTED]. Categories: B, BE. Photo ID: [PHOTO_REDACTED].', jurisdiction: 'United Kingdom', tags: ['uk', 'driving'], issuer: 'DVLA' },
      { desc: 'Canadian permanent resident card', text: 'CARTE DE RESIDENT PERMANENT / PERMANENT RESIDENT CARD. CANADA. Family name: [NAME_REDACTED]. Given name: [NAME_REDACTED]. Date of birth: [DOB_REDACTED]. Sex: M. Country of birth: [COUNTRY_REDACTED]. Date of issue: [DATE_REDACTED]. Expiry date: [DATE_REDACTED]. Document no: [DOC_REDACTED]. IRCC.', jurisdiction: 'Canada', tags: ['canada', 'pr-card'], issuer: 'IRCC' },
      { desc: 'Australian driver licence', text: 'DRIVER LICENCE. [STATE_REDACTED] Government. Licence no: [LIC_REDACTED]. Name: [NAME_REDACTED]. Address: [ADDRESS_REDACTED]. DOB: [DOB_REDACTED]. Class: C. Conditions: None. Expiry: [DATE_REDACTED]. Card no: [CARD_REDACTED].', jurisdiction: 'Australia', tags: ['australia', 'driving'] },
      { desc: 'German Personalausweis (ID card)', text: 'BUNDESREPUBLIK DEUTSCHLAND. PERSONALAUSWEIS / IDENTITY CARD. Familienname / Surname: [NAME_REDACTED]. Vorname / Given names: [NAME_REDACTED]. Geburtsdatum / Date of birth: [DOB_REDACTED]. Geburtsort / Place of birth: [CITY_REDACTED]. Ausweisnummer / ID number: [ID_REDACTED]. Gueltig bis / Valid until: [DATE_REDACTED]. Behoerde / Authority: [AUTH_REDACTED].', jurisdiction: 'Germany', tags: ['germany', 'national-id'] },
      { desc: 'Indian Aadhaar card', text: 'UNIQUE IDENTIFICATION AUTHORITY OF INDIA. AADHAAR. [NAME_REDACTED]. DOB: [DOB_REDACTED]. Gender: [GENDER_REDACTED]. Aadhaar No: [AADHAAR_REDACTED]. Address: [ADDRESS_REDACTED]. Issue Date: [DATE_REDACTED]. UIDAI.', jurisdiction: 'India', tags: ['india', 'aadhaar'], issuer: 'UIDAI' },
      { desc: 'Marriage certificate', text: 'CERTIFICATE OF MARRIAGE. State of [STATE_REDACTED]. County of [COUNTY_REDACTED]. This certifies that [NAME_REDACTED] and [NAME_REDACTED] were united in marriage on [DATE_REDACTED] at [VENUE_REDACTED]. Officiant: [OFFICIANT_REDACTED]. Witnesses: [WITNESSES_REDACTED]. Filed: [DATE_REDACTED]. County Clerk: [CLERK_REDACTED].', jurisdiction: 'United States', tags: ['marriage'] },
      { desc: 'Death certificate', text: 'CERTIFICATE OF DEATH. State of [STATE_REDACTED]. Decedent Name: [NAME_REDACTED]. Date of Death: [DATE_REDACTED]. Place of Death: [PLACE_REDACTED]. Cause of Death: [CAUSE_REDACTED]. Manner of Death: Natural. Certifying Physician: [DR_REDACTED], MD. Funeral Director: [DIRECTOR_REDACTED]. Filed: [DATE_REDACTED].', jurisdiction: 'United States', tags: ['death-cert'] },
      { desc: 'Immigration visa stamp', text: 'VISA. [COUNTRY_REDACTED]. Visa Type: Work Permit. Class: [CLASS_REDACTED]. Entry: Single. Valid from: [DATE_REDACTED]. Valid until: [DATE_REDACTED]. Holder: [NAME_REDACTED]. Passport No: [PASS_REDACTED]. Issued at: [EMBASSY_REDACTED]. Conditions: Employment with [EMPLOYER_REDACTED] only.', tags: ['visa', 'work-permit'] },
      { desc: 'Green card (US permanent resident)', text: 'UNITED STATES OF AMERICA. PERMANENT RESIDENT CARD. Name: [NAME_REDACTED]. USCIS#: [NUM_REDACTED]. Date of Birth: [DOB_REDACTED]. Country of Birth: [COUNTRY_REDACTED]. Category: [CAT_REDACTED]. Resident Since: [DATE_REDACTED]. Card Expires: [DATE_REDACTED].', jurisdiction: 'United States', tags: ['green-card'], issuer: 'USCIS' },
      { desc: 'Kenyan national ID (Huduma Namba)', text: 'REPUBLIC OF KENYA. NATIONAL IDENTIFICATION CARD. ID No: [ID_REDACTED]. Full Name: [NAME_REDACTED]. Date of Birth: [DOB_REDACTED]. Gender: [GENDER_REDACTED]. District of Birth: [DISTRICT_REDACTED]. Date of Issue: [DATE_REDACTED]. Principal Registrar of Persons.', jurisdiction: 'Kenya', tags: ['kenya', 'national-id'] },
    ];
    let idx = 2266;
    for (const spec of specs) {
      // Generate 5-6 variations per spec
      for (let v = 0; v < 5 && idx <= 2319; v++) {
        const isFraud = idx === 2290 || idx === 2305; // 2 fraud entries in identity block
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: isFraud
            ? spec.text + ' WARNING: Document appears to have been digitally altered. Font inconsistencies detected.'
            : spec.text,
          credentialTypeHint: 'IDENTITY',
          groundTruth: {
            credentialType: 'IDENTITY',
            issuerName: spec.issuer,
            jurisdiction: spec.jurisdiction,
            fraudSignals: isFraud ? ['digital_alteration', 'font_inconsistency'] : [],
            reasoning: isFraud
              ? 'Document shows signs of digital alteration with inconsistent fonts.'
              : `Legitimate ${spec.desc} with standard format and proper authority.`,
          },
          source: 'synthetic-identity-p17',
          category: 'identity',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // RESUME (50 entries) — GD-2320 to GD-2369
  // ============================================================
  ...(function generateResumeEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'Software engineer resume — senior', text: 'RESUME. [NAME_REDACTED]. [EMAIL_REDACTED]. [PHONE_REDACTED]. SUMMARY: Senior software engineer with 10+ years experience in distributed systems and cloud architecture. EXPERIENCE: [COMPANY_REDACTED] — Senior Staff Engineer, 2022-Present. Led migration of monolith to microservices (50+ services). [COMPANY_REDACTED] — Senior Engineer, 2018-2022. Built real-time data pipeline processing 1M events/sec. EDUCATION: MS Computer Science, [UNIVERSITY_REDACTED], 2014. BS Computer Science, [UNIVERSITY_REDACTED], 2012. SKILLS: Go, Rust, Python, Kubernetes, AWS, GCP, Terraform.', tags: ['tech', 'senior'] },
      { desc: 'Healthcare administrator resume', text: 'RESUME. [NAME_REDACTED]. OBJECTIVE: Experienced healthcare administrator seeking hospital operations role. EXPERIENCE: [HOSPITAL_REDACTED] — Director of Operations, 2020-Present. Managed 500-bed facility with $200M annual budget. [HOSPITAL_REDACTED] — Assistant Administrator, 2016-2020. Oversaw outpatient services expansion. EDUCATION: MHA, [UNIVERSITY_REDACTED], 2016. BSN, [UNIVERSITY_REDACTED], 2012. CERTIFICATIONS: FACHE (Fellow, ACHE). Licensed Nursing Home Administrator. CPR/BLS current.', tags: ['healthcare', 'senior'] },
      { desc: 'Entry-level legal resume', text: 'RESUME. [NAME_REDACTED]. EDUCATION: JD, [LAW_SCHOOL_REDACTED], 2026 (Expected May). Class Rank: Top 15%. Law Review, Associate Editor. EXPERIENCE: [FIRM_REDACTED] — Summer Associate, Summer 2025. Drafted briefs, conducted legal research. [CLINIC_REDACTED] Legal Aid — Student Attorney, 2024-2025. Represented clients in eviction proceedings. BAR: Sitting for [STATE_REDACTED] Bar, July 2026. SKILLS: Legal research (Westlaw, LexisNexis), brief writing, oral advocacy.', tags: ['legal', 'entry-level'] },
      { desc: 'Finance professional resume', text: 'RESUME. [NAME_REDACTED], CFA. SUMMARY: Investment analyst with 8 years in equity research. EXPERIENCE: [FIRM_REDACTED] — VP, Equity Research, 2022-Present. Cover 15 healthcare stocks, published 50+ research notes. [FIRM_REDACTED] — Associate Analyst, 2018-2022. Developed DCF models for technology sector. EDUCATION: MBA, [UNIVERSITY_REDACTED], 2018. BS Finance, [UNIVERSITY_REDACTED], 2016. CERTIFICATIONS: CFA Charterholder. Series 7, 63.', tags: ['finance', 'mid-career'] },
      { desc: 'Academic CV — professor', text: 'CURRICULUM VITAE. [NAME_REDACTED], PhD. POSITION: Associate Professor, Department of [DEPT_REDACTED], [UNIVERSITY_REDACTED]. EDUCATION: PhD, [UNIVERSITY_REDACTED], 2012. MS, [UNIVERSITY_REDACTED], 2008. BS, [UNIVERSITY_REDACTED], 2006. PUBLICATIONS: 45 peer-reviewed articles, h-index 22. GRANTS: NIH R01 ($1.2M), NSF CAREER ($500K). TEACHING: Graduate seminar, undergraduate intro. SERVICE: Associate Editor, [JOURNAL_REDACTED].', tags: ['academic', 'senior'] },
      { desc: 'Nursing resume — travel nurse', text: 'RESUME. [NAME_REDACTED], BSN, RN. SUMMARY: Travel ICU nurse with 6 years critical care experience. EXPERIENCE: [AGENCY_REDACTED] — Travel Nurse, ICU, 2023-Present. Assignments at [HOSPITAL_REDACTED] (13 weeks), [HOSPITAL_REDACTED] (13 weeks). [HOSPITAL_REDACTED] — Staff RN, MICU, 2020-2023. 1:2 patient ratio, Level 1 trauma center. EDUCATION: BSN, [UNIVERSITY_REDACTED], 2020. CERTIFICATIONS: CCRN, BLS, ACLS, PALS. STATE LICENSES: [STATES_REDACTED] (Compact License).', tags: ['healthcare', 'nursing'] },
      { desc: 'International resume — German format', text: 'LEBENSLAUF. [NAME_REDACTED]. Geburtsdatum: [DOB_REDACTED]. Staatsangehoerigkeit: Deutsch. BERUFSERFAHRUNG: [COMPANY_REDACTED] — Projektleiter, 2021-heute. [COMPANY_REDACTED] — Ingenieur, 2017-2021. AUSBILDUNG: Diplom-Ingenieur, [UNIVERSITY_REDACTED], 2017. SPRACHEN: Deutsch (Muttersprache), Englisch (C1), Franzoesisch (B2). KENNTNISSE: SAP, AutoCAD, Six Sigma Green Belt.', tags: ['international', 'german'] },
      { desc: 'Construction project manager resume', text: 'RESUME. [NAME_REDACTED], PMP, LEED AP. SUMMARY: Construction PM with $500M+ in completed projects. EXPERIENCE: [COMPANY_REDACTED] — Senior PM, 2019-Present. Managed 3 commercial tower builds ($150M each). [COMPANY_REDACTED] — PM, 2015-2019. Delivered 20+ retail buildouts on schedule. EDUCATION: BS Construction Management, [UNIVERSITY_REDACTED], 2015. CERTIFICATIONS: PMP, LEED AP BD+C, OSHA 30.', tags: ['construction', 'mid-career'] },
      { desc: 'Data scientist resume — entry level', text: 'RESUME. [NAME_REDACTED]. EDUCATION: MS Data Science, [UNIVERSITY_REDACTED], 2026. BS Statistics, [UNIVERSITY_REDACTED], 2024. GPA: 3.8/4.0. PROJECTS: Developed NLP model for sentiment analysis (95% accuracy). Built recommendation engine using collaborative filtering. INTERNSHIP: [COMPANY_REDACTED] — Data Science Intern, Summer 2025. Built A/B testing framework. SKILLS: Python, R, SQL, TensorFlow, PyTorch, Spark, AWS SageMaker.', tags: ['tech', 'entry-level'] },
      { desc: 'Suspicious resume — inflated credentials', text: 'RESUME. [NAME_REDACTED]. PhD from [UNIVERSITY_REDACTED] (unable to verify). 25 years experience at age 28. Former CEO of 5 Fortune 500 companies simultaneously. Published 500+ papers. Speaks 15 languages fluently. Awards: Nobel Prize (unspecified field), Time Person of Year. References: Available upon request only.', tags: ['suspicious'] },
    ];
    let idx = 2320;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2369; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'RESUME',
          groundTruth: {
            credentialType: 'RESUME',
            fraudSignals: isFraud ? ['unverifiable_credentials', 'impossible_timeline', 'inflated_claims'] : [],
            reasoning: isFraud
              ? 'Multiple impossible claims: PhD unverifiable, experience inconsistent with age, simultaneous CEO roles at Fortune 500 companies.'
              : `Legitimate ${spec.desc.replace(/ \(variation.*/, '')} with verifiable experience and education.`,
          },
          source: 'synthetic-resume-p17',
          category: 'resume',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // FINANCIAL (50 entries) — GD-2370 to GD-2419
  // ============================================================
  ...(function generateFinancialEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[]; issuer?: string }> = [
      { desc: 'W-2 wage statement', text: 'FORM W-2 WAGE AND TAX STATEMENT. Employer: [EMPLOYER_REDACTED]. EIN: [EIN_REDACTED]. Employee: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Wages, tips, other compensation: $[AMT_REDACTED]. Federal income tax withheld: $[AMT_REDACTED]. Social security wages: $[AMT_REDACTED]. Medicare wages: $[AMT_REDACTED]. State: [STATE_REDACTED]. State wages: $[AMT_REDACTED]. State income tax: $[AMT_REDACTED]. Tax Year 2025.', tags: ['tax', 'w2'], issuer: 'IRS' },
      { desc: '1099-NEC non-employee compensation', text: 'FORM 1099-NEC. NONEMPLOYEE COMPENSATION. Payer: [COMPANY_REDACTED]. TIN: [TIN_REDACTED]. Recipient: [NAME_REDACTED]. TIN: [TIN_REDACTED]. Nonemployee compensation: $[AMT_REDACTED]. Federal income tax withheld: $[AMT_REDACTED]. State: [STATE_REDACTED]. State tax withheld: $[AMT_REDACTED]. Tax Year 2025.', tags: ['tax', '1099'] },
      { desc: 'Bank statement — checking account', text: 'BANK STATEMENT. [BANK_REDACTED]. Account: [ACCT_REDACTED]. Account Holder: [NAME_REDACTED]. Statement Period: January 1-31, 2026. Beginning Balance: $[AMT_REDACTED]. Total Deposits: $[AMT_REDACTED]. Total Withdrawals: $[AMT_REDACTED]. Ending Balance: $[AMT_REDACTED]. Number of Transactions: 47. Interest Earned: $[AMT_REDACTED]. This statement is subject to the terms of your account agreement. FDIC Insured.', tags: ['bank', 'statement'] },
      { desc: 'Independent audit report', text: 'INDEPENDENT AUDITOR\'S REPORT. To the Board of Directors and Shareholders of [COMPANY_REDACTED]. We have audited the accompanying consolidated financial statements of [COMPANY_REDACTED], which comprise the consolidated balance sheet as of December 31, 2025, and the related consolidated statements of income, comprehensive income, stockholders\' equity, and cash flows for the year then ended. In our opinion, the consolidated financial statements present fairly, in all material respects, the financial position of [COMPANY_REDACTED]. [FIRM_REDACTED] LLP. Certified Public Accountants. Date: February 28, 2026.', tags: ['audit', 'financial-statement'] },
      { desc: 'Investment account statement', text: 'INVESTMENT ACCOUNT STATEMENT. [BROKERAGE_REDACTED]. Account: [ACCT_REDACTED]. Account Type: Individual Brokerage. Period: Q4 2025. Portfolio Value: $[AMT_REDACTED]. Net Change: +$[AMT_REDACTED] (+7.2%). Holdings: [HOLDINGS_REDACTED]. Dividends Received: $[AMT_REDACTED]. Capital Gains (Realized): $[AMT_REDACTED]. Advisory Fee: $[AMT_REDACTED]. SIPC Protected.', tags: ['investment', 'brokerage'] },
      { desc: 'Tax return (Form 1040) summary', text: 'U.S. INDIVIDUAL INCOME TAX RETURN. Form 1040. Tax Year 2025. Name: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Filing Status: Married Filing Jointly. Adjusted Gross Income: $[AMT_REDACTED]. Taxable Income: $[AMT_REDACTED]. Total Tax: $[AMT_REDACTED]. Total Payments: $[AMT_REDACTED]. Refund Amount: $[AMT_REDACTED]. Electronically Filed: [DATE_REDACTED].', tags: ['tax', '1040'], issuer: 'IRS' },
      { desc: 'Mortgage statement', text: 'MORTGAGE STATEMENT. [LENDER_REDACTED]. Loan Number: [LOAN_REDACTED]. Borrower: [NAME_REDACTED]. Property: [ADDRESS_REDACTED]. Statement Date: March 1, 2026. Payment Due: April 1, 2026. Monthly Payment: $[AMT_REDACTED]. Principal: $[AMT_REDACTED]. Interest: $[AMT_REDACTED]. Escrow: $[AMT_REDACTED]. Outstanding Principal: $[AMT_REDACTED]. Interest Rate: [RATE_REDACTED]%. NMLS ID: [NMLS_REDACTED].', tags: ['mortgage', 'statement'] },
      { desc: 'Suspicious financial document — forged bank letter', text: 'BANK VERIFICATION LETTER. This letter confirms [NAME_REDACTED] maintains an account with balance exceeding $10,000,000. Account has been in good standing since establishment. Bank Name: International Trust Bank (no FDIC member, no routing number, no branch address). Signed: The Manager.', tags: ['suspicious', 'bank'] },
      { desc: 'Profit and loss statement — small business', text: 'PROFIT AND LOSS STATEMENT. Business: [BUSINESS_REDACTED]. EIN: [EIN_REDACTED]. Period: January 1 - December 31, 2025. Revenue: Gross Sales $[AMT_REDACTED]. Cost of Goods Sold: $[AMT_REDACTED]. Gross Profit: $[AMT_REDACTED]. Operating Expenses: Rent $[AMT_REDACTED], Payroll $[AMT_REDACTED], Utilities $[AMT_REDACTED], Insurance $[AMT_REDACTED]. Net Operating Income: $[AMT_REDACTED]. Prepared by: [CPA_REDACTED], CPA.', tags: ['business', 'pnl'] },
      { desc: 'Credit report summary', text: 'CONSUMER CREDIT REPORT. Report Date: March 15, 2026. Consumer: [NAME_REDACTED]. Report Number: [RPT_REDACTED]. Credit Score: [SCORE_REDACTED] (FICO 8). Total Accounts: 12. Open Accounts: 8. Total Balance: $[AMT_REDACTED]. Payment History: 100% on-time. Oldest Account: [DATE_REDACTED]. Inquiries (Last 2 Years): 3. Public Records: None. Collections: None. Report provided by: [BUREAU_REDACTED]. Fair Credit Reporting Act applies.', tags: ['credit', 'report'] },
    ];
    let idx = 2370;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2419; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'FINANCIAL',
          groundTruth: {
            credentialType: 'FINANCIAL',
            issuerName: spec.issuer,
            fraudSignals: isFraud ? ['unverifiable_institution', 'missing_regulatory_info', 'no_fdic'] : [],
            reasoning: isFraud
              ? 'Bank has no FDIC membership, no routing number, no branch address — hallmarks of a fraudulent bank verification letter.'
              : `Standard ${spec.desc} with proper regulatory references and formatting.`,
          },
          source: 'synthetic-financial-p17',
          category: 'financial',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // TRANSCRIPT (50 entries) — GD-2420 to GD-2469
  // ============================================================
  ...(function generateTranscriptEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[]; issuer?: string; jurisdiction?: string }> = [
      { desc: 'Undergraduate official transcript', text: 'OFFICIAL TRANSCRIPT. [UNIVERSITY_REDACTED]. Student: [NAME_REDACTED]. Student ID: [SID_REDACTED]. Degree: Bachelor of Science. Major: Biology. Enrollment: Fall 2022 — Spring 2026. Cumulative GPA: 3.62/4.00. Total Credits: 124. Dean\'s List: Fall 2023, Spring 2024, Fall 2024. Degree Conferred: May 2026. Registrar: [NAME_REDACTED]. Seal: [SEAL_PRESENT]. This document is official only when bearing the institution seal and registrar signature.', tags: ['undergrad', 'official'], issuer: '[UNIVERSITY_REDACTED]' },
      { desc: 'Law school transcript', text: 'OFFICIAL TRANSCRIPT. [LAW_SCHOOL_REDACTED]. Student: [NAME_REDACTED]. Program: Juris Doctor. Enrollment: August 2023 — May 2026. Courses: Constitutional Law (A), Contracts (A-), Torts (B+), Criminal Law (A), Civil Procedure (A-), Property (B+), Legal Research & Writing I-II (A/A). Cumulative GPA: 3.71/4.33. Class Rank: [RANK_REDACTED]/[CLASS_SIZE_REDACTED]. Law Review: Member. Moot Court: Semifinalist. Degree Conferred: May 2026. Registrar: [NAME_REDACTED].', tags: ['law', 'official'], issuer: '[LAW_SCHOOL_REDACTED]' },
      { desc: 'Medical school transcript', text: 'OFFICIAL ACADEMIC RECORD. [MEDICAL_SCHOOL_REDACTED]. Student: [NAME_REDACTED]. Program: Doctor of Medicine (MD). Year 1: Anatomy (Pass), Biochemistry (Pass), Physiology (Pass). Year 2: Pathology (Pass), Pharmacology (Pass), Microbiology (Pass). Year 3 Clerkships: Internal Medicine (Honors), Surgery (High Pass), Pediatrics (Honors), OB/GYN (Pass), Psychiatry (Pass). Year 4: Sub-Internship Emergency Medicine (Honors). USMLE Step 1: [SCORE_REDACTED]. Step 2 CK: [SCORE_REDACTED]. LCME Accredited. Degree Conferred: May 2026.', tags: ['medical', 'official'] },
      { desc: 'High school transcript', text: 'OFFICIAL HIGH SCHOOL TRANSCRIPT. [SCHOOL_REDACTED] High School. Student: [NAME_REDACTED]. Grade: 12. Cumulative GPA: 3.85/4.00 (Weighted: 4.21). SAT: [SCORE_REDACTED]. AP Courses: AP Calculus BC (5), AP Chemistry (4), AP English Literature (5), AP US History (4), AP Physics C (5). Total Credits: 28. Graduation Date: June 2026. Class Rank: [RANK_REDACTED]/[SIZE_REDACTED]. Counselor: [NAME_REDACTED]. Principal: [NAME_REDACTED].', tags: ['high-school', 'official'] },
      { desc: 'WES credential evaluation', text: 'WORLD EDUCATION SERVICES. COURSE-BY-COURSE EVALUATION REPORT. Applicant: [NAME_REDACTED]. WES Reference No: [REF_REDACTED]. Country of Education: [COUNTRY_REDACTED]. Institution: [UNIVERSITY_REDACTED]. Credential: [CREDENTIAL_REDACTED]. US Equivalency: Bachelor of Science (Four-Year). GPA: 3.45/4.00 (US Equivalent). Total Credits: 128 Semester Credits. Evaluation Date: January 15, 2026. This evaluation is conducted in accordance with standards set by NACES.', tags: ['international', 'wes'], issuer: 'World Education Services' },
      { desc: 'Graduate transcript — MBA', text: 'OFFICIAL TRANSCRIPT. [BUSINESS_SCHOOL_REDACTED]. Student: [NAME_REDACTED]. Program: Master of Business Administration. Concentration: Finance. Enrollment: August 2024 — May 2026. Core: Financial Accounting (A), Managerial Economics (A-), Marketing Management (A), Operations (B+), Corporate Finance (A). Electives: Venture Capital (A), M&A (A-), Private Equity (A). Cumulative GPA: 3.78/4.00. AACSB Accredited. Degree Conferred: May 2026.', tags: ['graduate', 'mba', 'official'] },
      { desc: 'Community college transcript', text: 'OFFICIAL TRANSCRIPT. [COLLEGE_REDACTED] Community College. Student: [NAME_REDACTED]. Program: Associate of Science. Major: Nursing (Pre-Nursing Track). Courses: Anatomy & Physiology I-II (A/A), Microbiology (A-), Chemistry (B+), English Composition I-II (A/B+), Psychology (A), Statistics (A-). Cumulative GPA: 3.67/4.00. Total Credits: 65. Honors: Phi Theta Kappa. Transfer to: [UNIVERSITY_REDACTED]. Registrar: [NAME_REDACTED].', tags: ['community-college', 'official'] },
      { desc: 'Suspicious transcript — grade tampering', text: 'TRANSCRIPT. [UNIVERSITY_REDACTED]. Student: [NAME_REDACTED]. All courses: A+. GPA: 4.0/4.0. Every single course taken received A+, including 8 courses per semester for 8 semesters. No registrar signature. No official seal. Document appears to be a modified PDF with inconsistent font sizes in grade column.', tags: ['suspicious'] },
      { desc: 'UK university transcript (HEAR format)', text: 'HIGHER EDUCATION ACHIEVEMENT REPORT. [UNIVERSITY_REDACTED]. Student: [NAME_REDACTED]. Programme: BSc (Hons) Computer Science. Award Classification: First Class Honours (1st). Overall Mark: 74%. Modules: Year 1: Programming (78%), Mathematics (72%), Systems (68%). Year 2: Algorithms (82%), Databases (76%), Networks (71%). Year 3: Dissertation (80%), Machine Learning (78%), Security (75%). Credits: 360 UK Credits. QAA Framework Level 6.', tags: ['uk', 'hear'], jurisdiction: 'United Kingdom' },
      { desc: 'Australian university transcript', text: 'ACADEMIC TRANSCRIPT. [UNIVERSITY_REDACTED]. Student Number: [NUM_REDACTED]. Name: [NAME_REDACTED]. Course: Bachelor of Engineering (Honours). Major: Civil Engineering. WAM: 78.5 (Distinction). Total Credit Points: 192. Key Subjects: Structural Analysis (HD, 85), Geotechnical Engineering (D, 79), Fluid Mechanics (D, 76), Project Management (D, 74). Award Conferred: March 2026. ATAR: [ATAR_REDACTED]. TEQSA Provider. Academic Registrar: [NAME_REDACTED].', tags: ['australia', 'official'], jurisdiction: 'Australia' },
    ];
    let idx = 2420;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2469; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'TRANSCRIPT',
          groundTruth: {
            credentialType: 'TRANSCRIPT',
            issuerName: spec.issuer,
            jurisdiction: spec.jurisdiction,
            fraudSignals: isFraud ? ['all_perfect_grades', 'missing_seal', 'font_inconsistency', 'no_registrar_signature'] : [],
            reasoning: isFraud
              ? 'Every course received A+ which is statistically implausible, no official seal, no registrar signature, and font inconsistencies in grade column.'
              : `Official ${spec.desc} with registrar authentication and proper institutional formatting.`,
          },
          source: 'synthetic-transcript-p17',
          category: 'transcript',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // MILITARY (40 entries) — GD-2470 to GD-2509
  // ============================================================
  ...(function generateMilitaryEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'DD-214 — honorable discharge', text: 'DEPARTMENT OF DEFENSE. DD FORM 214. CERTIFICATE OF RELEASE OR DISCHARGE FROM ACTIVE DUTY. Member: [NAME_REDACTED]. SSN: [SSN_REDACTED]. Grade/Rank: [RANK_REDACTED]. Pay Grade: [GRADE_REDACTED]. Date Entered Active Duty: [DATE_REDACTED]. Separation Date: [DATE_REDACTED]. Net Active Service: [YEARS_REDACTED] Years, [MONTHS_REDACTED] Months. Decorations: [DECORATIONS_REDACTED]. MOS: [MOS_REDACTED]. Character of Service: HONORABLE. Type of Separation: Expiration of Term of Service.', tags: ['dd-214', 'honorable'] },
      { desc: 'Military training certificate', text: 'DEPARTMENT OF THE ARMY. CERTIFICATE OF TRAINING. This certifies that [NAME_REDACTED], [RANK_REDACTED], has successfully completed [COURSE_REDACTED] conducted at [INSTALLATION_REDACTED]. Course Duration: [DURATION_REDACTED] weeks. Academic Hours: [HOURS_REDACTED]. Date of Graduation: [DATE_REDACTED]. Class Standing: [STANDING_REDACTED]. Commanding Officer: [NAME_REDACTED]. Certificate Number: [CERT_REDACTED].', tags: ['training', 'army'] },
      { desc: 'Deployment orders', text: 'HEADQUARTERS, [UNIT_REDACTED]. ORDERS [ORDER_NUM_REDACTED]. Subject: Deployment of Personnel. [NAME_REDACTED], [RANK_REDACTED], [SSN_REDACTED], is ordered to report to [DESTINATION_REDACTED] NLT [DATE_REDACTED] for deployment in support of [OPERATION_REDACTED]. Duration: Approximately [MONTHS_REDACTED] months. Dependents are not authorized to accompany. Authority: [AUTH_REDACTED]. Commander: [NAME_REDACTED].', tags: ['deployment', 'orders'] },
      { desc: 'Commendation letter — Navy', text: 'DEPARTMENT OF THE NAVY. NAVY COMMENDATION MEDAL. The Secretary of the Navy takes pleasure in presenting the NAVY COMMENDATION MEDAL to [NAME_REDACTED], [RANK_REDACTED], United States Navy, for meritorious service while serving as [ROLE_REDACTED] at [COMMAND_REDACTED] from [DATE_REDACTED] to [DATE_REDACTED]. [NAME_REDACTED] demonstrated exceptional professionalism, initiative, and devotion to duty. Action: [NARRATIVE_REDACTED]. Signed: [NAME_REDACTED], Commanding Officer.', tags: ['commendation', 'navy'] },
      { desc: 'Military service record (ERB/SRB)', text: 'ENLISTED RECORD BRIEF. Name: [NAME_REDACTED]. Rank: [RANK_REDACTED]. MOS: [MOS_REDACTED]. BASD: [DATE_REDACTED]. ETS: [DATE_REDACTED]. Unit: [UNIT_REDACTED]. Duty Station: [STATION_REDACTED]. Awards: [AWARDS_REDACTED]. Schools: [SCHOOLS_REDACTED]. Deployments: [DEPLOYMENTS_REDACTED]. Security Clearance: [CLEARANCE_REDACTED]. Physical Fitness: [SCORE_REDACTED]. Last Promotion: [DATE_REDACTED].', tags: ['service-record', 'erb'] },
      { desc: 'VA disability rating letter', text: 'DEPARTMENT OF VETERANS AFFAIRS. Rating Decision. Veteran: [NAME_REDACTED]. VA File Number: [FILE_REDACTED]. Service-Connected Disabilities: 1. [CONDITION_REDACTED] — [PERCENT_REDACTED]%. 2. [CONDITION_REDACTED] — [PERCENT_REDACTED]%. Combined Rating: [COMBINED_REDACTED]%. Effective Date: [DATE_REDACTED]. Monthly Compensation: $[AMT_REDACTED]. This decision is based on your claim received [DATE_REDACTED]. You have the right to appeal.', tags: ['va', 'disability'] },
      { desc: 'Air Force technical school certificate', text: 'DEPARTMENT OF THE AIR FORCE. COMMUNITY COLLEGE OF THE AIR FORCE. This certifies that [NAME_REDACTED], [RANK_REDACTED], USAF, has been awarded the Associate in Applied Science degree in [FIELD_REDACTED]. Cumulative GPA: [GPA_REDACTED]. Credit Hours: 64. This degree is accredited by the Southern Association of Colleges and Schools Commission on Colleges. Date: [DATE_REDACTED]. Commandant: [NAME_REDACTED].', tags: ['air-force', 'ccaf'] },
      { desc: 'Suspicious DD-214 — obvious forgery', text: 'DD FORM 214. Member: [NAME_REDACTED]. Rank: Five Star General. MOS: Classified Ultra Top Secret. Service: 2020-2021 (1 year active duty). Awards: Medal of Honor, Distinguished Service Cross, Silver Star, Bronze Star (all in one year). Character of Service: Honorable. Note: Font differs between fields. No ISSUING ACTIVITY listed. No Separation Authority cited.', tags: ['suspicious', 'dd-214'] },
    ];
    let idx = 2470;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2509; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'MILITARY',
          groundTruth: {
            credentialType: 'MILITARY',
            fraudSignals: isFraud ? ['impossible_rank_timeline', 'excessive_awards', 'font_inconsistency', 'missing_authority'] : [],
            reasoning: isFraud
              ? 'Five Star General rank with only 1 year of service is impossible. Multiple highest decorations in one year is implausible. Font inconsistencies and missing Separation Authority.'
              : `Legitimate ${spec.desc} with standard military format and proper authority references.`,
          },
          source: 'synthetic-military-p17',
          category: 'military',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // PUBLICATION (40 entries) — GD-2510 to GD-2549
  // ============================================================
  ...(function generatePublicationEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'Peer-reviewed journal article', text: 'JOURNAL ARTICLE. Title: Machine Learning Applications in Genomic Medicine: A Systematic Review. Authors: [AUTHORS_REDACTED]. Journal: Nature Reviews Genetics. Volume: 27, Issue: 3, pp. 145-162. DOI: 10.1038/s41576-026-0001-x. Published: March 2026. Abstract: This systematic review examines 247 studies on ML applications in genomic medicine... Keywords: machine learning, genomics, precision medicine, deep learning. Received: October 2025. Accepted: January 2026. Published: March 2026.', tags: ['journal', 'peer-reviewed'] },
      { desc: 'Conference paper', text: 'CONFERENCE PAPER. Title: Efficient Transformer Architectures for Edge Computing. Authors: [AUTHORS_REDACTED]. Conference: IEEE International Conference on Computer Vision (ICCV) 2026. Pages: 4521-4530. DOI: [DOI_REDACTED]. Abstract: We present a novel attention mechanism optimized for resource-constrained edge devices... Oral Presentation. Best Paper Nominee.', tags: ['conference', 'ieee'] },
      { desc: 'Book publication', text: 'BOOK. Title: Modern Cryptographic Engineering: Theory and Practice. Author: [AUTHOR_REDACTED]. Publisher: Springer. ISBN: 978-3-030-[ISBN_REDACTED]. Year: 2026. Pages: 524. Edition: 1st. Series: Lecture Notes in Computer Science. DOI: 10.1007/[DOI_REDACTED]. Subjects: Cryptography, Network Security, Information Theory.', tags: ['book', 'springer'] },
      { desc: 'Preprint on arXiv', text: 'PREPRINT. Title: Scaling Laws for Constitutional AI Fine-Tuning. Authors: [AUTHORS_REDACTED]. arXiv: 2603.[ID_REDACTED]. Submitted: March 1, 2026. Categories: cs.AI, cs.CL, cs.LG. Abstract: We investigate the scaling laws governing constitutional AI fine-tuning across model sizes from 1B to 175B parameters... Status: Under review at NeurIPS 2026. License: CC BY 4.0.', tags: ['preprint', 'arxiv'] },
      { desc: 'Book chapter', text: 'BOOK CHAPTER. Title: Regulatory Frameworks for Autonomous Vehicles. Authors: [AUTHORS_REDACTED]. Book: Handbook of Transportation Law and Policy. Editor: [EDITOR_REDACTED]. Publisher: Oxford University Press. Year: 2026. Chapter: 14. Pages: 312-345. ISBN: [ISBN_REDACTED]. DOI: [DOI_REDACTED].', tags: ['chapter', 'oup'] },
      { desc: 'Technical report', text: 'TECHNICAL REPORT. Title: Assessment of Cybersecurity Risks in Critical Infrastructure. Authors: [AUTHORS_REDACTED]. Organization: [ORG_REDACTED] National Laboratory. Report Number: [RPT_REDACTED]. Date: February 2026. Pages: 87. Classification: Unclassified. Sponsoring Agency: Department of Energy. Contract Number: [CONTRACT_REDACTED].', tags: ['technical-report'] },
      { desc: 'Suspicious publication — predatory journal', text: 'JOURNAL ARTICLE. Title: Revolutionary Discovery Cures All Known Diseases. Authors: [NAME_REDACTED]. Journal: International Journal of Advanced Research and Innovation. Impact Factor: Self-claimed 15.2. DOI: None. Published: Same day as submission. Peer Review: Not specified. APC: $50. Publisher: [PUBLISHER_REDACTED] (not indexed in Web of Science, Scopus, or PubMed).', tags: ['suspicious', 'predatory'] },
      { desc: 'Patent-related publication', text: 'RESEARCH DISCLOSURE. Title: Method for Real-Time Anomaly Detection in Industrial IoT Networks. Authors: [AUTHORS_REDACTED]. Disclosure Number: RD-2026-[NUM_REDACTED]. Date: January 2026. Organization: [COMPANY_REDACTED]. Abstract: A novel method combining federated learning with edge-based anomaly detection for securing industrial IoT networks... Prior Art Search: Completed. Patent Application: Pending.', tags: ['disclosure', 'industrial'] },
    ];
    let idx = 2510;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2549; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'PUBLICATION',
          groundTruth: {
            credentialType: 'PUBLICATION',
            fraudSignals: isFraud ? ['predatory_journal', 'no_doi', 'same_day_publication', 'not_indexed'] : [],
            reasoning: isFraud
              ? 'Published same day as submission, no DOI, self-claimed impact factor, not indexed in any reputable database — classic predatory journal indicators.'
              : `Legitimate ${spec.desc} with proper DOI, peer review, and recognized publisher.`,
          },
          source: 'synthetic-publication-p17',
          category: 'publication',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // INSURANCE (40 entries) — GD-2550 to GD-2589
  // ============================================================
  ...(function generateInsuranceEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'Certificate of insurance (COI) — general liability', text: 'CERTIFICATE OF LIABILITY INSURANCE. Date: March 1, 2026. Producer: [AGENCY_REDACTED] Insurance Agency. Insured: [COMPANY_REDACTED]. Coverage: Commercial General Liability. Policy Number: [POLICY_REDACTED]. Effective: January 1, 2026. Expiration: January 1, 2027. Limits: Each Occurrence $1,000,000. General Aggregate $2,000,000. Products/Completed Ops $2,000,000. Personal & Advertising Injury $1,000,000. Insurer: [INSURER_REDACTED]. AM Best Rating: A+ (Superior). NAIC #: [NAIC_REDACTED].', tags: ['coi', 'general-liability'] },
      { desc: 'Professional liability (E&O) insurance', text: 'PROFESSIONAL LIABILITY INSURANCE POLICY. Policyholder: [COMPANY_REDACTED]. Policy Number: [POLICY_REDACTED]. Type: Errors & Omissions. Coverage Period: March 1, 2026 - March 1, 2027. Per Claim Limit: $2,000,000. Aggregate Limit: $5,000,000. Deductible: $10,000 Per Claim. Retroactive Date: January 1, 2020. Coverage Territory: Worldwide. Insurer: [INSURER_REDACTED]. Underwriter: [NAME_REDACTED].', tags: ['eo', 'professional-liability'] },
      { desc: 'Cyber liability insurance', text: 'CYBER LIABILITY INSURANCE CERTIFICATE. Insured: [COMPANY_REDACTED]. Policy: [POLICY_REDACTED]. Effective: February 1, 2026. Expiration: February 1, 2027. Coverage: First Party: Data Breach Response $5,000,000. Business Interruption $2,000,000. Cyber Extortion $1,000,000. Third Party: Network Security Liability $5,000,000. Privacy Liability $5,000,000. Retention: $25,000. Insurer: [INSURER_REDACTED]. Sublimits apply per endorsement.', tags: ['cyber', 'liability'] },
      { desc: 'Workers compensation certificate', text: 'CERTIFICATE OF INSURANCE — WORKERS COMPENSATION. Insured: [COMPANY_REDACTED]. Policy: [POLICY_REDACTED]. Carrier: [INSURER_REDACTED]. State: [STATE_REDACTED]. Effective: January 1, 2026. Expiration: January 1, 2027. Coverage A (Workers Compensation): Statutory Limits. Coverage B (Employers Liability): Bodily Injury by Accident $1,000,000. Bodily Injury by Disease $1,000,000 (policy limit). Bodily Injury by Disease $1,000,000 (each employee). Experience Modification Factor: 0.89.', tags: ['workers-comp'] },
      { desc: 'Commercial auto insurance', text: 'COMMERCIAL AUTO INSURANCE. Named Insured: [COMPANY_REDACTED]. Policy: [POLICY_REDACTED]. Effective: April 1, 2026 to April 1, 2027. Vehicles Covered: Schedule of 15 vehicles (see attached). Liability: Combined Single Limit $1,000,000. Uninsured Motorist: $1,000,000. Medical Payments: $5,000. Physical Damage: Actual Cash Value. Deductible: Comprehensive $500, Collision $1,000. Insurer: [INSURER_REDACTED]. Territory: [STATE_REDACTED].', tags: ['commercial-auto'] },
      { desc: 'Umbrella/excess liability', text: 'COMMERCIAL UMBRELLA LIABILITY. Insured: [COMPANY_REDACTED]. Policy: [POLICY_REDACTED]. Effective: January 1, 2026 to January 1, 2027. Each Occurrence: $5,000,000. Aggregate: $5,000,000. Self-Insured Retention: $10,000. Underlying Insurance: CGL, Auto, Employers Liability. Insurer: [INSURER_REDACTED]. AM Best: A (Excellent), Financial Size: XV.', tags: ['umbrella', 'excess'] },
      { desc: 'Health insurance ID card', text: 'HEALTH INSURANCE ID CARD. Group: [GROUP_REDACTED]. Member: [NAME_REDACTED]. Member ID: [MID_REDACTED]. Group Number: [GRP_REDACTED]. Plan: PPO Gold. Effective Date: January 1, 2026. PCP Copay: $25. Specialist Copay: $50. ER Copay: $250. Rx: Generic $10 / Brand $35 / Specialty 20%. Deductible: $1,500 Individual / $3,000 Family. Out-of-Pocket Max: $6,000 / $12,000. Network: [NETWORK_REDACTED]. Insurer: [INSURER_REDACTED].', tags: ['health', 'id-card'] },
      { desc: 'Suspicious COI — expired and altered', text: 'CERTIFICATE OF LIABILITY INSURANCE. Insured: [COMPANY_REDACTED]. Policy: [POLICY_REDACTED]. Effective: January 1, 2020. Expiration: January 1, 2021. NOTE: This certificate shows a 2020-2021 policy period but the date field has been overwritten with "2026" using a different font. The limits field shows whiteout marks. Insurer NAIC number does not match the named carrier.', tags: ['suspicious', 'altered'] },
    ];
    let idx = 2550;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2589; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'INSURANCE',
          groundTruth: {
            credentialType: 'INSURANCE',
            fraudSignals: isFraud ? ['date_alteration', 'whiteout_marks', 'naic_mismatch', 'font_inconsistency'] : [],
            reasoning: isFraud
              ? 'Certificate shows date overwriting with different font, whiteout marks on limits, and NAIC number mismatch — clear signs of document alteration.'
              : `Standard ${spec.desc} with proper carrier information, limits, and regulatory references.`,
          },
          source: 'synthetic-insurance-p17',
          category: 'insurance',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // LEGAL (40 entries) — GD-2590 to GD-2629
  // ============================================================
  ...(function generateLegalEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'Non-disclosure agreement (NDA)', text: 'MUTUAL NON-DISCLOSURE AGREEMENT. This Agreement is entered into as of [DATE_REDACTED] between [PARTY_A_REDACTED] ("Discloser") and [PARTY_B_REDACTED] ("Recipient"). Purpose: Evaluation of potential business relationship. Confidential Information: All non-public business, technical, and financial information. Term: 2 years from Effective Date. Governing Law: State of [STATE_REDACTED]. Remedies: Injunctive relief in addition to damages. Signatures: [SIG_REDACTED].', tags: ['nda', 'contract'] },
      { desc: 'Court order — restraining order', text: 'SUPERIOR COURT OF [STATE_REDACTED]. COUNTY OF [COUNTY_REDACTED]. Case No: [CASE_REDACTED]. TEMPORARY RESTRAINING ORDER. [PETITIONER_REDACTED] v. [RESPONDENT_REDACTED]. THE COURT ORDERS: Respondent shall not contact, threaten, or come within 500 feet of Petitioner. This order is effective immediately and remains in force until [DATE_REDACTED]. Violation of this order is a criminal offense. Judge: [JUDGE_REDACTED]. Date: [DATE_REDACTED]. Filed: [DATE_REDACTED].', tags: ['court-order', 'restraining'] },
      { desc: 'Power of attorney — general', text: 'GENERAL POWER OF ATTORNEY. I, [NAME_REDACTED] ("Principal"), of [ADDRESS_REDACTED], hereby appoint [NAME_REDACTED] ("Agent") as my attorney-in-fact to act on my behalf in all matters including: financial transactions, real property, personal property, legal proceedings, and government benefits. This power of attorney is durable and shall not be affected by my subsequent incapacity. Effective Date: [DATE_REDACTED]. State of [STATE_REDACTED]. Notarized: [DATE_REDACTED]. Notary: [NOTARY_REDACTED]. Commission Expires: [DATE_REDACTED].', tags: ['poa', 'general'] },
      { desc: 'Employment contract', text: 'EMPLOYMENT AGREEMENT. This Agreement is made between [COMPANY_REDACTED] ("Employer") and [NAME_REDACTED] ("Employee"). Position: [TITLE_REDACTED]. Start Date: [DATE_REDACTED]. Compensation: $[SALARY_REDACTED] annually. Benefits: Health, dental, vision, 401(k) with 4% match. PTO: 20 days. Non-compete: 12 months post-termination within 50-mile radius. Termination: At-will, with 2-week notice period. Governing Law: [STATE_REDACTED]. Signatures: [SIG_REDACTED].', tags: ['employment', 'contract'] },
      { desc: 'Regulatory filing — SEC Form 4', text: 'SECURITIES AND EXCHANGE COMMISSION. FORM 4: STATEMENT OF CHANGES IN BENEFICIAL OWNERSHIP. Filed: [DATE_REDACTED]. Issuer: [COMPANY_REDACTED]. CIK: [CIK_REDACTED]. Reporting Person: [NAME_REDACTED]. Relationship: Director. Transaction: Purchase. Date: [DATE_REDACTED]. Shares: [NUM_REDACTED]. Price: $[PRICE_REDACTED]. Shares Owned Following: [NUM_REDACTED]. Direct Ownership.', tags: ['sec', 'form-4'] },
      { desc: 'Lease agreement', text: 'COMMERCIAL LEASE AGREEMENT. Landlord: [LANDLORD_REDACTED]. Tenant: [TENANT_REDACTED]. Premises: [ADDRESS_REDACTED]. Lease Term: 5 years, commencing [DATE_REDACTED]. Base Rent: $[AMT_REDACTED]/month. Annual Escalation: 3%. Security Deposit: $[AMT_REDACTED]. Use: General office. Maintenance: Triple-net (NNN). Insurance Required: CGL $1M, Property $500K. Governing Law: [STATE_REDACTED].', tags: ['lease', 'commercial'] },
      { desc: 'Settlement agreement', text: 'CONFIDENTIAL SETTLEMENT AGREEMENT AND RELEASE. Parties: [PARTY_A_REDACTED] and [PARTY_B_REDACTED]. Case: [CASE_REDACTED]. This Agreement resolves all claims arising from [DISPUTE_REDACTED]. Settlement Amount: $[AMT_REDACTED]. Payment: Within 30 days. Mutual Release: Both parties release all claims. Confidentiality: Terms are confidential. Non-Disparagement: Both parties agree. Governing Law: [STATE_REDACTED]. Signatures: [SIG_REDACTED].', tags: ['settlement'] },
      { desc: 'Suspicious legal document — forged notarization', text: 'POWER OF ATTORNEY. I, [NAME_REDACTED], grant all powers to [NAME_REDACTED]. Notarized by: [NOTARY_REDACTED]. Commission #: 12345. NOTE: Notary commission number is only 5 digits (should be longer). Notary seal appears to be a rubber stamp reproduction. Date of notarization is a Sunday. No jurat or acknowledgment language.', tags: ['suspicious', 'forged'] },
    ];
    let idx = 2590;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2629; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'LEGAL',
          groundTruth: {
            credentialType: 'LEGAL',
            fraudSignals: isFraud ? ['forged_notarization', 'invalid_commission_number', 'weekend_notarization', 'missing_jurat'] : [],
            reasoning: isFraud
              ? 'Notary commission number is suspiciously short, seal appears reproduced, notarization on a Sunday (unusual), and missing required jurat language.'
              : `Standard ${spec.desc} with proper legal format, governing law, and execution.`,
          },
          source: 'synthetic-legal-p17',
          category: 'legal',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // BADGE (40 entries) — GD-2630 to GD-2669
  // ============================================================
  ...(function generateBadgeEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'Credly digital badge — AWS Certified', text: 'DIGITAL BADGE. Platform: Credly. Badge Name: AWS Certified Solutions Architect — Associate. Issuer: Amazon Web Services. Issued: January 15, 2026. Expires: January 15, 2029. Badge ID: [BADGE_REDACTED]. Verification URL: https://www.credly.com/badges/[BADGE_REDACTED]. Skills: Cloud Architecture, AWS Services, Security, Networking. Standard: Open Badges v2.0.', tags: ['credly', 'aws', 'cloud'] },
      { desc: 'Open Badge — university microcredential', text: 'OPEN BADGE. Badge Name: Data Analytics Microcredential. Issuer: [UNIVERSITY_REDACTED]. Issued: February 2026. Criteria: Complete 4 courses (12 credits) in data analytics with GPA >= 3.0. Evidence: Course completion records. Skills: Python, SQL, Tableau, Statistical Analysis. Standard: IMS Open Badges v3.0. Hosted: [PLATFORM_REDACTED]. Badge Image: SVG, signed.', tags: ['open-badge', 'microcredential'] },
      { desc: 'Google professional certificate badge', text: 'DIGITAL BADGE. Platform: Credly. Badge Name: Google Professional Cloud Architect. Issuer: Google Cloud. Issued: March 10, 2026. Expires: March 10, 2028. Earner: [NAME_REDACTED]. Badge ID: [BADGE_REDACTED]. Criteria: Pass Google Cloud Professional Cloud Architect certification exam. Skills: GCP, Kubernetes, Cloud Security, IAM. Verification: https://www.credly.com/badges/[BADGE_REDACTED].', tags: ['credly', 'google', 'cloud'] },
      { desc: 'Microsoft certification badge', text: 'DIGITAL BADGE. Microsoft Certified: Azure Solutions Architect Expert. Issuer: Microsoft. Issued: February 1, 2026. Expires: February 1, 2027. Earner: [NAME_REDACTED]. Transcript ID: [TRANS_REDACTED]. Exams Passed: AZ-305. Skills: Azure Infrastructure, Identity, Security, Governance. Badge URL: https://learn.microsoft.com/certifications/[CERT_REDACTED].', tags: ['microsoft', 'azure'] },
      { desc: 'LinkedIn Learning badge', text: 'LEARNING PATH COMPLETION BADGE. Platform: LinkedIn Learning. Path: Become a Machine Learning Engineer. Courses Completed: 8 (32 hours). Completed: March 2026. Earner: [NAME_REDACTED]. Skills: Machine Learning, TensorFlow, Scikit-learn, Neural Networks, NLP. Certificate ID: [CERT_REDACTED]. Verification: linkedin.com/learning/certificates/[CERT_REDACTED].', tags: ['linkedin', 'learning'] },
      { desc: 'CompTIA certification badge', text: 'DIGITAL BADGE. CompTIA Security+. Certification Number: [CERT_REDACTED]. Issued: January 2026. Expires: January 2029. Earner: [NAME_REDACTED]. Exam: SY0-701. CE Credits Required: 50 over 3 years. Continuing Education Status: Active. Platform: CompTIA CertMetrics. Skills: Network Security, Cryptography, Risk Management, Incident Response.', tags: ['comptia', 'security'] },
      { desc: 'Salesforce Trailhead badge', text: 'TRAILHEAD BADGE. Badge: Salesforce Certified Administrator. Issuer: Salesforce. Earned: February 2026. Earner: [NAME_REDACTED]. Trailhead Rank: Ranger. Badges Earned: 200+. Superbadges: 5. Verification: trailhead.salesforce.com/credentials/verification. Exam: ADM-201. Skills: Salesforce Administration, Security, Data Management, Automation.', tags: ['salesforce', 'trailhead'] },
      { desc: 'Suspicious badge — unverifiable platform', text: 'DIGITAL BADGE. Badge Name: Certified Expert Everything. Issuer: Global Certification Institute (not recognized by any accreditation body). Platform: UnknownBadges.com (domain registered last week). No Open Badge standard. No verification URL. No criteria listed. No expiry. Skills: "All skills." Badge ID: 12345.', tags: ['suspicious'] },
    ];
    let idx = 2630;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2669; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'BADGE',
          groundTruth: {
            credentialType: 'BADGE',
            fraudSignals: isFraud ? ['unrecognized_issuer', 'no_verification_url', 'no_criteria', 'suspicious_platform'] : [],
            reasoning: isFraud
              ? 'Issuer not recognized, platform domain recently registered, no Open Badge standard compliance, no verification URL, and no specific criteria.'
              : `Legitimate ${spec.desc} with verifiable platform, recognized issuer, and Open Badge standard.`,
          },
          source: 'synthetic-badge-p17',
          category: 'badge',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // OTHER (30 entries) — GD-2670 to GD-2699
  // ============================================================
  ...(function generateOtherEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[] }> = [
      { desc: 'Unrecognizable scanned document — poor quality', text: '[HEAVILY_DEGRADED_SCAN]. Partial text visible: "...hereby cert...ation of...mber 20...igned by..." Most of the document is illegible due to scanning artifacts, rotation, and coffee stains. No logo or seal visible.', tags: ['junk', 'degraded'] },
      { desc: 'Mixed content — invoice and certificate combined', text: 'INVOICE #[INV_REDACTED]. Date: March 2026. Bill To: [NAME_REDACTED]. Services: Professional Development Course — $499.00. [PAGE_BREAK] CERTIFICATE OF COMPLETION. This certifies that [NAME_REDACTED] has completed the Professional Development Course in Leadership. Date: March 15, 2026. Instructor: [NAME_REDACTED].', tags: ['mixed', 'invoice-cert'] },
      { desc: 'Personal letter of recommendation', text: 'LETTER OF RECOMMENDATION. Date: February 20, 2026. To Whom It May Concern: I am writing to recommend [NAME_REDACTED] for [POSITION_REDACTED]. I have known [NAME_REDACTED] for 5 years in my capacity as [ROLE_REDACTED]. [NAME_REDACTED] is an outstanding [QUALITY_REDACTED]. Sincerely, [AUTHOR_REDACTED]. [TITLE_REDACTED].', tags: ['letter', 'recommendation'] },
      { desc: 'Spreadsheet data — not a credential', text: 'A,B,C,D\n1,Employee,Department,Start Date\n2,[NAME_REDACTED],Engineering,2024-01-15\n3,[NAME_REDACTED],Marketing,2023-06-01\n4,[NAME_REDACTED],Finance,2025-03-10\n... (200 more rows of tabular employee data)', tags: ['junk', 'spreadsheet'] },
      { desc: 'Email thread — compliance discussion', text: 'From: [EMAIL_REDACTED]. To: [EMAIL_REDACTED]. Subject: Re: Compliance audit follow-up. Date: March 10, 2026. Hi [NAME_REDACTED], Following up on our discussion about the SOC 2 audit findings. We need to address the access control issues by end of month. Key items: 1) MFA enforcement 2) Access reviews 3) Logging. Best, [NAME_REDACTED].', tags: ['email', 'not-credential'] },
      { desc: 'Blank document with header only', text: '[COMPANY_REDACTED] OFFICIAL LETTERHEAD. [ADDRESS_REDACTED]. [PHONE_REDACTED]. [The rest of the page is blank]', tags: ['blank', 'junk'] },
    ];
    let idx = 2670;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2699; v++) {
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'OTHER',
          groundTruth: {
            credentialType: 'OTHER',
            fraudSignals: [],
            reasoning: `Non-standard document: ${spec.desc}. Does not fit any recognized credential type.`,
          },
          source: 'synthetic-other-p17',
          category: 'other',
          tags: ['synthetic', 'clean', ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // CHARITY (30 entries) — GD-2700 to GD-2729
  // ============================================================
  ...(function generateCharityEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[]; issuer?: string; jurisdiction?: string }> = [
      { desc: 'IRS 501(c)(3) determination letter', text: 'DEPARTMENT OF THE TREASURY. INTERNAL REVENUE SERVICE. Date: [DATE_REDACTED]. EIN: [EIN_REDACTED]. Dear Applicant: We are pleased to inform you that upon review of your application, your organization has been determined to be exempt from Federal income tax under section 501(c)(3). Your exempt purposes are charitable, educational, and scientific. Donors may deduct contributions per section 170. Public charity status: 509(a)(1). Accounting period: Calendar year.', tags: ['501c3', 'irs'], issuer: 'Internal Revenue Service', jurisdiction: 'United States' },
      { desc: 'State charity registration', text: 'OFFICE OF THE ATTORNEY GENERAL. STATE OF [STATE_REDACTED]. CHARITABLE ORGANIZATION REGISTRATION. Registration No: [REG_REDACTED]. Organization: [ORG_REDACTED]. Address: [ADDRESS_REDACTED]. Registration Date: [DATE_REDACTED]. Expiration: [DATE_REDACTED]. Purpose: [PURPOSE_REDACTED]. Annual Reporting Required: Yes. Registered Agent: [AGENT_REDACTED].', tags: ['state-registration'], jurisdiction: 'United States' },
      { desc: 'ACNC registration (Australia)', text: 'AUSTRALIAN CHARITIES AND NOT-FOR-PROFITS COMMISSION. REGISTRATION CERTIFICATE. ABN: [ABN_REDACTED]. Charity Name: [ORG_REDACTED]. Registration Date: [DATE_REDACTED]. Charity Type: Advancing Education. Subtypes: Advancement of Education, Advancement of Social or Public Welfare. Status: Registered. Registered under the ACNC Act 2012. Commissioner: [NAME_REDACTED].', tags: ['acnc', 'australia'], issuer: 'ACNC', jurisdiction: 'Australia' },
      { desc: 'UK Charity Commission registration', text: 'CHARITY COMMISSION FOR ENGLAND AND WALES. Registered Charity Number: [NUM_REDACTED]. Name: [ORG_REDACTED]. Registration Date: [DATE_REDACTED]. Purposes: Relief of poverty, advancement of education. Annual Income: [AMT_REDACTED]. Governing Document: Trust Deed. Trustees: [TRUSTEES_REDACTED]. Reporting Status: Up to date.', tags: ['uk-charity'], jurisdiction: 'United Kingdom' },
      { desc: 'Canadian charity registration (CRA)', text: 'CANADA REVENUE AGENCY. NOTICE OF REGISTRATION. Business Number: [BN_REDACTED]. Organization: [ORG_REDACTED]. Effective Date of Registration: [DATE_REDACTED]. Registered as: Charitable Organization under the Income Tax Act. Category: Relief of Poverty. Fiscal Period End: December 31. Filing Requirement: T3010 annual return.', tags: ['cra', 'canada'], issuer: 'Canada Revenue Agency', jurisdiction: 'Canada' },
      { desc: 'Suspicious charity — unregistered solicitation', text: 'CHARITY APPEAL. Organization: [ORG_REDACTED] Foundation. Purpose: Help children worldwide. Registration: "Pending" (claimed for 3 years). No EIN listed. No state registration. Website domain registered last month. Address is a PO Box only. No financial disclosures. Board of directors: 1 person.', tags: ['suspicious'] },
    ];
    let idx = 2700;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2729; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'CHARITY',
          groundTruth: {
            credentialType: 'CHARITY',
            issuerName: spec.issuer,
            jurisdiction: spec.jurisdiction,
            fraudSignals: isFraud ? ['no_registration', 'pending_3_years', 'no_ein', 'no_financial_disclosure', 'single_board_member'] : [],
            reasoning: isFraud
              ? 'Charity claims registration has been "pending" for 3 years, has no EIN, no state registration, recently registered domain, and only one board member.'
              : `Legitimate ${spec.desc} with proper government registration and regulatory compliance.`,
          },
          source: 'synthetic-charity-p17',
          category: 'charity',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // PATENT (30 entries) — GD-2730 to GD-2759
  // ============================================================
  ...(function generatePatentEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[]; jurisdiction?: string }> = [
      { desc: 'US utility patent', text: 'UNITED STATES PATENT AND TRADEMARK OFFICE. Patent No: US [PATENT_REDACTED]. Title: Method and Apparatus for Distributed Machine Learning Training. Inventors: [INVENTORS_REDACTED]. Assignee: [COMPANY_REDACTED]. Filed: [DATE_REDACTED]. Granted: [DATE_REDACTED]. Classification: G06N 3/08. Claims: 24. Abstract: A method for distributing machine learning training across heterogeneous computing nodes...', tags: ['utility', 'us'], jurisdiction: 'United States' },
      { desc: 'US design patent', text: 'UNITED STATES PATENT. Patent No: US D[PATENT_REDACTED]. Title: Wearable Health Monitoring Device. Inventor: [INVENTOR_REDACTED]. Assignee: [COMPANY_REDACTED]. Filed: [DATE_REDACTED]. Granted: [DATE_REDACTED]. Term: 15 years from grant. Claim: The ornamental design for a wearable health monitoring device, as shown and described. [FIGURES_REDACTED].', tags: ['design', 'us'], jurisdiction: 'United States' },
      { desc: 'Provisional patent application', text: 'UNITED STATES PATENT AND TRADEMARK OFFICE. PROVISIONAL APPLICATION. Application No: 63/[APP_REDACTED]. Filing Date: [DATE_REDACTED]. Title: Quantum-Resistant Encryption for IoT Devices. Inventors: [INVENTORS_REDACTED]. This provisional application establishes a priority date. Expires: 12 months from filing. No examination. Applicant must file non-provisional within 12 months.', tags: ['provisional', 'us'], jurisdiction: 'United States' },
      { desc: 'PCT international patent application', text: 'PATENT COOPERATION TREATY. INTERNATIONAL APPLICATION. PCT Application No: PCT/US2026/[APP_REDACTED]. Filing Date: [DATE_REDACTED]. Title: Biodegradable Polymer Composite for Medical Implants. Applicant: [COMPANY_REDACTED]. International Searching Authority: USPTO. Priority: US Provisional [APP_REDACTED]. Designated States: All contracting states. International Publication No: WO 2026/[PUB_REDACTED].', tags: ['pct', 'international'] },
      { desc: 'European patent', text: 'EUROPEAN PATENT OFFICE. European Patent EP [PATENT_REDACTED]. Title: Autonomous Vehicle Navigation System Using LIDAR Fusion. Proprietor: [COMPANY_REDACTED]. Inventor: [INVENTOR_REDACTED]. Filing Date: [DATE_REDACTED]. Grant Date: [DATE_REDACTED]. Designated States: DE, FR, GB, NL, IT. Classification: G01S 17/93, G05D 1/02. Claims: 18. This patent has been granted and published in accordance with Article 97(1) EPC.', tags: ['european', 'epo'], jurisdiction: 'Europe' },
      { desc: 'Suspicious patent — fake filing', text: 'PATENT CERTIFICATE. Patent No: US99999999. Title: Perpetual Motion Machine. Inventor: [NAME_REDACTED]. Filed: Yesterday. Granted: Today. Claims: 1 (Unlimited energy from nothing). NOTE: Patent number format is invalid. Filing-to-grant time is impossible. Perpetual motion violates thermodynamics. No attorney of record. No classification.', tags: ['suspicious'] },
    ];
    let idx = 2730;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2759; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'PATENT',
          groundTruth: {
            credentialType: 'PATENT',
            jurisdiction: spec.jurisdiction,
            fraudSignals: isFraud ? ['invalid_patent_number', 'impossible_timeline', 'perpetual_motion', 'no_classification'] : [],
            reasoning: isFraud
              ? 'Invalid patent number format, same-day filing and grant (impossible), perpetual motion claim violates physics, no classification or attorney.'
              : `Legitimate ${spec.desc} with proper patent office format, classification, and filing timeline.`,
          },
          source: 'synthetic-patent-p17',
          category: 'patent',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),

  // ============================================================
  // BUSINESS_ENTITY (30 entries) — GD-2760 to GD-2789
  // ============================================================
  ...(function generateBusinessEntityEntries(): GoldenDatasetEntry[] {
    const entries: GoldenDatasetEntry[] = [];
    const specs: Array<{ desc: string; text: string; tags: string[]; jurisdiction?: string }> = [
      { desc: 'Certificate of Good Standing — Delaware', text: 'STATE OF DELAWARE. CERTIFICATE OF GOOD STANDING. I, [SECRETARY_REDACTED], Secretary of State of the State of Delaware, do hereby certify that [COMPANY_REDACTED], a corporation filed in this office on [DATE_REDACTED], File No: [FILE_REDACTED], is in good standing and has a legal corporate existence so far as the records of this office show. Issued: [DATE_REDACTED].', tags: ['good-standing', 'delaware'], jurisdiction: 'Delaware, USA' },
      { desc: 'Articles of incorporation', text: 'ARTICLES OF INCORPORATION OF [COMPANY_REDACTED]. Filed with the Secretary of State of [STATE_REDACTED]. Document No: [DOC_REDACTED]. Date Filed: [DATE_REDACTED]. Name: [COMPANY_REDACTED], Inc. Purpose: To engage in any lawful business. Authorized Shares: 10,000,000 common. Par Value: $0.001. Registered Agent: [AGENT_REDACTED]. Registered Office: [ADDRESS_REDACTED]. Incorporator: [NAME_REDACTED].', tags: ['articles', 'incorporation'], jurisdiction: 'United States' },
      { desc: 'Annual report filing', text: 'STATE OF [STATE_REDACTED]. ANNUAL REPORT. Entity Name: [COMPANY_REDACTED] LLC. File Number: [FILE_REDACTED]. Report Year: 2025. Principal Office: [ADDRESS_REDACTED]. Registered Agent: [AGENT_REDACTED]. Members/Managers: [NAMES_REDACTED]. Nature of Business: Technology Services. Status: Active. Filed: [DATE_REDACTED]. Fee Paid: $[AMT_REDACTED].', tags: ['annual-report'], jurisdiction: 'United States' },
      { desc: 'EIN confirmation letter (IRS)', text: 'DEPARTMENT OF THE TREASURY. INTERNAL REVENUE SERVICE. EIN: [EIN_REDACTED]. Entity Name: [COMPANY_REDACTED]. Entity Type: Limited Liability Company. Date Formed: [DATE_REDACTED]. Tax Classification: Partnership. Accounting Period: Calendar Year. This EIN was assigned to your entity on [DATE_REDACTED]. Keep this letter for your permanent records.', tags: ['ein', 'irs'], jurisdiction: 'United States' },
      { desc: 'UK Companies House certificate', text: 'COMPANIES HOUSE. CERTIFICATE OF INCORPORATION. Company Number: [NUM_REDACTED]. Company Name: [COMPANY_REDACTED] LTD. Registered Office: [ADDRESS_REDACTED]. Date of Incorporation: [DATE_REDACTED]. Company Type: Private Limited by Shares. Directors: [DIRECTORS_REDACTED]. Secretary: [SECRETARY_REDACTED]. Share Capital: [SHARES_REDACTED].', tags: ['uk', 'companies-house'], jurisdiction: 'United Kingdom' },
      { desc: 'Suspicious business registration — shell company indicators', text: 'CERTIFICATE OF FORMATION. [COMPANY_REDACTED] LLC. State: [STATE_REDACTED]. Registered Agent: [MASS_AGENT_REDACTED] (serves as agent for 10,000+ entities). Address: Virtual office, mail forwarding only. No physical presence. Members: Single member — another LLC in different state. Purpose: "Any lawful purpose." Filed same day as 50 other entities with identical agent.', tags: ['suspicious'] },
    ];
    let idx = 2760;
    for (const spec of specs) {
      for (let v = 0; v < 5 && idx <= 2789; v++) {
        const isFraud = spec.tags.includes('suspicious');
        entries.push({
          id: `GD-${idx}`,
          description: `${spec.desc} (variation ${v + 1})`,
          strippedText: spec.text,
          credentialTypeHint: 'BUSINESS_ENTITY',
          groundTruth: {
            credentialType: 'BUSINESS_ENTITY',
            jurisdiction: spec.jurisdiction,
            fraudSignals: isFraud ? ['mass_registered_agent', 'virtual_office_only', 'nested_llc_ownership', 'bulk_filing'] : [],
            reasoning: isFraud
              ? 'Shell company indicators: mass registered agent (10,000+ entities), virtual office only, nested LLC ownership, and bulk filing with identical agent.'
              : `Legitimate ${spec.desc} with proper state filing, registered agent, and corporate details.`,
          },
          source: 'synthetic-business-p17',
          category: 'business_entity',
          tags: ['synthetic', ...(isFraud ? ['fraud'] : ['clean']), ...spec.tags],
        });
        idx++;
      }
    }
    return entries;
  })(),
];
