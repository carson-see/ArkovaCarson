/**
 * S3.3 Wave 3 top-15 held-out tranche 11-15.
 *
 * Every row is independently authored literal data. Nothing in this file is
 * generated, imported into training, or accepted by its mere presence.
 */

import type { S33HeldoutEntry } from './golden-dataset-s33-types.js';

const LEGAL_GENERAL_CLE: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LGC-001', description: 'General CLE on civil discovery management',
    strippedText: 'RIVER BEND LEGAL INSTITUTE records [ATTORNEY_REDACTED] as completing Civil Discovery Management on January 12, 2026. Activity LGC-26011 awards 3.0 general CLE hours by live webcast. The Missouri Continuing Legal Education Board approved the provider for Missouri credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'River Bend Legal Institute', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-01-12', fieldOfStudy: 'Civil Discovery Management', accreditingBody: 'Missouri Continuing Legal Education Board', jurisdiction: 'Missouri', creditHours: 3, creditType: 'General CLE', activityNumber: 'LGC-26011', courseId: 'LGC-26011', providerName: 'River Bend Legal Institute', approvedBy: 'Missouri Continuing Legal Education Board', deliveryMethod: 'Live Webcast', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/civil-discovery', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-002', description: 'General CLE on appellate briefing',
    strippedText: 'CASCADIA APPELLATE EDUCATION CENTER certifies [ATTORNEY_REDACTED] for four general CLE hours in Effective Appellate Briefing. Course LGC-26028 concluded February 9, 2026 through an in-person seminar. Washington State Bar MCLE Department authorizes the credit in Washington.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Cascadia Appellate Education Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-02-09', fieldOfStudy: 'Appellate Briefing', accreditingBody: 'Washington State Bar MCLE Department', jurisdiction: 'Washington', creditHours: 4, creditType: 'General CLE', activityNumber: 'LGC-26028', courseId: 'LGC-26028', providerName: 'Cascadia Appellate Education Center', approvedBy: 'Washington State Bar MCLE Department', deliveryMethod: 'In-Person Seminar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/appellate-briefing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-003', description: 'General CLE on commercial leasing',
    strippedText: 'GREAT LAKES BAR STUDY FORUM reports [ATTORNEY_REDACTED] completed Commercial Lease Drafting on March 16, 2026. Program LGC-26045 carries 2.0 general CLE hours delivered as an on-demand recording. Michigan Attorney Discipline and Education Office approved the activity in Michigan.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Great Lakes Bar Study Forum', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-03-16', fieldOfStudy: 'Commercial Lease Drafting', accreditingBody: 'Michigan Attorney Discipline and Education Office', jurisdiction: 'Michigan', creditHours: 2, creditType: 'General CLE', activityNumber: 'LGC-26045', courseId: 'LGC-26045', providerName: 'Great Lakes Bar Study Forum', approvedBy: 'Michigan Attorney Discipline and Education Office', deliveryMethod: 'On-Demand Recording', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/commercial-leasing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-004', description: 'General CLE on witness examination',
    strippedText: 'BLUE RIDGE TRIAL ACADEMY confirms [ATTORNEY_REDACTED] attended Practical Witness Examination on April 13, 2026. Activity LGC-26060 provides 5.0 general CLE hours in a classroom workshop. Virginia’s mandatory legal-education board approved the program for Virginia.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Blue Ridge Trial Academy', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-04-13', fieldOfStudy: 'Witness Examination', accreditingBody: 'Virginia Mandatory Continuing Legal Education Board', jurisdiction: 'Virginia', creditHours: 5, creditType: 'General CLE', activityNumber: 'LGC-26060', courseId: 'LGC-26060', providerName: 'Blue Ridge Trial Academy', approvedBy: 'Virginia Mandatory Continuing Legal Education Board', deliveryMethod: 'Classroom Workshop', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/witness-examination', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-005', description: 'General CLE on probate procedure',
    strippedText: 'PINE COAST LAW LEARNING COOPERATIVE verifies [ATTORNEY_REDACTED] completed Modern Probate Procedure on May 11, 2026. Course LGC-26076 awards 3.5 general CLE hours through a hybrid seminar. Maine Board of Overseers Education Unit authorized the offering in Maine.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Pine Coast Law Learning Cooperative', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-05-11', fieldOfStudy: 'Probate Procedure', accreditingBody: 'Maine Board of Overseers Education Unit', jurisdiction: 'Maine', creditHours: 3.5, creditType: 'General CLE', activityNumber: 'LGC-26076', courseId: 'LGC-26076', providerName: 'Pine Coast Law Learning Cooperative', approvedBy: 'Maine Board of Overseers Education Unit', deliveryMethod: 'Hybrid Seminar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/probate-procedure', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-006', description: 'General CLE on administrative hearings',
    strippedText: 'DESERT ADMINISTRATIVE LAW CENTER issues a completion record to [ATTORNEY_REDACTED] for Agency Hearing Practice. Program LGC-26091 ended June 15, 2026 and grants 2.5 general CLE hours via interactive webinar. Arizona Continuing Legal Education Committee approved Arizona credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Desert Administrative Law Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-06-15', fieldOfStudy: 'Administrative Hearing Practice', accreditingBody: 'Arizona Continuing Legal Education Committee', jurisdiction: 'Arizona', creditHours: 2.5, creditType: 'General CLE', activityNumber: 'LGC-26091', courseId: 'LGC-26091', providerName: 'Desert Administrative Law Center', approvedBy: 'Arizona Continuing Legal Education Committee', deliveryMethod: 'Interactive Webinar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/administrative-hearings', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-007', description: 'General CLE on legal research',
    strippedText: 'KEYSTONE LEGAL RESEARCH COLLECTIVE recognizes [ATTORNEY_REDACTED] for Advanced Statutory Research completed July 13, 2026. Session LGC-26106 qualifies for 3.0 general CLE hours as a live online class. Pennsylvania Continuing Legal Education Board approved it for Pennsylvania.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Keystone Legal Research Collective', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-07-13', fieldOfStudy: 'Statutory Research', accreditingBody: 'Pennsylvania Continuing Legal Education Board', jurisdiction: 'Pennsylvania', creditHours: 3, creditType: 'General CLE', activityNumber: 'LGC-26106', courseId: 'LGC-26106', providerName: 'Keystone Legal Research Collective', approvedBy: 'Pennsylvania Continuing Legal Education Board', deliveryMethod: 'Live Online Class', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/statutory-research', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-008', description: 'General CLE on contract remedies',
    strippedText: 'PALMETTO COMMERCIAL LAW SEMINARS documents [ATTORNEY_REDACTED]’s completion of Contract Remedies in Practice on August 17, 2026. Course LGC-26122 awards 4.0 general CLE hours in group live format. South Carolina Commission on CLE approved the course in South Carolina.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Palmetto Commercial Law Seminars', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-08-17', fieldOfStudy: 'Contract Remedies', accreditingBody: 'South Carolina Commission on CLE', jurisdiction: 'South Carolina', creditHours: 4, creditType: 'General CLE', activityNumber: 'LGC-26122', courseId: 'LGC-26122', providerName: 'Palmetto Commercial Law Seminars', approvedBy: 'South Carolina Commission on CLE', deliveryMethod: 'Group Live', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/contract-remedies', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-009', description: 'OCR-degraded general CLE certificate',
    strippedText: 'N0RTHERN PlNES LEGAL EDUCATl0N confirms [ATTORNEY_REDACTED] completed Municipal Litigation on September 14, 2026. LGC-26137 awards 3.0 general CLE hours by webcast. OCR alters the heading only. Minnesota CLE Board approved Minnesota credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Northern Pines Legal Education', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-09-14', fieldOfStudy: 'Municipal Litigation', accreditingBody: 'Minnesota CLE Board', jurisdiction: 'Minnesota', creditHours: 3, creditType: 'General CLE', activityNumber: 'LGC-26137', courseId: 'LGC-26137', providerName: 'Northern Pines Legal Education', approvedBy: 'Minnesota CLE Board', deliveryMethod: 'Webcast', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-010', description: 'General CLE with fractional credit',
    strippedText: 'GULF ADVOCACY LEARNING NETWORK credits [ATTORNEY_REDACTED] with 1.25 general CLE hours for Electronic Filing Fundamentals. Activity LGC-26152 completed October 12, 2026 by self-study audio. Florida Bar Continuing Legal Education Office approved the fractional Florida award.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Gulf Advocacy Learning Network', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-10-12', fieldOfStudy: 'Electronic Filing Fundamentals', accreditingBody: 'Florida Bar Continuing Legal Education Office', jurisdiction: 'Florida', creditHours: 1.25, creditType: 'General CLE', activityNumber: 'LGC-26152', courseId: 'LGC-26152', providerName: 'Gulf Advocacy Learning Network', approvedBy: 'Florida Bar Continuing Legal Education Office', deliveryMethod: 'Self-Study Audio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/fractional', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'edge', 'fractional'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-011', description: 'General CLE with registration-date trap',
    strippedText: 'BLUEGRASS LAW PRACTICE ACADEMY awards [ATTORNEY_REDACTED] 2.0 general CLE hours for Motion Practice on November 16, 2026. October 20 is registration, not completion. LGC-26168; Kentucky Continuing Legal Education Commission; live seminar; Kentucky jurisdiction.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'Bluegrass Law Practice Academy', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-11-16', fieldOfStudy: 'Motion Practice', accreditingBody: 'Kentucky Continuing Legal Education Commission', jurisdiction: 'Kentucky', creditHours: 2, creditType: 'General CLE', activityNumber: 'LGC-26168', courseId: 'LGC-26168', providerName: 'Bluegrass Law Practice Academy', approvedBy: 'Kentucky Continuing Legal Education Commission', deliveryMethod: 'Live Seminar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LGC-012', description: 'General CLE mislabeled ethics seminar',
    strippedText: 'ETHICS SEMINAR appears on the portal tile, but the completed subject is Federal Civil Procedure with no ethics component. HIGH DESERT LAW CENTER awards [ATTORNEY_REDACTED] 3.0 general CLE hours on December 14, 2026. LGC-26183; Nevada CLE Board; Nevada.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'general_cle', issuerName: 'High Desert Law Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-12-14', fieldOfStudy: 'Federal Civil Procedure', accreditingBody: 'Nevada CLE Board', jurisdiction: 'Nevada', creditHours: 3, ethicsHours: 0, creditType: 'General CLE', activityNumber: 'LGC-26183', courseId: 'LGC-26183', providerName: 'High Desert Law Center', approvedBy: 'Nevada CLE Board', deliveryMethod: 'Interactive Webinar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-11-general-cle/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'general-cle', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_ETHICS_CLE: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LEC-001', description: 'Ethics CLE on fiduciary conflicts',
    strippedText: 'HARBOR ETHICS FACULTY records [ATTORNEY_REDACTED] as finishing Fiduciary Conflicts and Client Loyalty on January 21, 2026. Ethics activity LEC-26014 grants 2.0 hours by moderated webcast. Delaware Commission on Continuing Legal Education recognizes the provider and the Delaware credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Harbor Ethics Faculty', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-01-21', fieldOfStudy: 'Fiduciary Conflicts and Client Loyalty', accreditingBody: 'Delaware Commission on Continuing Legal Education', jurisdiction: 'Delaware', creditHours: 2, ethicsHours: 2, creditType: 'Ethics CLE', activityNumber: 'LEC-26014', courseId: 'LEC-26014', providerName: 'Harbor Ethics Faculty', approvedBy: 'Delaware Commission on Continuing Legal Education', deliveryMethod: 'Moderated Webcast', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/fiduciary-conflicts', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-002', description: 'Ethics CLE on safeguarding client funds',
    strippedText: 'PRAIRIE PROFESSIONAL RESPONSIBILITY SCHOOL awards [ATTORNEY_REDACTED] three ethics hours for Safeguarding Client Trust Funds. The classroom program ended February 18, 2026 under LEC-26031. Illinois Minimum Continuing Legal Education Board approved the activity for Illinois lawyers.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Prairie Professional Responsibility School', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-02-18', fieldOfStudy: 'Safeguarding Client Trust Funds', accreditingBody: 'Illinois Minimum Continuing Legal Education Board', jurisdiction: 'Illinois', creditHours: 3, ethicsHours: 3, creditType: 'Professional Responsibility Ethics', activityNumber: 'LEC-26031', courseId: 'LEC-26031', providerName: 'Prairie Professional Responsibility School', approvedBy: 'Illinois Minimum Continuing Legal Education Board', deliveryMethod: 'Classroom Program', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/client-funds', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-003', description: 'Ethics CLE on confidentiality duties',
    strippedText: 'MOUNTAIN COUNSEL CONDUCT FORUM confirms the March 20, 2026 completion of Confidentiality After Representation for [ATTORNEY_REDACTED]. Interactive course LEC-26047 carries 1.5 ethics CLE hours. Colorado’s judicial-education committee authorizes the state credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Mountain Counsel Conduct Forum', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-03-20', fieldOfStudy: 'Confidentiality After Representation', accreditingBody: 'Colorado Supreme Court Continuing Legal and Judicial Education Committee', jurisdiction: 'Colorado', creditHours: 1.5, ethicsHours: 1.5, creditType: 'Ethics CLE', activityNumber: 'LEC-26047', courseId: 'LEC-26047', providerName: 'Mountain Counsel Conduct Forum', approvedBy: 'Colorado Supreme Court Continuing Legal and Judicial Education Committee', deliveryMethod: 'Interactive Online Course', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/confidentiality', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-004', description: 'Ethics CLE on candor to tribunals',
    strippedText: 'CAPITOL ADVOCATE INTEGRITY CENTER lists [ATTORNEY_REDACTED] on its April 24, 2026 completion roll for Candor in Motion Practice. LEC-26063 is a live seminar worth 2.5 ethics hours. District of Columbia Bar Continuing Legal Education Office approved the District of Columbia offering.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Capitol Advocate Integrity Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-04-24', fieldOfStudy: 'Candor in Motion Practice', accreditingBody: 'District of Columbia Bar Continuing Legal Education Office', jurisdiction: 'District of Columbia', creditHours: 2.5, ethicsHours: 2.5, creditType: 'Legal Ethics', activityNumber: 'LEC-26063', courseId: 'LEC-26063', providerName: 'Capitol Advocate Integrity Center', approvedBy: 'District of Columbia Bar Continuing Legal Education Office', deliveryMethod: 'Live Seminar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/tribunal-candor', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-005', description: 'Ethics CLE on supervisory responsibility',
    strippedText: 'SOUTHERN COUNSEL ACCOUNTABILITY PROJECT credits [ATTORNEY_REDACTED] for Supervising Lawyers and Delegated Work, completed May 22, 2026. Recorded module LEC-26079 supplies 2.0 ethics hours. Georgia’s lawyer-competency commission accepts the program statewide.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Southern Counsel Accountability Project', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-05-22', fieldOfStudy: 'Supervisory Responsibility', accreditingBody: 'Georgia Commission on Continuing Lawyer Competency', jurisdiction: 'Georgia', creditHours: 2, ethicsHours: 2, creditType: 'Professionalism Ethics CLE', activityNumber: 'LEC-26079', courseId: 'LEC-26079', providerName: 'Southern Counsel Accountability Project', approvedBy: 'Georgia Commission on Continuing Lawyer Competency', deliveryMethod: 'Recorded Module', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/supervisory-responsibility', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-006', description: 'Ethics CLE on client communication',
    strippedText: 'PACIFIC DUTIES INSTITUTE certifies [ATTORNEY_REDACTED] for 1.0 ethics hour after Client Communication and Informed Consent on June 19, 2026. The hybrid workshop identifier is LEC-26094. Oregon State Bar Minimum Continuing Legal Education Department approved Oregon participation.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Pacific Duties Institute', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-06-19', fieldOfStudy: 'Client Communication and Informed Consent', accreditingBody: 'Oregon State Bar Minimum Continuing Legal Education Department', jurisdiction: 'Oregon', creditHours: 1, ethicsHours: 1, creditType: 'Ethics CLE', activityNumber: 'LEC-26094', courseId: 'LEC-26094', providerName: 'Pacific Duties Institute', approvedBy: 'Oregon State Bar Minimum Continuing Legal Education Department', deliveryMethod: 'Hybrid Workshop', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/client-communication', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-007', description: 'Ethics CLE on withdrawal obligations',
    strippedText: 'GREAT PLAINS LAWYER DUTIES ACADEMY enters [ATTORNEY_REDACTED] as completing Withdrawal Without Client Prejudice on July 17, 2026. Telephone seminar LEC-26110 conveys 1.25 ethics hours. Nebraska Mandatory Continuing Legal Education Commission recognizes the Nebraska course.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Great Plains Lawyer Duties Academy', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-07-17', fieldOfStudy: 'Withdrawal Without Client Prejudice', accreditingBody: 'Nebraska Mandatory Continuing Legal Education Commission', jurisdiction: 'Nebraska', creditHours: 1.25, ethicsHours: 1.25, creditType: 'Ethics and Professional Responsibility', activityNumber: 'LEC-26110', courseId: 'LEC-26110', providerName: 'Great Plains Lawyer Duties Academy', approvedBy: 'Nebraska Mandatory Continuing Legal Education Commission', deliveryMethod: 'Telephone Seminar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/withdrawal-duties', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-008', description: 'Ethics CLE on witness contact limits',
    strippedText: 'LAKESIDE PROFESSIONAL CONDUCT WORKSHOPS documents [ATTORNEY_REDACTED] in Contact with Represented Witnesses, concluded August 21, 2026. In-person activity LEC-26126 awards 3.0 ethics hours. Wisconsin Board of Bar Examiners CLE Division recognizes the Wisconsin credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Lakeside Professional Conduct Workshops', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-08-21', fieldOfStudy: 'Contact with Represented Witnesses', accreditingBody: 'Wisconsin Board of Bar Examiners CLE Division', jurisdiction: 'Wisconsin', creditHours: 3, ethicsHours: 3, creditType: 'Legal Ethics', activityNumber: 'LEC-26126', courseId: 'LEC-26126', providerName: 'Lakeside Professional Conduct Workshops', approvedBy: 'Wisconsin Board of Bar Examiners CLE Division', deliveryMethod: 'In-Person Workshop', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/witness-contact', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-009', description: 'OCR-degraded ethics CLE record',
    strippedText: 'ATLANTlC PR0FESSl0NAL RESP0NSlBlLlTY C0UNCIL confirms [ATTORNEY_REDACTED] completed Ethics of Settlement Authority on September 18, 2026. OCR affects the masthead only. LEC-26141 provides 2.0 ethics hours by webcast; the New Jersey CLE board approved statewide credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Atlantic Professional Responsibility Council', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-09-18', fieldOfStudy: 'Ethics of Settlement Authority', accreditingBody: 'New Jersey Board on Continuing Legal Education', jurisdiction: 'New Jersey', creditHours: 2, ethicsHours: 2, creditType: 'Ethics CLE', activityNumber: 'LEC-26141', courseId: 'LEC-26141', providerName: 'Atlantic Professional Responsibility Council', approvedBy: 'New Jersey Board on Continuing Legal Education', deliveryMethod: 'Webcast', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-010', description: 'Mixed-credit seminar with ethics split',
    strippedText: 'FOOTHILL LAW PRACTICE COLLOQUIUM reports a 4.0-hour program for [ATTORNEY_REDACTED] on October 23, 2026. Only 1.0 hour is ethics; the remaining 3.0 hours are general credit. Ethics segment LEC-26157 covers Client File Destruction. California State Bar MCLE Program approved the California allocation.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Foothill Law Practice Colloquium', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-10-23', fieldOfStudy: 'Client File Destruction', accreditingBody: 'California State Bar MCLE Program', jurisdiction: 'California', creditHours: 1, ethicsHours: 1, creditType: 'Ethics Segment of Mixed CLE', activityNumber: 'LEC-26157', courseId: 'LEC-26157', providerName: 'Foothill Law Practice Colloquium', approvedBy: 'California State Bar MCLE Program', deliveryMethod: 'Live Conference', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/ethics-split', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'edge', 'ethics-split'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-011', description: 'Ethics CLE with attendance-date trap',
    strippedText: 'COMMONWEALTH COUNSEL ETHICS CENTER grants [ATTORNEY_REDACTED] 2.0 ethics hours for Duties to Prospective Clients on November 20, 2026. November 6 was enrollment, not completion. Activity LEC-26173 used a live online classroom; the Massachusetts bar-overseers education unit approved state credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Commonwealth Counsel Ethics Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-11-20', fieldOfStudy: 'Duties to Prospective Clients', accreditingBody: 'Massachusetts Board of Bar Overseers CLE Unit', jurisdiction: 'Massachusetts', creditHours: 2, ethicsHours: 2, creditType: 'Professional Responsibility CLE', activityNumber: 'LEC-26173', courseId: 'LEC-26173', providerName: 'Commonwealth Counsel Ethics Center', approvedBy: 'Massachusetts Board of Bar Overseers CLE Unit', deliveryMethod: 'Live Online Classroom', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LEC-012', description: 'Ethics CLE despite general-credit portal label',
    strippedText: 'GENERAL CREDIT labels the archive tile, while the underlying record expressly awards ethics credit. NORTHERN COUNSEL STANDARDS LAB gives [ATTORNEY_REDACTED] 1.5 ethics hours for Truthful Negotiation Statements on December 18, 2026. LEC-26189; Vermont Mandatory Continuing Legal Education Board; Vermont; interactive webinar.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'ethics_cle', issuerName: 'Northern Counsel Standards Lab', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-12-18', fieldOfStudy: 'Truthful Negotiation Statements', accreditingBody: 'Vermont Mandatory Continuing Legal Education Board', jurisdiction: 'Vermont', creditHours: 1.5, ethicsHours: 1.5, creditType: 'Ethics CLE', activityNumber: 'LEC-26189', courseId: 'LEC-26189', providerName: 'Northern Counsel Standards Lab', approvedBy: 'Vermont Mandatory Continuing Legal Education Board', deliveryMethod: 'Interactive Webinar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-12-ethics-cle/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'ethics-cle', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_SPECIALIZED_CLE: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LSC-001', description: 'Specialized CLE in immigration appeals',
    strippedText: 'BORDERLAND IMMIGRATION PRACTICE INSTITUTE places [ATTORNEY_REDACTED] on the January 27, 2026 completion roster for Administrative Immigration Appeals. Specialist program LSC-26016 delivers 4.0 CLE hours through a live virtual workshop. New Mexico Minimum Continuing Legal Education Board approved the New Mexico specialty credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Borderland Immigration Practice Institute', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-01-27', fieldOfStudy: 'Administrative Immigration Appeals', accreditingBody: 'New Mexico Minimum Continuing Legal Education Board', jurisdiction: 'New Mexico', creditHours: 4, creditType: 'Immigration Law Specialty CLE', activityNumber: 'LSC-26016', courseId: 'LSC-26016', providerName: 'Borderland Immigration Practice Institute', approvedBy: 'New Mexico Minimum Continuing Legal Education Board', deliveryMethod: 'Live Virtual Workshop', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/immigration-appeals', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-002', description: 'Specialized CLE in bankruptcy practice',
    strippedText: 'MIDWEST INSOLVENCY EDUCATION CONSORTIUM recognizes [ATTORNEY_REDACTED] for Chapter 11 Plan Confirmation, finished February 25, 2026. Advanced activity LSC-26033 awards 5.0 specialist hours in a classroom institute. Indiana Commission for Continuing Legal Education accepts the Indiana course.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Midwest Insolvency Education Consortium', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-02-25', fieldOfStudy: 'Chapter 11 Plan Confirmation', accreditingBody: 'Indiana Commission for Continuing Legal Education', jurisdiction: 'Indiana', creditHours: 5, creditType: 'Bankruptcy Law Specialty CLE', activityNumber: 'LSC-26033', courseId: 'LSC-26033', providerName: 'Midwest Insolvency Education Consortium', approvedBy: 'Indiana Commission for Continuing Legal Education', deliveryMethod: 'Classroom Institute', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/bankruptcy-confirmation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-003', description: 'Specialized CLE in elder law',
    strippedText: 'SENIOR ADVOCACY LAW CENTER certifies that [ATTORNEY_REDACTED] completed Medicaid Asset Protection Planning on March 24, 2026. LSC-26049 supplies 3.5 elder-law specialty hours via synchronous webcast. Tennessee’s legal-education commission approved the state credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Senior Advocacy Law Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-03-24', fieldOfStudy: 'Medicaid Asset Protection Planning', accreditingBody: 'Tennessee Commission on Continuing Legal Education', jurisdiction: 'Tennessee', creditHours: 3.5, creditType: 'Elder Law Specialty CLE', activityNumber: 'LSC-26049', courseId: 'LSC-26049', providerName: 'Senior Advocacy Law Center', approvedBy: 'Tennessee Commission on Continuing Legal Education', deliveryMethod: 'Synchronous Webcast', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/elder-law', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-004', description: 'Specialized CLE in cybersecurity law',
    strippedText: 'DIGITAL RISK LAW ACADEMY logs [ATTORNEY_REDACTED] for Incident Response and Breach Notice completed April 28, 2026. Technical-law course LSC-26065 confers 6.0 specialist CLE hours in hybrid format. Maryland State Bar Continuing Legal Education Program approved the Maryland offering.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Digital Risk Law Academy', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-04-28', fieldOfStudy: 'Incident Response and Breach Notice', accreditingBody: 'Maryland State Bar Continuing Legal Education Program', jurisdiction: 'Maryland', creditHours: 6, creditType: 'Cybersecurity Law Specialty CLE', activityNumber: 'LSC-26065', courseId: 'LSC-26065', providerName: 'Digital Risk Law Academy', approvedBy: 'Maryland State Bar Continuing Legal Education Program', deliveryMethod: 'Hybrid Program', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/cybersecurity-law', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-005', description: 'Specialized CLE in child welfare litigation',
    strippedText: 'CHILD ADVOCACY LITIGATION COLLEGE issues [ATTORNEY_REDACTED] a May 26, 2026 record for Dependency Adjudication Evidence. Intensive LSC-26081 is worth 4.5 child-welfare specialty hours and was taught in person. Ohio’s legal-education commission approved the state credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Child Advocacy Litigation College', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-05-26', fieldOfStudy: 'Dependency Adjudication Evidence', accreditingBody: 'Ohio Commission on Continuing Legal Education', jurisdiction: 'Ohio', creditHours: 4.5, creditType: 'Child Welfare Law Specialty CLE', activityNumber: 'LSC-26081', courseId: 'LSC-26081', providerName: 'Child Advocacy Litigation College', approvedBy: 'Ohio Commission on Continuing Legal Education', deliveryMethod: 'In-Person Intensive', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/child-welfare', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-006', description: 'Specialized CLE in tax controversy',
    strippedText: 'FEDERAL TAX DISPUTE FORUM confirms [ATTORNEY_REDACTED] attended Administrative Penalty Appeals on June 23, 2026. On-demand advanced module LSC-26096 provides 3.0 tax-specialty CLE hours. New York State Continuing Legal Education Board accredits the program for New York.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Federal Tax Dispute Forum', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-06-23', fieldOfStudy: 'Administrative Penalty Appeals', accreditingBody: 'New York State Continuing Legal Education Board', jurisdiction: 'New York', creditHours: 3, creditType: 'Tax Controversy Specialty CLE', activityNumber: 'LSC-26096', courseId: 'LSC-26096', providerName: 'Federal Tax Dispute Forum', approvedBy: 'New York State Continuing Legal Education Board', deliveryMethod: 'On-Demand Advanced Module', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/tax-controversy', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-007', description: 'Specialized CLE in environmental permitting',
    strippedText: 'WATERSHED REGULATORY LAW SCHOOL enters [ATTORNEY_REDACTED] for Wetlands Permit Appeals on July 28, 2026. Specialist seminar LSC-26112 carries 2.5 environmental-law hours through group live instruction. North Carolina State Bar CLE Department authorizes North Carolina credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Watershed Regulatory Law School', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-07-28', fieldOfStudy: 'Wetlands Permit Appeals', accreditingBody: 'North Carolina State Bar CLE Department', jurisdiction: 'North Carolina', creditHours: 2.5, creditType: 'Environmental Law Specialty CLE', activityNumber: 'LSC-26112', courseId: 'LSC-26112', providerName: 'Watershed Regulatory Law School', approvedBy: 'North Carolina State Bar CLE Department', deliveryMethod: 'Group Live Instruction', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/environmental-permitting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-008', description: 'Specialized CLE in health reimbursement',
    strippedText: 'HEALTH PAYMENT LAW COLLABORATIVE validates [ATTORNEY_REDACTED] for Medicare Reimbursement Appeals, completed August 25, 2026. Advanced webinar LSC-26128 earns 3.25 health-law specialty hours. Texas State Bar Minimum Continuing Legal Education Department approved the Texas course.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Health Payment Law Collaborative', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-08-25', fieldOfStudy: 'Medicare Reimbursement Appeals', accreditingBody: 'Texas State Bar Minimum Continuing Legal Education Department', jurisdiction: 'Texas', creditHours: 3.25, creditType: 'Health Law Specialty CLE', activityNumber: 'LSC-26128', courseId: 'LSC-26128', providerName: 'Health Payment Law Collaborative', approvedBy: 'Texas State Bar Minimum Continuing Legal Education Department', deliveryMethod: 'Advanced Webinar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/health-reimbursement', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-009', description: 'OCR-degraded specialized CLE certificate',
    strippedText: 'C0ASTAL MARlTlME LAW FACULTY certifies [ATTORNEY_REDACTED] for Vessel Arrest Procedure on September 22, 2026. OCR substitutions touch the provider heading only. LSC-26143 grants 4.0 maritime-law specialty hours; Louisiana State Bar Association MCLE Committee approved Louisiana credit.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Coastal Maritime Law Faculty', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-09-22', fieldOfStudy: 'Vessel Arrest Procedure', accreditingBody: 'Louisiana State Bar Association MCLE Committee', jurisdiction: 'Louisiana', creditHours: 4, creditType: 'Maritime Law Specialty CLE', activityNumber: 'LSC-26143', courseId: 'LSC-26143', providerName: 'Coastal Maritime Law Faculty', approvedBy: 'Louisiana State Bar Association MCLE Committee', deliveryMethod: 'Live Webcast', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-010', description: 'Specialized CLE with quarter-hour award',
    strippedText: 'PUBLIC BENEFITS LAW NETWORK allocates 1.75 specialty CLE hours to [ATTORNEY_REDACTED] for Disability Benefits Appeals on October 27, 2026. LSC-26159 was a facilitated online clinic. Iowa Commission on Continuing Legal Education approved the fractional Iowa award.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Public Benefits Law Network', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-10-27', fieldOfStudy: 'Disability Benefits Appeals', accreditingBody: 'Iowa Commission on Continuing Legal Education', jurisdiction: 'Iowa', creditHours: 1.75, creditType: 'Public Benefits Specialty CLE', activityNumber: 'LSC-26159', courseId: 'LSC-26159', providerName: 'Public Benefits Law Network', approvedBy: 'Iowa Commission on Continuing Legal Education', deliveryMethod: 'Facilitated Online Clinic', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/fractional', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'edge', 'fractional'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-011', description: 'Specialized CLE with publication-date trap',
    strippedText: 'APPALACHIAN ENERGY LAW PROGRAM awards [ATTORNEY_REDACTED] 5.0 specialty hours for Mineral Lease Litigation on November 24, 2026. October 30 is the syllabus publication date, not completion. LSC-26175; West Virginia State Bar MCLE Commission; West Virginia; classroom seminar.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Appalachian Energy Law Program', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-11-24', fieldOfStudy: 'Mineral Lease Litigation', accreditingBody: 'West Virginia State Bar MCLE Commission', jurisdiction: 'West Virginia', creditHours: 5, creditType: 'Energy Law Specialty CLE', activityNumber: 'LSC-26175', courseId: 'LSC-26175', providerName: 'Appalachian Energy Law Program', approvedBy: 'West Virginia State Bar MCLE Commission', deliveryMethod: 'Classroom Seminar', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LSC-012', description: 'Specialized CLE under a general-course portal tile',
    strippedText: 'GENERAL LAW UPDATE is the portal tile, but the attached record identifies a specialist course in Tribal Court Jurisdiction. INTERMOUNTAIN INDIGENOUS LAW CENTER gives [ATTORNEY_REDACTED] 3.0 hours on December 22, 2026. LSC-26191; Montana Commission of Continuing Legal Education; Montana; hybrid institute.',
    credentialTypeHint: 'CLE', groundTruth: { credentialType: 'CLE', subType: 'specialized_cle', issuerName: 'Intermountain Indigenous Law Center', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-12-22', fieldOfStudy: 'Tribal Court Jurisdiction', accreditingBody: 'Montana Commission of Continuing Legal Education', jurisdiction: 'Montana', creditHours: 3, creditType: 'Indigenous Law Specialty CLE', activityNumber: 'LSC-26191', courseId: 'LSC-26191', providerName: 'Intermountain Indigenous Law Center', approvedBy: 'Montana Commission of Continuing Legal Education', deliveryMethod: 'Hybrid Institute', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-13-specialized-cle/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'specialized-cle', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_UTILITY_PATENTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LUP-001', description: 'Utility patent for adaptive irrigation valve',
    strippedText: 'The federal patent authority granted utility patent US 12,630,101 to [INVENTOR_REDACTED] on January 6, 2026 for an Adaptive Irrigation Valve Controller. The record assigns technology class Fluid Distribution and lists United States jurisdiction. Stated term expiry is August 14, 2043.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-01-06', expiryDate: '2043-08-14', fieldOfStudy: 'Adaptive Irrigation Valve Controller', licenseNumber: 'US 12,630,101', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/irrigation-valve', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-002', description: 'Utility patent for thermal battery housing',
    strippedText: 'Utility grant US 12,647,218 names [INVENTOR_REDACTED] for a Phase-Change Battery Housing. Issuance occurred February 10, 2026 through the national patent office, with projected expiration September 2, 2043. Classification is Electrochemical Thermal Management; governing jurisdiction is United States.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-02-10', expiryDate: '2043-09-02', fieldOfStudy: 'Phase-Change Battery Housing', licenseNumber: 'US 12,647,218', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/battery-housing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-003', description: 'Utility patent for acoustic leak sensing',
    strippedText: 'On March 3, 2026, the American patent registrar issued US 12,664,335 to [INVENTOR_REDACTED]. The protected utility invention is Distributed Acoustic Pipeline Leak Sensing in the Industrial Monitoring field. Its register shows United States jurisdiction and an October 19, 2043 expected term end.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-03-03', expiryDate: '2043-10-19', fieldOfStudy: 'Distributed Acoustic Pipeline Leak Sensing', licenseNumber: 'US 12,664,335', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/acoustic-leak-sensing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-004', description: 'Utility patent for recyclable barrier film',
    strippedText: 'National utility patent US 12,681,452 protects a Recyclable Moisture Barrier Film credited to [INVENTOR_REDACTED]. The grant date is April 7, 2026, not the earlier publication date. Materials Packaging is the technical field; United States is the jurisdiction; November 6, 2043 is the recorded expiry.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-04-07', expiryDate: '2043-11-06', fieldOfStudy: 'Recyclable Moisture Barrier Film', licenseNumber: 'US 12,681,452', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/barrier-film', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-005', description: 'Utility patent for low-power soil telemetry',
    strippedText: 'Patent US 12,698,569 was conferred May 5, 2026 upon [INVENTOR_REDACTED] for Low-Power Soil Telemetry Nodes. The issuing federal bureau categorizes it under Agricultural Sensor Networks. Registry fields identify United States jurisdiction and a December 11, 2043 projected expiration.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-05-05', expiryDate: '2043-12-11', fieldOfStudy: 'Low-Power Soil Telemetry Nodes', licenseNumber: 'US 12,698,569', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/soil-telemetry', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-006', description: 'Utility patent for robotic orchard pruning',
    strippedText: 'The United States invention register lists utility number US 12,715,686 for Vision-Guided Orchard Pruning. [INVENTOR_REDACTED] received the right on June 2, 2026. Agricultural Robotics is the field, January 15, 2044 is the projected term end, and United States law controls.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-06-02', expiryDate: '2044-01-15', fieldOfStudy: 'Vision-Guided Orchard Pruning', licenseNumber: 'US 12,715,686', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/orchard-pruning', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-007', description: 'Utility patent for cold-chain package tracking',
    strippedText: 'A July 7, 2026 utility grant covers Tamper-Evident Cold-Chain Package Tracking under US 12,732,803. [INVENTOR_REDACTED] is the named inventor. The national register records Logistics Telemetry, United States jurisdiction, and February 20, 2044 as the calculated expiration.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-07-07', expiryDate: '2044-02-20', fieldOfStudy: 'Tamper-Evident Cold-Chain Package Tracking', licenseNumber: 'US 12,732,803', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/cold-chain-tracking', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-008', description: 'Utility patent for modular flood barrier',
    strippedText: 'Federal utility right US 12,749,920 belongs to [INVENTOR_REDACTED] for Interlocking Modular Flood Barriers. It entered the grant register August 4, 2026. Civil Resilience Systems is the technology classification, United States is the legal territory, and March 29, 2044 is the term endpoint.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-08-04', expiryDate: '2044-03-29', fieldOfStudy: 'Interlocking Modular Flood Barriers', licenseNumber: 'US 12,749,920', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/flood-barrier', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-009', description: 'OCR-degraded utility patent face page',
    strippedText: 'UTlLlTY PATENT US 12,767,037 was granted September 1, 2026 for Variable-Porosity Air Filtration to [INVENTOR_REDACTED]. OCR distorts the document caption but leaves the right intact. Federal registry data gives United States jurisdiction, Filtration Engineering, and April 18, 2044 expiration.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-09-01', expiryDate: '2044-04-18', fieldOfStudy: 'Variable-Porosity Air Filtration', licenseNumber: 'US 12,767,037', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-010', description: 'Utility patent with application-number decoy',
    strippedText: 'Application 19/845,220 appears above the operative identifier but is not the patent number. The issued utility right is US 12,784,154 for [INVENTOR_REDACTED] and Secure Metered Fluid Coupling, granted October 6, 2026. United States; Industrial Fluid Security; May 23, 2044 term end.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-10-06', expiryDate: '2044-05-23', fieldOfStudy: 'Secure Metered Fluid Coupling', licenseNumber: 'US 12,784,154', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-011', description: 'Utility patent with filing-date trap',
    strippedText: 'Utility invention US 12,801,271 concerns Reconfigurable Warehouse Lift Controls and names [INVENTOR_REDACTED]. The filing date was June 12, 2023; issuance did not occur until November 3, 2026. The patent register states United States jurisdiction, Warehouse Automation, and June 30, 2044 expiry.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-11-03', expiryDate: '2044-06-30', fieldOfStudy: 'Reconfigurable Warehouse Lift Controls', licenseNumber: 'US 12,801,271', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LUP-012', description: 'Utility patent mislabeled as design right',
    strippedText: 'DESIGN PATENT is an indexing label copied onto the scan, yet the claims and grant line identify a utility patent. US 12,818,388 protects Distributed Reservoir Quality Sampling for [INVENTOR_REDACTED] from December 1, 2026. United States jurisdiction; Water Quality Instrumentation; July 27, 2044 expiration.',
    credentialTypeHint: 'PATENT', groundTruth: { credentialType: 'PATENT', subType: 'utility', issuerName: 'United States Patent and Trademark Office', recipientIdentifier: '[INVENTOR_REDACTED]', issuedDate: '2026-12-01', expiryDate: '2044-07-27', fieldOfStudy: 'Distributed Reservoir Quality Sampling', licenseNumber: 'US 12,818,388', jurisdiction: 'United States', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-14-utility-patent/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'utility-patent', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_REGULATORY_INSTRUMENTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LRI-001', description: 'Federal water monitoring regulation',
    strippedText: 'The National Watershed Administration promulgated final rule 40 CFR 151.24 on January 8, 2026. It establishes continuous discharge-sensor calibration for regulated facilities and applies to [PUBLIC_APPLICABILITY]. Federal jurisdiction is United States; the instrument carries no sunset date.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'federal', issuerName: 'National Watershed Administration', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-01-08', fieldOfStudy: 'Discharge Sensor Calibration', licenseNumber: '40 CFR 151.24', jurisdiction: 'United States Federal', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/water-monitoring', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'federal', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-002', description: 'State grid interconnection regulation',
    strippedText: 'Colorado Energy Reliability Commission adopted regulation 4 CCR 733-8 on February 12, 2026 for [PUBLIC_APPLICABILITY]. The state instrument governs distributed-storage interconnection queues across Colorado. Its register describes Grid Interconnection Procedure and records December 31, 2031 as the review sunset.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'state', issuerName: 'Colorado Energy Reliability Commission', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-02-12', expiryDate: '2031-12-31', fieldOfStudy: 'Distributed Storage Interconnection', licenseNumber: '4 CCR 733-8', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/grid-interconnection', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'state', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-003', description: 'Federal medical-device traceability rule',
    strippedText: 'Final regulation 21 CFR 894.77 was issued March 9, 2026 by the Federal Medical Products Bureau. The rule directs [PUBLIC_APPLICABILITY] to preserve device-component traceability records. It covers Medical Device Supply Integrity throughout United States federal jurisdiction without a stated expiration.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'federal', issuerName: 'Federal Medical Products Bureau', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-03-09', fieldOfStudy: 'Medical Device Supply Integrity', licenseNumber: '21 CFR 894.77', jurisdiction: 'United States Federal', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/device-traceability', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'federal', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-004', description: 'State wildfire construction standard',
    strippedText: 'Oregon Resilient Construction Board enacted OAR chapter 918, division 490, rule 65 on April 14, 2026. The statewide measure requires ember-resistant ventilation for [PUBLIC_APPLICABILITY] in designated hazard zones. Subject is Wildfire-Resilient Construction; jurisdiction is Oregon; scheduled reassessment is April 30, 2032.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'state', issuerName: 'Oregon Resilient Construction Board', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-04-14', expiryDate: '2032-04-30', fieldOfStudy: 'Wildfire-Resilient Construction', licenseNumber: 'OAR 918-490-0065', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/wildfire-construction', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'state', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-005', description: 'Federal rail battery safety regulation',
    strippedText: 'On May 11, 2026 the Interstate Rail Safety Office published final requirement 49 CFR 238.905. It regulates thermal monitoring for onboard battery cabinets used by [PUBLIC_APPLICABILITY]. Rail Energy Storage Safety is the subject, and the governing territory is United States federal jurisdiction.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'federal', issuerName: 'Interstate Rail Safety Office', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-05-11', fieldOfStudy: 'Rail Energy Storage Safety', licenseNumber: '49 CFR 238.905', jurisdiction: 'United States Federal', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/rail-battery-safety', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'federal', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-006', description: 'State automated-decision notice rule',
    strippedText: 'Massachusetts Consumer Data Commission approved 201 CMR 38.12 on June 15, 2026. The rule orders [PUBLIC_APPLICABILITY] to provide review notices for consequential automated decisions. Massachusetts is the jurisdiction; Automated Decision Transparency is the regulated field; sunset review falls June 30, 2030.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'state', issuerName: 'Massachusetts Consumer Data Commission', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-06-15', expiryDate: '2030-06-30', fieldOfStudy: 'Automated Decision Transparency', licenseNumber: '201 CMR 38.12', jurisdiction: 'Massachusetts', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/automated-decision-notice', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'state', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-007', description: 'Federal aviation fuel reporting rule',
    strippedText: 'Civil Aviation Environmental Directorate finalized 14 CFR 199.42 on July 13, 2026. Covered [PUBLIC_APPLICABILITY] must submit lifecycle fuel-intensity reports under the Aviation Fuel Accounting program. The regulation is federal, reaches the United States, and contains no fixed termination date.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'federal', issuerName: 'Civil Aviation Environmental Directorate', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-07-13', fieldOfStudy: 'Aviation Fuel Accounting', licenseNumber: '14 CFR 199.42', jurisdiction: 'United States Federal', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/aviation-fuel-reporting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'federal', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-008', description: 'State coastal insurance data rule',
    strippedText: 'North Carolina Insurance Data Council adopted 11 NCAC 23.0418 on August 17, 2026. It directs [PUBLIC_APPLICABILITY] to report coastal property exposure using uniform geospatial bands. Coastal Insurance Exposure is the subject, North Carolina is the jurisdiction, and August 31, 2031 is the scheduled sunset.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'state', issuerName: 'North Carolina Insurance Data Council', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-08-17', expiryDate: '2031-08-31', fieldOfStudy: 'Coastal Insurance Exposure', licenseNumber: '11 NCAC 23.0418', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/coastal-insurance', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'state', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-009', description: 'OCR-degraded federal food transport rule',
    strippedText: 'F00D TRANSP0RT SANlTATl0N RULE 7 CFR 1182.31 was issued September 10, 2026 by the National Food Logistics Agency. OCR damages only the heading. [PUBLIC_APPLICABILITY] remains subject to Refrigerated Transport Sanitation requirements across United States federal jurisdiction.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'federal', issuerName: 'National Food Logistics Agency', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-09-10', fieldOfStudy: 'Refrigerated Transport Sanitation', licenseNumber: '7 CFR 1182.31', jurisdiction: 'United States Federal', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'federal', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-010', description: 'State rule with proposal-number decoy',
    strippedText: 'Proposal 26-118 is displayed in the margin but is not the operative citation. California Circular Economy Board issued final regulation 14 CCR 18997.6 on October 15, 2026 for [PUBLIC_APPLICABILITY]. California; Reusable Shipping Containers; October 31, 2032 sunset review.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'state', issuerName: 'California Circular Economy Board', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-10-15', expiryDate: '2032-10-31', fieldOfStudy: 'Reusable Shipping Containers', licenseNumber: '14 CCR 18997.6', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'state', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-011', description: 'Federal regulation with effective-date trap',
    strippedText: 'Cyber Infrastructure Resilience Office promulgated 6 CFR 178.55 on November 12, 2026. January 1, 2027 is the compliance-effective date, not issuance. The measure covers [PUBLIC_APPLICABILITY], Operational Technology Incident Reporting, and United States federal jurisdiction.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'federal', issuerName: 'Cyber Infrastructure Resilience Office', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-11-12', fieldOfStudy: 'Operational Technology Incident Reporting', licenseNumber: '6 CFR 178.55', jurisdiction: 'United States Federal', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'federal', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LRI-012', description: 'State rule under federal portal label',
    strippedText: 'FEDERAL RULE is a repository label only. The instrument itself is Washington Administrative Code 480-118-340, adopted December 14, 2026 by Washington Clean Freight Commission. It governs [PUBLIC_APPLICABILITY] and Electric Freight Depot Reporting in Washington through a December 31, 2033 review date.',
    credentialTypeHint: 'REGULATION', groundTruth: { credentialType: 'REGULATION', subType: 'state', issuerName: 'Washington Clean Freight Commission', recipientIdentifier: '[PUBLIC_APPLICABILITY]', issuedDate: '2026-12-14', expiryDate: '2033-12-31', fieldOfStudy: 'Electric Freight Depot Reporting', licenseNumber: 'WAC 480-118-340', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/legal-15-regulatory-instrument/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'regulatory-instrument', 'state', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_SEC_10Q_FILINGS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FQ1-001', description: 'Quarterly filing for renewable controls company',
    strippedText: 'Northfield Renewable Controls, Inc. filed Form 10-Q on January 29, 2026 for the quarter ended December 31, 2025. The SEC registry assigns accession 10Q-26-1101 and identifies [PUBLIC_FILING] as the filing audience. Reporting subject is Quarterly Financial and Risk Disclosure under United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Northfield Renewable Controls, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-01-29', fieldOfStudy: 'Quarterly Financial and Risk Disclosure', licenseNumber: '10Q-26-1101', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/renewable-controls', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-002', description: 'Quarterly filing for cold logistics issuer',
    strippedText: 'Harbor Cold Logistics Corporation submitted its Form 10-Q on February 26, 2026, covering the fiscal quarter closed January 31, 2026. Filing key 10Q-26-1118 appears in the commission index for [PUBLIC_FILING]. The document concerns Interim Operations and Liquidity within United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Harbor Cold Logistics Corporation', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-02-26', fieldOfStudy: 'Interim Operations and Liquidity', licenseNumber: '10Q-26-1118', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/cold-logistics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-003', description: 'Quarterly filing for water analytics issuer',
    strippedText: 'Blue Mesa Water Analytics, Inc. delivered Form 10-Q to the securities commission on March 30, 2026. The report addresses the quarter ending February 28, 2026 and bears accession 10Q-26-1135 for [PUBLIC_FILING]. Its subject is Quarterly Revenue and Controls in United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Blue Mesa Water Analytics, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-03-30', fieldOfStudy: 'Quarterly Revenue and Controls', licenseNumber: '10Q-26-1135', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/water-analytics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-004', description: 'Quarterly filing for sensor manufacturer',
    strippedText: 'Cedar Ridge Sensor Systems delivered its Form 10-Q filing dated April 27, 2026. It covers the three months ended March 31, 2026. Accession 10Q-26-1152 indexes the [PUBLIC_FILING] record; subject is Interim Manufacturing Performance; jurisdiction is United States SEC.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Cedar Ridge Sensor Systems', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-04-27', fieldOfStudy: 'Interim Manufacturing Performance', licenseNumber: '10Q-26-1152', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/sensor-manufacturing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-005', description: 'Quarterly filing for materials recovery issuer',
    strippedText: 'Loopstone Materials Recovery Company lodged Form 10-Q on May 28, 2026 for its quarter completed April 30, 2026. Commission accession 10Q-26-1169 binds the report for [PUBLIC_FILING]. The filing covers Quarterly Cash Flow and Recycling Operations under United States SEC authority.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Loopstone Materials Recovery Company', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-05-28', fieldOfStudy: 'Quarterly Cash Flow and Recycling Operations', licenseNumber: '10Q-26-1169', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/materials-recovery', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-006', description: 'Quarterly filing for grid software issuer',
    strippedText: 'Juniper Grid Software, Inc. transmitted Form 10-Q on June 29, 2026. The reporting period ended May 31, 2026, and the public commission ledger records 10Q-26-1186 for [PUBLIC_FILING]. Interim Subscription Metrics and Market Risk is the subject in United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Juniper Grid Software, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-06-29', fieldOfStudy: 'Interim Subscription Metrics and Market Risk', licenseNumber: '10Q-26-1186', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/grid-software', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-007', description: 'Quarterly filing for modular housing issuer',
    strippedText: 'Prairie Modular Housing Corporation filed Form 10-Q with a July 30, 2026 filing date and June 30, 2026 quarter end. Identifier 10Q-26-1203 belongs to the [PUBLIC_FILING] submission. Quarterly Backlog and Construction Costs is its field; United States SEC is the jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Prairie Modular Housing Corporation', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-07-30', fieldOfStudy: 'Quarterly Backlog and Construction Costs', licenseNumber: '10Q-26-1203', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/modular-housing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-008', description: 'Quarterly filing for freight optimization issuer',
    strippedText: 'Summit Freight Optimization, Inc. registered Form 10-Q on August 27, 2026 for the interim period ending July 31, 2026. The [PUBLIC_FILING] index number is 10Q-26-1220. Subject matter is Quarterly Network Utilization and Liquidity under United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Summit Freight Optimization, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-08-27', fieldOfStudy: 'Quarterly Network Utilization and Liquidity', licenseNumber: '10Q-26-1220', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/freight-optimization', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-009', description: 'OCR-degraded Form 10-Q cover',
    strippedText: 'F0RM 10-Q for Granite Harbor Circuits, Inc. was filed September 28, 2026 and covers the quarter ended August 31, 2026. OCR alters the cover caption only. Accession 10Q-26-1237 serves [PUBLIC_FILING]; Quarterly Component Supply Risk; United States SEC.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Granite Harbor Circuits, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-09-28', fieldOfStudy: 'Quarterly Component Supply Risk', licenseNumber: '10Q-26-1237', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-010', description: 'Amended quarterly report with accession decoy',
    strippedText: 'Prior accession 10Q-26-1249 is superseded. Silver Fir Mobility, Inc. filed Form 10-Q/A on October 26, 2026 under operative accession 10Q-26-1254 for [PUBLIC_FILING]. It amends September-quarter Controls and Liquidity disclosure; classification remains form 10-Q; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Silver Fir Mobility, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-10-26', fieldOfStudy: 'Amended Quarterly Controls and Liquidity', licenseNumber: '10Q-26-1254', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-011', description: 'Quarterly report with period-end date trap',
    strippedText: 'Pine Basin Thermal Systems closed its fiscal quarter on October 31, 2026, but that date is not filing issuance. Form 10-Q was filed November 30, 2026 as 10Q-26-1271 for [PUBLIC_FILING]. Interim Thermal Equipment Results; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Pine Basin Thermal Systems', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-11-30', fieldOfStudy: 'Interim Thermal Equipment Results', licenseNumber: '10Q-26-1271', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FQ1-012', description: 'Form 10-Q mislabeled annual report',
    strippedText: 'ANNUAL REPORT is an archive-folder label, not the filing type. The cover identifies Form 10-Q from Rivergate Industrial Imaging, filed December 28, 2026 under 10Q-26-1288 for [PUBLIC_FILING]. Quarterly Imaging Systems Performance; United States SEC jurisdiction; quarter ended November 30, 2026.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10q', issuerName: 'Rivergate Industrial Imaging', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-12-28', fieldOfStudy: 'Quarterly Imaging Systems Performance', licenseNumber: '10Q-26-1288', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-11-sec-10q/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10q', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_SEC_8K_FILINGS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-F8K-001', description: 'Current report for executive transition',
    strippedText: 'Aspen Metering Technologies filed Form 8-K on January 14, 2026 to report a chief executive transition. The commission assigned accession 8K-26-2104 for [PUBLIC_FILING]. Executive Leadership Change is the disclosed subject, governed by United States SEC filing jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Aspen Metering Technologies', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-01-14', fieldOfStudy: 'Executive Leadership Change', licenseNumber: '8K-26-2104', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/executive-transition', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-002', description: 'Current report for acquisition agreement',
    strippedText: 'On February 17, 2026, Delta Marsh Environmental Services submitted Form 8-K concerning a definitive acquisition agreement. Index key 8K-26-2121 identifies the [PUBLIC_FILING] record. Material Acquisition Agreement is the subject within United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Delta Marsh Environmental Services', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-02-17', fieldOfStudy: 'Material Acquisition Agreement', licenseNumber: '8K-26-2121', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/acquisition-agreement', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-003', description: 'Current report for credit facility',
    strippedText: 'Copper Trail Agri-Systems lodged Form 8-K on March 13, 2026 after entering a revolving credit facility. Accession 8K-26-2138 appears on the public securities ledger for [PUBLIC_FILING]. Financing Facility Disclosure is the report subject under United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Copper Trail Agri-Systems', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-03-13', fieldOfStudy: 'Financing Facility Disclosure', licenseNumber: '8K-26-2138', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/credit-facility', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-004', description: 'Current report for cybersecurity incident',
    strippedText: 'Lakefront Clinical Data Systems transmitted a Form 8-K current report on April 16, 2026. It discloses a material cybersecurity incident under accession 8K-26-2155 for [PUBLIC_FILING]. Cybersecurity Event Disclosure is classified in United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Lakefront Clinical Data Systems', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-04-16', fieldOfStudy: 'Cybersecurity Event Disclosure', licenseNumber: '8K-26-2155', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/cybersecurity-incident', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-005', description: 'Current report for auditor change',
    strippedText: 'Red Canyon Processing Equipment registered Form 8-K on May 15, 2026 for a change in certifying accountant. The [PUBLIC_FILING] accession is 8K-26-2172. Auditor Appointment and Dismissal is the event category, and United States SEC is the filing jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Red Canyon Processing Equipment', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-05-15', fieldOfStudy: 'Auditor Appointment and Dismissal', licenseNumber: '8K-26-2172', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/auditor-change', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-006', description: 'Current report for asset impairment',
    strippedText: 'Form 8-K from Tidal Basin Storage Corporation carries a June 18, 2026 filing date. It reports a material asset impairment through commission identifier 8K-26-2189 for [PUBLIC_FILING]. Asset Impairment Recognition is the subject in United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Tidal Basin Storage Corporation', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-06-18', fieldOfStudy: 'Asset Impairment Recognition', licenseNumber: '8K-26-2189', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/asset-impairment', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-007', description: 'Current report for restructuring plan',
    strippedText: 'Timberline Fleet Electrification, Inc. filed Form 8-K on July 16, 2026 announcing a board-approved restructuring plan. Accession 8K-26-2206 corresponds to [PUBLIC_FILING]. Workforce and Facility Restructuring is the disclosure subject within United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Timberline Fleet Electrification, Inc.', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-07-16', fieldOfStudy: 'Workforce and Facility Restructuring', licenseNumber: '8K-26-2206', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/restructuring-plan', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-008', description: 'Current report for supply agreement',
    strippedText: 'Evergreen Medical Packaging submitted a Form 8-K on August 14, 2026 regarding a long-term supply agreement. Securities accession 8K-26-2223 indexes the [PUBLIC_FILING] document. Material Supply Contract is the subject and United States SEC is the jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Evergreen Medical Packaging', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-08-14', fieldOfStudy: 'Material Supply Contract', licenseNumber: '8K-26-2223', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/material-supply-contract', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-009', description: 'OCR-degraded current report cover',
    strippedText: 'F0RM 8-K from Foothill Microgrid Services was filed September 17, 2026 for a material equipment loss. OCR affects only the title block. Identifier 8K-26-2240 serves [PUBLIC_FILING]; Insured Equipment Loss; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Foothill Microgrid Services', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-09-17', fieldOfStudy: 'Insured Equipment Loss', licenseNumber: '8K-26-2240', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-010', description: 'Current report with item-number decoy',
    strippedText: 'Item 9.01 exhibit number 26-441 is not the filing accession. Stonebridge Food Automation filed Form 8-K on October 15, 2026 under 8K-26-2257 for [PUBLIC_FILING]. Acquisition Completion is the event subject; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Stonebridge Food Automation', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-10-15', fieldOfStudy: 'Acquisition Completion', licenseNumber: '8K-26-2257', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-011', description: 'Current report with event-date trap',
    strippedText: 'Meadowline Utility Mapping signed a material contract on November 4, 2026, but that is the event date. Its Form 8-K filing date is November 13, 2026 under accession 8K-26-2274 for [PUBLIC_FILING]. Material Customer Contract; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Meadowline Utility Mapping', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-11-13', fieldOfStudy: 'Material Customer Contract', licenseNumber: '8K-26-2274', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-F8K-012', description: 'Current report mislabeled quarterly filing',
    strippedText: 'FORM 10-Q appears in the repository navigation, yet the document cover and event items identify Form 8-K. Birch Coast Marine Sensors filed it December 17, 2026 as 8K-26-2291 for [PUBLIC_FILING]. Director Resignation; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_8k', issuerName: 'Birch Coast Marine Sensors', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-12-17', fieldOfStudy: 'Director Resignation', licenseNumber: '8K-26-2291', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-12-sec-8k/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-8k', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_SEC_DEF14A_FILINGS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FDA-001', description: 'Definitive proxy for board election',
    strippedText: 'Clearwater Industrial Pumps filed definitive proxy statement DEF 14A on January 22, 2026. Accession DFA-26-3107 indexes the [PUBLIC_FILING] document for its annual shareholder meeting. Board Election and Governance is the subject within United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Clearwater Industrial Pumps', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-01-22', fieldOfStudy: 'Board Election and Governance', licenseNumber: 'DFA-26-3107', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/board-election', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-002', description: 'Definitive proxy for executive compensation',
    strippedText: 'Willow Transit Analytics submitted Form DEF 14A on February 23, 2026. The definitive proxy discusses executive compensation and carries commission key DFA-26-3124 for [PUBLIC_FILING]. Executive Pay and Say-on-Pay is its field under United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Willow Transit Analytics', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-02-23', fieldOfStudy: 'Executive Pay and Say-on-Pay', licenseNumber: 'DFA-26-3124', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/executive-compensation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-003', description: 'Definitive proxy for equity plan vote',
    strippedText: 'Form DEF 14A from Granite Plains Bio-Materials was filed March 26, 2026 under accession DFA-26-3141. The [PUBLIC_FILING] proxy requests approval of an employee equity plan. Equity Incentive Plan Vote is the subject, and United States SEC is the jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Granite Plains Bio-Materials', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-03-26', fieldOfStudy: 'Equity Incentive Plan Vote', licenseNumber: 'DFA-26-3141', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/equity-plan-vote', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-004', description: 'Definitive proxy for auditor ratification',
    strippedText: 'Mesa Coast Filtration Systems filed its definitive proxy, Form DEF 14A, on April 23, 2026. Filing identifier DFA-26-3158 belongs to [PUBLIC_FILING]. Auditor Ratification and Audit Committee Oversight is the report subject under United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Mesa Coast Filtration Systems', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-04-23', fieldOfStudy: 'Auditor Ratification and Audit Committee Oversight', licenseNumber: 'DFA-26-3158', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/auditor-ratification', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-005', description: 'Definitive proxy for director classification',
    strippedText: 'Beacon Circular Packaging lodged DEF 14A on May 21, 2026 for [PUBLIC_FILING]. The proxy seeks a vote to declassify its board and appears under accession DFA-26-3175. Board Declassification Proposal is the subject within United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Beacon Circular Packaging', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-05-21', fieldOfStudy: 'Board Declassification Proposal', licenseNumber: 'DFA-26-3175', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/board-declassification', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-006', description: 'Definitive proxy for shareholder proposal',
    strippedText: 'Prairie Data Infrastructure submitted a definitive DEF 14A proxy on June 25, 2026. Accession DFA-26-3192 identifies the [PUBLIC_FILING] packet containing a climate-risk shareholder proposal. Shareholder Proposal and Board Response is classified in United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Prairie Data Infrastructure', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-06-25', fieldOfStudy: 'Shareholder Proposal and Board Response', licenseNumber: 'DFA-26-3192', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/shareholder-proposal', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-007', description: 'Definitive proxy for governance amendments',
    strippedText: 'Canyon Medical Logistics filed Form DEF 14A on July 23, 2026 under DFA-26-3209. The [PUBLIC_FILING] materials propose charter amendments and director qualification changes. Corporate Governance Amendments is the filing field, governed by United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Canyon Medical Logistics', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-07-23', fieldOfStudy: 'Corporate Governance Amendments', licenseNumber: 'DFA-26-3209', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/governance-amendments', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-008', description: 'Definitive proxy for compensation clawback',
    strippedText: 'Riverbend Agricultural Robotics registered definitive proxy statement DEF 14A on August 20, 2026. The [PUBLIC_FILING] record is DFA-26-3226 and includes a compensation clawback policy vote. Compensation Recovery Governance is the subject in United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Riverbend Agricultural Robotics', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-08-20', fieldOfStudy: 'Compensation Recovery Governance', licenseNumber: 'DFA-26-3226', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/compensation-clawback', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-009', description: 'OCR-degraded definitive proxy cover',
    strippedText: 'DEFlNlTlVE PR0XY STATEMENT from Alpine Thermal Networks was filed September 24, 2026. The optical scan confuses letters in the heading only. DEF 14A accession DFA-26-3243 serves [PUBLIC_FILING]; Director Nomination Process; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Alpine Thermal Networks', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-09-24', fieldOfStudy: 'Director Nomination Process', licenseNumber: 'DFA-26-3243', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-010', description: 'Definitive proxy with preliminary accession decoy',
    strippedText: 'Preliminary proxy PRE-26-088 is superseded and not the operative record. Coastal Grid Components filed definitive DEF 14A on October 22, 2026 as DFA-26-3260 for [PUBLIC_FILING]. Independent Director Election; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Coastal Grid Components', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-10-22', fieldOfStudy: 'Independent Director Election', licenseNumber: 'DFA-26-3260', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-011', description: 'Definitive proxy with meeting-date trap',
    strippedText: 'The annual meeting for Pine Harbor Utility Software occurs December 9, 2026, but that is not the filing date. Form DEF 14A was filed November 19, 2026 under DFA-26-3277 for [PUBLIC_FILING]. Governance and Annual Meeting Matters; United States SEC.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Pine Harbor Utility Software', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-11-19', fieldOfStudy: 'Governance and Annual Meeting Matters', licenseNumber: 'DFA-26-3277', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FDA-012', description: 'Definitive proxy under annual-report label',
    strippedText: 'ANNUAL REPORT labels the download folder, while the filed document is definitive proxy statement DEF 14A. Marshland Power Electronics submitted it December 21, 2026 as DFA-26-3294 for [PUBLIC_FILING]. Executive Compensation and Director Election; United States SEC jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_def14a', issuerName: 'Marshland Power Electronics', recipientIdentifier: '[PUBLIC_FILING]', issuedDate: '2026-12-21', fieldOfStudy: 'Executive Compensation and Director Election', licenseNumber: 'DFA-26-3294', jurisdiction: 'United States SEC', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-13-sec-def14a/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-def14a', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_FINRA_BROKERS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FFB-001', description: 'Active broker with general securities registrations',
    strippedText: 'FINRA registration extract dated January 19, 2026 identifies [BROKER_REDACTED] under CRD 7314101. The broker is active with Cedar Harbor Securities in Illinois and holds Series 7 and Series 66 qualifications. Registration field is Securities Brokerage; original registration date is January 19, 2021.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2021-01-19', fieldOfStudy: 'Securities Brokerage', jurisdiction: 'Illinois', crdNumber: '7314101', firmName: 'Cedar Harbor Securities', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 66', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/general-securities', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-002', description: 'Active broker with municipal securities qualification',
    strippedText: 'A February 16, 2026 FINRA registry record shows [BROKER_REDACTED], CRD 7314228, affiliated with Prairie Municipal Markets. Status is active in Iowa. Series 7, Series 52, and Series 63 are listed for Municipal Securities Brokerage; first registered February 16, 2020.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2020-02-16', fieldOfStudy: 'Municipal Securities Brokerage', jurisdiction: 'Iowa', crdNumber: '7314228', firmName: 'Prairie Municipal Markets', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 52, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/municipal-securities', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-003', description: 'Active broker with investment banking registration',
    strippedText: 'The March 18, 2026 FINRA status page records [BROKER_REDACTED] as active at Blue Ridge Capital Placement. CRD 7314355 carries Series 79 and Series 63 qualifications in Virginia. Investment Banking is the registered activity; initial registration occurred March 18, 2022.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2022-03-18', fieldOfStudy: 'Investment Banking', jurisdiction: 'Virginia', crdNumber: '7314355', firmName: 'Blue Ridge Capital Placement', finraRegistration: 'Active', seriesLicenses: 'Series 79, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/investment-banking', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-004', description: 'Active broker with options principal qualification',
    strippedText: 'FINRA lists [BROKER_REDACTED] at Granite Coast Brokerage under CRD 7314482. The April 20, 2026 extract marks an active Maine registration and Series 7, Series 4, and Series 24 qualifications. Brokerage Supervision is the field; registration began April 20, 2019.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2019-04-20', fieldOfStudy: 'Brokerage Supervision', jurisdiction: 'Maine', crdNumber: '7314482', firmName: 'Granite Coast Brokerage', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 4, Series 24', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/options-principal', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-005', description: 'Active broker with private securities qualification',
    strippedText: 'On May 18, 2026 the FINRA register reports [BROKER_REDACTED] active with Summit Private Markets, CRD 7314609. Colorado jurisdiction and Series 82 plus Series 63 qualifications are present. Private Securities Offerings is the specialty; the registration start is May 18, 2023.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2023-05-18', fieldOfStudy: 'Private Securities Offerings', jurisdiction: 'Colorado', crdNumber: '7314609', firmName: 'Summit Private Markets', finraRegistration: 'Active', seriesLicenses: 'Series 82, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/private-offerings', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-006', description: 'Active broker with commodities futures qualification',
    strippedText: 'FINRA status dated June 17, 2026 places [BROKER_REDACTED] at Red River Futures Securities. CRD 7314736 is active in Texas with Series 3 and Series 7 credentials. Securities and Futures Brokerage is the activity; first registration was June 17, 2021.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2021-06-17', fieldOfStudy: 'Securities and Futures Brokerage', jurisdiction: 'Texas', crdNumber: '7314736', firmName: 'Red River Futures Securities', finraRegistration: 'Active', seriesLicenses: 'Series 3, Series 7', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/futures-brokerage', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-007', description: 'Active broker with research analyst qualification',
    strippedText: 'The July 20, 2026 regulatory extract identifies [BROKER_REDACTED] by CRD 7314863 at Lakeview Research Securities. FINRA marks the Wisconsin registration active and lists Series 86, Series 87, and Series 63. Equity Research is the field; registration began July 20, 2020.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2020-07-20', fieldOfStudy: 'Equity Research', jurisdiction: 'Wisconsin', crdNumber: '7314863', firmName: 'Lakeview Research Securities', finraRegistration: 'Active', seriesLicenses: 'Series 86, Series 87, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/research-analyst', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-008', description: 'Active broker with operations qualification',
    strippedText: 'An August 19, 2026 FINRA record shows [BROKER_REDACTED] active at Harbor Settlement Services, CRD 7314990. The New Jersey registration includes Series 99 and Series 63. Broker-Dealer Operations is the registered field, dating from August 19, 2024.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2024-08-19', fieldOfStudy: 'Broker-Dealer Operations', jurisdiction: 'New Jersey', crdNumber: '7314990', firmName: 'Harbor Settlement Services', finraRegistration: 'Active', seriesLicenses: 'Series 99, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/broker-operations', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-009', description: 'OCR-degraded FINRA registration extract',
    strippedText: 'FlNRA REGISTRATl0N EXTRACT lists [BROKER_REDACTED], CRD 7315117, at Northern Plains Securities. OCR substitutions affect the heading only. The September 21, 2026 view shows active Minnesota status, Series 7 and Series 63, Retail Securities Brokerage, registered since September 21, 2022.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2022-09-21', fieldOfStudy: 'Retail Securities Brokerage', jurisdiction: 'Minnesota', crdNumber: '7315117', firmName: 'Northern Plains Securities', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-010', description: 'FINRA broker record with former-firm decoy',
    strippedText: 'Old employer Maple Crossing Capital ended in 2024 and is not the current firm. FINRA shows [BROKER_REDACTED], CRD 7315244, active at Foothill Securities on October 19, 2026. California; Series 7 and Series 66; Wealth Brokerage; registered since October 19, 2018.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2018-10-19', fieldOfStudy: 'Wealth Brokerage', jurisdiction: 'California', crdNumber: '7315244', firmName: 'Foothill Securities', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 66', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-011', description: 'FINRA record with report-date trap',
    strippedText: 'The registry snapshot was generated November 18, 2026, but [BROKER_REDACTED] first registered November 18, 2021. FINRA CRD 7315371 is active with Seaboard Institutional Brokerage in Maryland. Series 7, Series 24, and Series 63 support Institutional Brokerage Supervision.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2021-11-18', fieldOfStudy: 'Institutional Brokerage Supervision', jurisdiction: 'Maryland', crdNumber: '7315371', firmName: 'Seaboard Institutional Brokerage', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 24, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFB-012', description: 'FINRA broker under adviser-only portal label',
    strippedText: 'INVESTMENT ADVISER ONLY labels the archive tile, although the underlying FINRA record is an active broker registration. [BROKER_REDACTED], CRD 7315498, works at Gulfline Securities in Florida with Series 7 and Series 63. Securities Brokerage registration began December 16, 2023.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'finra_registered', issuerName: 'FINRA', recipientIdentifier: '[BROKER_REDACTED]', issuedDate: '2023-12-16', fieldOfStudy: 'Securities Brokerage', jurisdiction: 'Florida', crdNumber: '7315498', firmName: 'Gulfline Securities', finraRegistration: 'Active', seriesLicenses: 'Series 7, Series 63', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-14-finra-broker/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'finra-broker', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_INVESTMENT_ADVISERS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FIA-001', description: 'SEC-registered portfolio adviser',
    strippedText: 'The Securities and Exchange Commission register identifies [ADVISER_REDACTED] as an active federal investment adviser, CRD 8014101. Registration began January 25, 2021 for Harbor Elm Portfolio Counsel. Investment Portfolio Management is the field and United States is the jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'sec_registered', issuerName: 'Securities and Exchange Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2021-01-25', fieldOfStudy: 'Investment Portfolio Management', jurisdiction: 'United States', crdNumber: '8014101', firmName: 'Harbor Elm Portfolio Counsel', finraRegistration: 'SEC Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/sec-portfolio-management', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'sec-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-002', description: 'State-registered retirement adviser',
    strippedText: 'Vermont Department of Financial Regulation lists [ADVISER_REDACTED] under CRD 8014228 as a current state investment adviser. Green Mountain Retirement Counsel became registered February 22, 2022. Retirement Investment Advisory is the specialty and Vermont is the registration jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'state_registered', issuerName: 'Vermont Department of Financial Regulation', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2022-02-22', fieldOfStudy: 'Retirement Investment Advisory', jurisdiction: 'Vermont', crdNumber: '8014228', firmName: 'Green Mountain Retirement Counsel', finraRegistration: 'State Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/state-retirement', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'state-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-003', description: 'SEC-registered institutional adviser',
    strippedText: 'Federal adviser records show [ADVISER_REDACTED], CRD 8014355, actively registered through the Securities and Exchange Commission. Prairie Stone Institutional Advisors entered registration March 24, 2020. Institutional Asset Allocation is the advisory field across United States jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'sec_registered', issuerName: 'Securities and Exchange Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2020-03-24', fieldOfStudy: 'Institutional Asset Allocation', jurisdiction: 'United States', crdNumber: '8014355', firmName: 'Prairie Stone Institutional Advisors', finraRegistration: 'SEC Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/sec-institutional', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'sec-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-004', description: 'State-registered sustainable adviser',
    strippedText: 'Oregon Division of Financial Regulation confirms active state registration for [ADVISER_REDACTED], CRD 8014482. Cascade Sustainable Advisory began April 21, 2023 and practices Sustainable Investment Advisory. Oregon is the registration jurisdiction; the record is not a broker registration.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'state_registered', issuerName: 'Oregon Division of Financial Regulation', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2023-04-21', fieldOfStudy: 'Sustainable Investment Advisory', jurisdiction: 'Oregon', crdNumber: '8014482', firmName: 'Cascade Sustainable Advisory', finraRegistration: 'State Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/state-sustainable', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'state-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-005', description: 'SEC-registered infrastructure adviser',
    strippedText: 'The federal investment adviser index marks [ADVISER_REDACTED] active under CRD 8014609 at Rivergate Infrastructure Advisers. SEC registration dates to May 23, 2019. Infrastructure Fund Advisory is the declared field, and the registration reaches United States jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'sec_registered', issuerName: 'Securities and Exchange Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2019-05-23', fieldOfStudy: 'Infrastructure Fund Advisory', jurisdiction: 'United States', crdNumber: '8014609', firmName: 'Rivergate Infrastructure Advisers', finraRegistration: 'SEC Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/sec-infrastructure', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'sec-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-006', description: 'State-registered agricultural adviser',
    strippedText: 'Iowa Insurance and Financial Services Division records [ADVISER_REDACTED], CRD 8014736, as an active state adviser with Fieldstone Agricultural Wealth. Registration began June 26, 2021. Agricultural Investment Planning is the field and Iowa is the governing jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'state_registered', issuerName: 'Iowa Insurance and Financial Services Division', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2021-06-26', fieldOfStudy: 'Agricultural Investment Planning', jurisdiction: 'Iowa', crdNumber: '8014736', firmName: 'Fieldstone Agricultural Wealth', finraRegistration: 'State Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/state-agricultural', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'state-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-007', description: 'SEC-registered quantitative adviser',
    strippedText: 'SEC adviser registration for [ADVISER_REDACTED] is active under CRD 8014863 and firm name North Coast Quantitative Counsel. The federal registration started July 22, 2024. Quantitative Portfolio Advisory is the field, applicable across United States jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'sec_registered', issuerName: 'Securities and Exchange Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2024-07-22', fieldOfStudy: 'Quantitative Portfolio Advisory', jurisdiction: 'United States', crdNumber: '8014863', firmName: 'North Coast Quantitative Counsel', finraRegistration: 'SEC Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/sec-quantitative', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'sec-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-008', description: 'State-registered education savings adviser',
    strippedText: 'Colorado Division of Securities displays active state adviser status for [ADVISER_REDACTED] and CRD 8014990. Alpine Education Savings Counsel registered August 24, 2022. Education Savings Investment Advice is the practice area and Colorado is the jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'state_registered', issuerName: 'Colorado Division of Securities', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2022-08-24', fieldOfStudy: 'Education Savings Investment Advice', jurisdiction: 'Colorado', crdNumber: '8014990', firmName: 'Alpine Education Savings Counsel', finraRegistration: 'State Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/state-education-savings', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'state-registered', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-009', description: 'OCR-degraded SEC adviser record',
    strippedText: 'SEC lNVESTMENT ADVlSER REGISTRY shows [ADVISER_REDACTED], CRD 8015117, active at Bluewater Fiduciary Analytics. OCR changes the heading only. Federal registration began September 25, 2020 for Fiduciary Risk Advisory throughout United States jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'sec_registered', issuerName: 'Securities and Exchange Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2020-09-25', fieldOfStudy: 'Fiduciary Risk Advisory', jurisdiction: 'United States', crdNumber: '8015117', firmName: 'Bluewater Fiduciary Analytics', finraRegistration: 'SEC Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'sec-registered', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-010', description: 'State adviser record with former regulator decoy',
    strippedText: 'Former Nevada notice is historical and does not define current jurisdiction. Arizona Corporation Commission presently registers [ADVISER_REDACTED], CRD 8015244, at Desert Horizon Advisory. State status active since October 27, 2023; Small Business Investment Advice; Arizona.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'state_registered', issuerName: 'Arizona Corporation Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2023-10-27', fieldOfStudy: 'Small Business Investment Advice', jurisdiction: 'Arizona', crdNumber: '8015244', firmName: 'Desert Horizon Advisory', finraRegistration: 'State Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'state-registered', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-011', description: 'SEC adviser with snapshot-date trap',
    strippedText: 'The adviser snapshot was downloaded November 23, 2026, not the registration start. [ADVISER_REDACTED] entered SEC registration November 23, 2018 under CRD 8015371 at Meridian Public Pension Counsel. Public Pension Advisory; active federal status; United States jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'sec_registered', issuerName: 'Securities and Exchange Commission', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2018-11-23', fieldOfStudy: 'Public Pension Advisory', jurisdiction: 'United States', crdNumber: '8015371', firmName: 'Meridian Public Pension Counsel', finraRegistration: 'SEC Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'sec-registered', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FIA-012', description: 'State adviser under broker portal label',
    strippedText: 'BROKER REGISTRATION is an imported portal heading, while the underlying record says state investment adviser. Maine Office of Securities registers [ADVISER_REDACTED], CRD 8015498, at Pine Coast Household Advisory. Active since December 20, 2021; Household Financial Planning; Maine jurisdiction.',
    credentialTypeHint: 'FINANCIAL_ADVISOR', groundTruth: { credentialType: 'FINANCIAL_ADVISOR', subType: 'state_registered', issuerName: 'Maine Office of Securities', recipientIdentifier: '[ADVISER_REDACTED]', issuedDate: '2021-12-20', fieldOfStudy: 'Household Financial Planning', jurisdiction: 'Maine', crdNumber: '8015498', firmName: 'Pine Coast Household Advisory', finraRegistration: 'State Registered - Active', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/financial-15-investment-adviser/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'investment-adviser', 'state-registered', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_TRADE_CERTIFICATIONS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-ETC-001', description: 'Structural welding trade certification',
    strippedText: 'Iron Valley Trades Council certifies [TRADESPERSON_REDACTED] as a Structural Welding Specialist. Trade credential ETC-26012 was issued January 15, 2026 and expires January 31, 2029. American Fabrication Skills Board accredits the program for Pennsylvania jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Iron Valley Trades Council', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-01-15', expiryDate: '2029-01-31', fieldOfStudy: 'Structural Welding', licenseNumber: 'ETC-26012', accreditingBody: 'American Fabrication Skills Board', jurisdiction: 'Pennsylvania', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/structural-welding', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-002', description: 'Industrial electrician trade certification',
    strippedText: 'Great Lakes Electrical Craft Institute awards [TRADESPERSON_REDACTED] Industrial Electrician certification ETC-26029. The credential began February 19, 2026 and remains valid through February 28, 2029. Manufacturing Trades Accreditation Commission recognizes it in Michigan.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Great Lakes Electrical Craft Institute', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-02-19', expiryDate: '2029-02-28', fieldOfStudy: 'Industrial Electrical Systems', licenseNumber: 'ETC-26029', accreditingBody: 'Manufacturing Trades Accreditation Commission', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/industrial-electrician', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-003', description: 'Commercial plumbing trade certification',
    strippedText: 'Mid-Atlantic Pipe Trades Academy designates [TRADESPERSON_REDACTED] a Commercial Plumbing Craft Professional. Number ETC-26045 carries a March 18, 2026 issue date and March 31, 2029 renewal deadline. Building Craft Standards Alliance accredits the Virginia credential.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Mid-Atlantic Pipe Trades Academy', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-03-18', expiryDate: '2029-03-31', fieldOfStudy: 'Commercial Plumbing', licenseNumber: 'ETC-26045', accreditingBody: 'Building Craft Standards Alliance', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/commercial-plumbing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-004', description: 'Refrigeration mechanic trade certification',
    strippedText: 'Northern Climate Mechanical Guild recognizes [TRADESPERSON_REDACTED] in Commercial Refrigeration Service. Trade certificate ETC-26062 was issued April 16, 2026 with expiry April 30, 2029. Mechanical Workforce Credentialing Board accredits the qualification in Minnesota.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Northern Climate Mechanical Guild', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-04-16', expiryDate: '2029-04-30', fieldOfStudy: 'Commercial Refrigeration Service', licenseNumber: 'ETC-26062', accreditingBody: 'Mechanical Workforce Credentialing Board', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/refrigeration-mechanic', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-005', description: 'CNC machining trade certification',
    strippedText: 'Precision Valley Manufacturing School grants [TRADESPERSON_REDACTED] the CNC Machining Craft credential ETC-26078. Certification starts May 21, 2026 and renews after May 31, 2029. Advanced Manufacturing Skills Council accredits the Ohio trade program.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Precision Valley Manufacturing School', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-05-21', expiryDate: '2029-05-31', fieldOfStudy: 'CNC Machining', licenseNumber: 'ETC-26078', accreditingBody: 'Advanced Manufacturing Skills Council', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/cnc-machining', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-006', description: 'Solar installer trade certification',
    strippedText: 'Desert Renewable Trades Association certifies [TRADESPERSON_REDACTED] in Photovoltaic Array Installation. ETC-26093 became effective June 18, 2026 and expires June 30, 2029. Clean Energy Craft Accreditation Council approves the credential for Arizona.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Desert Renewable Trades Association', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-06-18', expiryDate: '2029-06-30', fieldOfStudy: 'Photovoltaic Array Installation', licenseNumber: 'ETC-26093', accreditingBody: 'Clean Energy Craft Accreditation Council', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/solar-installer', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-007', description: 'Historic masonry trade certification',
    strippedText: 'Heritage Masonry Craft College awards [TRADESPERSON_REDACTED] certification in Historic Brick Restoration. Credential ETC-26109 was issued July 16, 2026 and is current until July 31, 2029. Traditional Building Skills Commission accredits the South Carolina program.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Heritage Masonry Craft College', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-07-16', expiryDate: '2029-07-31', fieldOfStudy: 'Historic Brick Restoration', licenseNumber: 'ETC-26109', accreditingBody: 'Traditional Building Skills Commission', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/historic-masonry', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-008', description: 'Timber framing trade certification',
    strippedText: 'Pine Coast Carpentry Guild credentials [TRADESPERSON_REDACTED] as a Timber Framing Craftsperson. ETC-26125 begins August 20, 2026 and ends August 31, 2029 unless renewed. North American Carpentry Standards Forum accredits the Maine credential.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Pine Coast Carpentry Guild', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-08-20', expiryDate: '2029-08-31', fieldOfStudy: 'Timber Framing', licenseNumber: 'ETC-26125', accreditingBody: 'North American Carpentry Standards Forum', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/timber-framing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-009', description: 'OCR-degraded trade certification',
    strippedText: 'RlVERBEND HEAVY EQUlPMENT lNSTlTUTE certifies [TRADESPERSON_REDACTED] in Hydraulic Equipment Repair under ETC-26140. OCR affects the issuer heading only. Issued September 17, 2026; expires September 30, 2029; Mobile Machinery Skills Board; Kentucky jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Riverbend Heavy Equipment Institute', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-09-17', expiryDate: '2029-09-30', fieldOfStudy: 'Hydraulic Equipment Repair', licenseNumber: 'ETC-26140', accreditingBody: 'Mobile Machinery Skills Board', jurisdiction: 'Kentucky', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-010', description: 'Trade certification with apprentice-number decoy',
    strippedText: 'Apprenticeship record AP-8894 appears in the margin but is not the trade credential. Gulf Process Trades Center issues ETC-26156 to [TRADESPERSON_REDACTED] for Process Pipefitting on October 22, 2026, expiring October 31, 2029. Industrial Craft Accreditation Board; Louisiana.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Gulf Process Trades Center', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-10-22', expiryDate: '2029-10-31', fieldOfStudy: 'Process Pipefitting', licenseNumber: 'ETC-26156', accreditingBody: 'Industrial Craft Accreditation Board', jurisdiction: 'Louisiana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-011', description: 'Trade certification with assessment-date trap',
    strippedText: 'The practical assessment occurred October 29, 2026, but certification issuance followed on November 19, 2026. Palmetto Marine Trades School grants [TRADESPERSON_REDACTED] ETC-26172 in Marine Electrical Installation through November 30, 2029. Coastal Craft Credentialing Council; South Carolina.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Palmetto Marine Trades School', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-11-19', expiryDate: '2029-11-30', fieldOfStudy: 'Marine Electrical Installation', licenseNumber: 'ETC-26172', accreditingBody: 'Coastal Craft Credentialing Council', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETC-012', description: 'Trade certification under training-only label',
    strippedText: 'TRAINING ATTENDANCE labels the portal tile, while the signed record confers a renewable trade credential. Mountain Hoist Academy awards [TRADESPERSON_REDACTED] ETC-26188 in Elevator Maintenance on December 17, 2026 through December 31, 2029. Vertical Transport Skills Commission; Colorado.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'trade_certification', issuerName: 'Mountain Hoist Academy', recipientIdentifier: '[TRADESPERSON_REDACTED]', issuedDate: '2026-12-17', expiryDate: '2029-12-31', fieldOfStudy: 'Elevator Maintenance', licenseNumber: 'ETC-26188', accreditingBody: 'Vertical Transport Skills Commission', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-11-trade-certification/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'trade-certification', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_TRAINING_CERTIFICATES: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-ETR-001', description: 'Lockout-tagout training certificate',
    strippedText: 'Factory Safety Learning Center confirms [LEARNER_REDACTED] completed Advanced Lockout and Tagout on January 13, 2026. Training certificate ETR-26010 documents an eight-hour practical course. Industrial Safety Education Council recognizes the curriculum for Ohio jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Factory Safety Learning Center', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-01-13', fieldOfStudy: 'Advanced Lockout and Tagout', licenseNumber: 'ETR-26010', accreditingBody: 'Industrial Safety Education Council', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/lockout-tagout', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-002', description: 'Research privacy training certificate',
    strippedText: 'Clinical Data Stewardship Academy records [LEARNER_REDACTED] as finishing Privacy Controls for Human-Subjects Research. Program ETR-26027 concluded February 11, 2026 after six instructional hours. Research Compliance Training Board endorses the curriculum in Massachusetts.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Clinical Data Stewardship Academy', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-02-11', fieldOfStudy: 'Privacy Controls for Human-Subjects Research', licenseNumber: 'ETR-26027', accreditingBody: 'Research Compliance Training Board', jurisdiction: 'Massachusetts', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/research-privacy', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-003', description: 'Forklift stability training certificate',
    strippedText: 'Warehouse Mobility Training Cooperative issues ETR-26043 to [LEARNER_REDACTED] for Counterbalanced Forklift Stability. The supervised training ended March 12, 2026 and lasted ten hours. Material Handling Education Alliance recognizes the course within Indiana jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Warehouse Mobility Training Cooperative', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-03-12', fieldOfStudy: 'Counterbalanced Forklift Stability', licenseNumber: 'ETR-26043', accreditingBody: 'Material Handling Education Alliance', jurisdiction: 'Indiana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/forklift-stability', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-004', description: 'Laboratory spill response training certificate',
    strippedText: 'Great Basin Laboratory Safety Institute certifies [LEARNER_REDACTED] for Chemical Spill Isolation and Reporting. Twelve-hour training ETR-26059 finished April 9, 2026. Laboratory Risk Instruction Commission approves the course for Nevada jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Great Basin Laboratory Safety Institute', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-04-09', fieldOfStudy: 'Chemical Spill Isolation and Reporting', licenseNumber: 'ETR-26059', accreditingBody: 'Laboratory Risk Instruction Commission', jurisdiction: 'Nevada', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/laboratory-spill-response', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-005', description: 'Incident command training certificate',
    strippedText: 'Regional Emergency Coordination School recognizes [LEARNER_REDACTED] for completing Unified Incident Command Fundamentals. Certificate ETR-26075 marks May 14, 2026 and a sixteen-hour blended course. Public Safety Training Accreditation Forum endorses it in North Carolina.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Regional Emergency Coordination School', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-05-14', fieldOfStudy: 'Unified Incident Command Fundamentals', licenseNumber: 'ETR-26075', accreditingBody: 'Public Safety Training Accreditation Forum', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/incident-command', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-006', description: 'Cold-chain sanitation training certificate',
    strippedText: 'Food Transport Hygiene Center awards [LEARNER_REDACTED] training certificate ETR-26090 in Refrigerated Cargo Sanitation. The seven-hour session completed June 11, 2026. Supply Chain Food Safety Council recognizes the instruction across Wisconsin jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Food Transport Hygiene Center', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-06-11', fieldOfStudy: 'Refrigerated Cargo Sanitation', licenseNumber: 'ETR-26090', accreditingBody: 'Supply Chain Food Safety Council', jurisdiction: 'Wisconsin', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/cold-chain-sanitation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-007', description: 'Confined-space rescue training certificate',
    strippedText: 'Appalachian Rescue Instruction Group documents [LEARNER_REDACTED] in Permit-Required Confined Space Rescue. Practical course ETR-26106 ended July 9, 2026 after twenty hours. Occupational Rescue Training Council accredits the West Virginia program.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Appalachian Rescue Instruction Group', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-07-09', fieldOfStudy: 'Permit-Required Confined Space Rescue', licenseNumber: 'ETR-26106', accreditingBody: 'Occupational Rescue Training Council', jurisdiction: 'West Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/confined-space-rescue', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-008', description: 'Accessible document training certificate',
    strippedText: 'Inclusive Publishing Learning Lab confirms [LEARNER_REDACTED] completed Accessible Structured Documents on August 13, 2026. Training record ETR-26122 covers nine instructional hours. Digital Inclusion Education Standards Board recognizes the Washington course.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Inclusive Publishing Learning Lab', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-08-13', fieldOfStudy: 'Accessible Structured Documents', licenseNumber: 'ETR-26122', accreditingBody: 'Digital Inclusion Education Standards Board', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/accessible-documents', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-009', description: 'OCR-degraded training certificate',
    strippedText: 'C0ASTAL ST0RM READlNESS ACADEMY records [LEARNER_REDACTED] for Emergency Pump Deployment. OCR changes the provider heading only. Eight-hour program ETR-26137 concluded September 10, 2026; Municipal Preparedness Training Board; Florida jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Coastal Storm Readiness Academy', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-09-10', fieldOfStudy: 'Emergency Pump Deployment', licenseNumber: 'ETR-26137', accreditingBody: 'Municipal Preparedness Training Board', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-010', description: 'Training certificate with two course identifiers',
    strippedText: 'Course SAFE-214 is a prerequisite, not the completed class. [LEARNER_REDACTED] finished Overhead Crane Signal Coordination as ETR-26153 on October 8, 2026. Ten-hour training by River City Lift School; Heavy Equipment Instruction Council; Missouri jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'River City Lift School', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-10-08', fieldOfStudy: 'Overhead Crane Signal Coordination', licenseNumber: 'ETR-26153', accreditingBody: 'Heavy Equipment Instruction Council', jurisdiction: 'Missouri', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-011', description: 'Training certificate with enrollment-date trap',
    strippedText: 'Enrollment occurred October 20, 2026, while successful training completion occurred November 12, 2026. [LEARNER_REDACTED] receives ETR-26169 for Hazardous Battery Handling from Mountain Energy Safety School. Storage Safety Curriculum Council; Colorado jurisdiction; six hours.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Mountain Energy Safety School', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-11-12', fieldOfStudy: 'Hazardous Battery Handling', licenseNumber: 'ETR-26169', accreditingBody: 'Storage Safety Curriculum Council', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ETR-012', description: 'Training record mislabeled general completion',
    strippedText: 'GENERAL COMPLETION CERTIFICATE appears on the archive tile, but the source identifies structured employee training. Lakeshore Cyber Practice Center issues [LEARNER_REDACTED] ETR-26185 for Phishing Incident Triage on December 10, 2026. Cyber Workforce Instruction Board; Illinois; twelve hours.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'training_certificate', issuerName: 'Lakeshore Cyber Practice Center', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-12-10', fieldOfStudy: 'Phishing Incident Triage', licenseNumber: 'ETR-26185', accreditingBody: 'Cyber Workforce Instruction Board', jurisdiction: 'Illinois', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-12-training-certificate/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'instruction-certificate', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_COMPLETION_CERTIFICATES: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-ECC-001', description: 'Community mediation program completion',
    strippedText: 'Civic Resolution Learning Institute awards [PARTICIPANT_REDACTED] a certificate of completion for the Community Mediation Practicum. Program ECC-26008 concluded January 20, 2026 after a twelve-week sequence. Community Education Quality Council recognizes the noncredit program in Maryland.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Civic Resolution Learning Institute', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-01-20', fieldOfStudy: 'Community Mediation Practicum', licenseNumber: 'ECC-26008', accreditingBody: 'Community Education Quality Council', jurisdiction: 'Maryland', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/community-mediation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-002', description: 'Archival preservation program completion',
    strippedText: 'Northern Collections Institute recognizes [PARTICIPANT_REDACTED] for completing Foundations of Archival Preservation. Completion record ECC-26024 is dated February 24, 2026 and represents a ten-week noncredit program. Cultural Heritage Education Board recognizes the offering in Minnesota.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Northern Collections Institute', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-02-24', fieldOfStudy: 'Foundations of Archival Preservation', licenseNumber: 'ECC-26024', accreditingBody: 'Cultural Heritage Education Board', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/archival-preservation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-003', description: 'Public leadership program completion',
    strippedText: 'Capitol Civic Leadership Forum grants [PARTICIPANT_REDACTED] completion certificate ECC-26040 for Local Government Leadership. The cohort ended March 24, 2026 after fourteen weeks. Public Administration Learning Commission endorses the program for District of Columbia jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Capitol Civic Leadership Forum', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-03-24', fieldOfStudy: 'Local Government Leadership', licenseNumber: 'ECC-26040', accreditingBody: 'Public Administration Learning Commission', jurisdiction: 'District of Columbia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/public-leadership', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-004', description: 'Urban forestry program completion',
    strippedText: 'Great Lakes Urban Ecology School presents [PARTICIPANT_REDACTED] with ECC-26056 after completion of Community Urban Forestry. The semester-length noncredit sequence ended April 21, 2026. Environmental Extension Education Council recognizes it within Michigan jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Great Lakes Urban Ecology School', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-04-21', fieldOfStudy: 'Community Urban Forestry', licenseNumber: 'ECC-26056', accreditingBody: 'Environmental Extension Education Council', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/urban-forestry', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-005', description: 'Data ethics program completion',
    strippedText: 'Responsible Data Practice Institute issues [PARTICIPANT_REDACTED] certificate ECC-26072 for completing Applied Data Ethics. The eight-week educational series closed May 19, 2026. Technology Continuing Studies Review Board recognizes the noncredit curriculum in Massachusetts.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Responsible Data Practice Institute', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-05-19', fieldOfStudy: 'Applied Data Ethics', licenseNumber: 'ECC-26072', accreditingBody: 'Technology Continuing Studies Review Board', jurisdiction: 'Massachusetts', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/data-ethics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-006', description: 'Restorative justice program completion',
    strippedText: 'Mountain Community Justice Center records [PARTICIPANT_REDACTED] as completing Restorative Conference Facilitation. ECC-26087 bears a June 23, 2026 completion date for the eleven-week series. Civic Learning Accreditation Network recognizes the Colorado program.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Mountain Community Justice Center', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-06-23', fieldOfStudy: 'Restorative Conference Facilitation', licenseNumber: 'ECC-26087', accreditingBody: 'Civic Learning Accreditation Network', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/restorative-justice', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-007', description: 'Watershed stewardship program completion',
    strippedText: 'River Basin Extension College certifies [PARTICIPANT_REDACTED] completed Watershed Stewardship Planning. Noncredit sequence ECC-26103 concluded July 21, 2026 over nine weeks. Natural Resources Extension Standards Council approves the educational program in Oregon.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'River Basin Extension College', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-07-21', fieldOfStudy: 'Watershed Stewardship Planning', licenseNumber: 'ECC-26103', accreditingBody: 'Natural Resources Extension Standards Council', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/watershed-stewardship', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-008', description: 'Community interpreting program completion',
    strippedText: 'Coastal Language Access School awards [PARTICIPANT_REDACTED] ECC-26119 for Community Interpreting Foundations. The twelve-week program reached completion August 18, 2026. Language Access Education Quality Council recognizes the Maine noncredit offering.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Coastal Language Access School', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-08-18', fieldOfStudy: 'Community Interpreting Foundations', licenseNumber: 'ECC-26119', accreditingBody: 'Language Access Education Quality Council', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/community-interpreting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-009', description: 'OCR-degraded completion certificate',
    strippedText: 'PALMETT0 F00D SYSTEMS lNSTlTUTE awards [PARTICIPANT_REDACTED] ECC-26134 for Regional Food Systems Planning. OCR changes the school heading only. Ten-week sequence completed September 22, 2026; Community Extension Review Council; South Carolina jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Palmetto Food Systems Institute', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-09-22', fieldOfStudy: 'Regional Food Systems Planning', licenseNumber: 'ECC-26134', accreditingBody: 'Community Extension Review Council', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-010', description: 'Completion certificate with module-number decoy',
    strippedText: 'Module CERT-311 is one component and not the final certificate identifier. Seaboard Planning Academy grants [PARTICIPANT_REDACTED] ECC-26150 for complete Coastal Land-Use Mediation on October 20, 2026. Planning Education Standards Forum; North Carolina jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Seaboard Planning Academy', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-10-20', fieldOfStudy: 'Coastal Land-Use Mediation', licenseNumber: 'ECC-26150', accreditingBody: 'Planning Education Standards Forum', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-011', description: 'Completion certificate with program-start trap',
    strippedText: 'The learning sequence began September 8, 2026, but completion occurred November 17, 2026. [PARTICIPANT_REDACTED] receives ECC-26166 in Cooperative Housing Governance from Lakeside Civic Studies Center. Adult Community Learning Commission; Wisconsin jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Lakeside Civic Studies Center', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-11-17', fieldOfStudy: 'Cooperative Housing Governance', licenseNumber: 'ECC-26166', accreditingBody: 'Adult Community Learning Commission', jurisdiction: 'Wisconsin', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-ECC-012', description: 'Completion certificate under workforce-training label',
    strippedText: 'WORKFORCE TRAINING labels the portal category, yet the source is a noncredit program completion award. Desert Public History College grants [PARTICIPANT_REDACTED] ECC-26182 for Oral History Curation on December 15, 2026. Public Humanities Education Board; Arizona jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Desert Public History College', recipientIdentifier: '[PARTICIPANT_REDACTED]', issuedDate: '2026-12-15', fieldOfStudy: 'Oral History Curation', licenseNumber: 'ECC-26182', accreditingBody: 'Public Humanities Education Board', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-13-completion-certificate/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'completion-certificate', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_ACCREDITATIONS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EAC-001', description: 'Institutional accreditation for regional college',
    strippedText: 'Midland Collegiate Quality Commission grants institutional accreditation EAC-26006 to [INSTITUTION_REDACTED]. The status begins January 12, 2026 and continues through January 31, 2031. Scope is Comprehensive Postsecondary Institution in Kansas; National Higher Education Recognition Council recognizes the accreditor.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'institutional', issuerName: 'Midland Collegiate Quality Commission', recipientIdentifier: '[INSTITUTION_REDACTED]', issuedDate: '2026-01-12', expiryDate: '2031-01-31', fieldOfStudy: 'Comprehensive Postsecondary Institution', licenseNumber: 'EAC-26006', accreditingBody: 'National Higher Education Recognition Council', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/institutional-college', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'institutional', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-002', description: 'Programmatic accreditation for nursing program',
    strippedText: 'Council for Applied Nursing Education accredits [PROGRAM_REDACTED] under program identifier EAC-26022. The programmatic term runs February 16, 2026 through February 28, 2031 for Associate Nursing Education in Ohio. Allied Health Accreditor Recognition Board recognizes the council.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'programmatic', issuerName: 'Council for Applied Nursing Education', recipientIdentifier: '[PROGRAM_REDACTED]', issuedDate: '2026-02-16', expiryDate: '2031-02-28', fieldOfStudy: 'Associate Nursing Education', licenseNumber: 'EAC-26022', accreditingBody: 'Allied Health Accreditor Recognition Board', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/nursing-program', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'programmatic', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-003', description: 'Institutional accreditation for technical institute',
    strippedText: 'Technical Institute Standards Association awards [INSTITUTION_REDACTED] institutional status EAC-26038 from March 16, 2026 to March 31, 2032. The accredited scope is Career and Technical Education in Wisconsin. National Vocational Quality Recognition Forum recognizes the association.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'institutional', issuerName: 'Technical Institute Standards Association', recipientIdentifier: '[INSTITUTION_REDACTED]', issuedDate: '2026-03-16', expiryDate: '2032-03-31', fieldOfStudy: 'Career and Technical Education Institution', licenseNumber: 'EAC-26038', accreditingBody: 'National Vocational Quality Recognition Forum', jurisdiction: 'Wisconsin', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/institutional-technical', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'institutional', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-004', description: 'Programmatic accreditation for planning curriculum',
    strippedText: 'Urban Planning Education Review Council approves [PROGRAM_REDACTED] as a programmatically accredited curriculum. EAC-26054 is effective April 13, 2026 through April 30, 2031 for Graduate Urban Planning in Oregon. Professional Curriculum Recognition Assembly recognizes the council.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'programmatic', issuerName: 'Urban Planning Education Review Council', recipientIdentifier: '[PROGRAM_REDACTED]', issuedDate: '2026-04-13', expiryDate: '2031-04-30', fieldOfStudy: 'Graduate Urban Planning', licenseNumber: 'EAC-26054', accreditingBody: 'Professional Curriculum Recognition Assembly', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/urban-planning-program', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'programmatic', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-005', description: 'Institutional accreditation for distance university',
    strippedText: 'Distance Learning Institutional Commission confers EAC-26070 on [INSTITUTION_REDACTED]. Institution-wide accreditation begins May 18, 2026 and expires May 31, 2031 for Online Higher Education in Arizona. Federal Distance Education Recognition Council recognizes the commission.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'institutional', issuerName: 'Distance Learning Institutional Commission', recipientIdentifier: '[INSTITUTION_REDACTED]', issuedDate: '2026-05-18', expiryDate: '2031-05-31', fieldOfStudy: 'Online Higher Education Institution', licenseNumber: 'EAC-26070', accreditingBody: 'Federal Distance Education Recognition Council', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/institutional-distance', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'institutional', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-006', description: 'Programmatic accreditation for cybersecurity degree',
    strippedText: 'Computing Assurance Program Council grants programmatic accreditation EAC-26085 to [PROGRAM_REDACTED]. The Cybersecurity Bachelor Curriculum term spans June 15, 2026 through June 30, 2032 in Virginia. Technology Education Accreditor Recognition Board recognizes the council.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'programmatic', issuerName: 'Computing Assurance Program Council', recipientIdentifier: '[PROGRAM_REDACTED]', issuedDate: '2026-06-15', expiryDate: '2032-06-30', fieldOfStudy: 'Cybersecurity Bachelor Curriculum', licenseNumber: 'EAC-26085', accreditingBody: 'Technology Education Accreditor Recognition Board', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/cybersecurity-program', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'programmatic', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-007', description: 'Institutional accreditation for community college',
    strippedText: 'Atlantic Community College Review Board accredits [INSTITUTION_REDACTED] at the institutional level under EAC-26101. Status runs July 13, 2026 through July 31, 2031 for Comprehensive Two-Year Education in Maine. Postsecondary Recognition Coordination Council recognizes the board.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'institutional', issuerName: 'Atlantic Community College Review Board', recipientIdentifier: '[INSTITUTION_REDACTED]', issuedDate: '2026-07-13', expiryDate: '2031-07-31', fieldOfStudy: 'Comprehensive Two-Year Education', licenseNumber: 'EAC-26101', accreditingBody: 'Postsecondary Recognition Coordination Council', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/institutional-community-college', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'institutional', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-008', description: 'Programmatic accreditation for environmental engineering',
    strippedText: 'Engineering Curriculum Quality Alliance accredits [PROGRAM_REDACTED] in Environmental Engineering. Program status EAC-26117 begins August 17, 2026 and ends August 31, 2032 in Colorado. National Engineering Accreditor Recognition Panel recognizes the alliance.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'programmatic', issuerName: 'Engineering Curriculum Quality Alliance', recipientIdentifier: '[PROGRAM_REDACTED]', issuedDate: '2026-08-17', expiryDate: '2032-08-31', fieldOfStudy: 'Environmental Engineering Program', licenseNumber: 'EAC-26117', accreditingBody: 'National Engineering Accreditor Recognition Panel', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/environmental-engineering-program', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'programmatic', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-009', description: 'OCR-degraded institutional accreditation record',
    strippedText: 'N0RTHERN lNSTlTUTl0NAL QUALlTY B0ARD grants [INSTITUTION_REDACTED] EAC-26132. OCR affects the authority heading only. Institutional status covers Comprehensive Liberal Arts Education in Minnesota from September 14, 2026 through September 30, 2031; National Collegiate Recognition Council recognizes the board.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'institutional', issuerName: 'Northern Institutional Quality Board', recipientIdentifier: '[INSTITUTION_REDACTED]', issuedDate: '2026-09-14', expiryDate: '2031-09-30', fieldOfStudy: 'Comprehensive Liberal Arts Education', licenseNumber: 'EAC-26132', accreditingBody: 'National Collegiate Recognition Council', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'institutional', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-010', description: 'Programmatic accreditation with candidacy decoy',
    strippedText: 'Candidate file CAN-418 appears in the history but is superseded. Behavioral Health Education Council grants full programmatic accreditation EAC-26148 to [PROGRAM_REDACTED] on October 19, 2026 through October 31, 2031. Clinical Counseling Curriculum; Tennessee; Health Programs Recognition Assembly.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'programmatic', issuerName: 'Behavioral Health Education Council', recipientIdentifier: '[PROGRAM_REDACTED]', issuedDate: '2026-10-19', expiryDate: '2031-10-31', fieldOfStudy: 'Clinical Counseling Curriculum', licenseNumber: 'EAC-26148', accreditingBody: 'Health Programs Recognition Assembly', jurisdiction: 'Tennessee', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'programmatic', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-011', description: 'Institutional accreditation with visit-date trap',
    strippedText: 'The review team visited October 12, 2026, but accreditation issuance occurred November 16, 2026. Southern Postsecondary Standards Council grants [INSTITUTION_REDACTED] EAC-26164 through November 30, 2031. Comprehensive Private College; Georgia; National Institution Recognition Forum.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'institutional', issuerName: 'Southern Postsecondary Standards Council', recipientIdentifier: '[INSTITUTION_REDACTED]', issuedDate: '2026-11-16', expiryDate: '2031-11-30', fieldOfStudy: 'Comprehensive Private College', licenseNumber: 'EAC-26164', accreditingBody: 'National Institution Recognition Forum', jurisdiction: 'Georgia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'institutional', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EAC-012', description: 'Programmatic accreditation under institutional label',
    strippedText: 'INSTITUTIONAL ACCREDITATION is the portal category, although the signed decision covers only one curriculum. Renewable Energy Education Board grants [PROGRAM_REDACTED] programmatic EAC-26180 on December 14, 2026 through December 31, 2032. Solar Systems Technology; Arizona; Applied Energy Recognition Council.',
    credentialTypeHint: 'ACCREDITATION', groundTruth: { credentialType: 'ACCREDITATION', subType: 'programmatic', issuerName: 'Renewable Energy Education Board', recipientIdentifier: '[PROGRAM_REDACTED]', issuedDate: '2026-12-14', expiryDate: '2032-12-31', fieldOfStudy: 'Solar Systems Technology Program', licenseNumber: 'EAC-26180', accreditingBody: 'Applied Energy Recognition Council', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-14-accreditation/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'accreditation', 'programmatic', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_MICROCREDENTIALS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EMB-001', description: 'Microcredential in geospatial field mapping',
    strippedText: 'Redwood Extension University awards [LEARNER_REDACTED] the Geospatial Field Mapping microcredential on January 9, 2026. The digital badge reflects a four-credit short course and has a validity endpoint of January 31, 2029. Western Extension Learning Consortium recognizes the award in California.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Redwood Extension University', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-01-09', expiryDate: '2029-01-31', fieldOfStudy: 'Geospatial Field Mapping', accreditingBody: 'Western Extension Learning Consortium', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/geospatial-mapping', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-002', description: 'Microcredential in nonprofit budgeting',
    strippedText: 'Lakeview School of Continuing Studies grants [LEARNER_REDACTED] a Nonprofit Budgeting microcredential dated February 13, 2026. The assessed educational badge carries three academic credits and expires February 28, 2029. Great Lakes Microlearning Council recognizes it in Michigan.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Lakeview School of Continuing Studies', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-02-13', expiryDate: '2029-02-28', fieldOfStudy: 'Nonprofit Budgeting', accreditingBody: 'Great Lakes Microlearning Council', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/nonprofit-budgeting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-003', description: 'Microcredential in clinical data stewardship',
    strippedText: 'Prairie Health Sciences College recognizes [LEARNER_REDACTED] with the Clinical Data Stewardship microcredential. Issued March 13, 2026, the two-credit badge is current until March 31, 2029. Midwest Digital Credential Quality Board recognizes the Illinois award.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Prairie Health Sciences College', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-03-13', expiryDate: '2029-03-31', fieldOfStudy: 'Clinical Data Stewardship', accreditingBody: 'Midwest Digital Credential Quality Board', jurisdiction: 'Illinois', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/clinical-data-stewardship', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-004', description: 'Microcredential in climate risk communication',
    strippedText: 'Atlantic Coastal University issues [LEARNER_REDACTED] a Climate Risk Communication microcredential on April 10, 2026. The competency-based badge represents four academic credits and expires April 30, 2029. Coastal Higher Learning Badge Council recognizes it in North Carolina.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Atlantic Coastal University', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-04-10', expiryDate: '2029-04-30', fieldOfStudy: 'Climate Risk Communication', accreditingBody: 'Coastal Higher Learning Badge Council', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/climate-risk-communication', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-005', description: 'Microcredential in industrial energy auditing',
    strippedText: 'Mountain Polytechnic Extension awards [LEARNER_REDACTED] the Industrial Energy Auditing microcredential. The three-credit educational badge began May 15, 2026 and renews after May 31, 2029. Rocky Mountain Short-Course Recognition Forum recognizes the Colorado credential.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Mountain Polytechnic Extension', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-05-15', expiryDate: '2029-05-31', fieldOfStudy: 'Industrial Energy Auditing', accreditingBody: 'Rocky Mountain Short-Course Recognition Forum', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/energy-auditing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-006', description: 'Microcredential in accessible course design',
    strippedText: 'Cascadia College of Education confers [LEARNER_REDACTED] an Accessible Course Design microcredential on June 12, 2026. The badge verifies a two-credit assessed module and expires June 30, 2029. Northwest Academic Microcredential Council recognizes it in Washington.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Cascadia College of Education', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-06-12', expiryDate: '2029-06-30', fieldOfStudy: 'Accessible Course Design', accreditingBody: 'Northwest Academic Microcredential Council', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/accessible-course-design', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-007', description: 'Microcredential in public procurement analytics',
    strippedText: 'Commonwealth Public Service University grants [LEARNER_REDACTED] the Public Procurement Analytics microcredential. The four-credit digital award is dated July 10, 2026 and runs through July 31, 2029. Public Administration Microlearning Alliance recognizes it in Virginia.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Commonwealth Public Service University', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-07-10', expiryDate: '2029-07-31', fieldOfStudy: 'Public Procurement Analytics', accreditingBody: 'Public Administration Microlearning Alliance', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/public-procurement', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-008', description: 'Microcredential in watershed sensor analysis',
    strippedText: 'Pine River Environmental College issues [LEARNER_REDACTED] an assessed microcredential in Watershed Sensor Analysis on August 14, 2026. The three-credit badge remains current through August 31, 2029. Environmental Extension Credential Council recognizes the Oregon award.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Pine River Environmental College', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-08-14', expiryDate: '2029-08-31', fieldOfStudy: 'Watershed Sensor Analysis', accreditingBody: 'Environmental Extension Credential Council', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/watershed-sensors', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-009', description: 'OCR-degraded educational microcredential',
    strippedText: 'GULF URBAN STUDlES C0LLEGE awards [LEARNER_REDACTED] a Transit Equity Mapping microcredential. OCR changes the institution heading only. The two-credit badge issued September 11, 2026 expires September 30, 2029; Southern Academic Badge Review Council; Florida jurisdiction.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Gulf Urban Studies College', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-09-11', expiryDate: '2029-09-30', fieldOfStudy: 'Transit Equity Mapping', accreditingBody: 'Southern Academic Badge Review Council', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-010', description: 'Microcredential with course-section decoy',
    strippedText: 'Section identifier SEC-441 appears beside the transcript link but is not a credential ID. Great Plains Agriculture College awards [LEARNER_REDACTED] a Soil Carbon Measurement microcredential on October 9, 2026 through October 31, 2029. Agricultural Microlearning Standards Board; Iowa; three credits.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Great Plains Agriculture College', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-10-09', expiryDate: '2029-10-31', fieldOfStudy: 'Soil Carbon Measurement', accreditingBody: 'Agricultural Microlearning Standards Board', jurisdiction: 'Iowa', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-011', description: 'Microcredential with assessment-date trap',
    strippedText: 'Final assessment occurred October 28, 2026, but the microcredential was not issued until November 13, 2026. Harbor Digital Humanities Institute awards [LEARNER_REDACTED] a Community Archive Metadata badge through November 30, 2029. Cultural Microcredential Recognition Network; Maine; two credits.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Harbor Digital Humanities Institute', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-11-13', expiryDate: '2029-11-30', fieldOfStudy: 'Community Archive Metadata', accreditingBody: 'Cultural Microcredential Recognition Network', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EMB-012', description: 'Educational microcredential under vendor badge label',
    strippedText: 'VENDOR SKILL BADGE labels the imported tile, yet the award is credit-bearing and issued by a college. Blue Ridge Applied Learning College grants [LEARNER_REDACTED] the Rural Telehealth Operations microcredential on December 11, 2026 through December 31, 2029. Appalachian Academic Badge Council; Virginia; four credits.',
    credentialTypeHint: 'BADGE', groundTruth: { credentialType: 'BADGE', subType: 'educational_microcredential', issuerName: 'Blue Ridge Applied Learning College', recipientIdentifier: '[LEARNER_REDACTED]', issuedDate: '2026-12-11', expiryDate: '2029-12-31', fieldOfStudy: 'Rural Telehealth Operations', accreditingBody: 'Appalachian Academic Badge Council', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-11-15/education-15-microcredential/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'microcredential', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

export const S33_WAVE2_TOP15_11_15_HELDOUT: S33HeldoutEntry[] = [
  ...LEGAL_GENERAL_CLE,
  ...LEGAL_ETHICS_CLE,
  ...LEGAL_SPECIALIZED_CLE,
  ...LEGAL_UTILITY_PATENTS,
  ...LEGAL_REGULATORY_INSTRUMENTS,
  ...FINANCIAL_SEC_10Q_FILINGS,
  ...FINANCIAL_SEC_8K_FILINGS,
  ...FINANCIAL_SEC_DEF14A_FILINGS,
  ...FINANCIAL_FINRA_BROKERS,
  ...FINANCIAL_INVESTMENT_ADVISERS,
  ...EDUCATION_TRADE_CERTIFICATIONS,
  ...EDUCATION_TRAINING_CERTIFICATES,
  ...EDUCATION_COMPLETION_CERTIFICATES,
  ...EDUCATION_ACCREDITATIONS,
  ...EDUCATION_MICROCREDENTIALS,
];
