/**
 * GRE-06: Golden Dataset SubType Backfill
 *
 * Maps existing golden dataset entry IDs (phases 1-8) to their appropriate
 * subType values. This enriches older entries that were created before the
 * GRE-01 sub-type taxonomy was introduced.
 *
 * Only covers entries where the subType is clearly determinable from the
 * description and strippedText. Does not attempt to backfill ambiguous cases.
 *
 * Usage: Apply these subTypes during eval scoring or dataset restructuring.
 */

/**
 * Backfill entry with subType and optional reasoning/concerns.
 */
export interface SubTypeBackfillEntry {
  subType: string;
  reasoning?: string;
  concerns?: string[];
}

/**
 * Map of golden dataset entry ID -> subType backfill data.
 * Covers phases 1-8 (GD-001 through GD-1330).
 */
export const SUBTYPE_BACKFILL: Record<string, SubTypeBackfillEntry> = {
  // ============================================================
  // DEGREE entries — mapped by degreeLevel
  // ============================================================
  'GD-001': { subType: 'bachelor' },
  'GD-011': { subType: 'doctorate' },
  'GD-012': { subType: 'associate' },
  'GD-013': { subType: 'master', concerns: ['International credential — UK'] },
  'GD-014': { subType: 'bachelor' },
  'GD-015': { subType: 'associate', concerns: ['Defunct institution — fraud signal'] },
  'GD-026': { subType: 'bachelor', concerns: ['OCR artifacts present'] },
  'GD-027': { subType: 'doctorate', concerns: ['Future-dated — suspicious'] },
  'GD-029': { subType: 'bachelor', concerns: ['Non-English — Spanish'] },
  'GD-037': { subType: 'master', concerns: ['Non-English — German'] },
  'GD-040': { subType: 'bachelor', concerns: ['Impossible dates — fraud signal'] },
  'GD-041': { subType: 'professional_jd', reasoning: 'Yale Law School JD is a professional doctoral degree in law.' },
  'GD-042': { subType: 'professional_edd', reasoning: 'Columbia University EdD is a professional doctorate in education.' },
  'GD-046': { subType: 'master', concerns: ['International credential — Japan'] },
  'GD-051': { subType: 'bachelor', concerns: ['International credential — India'] },
  'GD-056': { subType: 'master', concerns: ['International credential — Korea'] },
  'GD-060': { subType: 'doctorate', concerns: ['Very old date — over 50 years'] },
  'GD-067': { subType: 'bachelor', concerns: ['International credential — Brazil'] },
  'GD-071': { subType: 'master', concerns: ['Mixed encoding artifacts'] },
  'GD-080': { subType: 'master', reasoning: 'Dual-degree diploma — classified by primary degree level.' },
  'GD-089': { subType: 'doctorate', concerns: ['Diploma mill — suspicious'] },
  'GD-092': { subType: 'master', concerns: ['German/English mix — international'] },
  'GD-100': { subType: 'bachelor', concerns: ['Truncated/corrupted document'] },
  'GD-101': { subType: 'master', reasoning: 'Carnegie Mellon MS in AI — master of science.' },
  'GD-102': { subType: 'doctorate', reasoning: 'Caltech PhD in Physics.' },
  'GD-103': { subType: 'bachelor', concerns: ['International credential — Australia'] },
  'GD-104': { subType: 'bachelor', concerns: ['International credential — Singapore'] },
  'GD-105': { subType: 'master', reasoning: 'UC Berkeley MBA is a master-level professional degree.' },
  'GD-106': { subType: 'master', concerns: ['International credential — UK'] },
  'GD-107': { subType: 'bachelor', concerns: ['International credential — Canada'] },
  'GD-108': { subType: 'bachelor' },
  'GD-109': { subType: 'master', concerns: ['International credential — Israel'] },
  'GD-110': { subType: 'bachelor' },
  'GD-141': { subType: 'bachelor' },
  'GD-142': { subType: 'master' },
  'GD-143': { subType: 'doctorate', concerns: ['HTML artifacts in text'] },
  'GD-147': { subType: 'associate', concerns: ['For-profit institution — format anomaly'] },
  'GD-148': { subType: 'master', concerns: ['International credential — Arabic'] },
  'GD-161': { subType: 'doctorate', reasoning: 'Princeton PhD in Economics.' },
  'GD-162': { subType: 'bachelor', reasoning: 'Brown University BA.' },
  'GD-171': { subType: 'master', reasoning: 'Cornell MS in CS.' },
  'GD-172': { subType: 'master', reasoning: 'UPenn Wharton MBA — professional master degree.' },
  'GD-181': { subType: 'bachelor', reasoning: 'Michigan State nursing degree — BSN.' },
  'GD-182': { subType: 'doctorate', reasoning: 'Georgia Tech PhD in ECE.' },
  'GD-192': { subType: 'bachelor' },
  'GD-193': { subType: 'bachelor', concerns: ['Contradictory information'] },
  'GD-194': { subType: 'master' },
  'GD-208': { subType: 'bachelor' },
  'GD-209': { subType: 'professional_md', reasoning: 'DNP (Doctor of Nursing Practice) is a professional doctorate.' },
  'GD-271': { subType: 'master', concerns: ['International credential — France'] },
  'GD-272': { subType: 'doctorate', concerns: ['International credential — Korea'] },
  'GD-273': { subType: 'bachelor', concerns: ['International credential — Brazil'] },
  'GD-274': { subType: 'master', concerns: ['International credential — Switzerland'] },
  'GD-276': { subType: 'bachelor', concerns: ['International credential — Mexico'] },
  'GD-279': { subType: 'bachelor', concerns: ['International credential — China'] },
  'GD-282': { subType: 'doctorate', concerns: ['International credential — Denmark'] },
  'GD-286': { subType: 'doctorate', concerns: ['Diploma mill — non-existent university'] },
  'GD-288': { subType: 'bachelor', concerns: ['Impossible date — before university founded'] },
  'GD-290': { subType: 'bachelor', concerns: ['Suspicious formatting anomalies'] },
  'GD-291': { subType: 'master', concerns: ['Fake accrediting body'] },

  // Phase 3-5 DEGREE entries
  'GD-311': { subType: 'bachelor' },
  'GD-312': { subType: 'master' },
  'GD-313': { subType: 'doctorate' },
  'GD-314': { subType: 'associate' },
  'GD-315': { subType: 'bachelor' },
  'GD-316': { subType: 'master' },
  'GD-501': { subType: 'bachelor' },
  'GD-502': { subType: 'master' },
  'GD-503': { subType: 'doctorate' },
  'GD-504': { subType: 'bachelor' },
  'GD-505': { subType: 'associate' },
  'GD-751': { subType: 'bachelor' },
  'GD-752': { subType: 'master' },
  'GD-753': { subType: 'doctorate' },
  'GD-754': { subType: 'bachelor' },
  'GD-755': { subType: 'associate' },

  // ============================================================
  // LICENSE entries — mapped by professional domain
  // ============================================================
  'GD-002': { subType: 'medical_md', reasoning: 'New York State medical license for MD.' },
  'GD-005': { subType: 'engineering_pe', reasoning: 'Texas PE license in Civil Engineering.' },
  'GD-016': { subType: 'nursing_rn', reasoning: 'California Board of Registered Nursing — RN license.' },
  'GD-017': { subType: 'real_estate' },
  'GD-018': { subType: 'cpa', concerns: ['License is expired'] },
  'GD-032': { subType: 'teaching' },
  'GD-033': { subType: 'pharmacist' },
  'GD-034': { subType: 'law_bar_admission' },
  'GD-038': { subType: 'dental' },
  'GD-043': { subType: 'architect' },
  'GD-047': { subType: 'veterinary' },
  'GD-048': { subType: 'general', reasoning: 'FAA pilot license — general license category.' },
  'GD-049': { subType: 'notary' },
  'GD-052': { subType: 'nursing_rn', concerns: ['International credential — Australia'] },
  'GD-055': { subType: 'law_bar_admission' },
  'GD-057': { subType: 'electrician' },
  'GD-061': { subType: 'social_work' },
  'GD-062': { subType: 'plumber' },
  'GD-064': { subType: 'cpa' },
  'GD-066': { subType: 'general', reasoning: 'Physiotherapy license — general license category.' },
  'GD-068': { subType: 'general', reasoning: 'Insurance adjuster — general license category.' },
  'GD-073': { subType: 'cosmetology' },
  'GD-076': { subType: 'general', reasoning: 'Massage therapy — general license category.' },
  'GD-078': { subType: 'real_estate' },
  'GD-083': { subType: 'general', reasoning: 'General contractor license.' },
  'GD-085': { subType: 'general', reasoning: 'Pesticide applicator — general license.' },
  'GD-087': { subType: 'general', reasoning: 'CDL — commercial driver license.' },
  'GD-093': { subType: 'medical_md', concerns: ['License is expired'] },
  'GD-096': { subType: 'psychology' },
  'GD-098': { subType: 'optometry' },
  'GD-111': { subType: 'general', reasoning: 'Physician assistant license — general category.' },
  'GD-112': { subType: 'general', reasoning: 'Occupational therapy license — general category.' },
  'GD-113': { subType: 'general', reasoning: 'Private investigator license — general category.' },
  'GD-114': { subType: 'speech_language_pathology' },
  'GD-115': { subType: 'general', reasoning: 'HVAC contractor license — general category.' },
  'GD-116': { subType: 'general', reasoning: 'Acupuncture license — general category.' },
  'GD-117': { subType: 'general', reasoning: 'Funeral director license — general category.' },
  'GD-118': { subType: 'general', reasoning: 'Surveyor license — general category.' },
  'GD-119': { subType: 'general', reasoning: 'Audiologist license — general category.' },
  'GD-120': { subType: 'chiropractic' },
  'GD-136': { subType: 'general', reasoning: 'Patent agent registration — general license.' },
  'GD-137': { subType: 'general', reasoning: 'Customs broker license — general license.' },
  'GD-138': { subType: 'general', reasoning: 'Respiratory therapy license — general license.' },
  'GD-144': { subType: 'medical_md', concerns: ['Very old license — 1995'] },
  'GD-145': { subType: 'real_estate', reasoning: 'Two credentials in one document — real estate primary.' },
  'GD-163': { subType: 'general', reasoning: 'Optician license — general category.' },
  'GD-164': { subType: 'general', reasoning: 'Hearing aid specialist license — general category.' },
  'GD-173': { subType: 'dental', reasoning: 'Dental hygienist — dental license category.' },
  'GD-174': { subType: 'general', reasoning: 'Dietitian license — general category.' },
  'GD-180': { subType: 'teaching' },
  'GD-183': { subType: 'general', reasoning: 'HVAC technician license — general category.' },
  'GD-184': { subType: 'nursing_lpn', reasoning: 'Midwifery is related to nursing/midwifery practice.' },
  'GD-186': { subType: 'general', reasoning: 'Enrolled Agent — IRS tax credential.' },
  'GD-187': { subType: 'general', reasoning: 'Art therapy license — general category.' },
  'GD-196': { subType: 'engineering_pe' },
  'GD-199': { subType: 'architect' },
  'GD-201': { subType: 'general', reasoning: 'Naturopathic physician license — general category.' },
  'GD-205': { subType: 'real_estate' },
  'GD-207': { subType: 'general', reasoning: 'Marriage and family therapist license — general category.' },

  // ============================================================
  // CERTIFICATE entries — mapped by certification type
  // ============================================================
  'GD-004': { subType: 'professional_certification', reasoning: 'PMP from PMI — professional certification.' },
  'GD-019': { subType: 'it_certification', reasoning: 'AWS Solutions Architect — IT certification.' },
  'GD-020': { subType: 'it_certification', reasoning: 'CISSP — IT security certification.' },
  'GD-035': { subType: 'it_certification', reasoning: 'CompTIA Security+ — IT certification.' },
  'GD-039': { subType: 'professional_certification', reasoning: 'Six Sigma Black Belt — professional certification.' },
  'GD-044': { subType: 'completion_certificate', reasoning: 'Coursera online course completion.' },
  'GD-050': { subType: 'professional_certification', reasoning: 'CFA-related — financial analysis.' },
  'GD-053': { subType: 'it_certification', reasoning: 'Cisco CCNP — IT certification.' },
  'GD-054': { subType: 'professional_certification', reasoning: 'Scrum Master — professional certification.' },
  'GD-063': { subType: 'professional_certification', reasoning: 'SHRM-CP — HR professional certification.' },
  'GD-065': { subType: 'it_certification', reasoning: 'Microsoft Azure — IT certification.' },
  'GD-069': { subType: 'professional_certification', reasoning: 'LEED AP — green building professional certification.' },
  'GD-074': { subType: 'completion_certificate', reasoning: 'GED is a high school equivalency certificate.' },
  'GD-077': { subType: 'it_certification', reasoning: 'Kubernetes (CKAD/CKA) — IT certification.' },
  'GD-079': { subType: 'training_certificate', concerns: ['Prompt injection attempt in text'] },
  'GD-081': { subType: 'professional_certification', reasoning: 'EMT certification — emergency medical professional cert.' },
  'GD-082': { subType: 'professional_certification', reasoning: 'Actuarial credential — professional certification.' },
  'GD-084': { subType: 'professional_certification', reasoning: 'Registered Dietitian — professional certification.' },
  'GD-088': { subType: 'it_certification', reasoning: 'CompTIA Project+ — IT certification.' },
  'GD-090': { subType: 'professional_certification', reasoning: 'Nutrition certification from credible org.' },
  'GD-095': { subType: 'trade_certification', reasoning: 'Welding inspection — trade certification.' },
  'GD-097': { subType: 'training_certificate', reasoning: 'Food handler certificate — training completion.' },
  'GD-099': { subType: 'it_certification', reasoning: 'Google Cloud Professional ML Engineer — IT cert.' },
  'GD-121': { subType: 'it_certification', reasoning: 'Salesforce Administrator — IT certification.' },
  'GD-122': { subType: 'it_certification', reasoning: 'ITIL Foundation — IT service management certification.' },
  'GD-123': { subType: 'training_certificate', reasoning: 'CPR/First Aid — training certification.' },
  'GD-124': { subType: 'training_certificate', reasoning: 'OSHA 30-hour card — safety training.' },
  'GD-125': { subType: 'it_certification', reasoning: 'Tableau Desktop Specialist — IT data viz certification.' },
  'GD-126': { subType: 'professional_certification', reasoning: 'PMI-ACP — agile professional certification.' },
  'GD-127': { subType: 'it_certification', reasoning: 'Certified Ethical Hacker — IT security certification.' },
  'GD-128': { subType: 'it_certification', reasoning: 'AWS Developer Associate — cloud IT certification.' },
  'GD-129': { subType: 'it_certification', reasoning: 'Oracle Database — IT certification.' },
  'GD-130': { subType: 'it_certification', reasoning: 'TOGAF — enterprise architecture IT certification.' },
  'GD-135': { subType: 'professional_certification', reasoning: 'Clinical research coordinator — professional cert.' },
  'GD-139': { subType: 'professional_certification', reasoning: 'Peer support specialist certification.' },
  'GD-146': { subType: 'completion_certificate', concerns: ['No dates present'] },
  'GD-149': { subType: 'completion_certificate', concerns: ['Special characters in issuer name'] },
  'GD-165': { subType: 'professional_certification', reasoning: 'Certified Fraud Examiner — professional certification.' },
  'GD-166': { subType: 'it_certification', reasoning: 'AWS Cloud Practitioner — IT certification.' },
  'GD-175': { subType: 'it_certification', reasoning: 'Terraform certification — IT infrastructure certification.' },
  'GD-176': { subType: 'it_certification', reasoning: 'Docker Certified Associate — IT certification.' },
  'GD-177': { subType: 'professional_certification', reasoning: 'Pharmacy technician — professional certification.' },
  'GD-178': { subType: 'professional_certification', reasoning: 'Supply chain certification — professional cert.' },
  'GD-185': { subType: 'completion_certificate', reasoning: 'Google UX Design certificate — course completion.' },
  'GD-188': { subType: 'professional_certification', reasoning: 'PHR — HR professional certification.' },

  // ============================================================
  // CLE entries — mapped by credit type
  // ============================================================
  'GD-003': { subType: 'ethics_cle', reasoning: 'Ethics CLE — credit type is Ethics.' },
  'GD-021': { subType: 'general_cle', reasoning: 'Florida multi-credit — general CLE.' },
  'GD-022': { subType: 'general_cle', reasoning: 'New York CLE — contract drafting.' },
  'GD-036': { subType: 'specialized_cle', reasoning: 'Substance abuse course — specialized CLE.' },
  'GD-045': { subType: 'elimination_of_bias', reasoning: 'Elimination of Bias credit.' },
  'GD-070': { subType: 'specialized_cle', reasoning: 'Technology credit — specialized CLE.' },
  'GD-131': { subType: 'ethics_cle', reasoning: 'Professional Responsibility — ethics CLE.' },
  'GD-132': { subType: 'general_cle', reasoning: 'Annual practice update — general CLE.' },
  'GD-150': { subType: 'general_cle', reasoning: 'Securities regulation — general CLE.' },
  'GD-170': { subType: 'specialized_cle', reasoning: 'Immigration law — specialized CLE.' },
  'GD-190': { subType: 'specialized_cle', reasoning: 'Bankruptcy law — specialized CLE.' },

  // ============================================================
  // TRANSCRIPT entries — mapped by level
  // ============================================================
  'GD-006': { subType: 'official_graduate', reasoning: 'Stanford MBA transcript — official graduate.' },
  'GD-023': { subType: 'official_undergraduate', reasoning: 'UCLA undergraduate transcript.' },
  'GD-058': { subType: 'official_undergraduate', reasoning: 'CS transcript — undergraduate.' },
  'GD-151': { subType: 'official_undergraduate', reasoning: 'Community college transcript — undergraduate.' },
  'GD-152': { subType: 'official_graduate', reasoning: 'Law school transcript — graduate/professional.' },
  'GD-153': { subType: 'official_undergraduate', reasoning: 'Engineering transcript with honors — undergraduate.' },
  'GD-167': { subType: 'official_graduate', reasoning: 'Medical school transcript — graduate/professional.' },
  'GD-168': { subType: 'official_undergraduate', reasoning: 'Nursing transcript — undergraduate.' },

  // ============================================================
  // PROFESSIONAL entries — mapped by type
  // ============================================================
  'GD-024': { subType: 'board_certification', reasoning: 'Board certification in surgery.' },
  'GD-025': { subType: 'membership', reasoning: 'Employment verification with sparse detail — professional reference.' },
  'GD-030': { subType: 'board_certification', reasoning: 'Multiple issuers — neurology board cert.' },
  'GD-075': { subType: 'residency', reasoning: 'Residency completion certificate.' },
  'GD-086': { subType: 'membership', reasoning: 'International accounting credential — professional membership.' },
  'GD-094': { subType: 'fellowship', reasoning: 'Fellowship certificate in medicine.' },
  'GD-133': { subType: 'board_certification', reasoning: 'Board certification in pediatrics.' },
  'GD-134': { subType: 'membership', reasoning: 'Teaching evaluation letter — professional reference.' },
  'GD-140': { subType: 'board_certification', reasoning: 'Board cert in anesthesiology.' },
  'GD-154': { subType: 'fellowship', reasoning: 'Research fellowship in neuroscience.' },
  'GD-155': { subType: 'membership', reasoning: 'Consulting firm reference letter — professional reference.' },
  'GD-169': { subType: 'board_certification', reasoning: 'Board cert in orthopedic surgery.' },
  'GD-179': { subType: 'residency', reasoning: 'Clinical psychology internship — residency-equivalent.' },
  'GD-189': { subType: 'board_certification', reasoning: 'Board cert in radiology.' },
};
