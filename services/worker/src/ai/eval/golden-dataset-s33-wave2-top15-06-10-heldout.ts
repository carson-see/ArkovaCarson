/**
 * S3.3 Wave 3 top-15 held-out tranche 06-10.
 *
 * Every row is independently authored literal data. Nothing in this file is
 * generated, imported into training, or accepted by its mere presence.
 */

import type { S33HeldoutEntry } from './golden-dataset-s33-types.js';

const LEGAL_COURT_ORDERS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LOR-001', description: 'District court preliminary-injunction order',
    strippedText: 'NORTHSTAR DISTRICT COURT. Order LCO-26017 grants a preliminary injunction to [PARTIES_REDACTED] concerning shoreline access. Judge Mara Ellison entered relief on January 14, 2026. The clerk records Minnesota as the controlling jurisdiction and Civil Equity as the matter classification.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Northstar District Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-01-14', fieldOfStudy: 'Preliminary Injunction', licenseNumber: 'LCO-26017', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/preliminary-injunction', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-002', description: 'Superior court discovery-protection order',
    strippedText: 'CASCADIA COUNTY SUPERIOR COURT places confidential engineering exhibits under protection in matter LCO-26031. The directive applies to [PARTIES_REDACTED] and was signed February 6, 2026. Court administration identifies Washington venue and Discovery Protection as the proceeding subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Cascadia County Superior Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-02-06', fieldOfStudy: 'Discovery Protection', licenseNumber: 'LCO-26031', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/discovery-protection', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-003', description: 'Probate court estate-distribution order',
    strippedText: 'GREAT BASIN PROBATE COURT authorizes final estate distribution for [PARTIES_REDACTED] under docket LCO-26048. Entry occurred March 11, 2026 after inventory approval. The probate registry lists Nevada jurisdiction and Final Estate Distribution as the adjudicated subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Great Basin Probate Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-03-11', fieldOfStudy: 'Final Estate Distribution', licenseNumber: 'LCO-26048', jurisdiction: 'Nevada', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/estate-distribution', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-004', description: 'Circuit court restitution-payment order',
    strippedText: 'BLUE RIDGE CIRCUIT COURT directs restitution payments in criminal matter LCO-26062 to the protected recipient [PARTIES_REDACTED]. The judicial officer entered the mandate April 9, 2026. Virginia is printed as jurisdiction; Restitution Schedule is the case subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Blue Ridge Circuit Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-04-09', fieldOfStudy: 'Restitution Schedule', licenseNumber: 'LCO-26062', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/restitution-schedule', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-005', description: 'Commercial division receivership order',
    strippedText: 'HUDSON MERCANTILE DIVISION appoints a limited receiver over specified warehouse assets belonging to [PARTIES_REDACTED]. Order LCO-26079 bears an entry date of May 18, 2026. New York jurisdiction and Limited Receivership appear in the authenticated docket header.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Hudson Mercantile Division', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-05-18', fieldOfStudy: 'Limited Receivership', licenseNumber: 'LCO-26079', jurisdiction: 'New York', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/limited-receivership', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-006', description: 'Family court support-modification order',
    strippedText: 'PRAIRIE FAMILY COURT modifies monthly support obligations for [PARTIES_REDACTED] in file LCO-26093. The modification was judicially entered June 23, 2026. Court records designate Kansas as jurisdiction and Support Modification as the ordered issue.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Prairie Family Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-06-23', fieldOfStudy: 'Support Modification', licenseNumber: 'LCO-26093', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/support-modification', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-007', description: 'Environmental court remediation order',
    strippedText: 'LAKE ERIE ENVIRONMENTAL COURT requires phased soil remediation by [PARTIES_REDACTED] through case LCO-26108. The signed entry is dated July 7, 2026. Ohio jurisdiction and Industrial Site Remediation are stated beside the court seal.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Lake Erie Environmental Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-07-07', fieldOfStudy: 'Industrial Site Remediation', licenseNumber: 'LCO-26108', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/site-remediation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-008', description: 'Bankruptcy court cash-collateral order',
    strippedText: 'SUN COAST BANKRUPTCY COURT permits restricted cash-collateral use by [PARTIES_REDACTED] in proceeding LCO-26124. Authorization was entered August 15, 2026. Florida jurisdiction and Interim Cash Collateral are recorded in the electronic docket caption.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Sun Coast Bankruptcy Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-08-15', fieldOfStudy: 'Interim Cash Collateral', licenseNumber: 'LCO-26124', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/cash-collateral', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-009', description: 'OCR-degraded appellate remand order',
    strippedText: 'APPELLATE C0URT 0F RED RlVER. LCO-26139 remands the valuation dispute involving [PARTIES_REDACTED]. Entry date: September 4, 2026. OCR swapped letters in the masthead only; Louisiana and Valuation Remand remain legible in the clerk index.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Appellate Court of Red River', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-09-04', fieldOfStudy: 'Valuation Remand', licenseNumber: 'LCO-26139', jurisdiction: 'Louisiana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-010', description: 'Order with hearing-date decoy',
    strippedText: 'PINE SOUND CHANCERY COURT resolves easement scope for [PARTIES_REDACTED] under LCO-26155. The operative order was entered October 19, 2026; the November 2 compliance hearing is not the issuance date. Maine jurisdiction and Easement Scope identify the ruling.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Pine Sound Chancery Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-10-19', fieldOfStudy: 'Easement Scope', licenseNumber: 'LCO-26155', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-011', description: 'Order with superseded minute-sheet identifier',
    strippedText: 'HIGH DESERT TAX COURT issues property-classification relief to [PARTIES_REDACTED]. Final order number LCO-26171 was entered November 12, 2026 in Utah. A margin note cites obsolete minute sheet MS-441; Property Classification is the controlling case subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'High Desert Tax Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-11-12', fieldOfStudy: 'Property Classification', licenseNumber: 'LCO-26171', jurisdiction: 'Utah', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LOR-012', description: 'Court order mislabeled as a settlement certificate',
    strippedText: 'SETTLEMENT CERTIFICATE appears above docket LCO-26188, but FOOTHILL CIVIL COURT commands enforcement rather than memorializing a private agreement. [PARTIES_REDACTED] received the judicial entry on December 8, 2026. California jurisdiction; Settlement Enforcement matter.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Foothill Civil Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-12-08', fieldOfStudy: 'Settlement Enforcement', licenseNumber: 'LCO-26188', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-06-court-order/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'court-order', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_CUSTODY_DIVORCE_DECREES: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LCD-001', description: 'Joint-custody dissolution decree',
    strippedText: 'CEDAR COUNTY DOMESTIC RELATIONS COURT dissolves the marriage of [PARTIES_REDACTED] and establishes joint legal custody. Decree LCD-26021 was entered January 22, 2026. Iowa jurisdiction and Parenting Allocation are recorded on the certified family docket.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Cedar County Domestic Relations Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-01-22', fieldOfStudy: 'Parenting Allocation', licenseNumber: 'LCD-26021', jurisdiction: 'Iowa', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/joint-custody', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-002', description: 'Primary-residence divorce decree',
    strippedText: 'SAGEBRUSH FAMILY DIVISION grants dissolution to [PARTIES_REDACTED] and designates a primary residence for the minor dependents. The clerk entered LCD-26037 on February 13, 2026. Idaho is the jurisdiction; Residential Custody is the decree subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Sagebrush Family Division', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-02-13', fieldOfStudy: 'Residential Custody', licenseNumber: 'LCD-26037', jurisdiction: 'Idaho', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/primary-residence', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-003', description: 'Divorce decree with property allocation',
    strippedText: 'OZARK CHANCERY FAMILY COURT enters a final divorce for [PARTIES_REDACTED] and allocates the listed marital property. Instrument LCD-26054 carries a March 17, 2026 judgment date. Arkansas jurisdiction and Equitable Distribution appear in the closing section.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Ozark Chancery Family Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-03-17', fieldOfStudy: 'Equitable Distribution', licenseNumber: 'LCD-26054', jurisdiction: 'Arkansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/property-allocation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-004', description: 'Custody decree assigning school decisions',
    strippedText: 'ALLEGHENY FAMILY BENCH awards shared physical custody to [PARTIES_REDACTED] while assigning educational decisions to one guardian. Decree LCD-26068 was filed April 28, 2026. Pennsylvania jurisdiction and Education Decision Authority identify the adjudicated issue.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Allegheny Family Bench', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-04-28', fieldOfStudy: 'Education Decision Authority', licenseNumber: 'LCD-26068', jurisdiction: 'Pennsylvania', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/education-decisions', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-005', description: 'Dissolution decree retaining pension jurisdiction',
    strippedText: 'PALMETTO DOMESTIC COURT terminates the marriage of [PARTIES_REDACTED] and reserves authority over pension division. Final decree LCD-26085 was signed May 9, 2026. South Carolina and Reserved Retirement Distribution are printed in the judicial certification.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Palmetto Domestic Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-05-09', fieldOfStudy: 'Reserved Retirement Distribution', licenseNumber: 'LCD-26085', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/pension-jurisdiction', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-006', description: 'Long-distance parenting decree',
    strippedText: 'BIG SKY FAMILY COURT approves a long-distance parenting schedule for [PARTIES_REDACTED], including alternating school breaks. The decree bears number LCD-26102 and date June 16, 2026. Montana jurisdiction and Interstate Parenting Schedule define the disposition.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Big Sky Family Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-06-16', fieldOfStudy: 'Interstate Parenting Schedule', licenseNumber: 'LCD-26102', jurisdiction: 'Montana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/interstate-parenting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-007', description: 'Divorce decree approving settlement terms',
    strippedText: 'GREEN MOUNTAIN SUPERIOR FAMILY UNIT incorporates negotiated dissolution terms for [PARTIES_REDACTED] without converting the instrument into a private contract. Judgment LCD-26119 entered July 21, 2026. Vermont jurisdiction; Marital Settlement Incorporation subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Green Mountain Superior Family Unit', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-07-21', fieldOfStudy: 'Marital Settlement Incorporation', licenseNumber: 'LCD-26119', jurisdiction: 'Vermont', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/settlement-incorporation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-008', description: 'Custody decree setting medical authority',
    strippedText: 'RIO GRANDE DISTRICT FAMILY COURT assigns routine medical consent and emergency-notice duties between [PARTIES_REDACTED]. Custody decree LCD-26133 was entered August 27, 2026. New Mexico jurisdiction and Medical Decision Allocation appear in the signed findings.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Rio Grande District Family Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-08-27', fieldOfStudy: 'Medical Decision Allocation', licenseNumber: 'LCD-26133', jurisdiction: 'New Mexico', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/medical-authority', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-009', description: 'OCR-noisy decree for supervised parenting',
    strippedText: 'TIDEWATER D0MESTlC RELATl0NS C0URT enters LCD-26147 for [PARTIES_REDACTED], requiring supervised parenting contact. The clerk date is September 18, 2026. OCR damage affects the court heading; Maryland and Supervised Contact remain intact.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Tidewater Domestic Relations Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-09-18', fieldOfStudy: 'Supervised Contact', licenseNumber: 'LCD-26147', jurisdiction: 'Maryland', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-010', description: 'Decree with mediation-date trap',
    strippedText: 'PEACHTREE FAMILY COURT grants divorce and divides holiday custody for [PARTIES_REDACTED]. LCD-26164 became effective October 24, 2026; September 30 was only mediation. Georgia jurisdiction and Holiday Parenting Allocation are stated on the judgment page.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Peachtree Family Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-10-24', fieldOfStudy: 'Holiday Parenting Allocation', licenseNumber: 'LCD-26164', jurisdiction: 'Georgia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-011', description: 'Decree with obsolete petition number',
    strippedText: 'CUMBERLAND DOMESTIC BENCH enters final custody disposition LCD-26180 for [PARTIES_REDACTED] on November 14, 2026. A scanned cover sheet repeats withdrawn petition P-8802, which is not the decree identifier. Tennessee jurisdiction; Transportation Responsibility subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'Cumberland Domestic Bench', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-11-14', fieldOfStudy: 'Transportation Responsibility', licenseNumber: 'LCD-26180', jurisdiction: 'Tennessee', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LCD-012', description: 'Dissolution decree captioned parenting agreement',
    strippedText: 'PARENTING AGREEMENT is the scan label, yet NORTH COAST DOMESTIC COURT itself orders dissolution and residential custody for [PARTIES_REDACTED]. Judicial decree LCD-26196 was entered December 19, 2026 in Oregon. Residential Schedule is the controlling subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'court_order', issuerName: 'North Coast Domestic Court', recipientIdentifier: '[PARTIES_REDACTED]', issuedDate: '2026-12-19', fieldOfStudy: 'Residential Schedule', licenseNumber: 'LCD-26196', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-07-custody-divorce-decree/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'custody-divorce-decree', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_AFFIDAVITS_DECLARATIONS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LAF-001', description: 'Affidavit of business-record custody',
    strippedText: 'HARBORLIGHT RECORDS OFFICE receives the sworn statement of [DECLARANT_REDACTED] concerning ordinary-course invoice custody. Affidavit LAF-26014 was subscribed January 8, 2026 before an authorized notarial officer. Massachusetts jurisdiction and Business Record Custody identify its purpose.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Harborlight Records Office', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-01-08', fieldOfStudy: 'Business Record Custody', licenseNumber: 'LAF-26014', jurisdiction: 'Massachusetts', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/business-records', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-002', description: 'Residency declaration under penalty of perjury',
    strippedText: 'SILVER CREEK HOUSING COUNSEL files declaration LAF-26029 from [DECLARANT_REDACTED] affirming continuous county residency. The declarant signed under penalty of perjury on February 12, 2026. Colorado is the named jurisdiction; Residency Attestation is the declared subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Silver Creek Housing Counsel', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-02-12', fieldOfStudy: 'Residency Attestation', licenseNumber: 'LAF-26029', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/residency', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-003', description: 'Affidavit describing service of process',
    strippedText: 'MAGNOLIA PROCESS ADMINISTRATION authenticates affidavit LAF-26043 for [DECLARANT_REDACTED], who recounts delivery of sealed pleadings. Oath and signature occurred March 5, 2026. Mississippi jurisdiction and Service of Process appear in the jurat block.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Magnolia Process Administration', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-03-05', fieldOfStudy: 'Service of Process', licenseNumber: 'LAF-26043', jurisdiction: 'Mississippi', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/service-of-process', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-004', description: 'Identity-loss affidavit without exposed identifiers',
    strippedText: 'GREAT PLAINS CONSUMER LAW CENTER records [DECLARANT_REDACTED] as affiant for an identity-loss narrative; all account identifiers are masked. Statement LAF-26057 was sworn April 16, 2026. Nebraska jurisdiction and Identity Misuse Declaration are printed above the notary acknowledgment.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Great Plains Consumer Law Center', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-04-16', fieldOfStudy: 'Identity Misuse Declaration', licenseNumber: 'LAF-26057', jurisdiction: 'Nebraska', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/identity-loss', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-005', description: 'Construction completion affidavit',
    strippedText: 'RED CLAY PROJECT COUNSEL preserves the sworn completion account of [DECLARANT_REDACTED] for a municipal roof project. Affidavit LAF-26072 bears May 20, 2026 as execution date. Alabama jurisdiction and Construction Completion define the statement scope.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Red Clay Project Counsel', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-05-20', fieldOfStudy: 'Construction Completion', licenseNumber: 'LAF-26072', jurisdiction: 'Alabama', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/construction-completion', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-006', description: 'Small-estate heirship affidavit',
    strippedText: 'FRONTIER ESTATE SERVICES accepts heirship affidavit LAF-26086 from [DECLARANT_REDACTED] regarding a qualifying small estate. The oath was completed June 9, 2026. Wyoming jurisdiction and Small Estate Heirship are stated in the certification panel.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Frontier Estate Services', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-06-09', fieldOfStudy: 'Small Estate Heirship', licenseNumber: 'LAF-26086', jurisdiction: 'Wyoming', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/heirship', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-007', description: 'Lost-instrument affidavit',
    strippedText: 'KEYSTONE COMMERCIAL COUNSEL retains declaration LAF-26101 by [DECLARANT_REDACTED], describing diligent search for an original warehouse note. The instrument was sworn July 14, 2026. Pennsylvania jurisdiction and Lost Commercial Instrument identify the legal subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Keystone Commercial Counsel', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-07-14', fieldOfStudy: 'Lost Commercial Instrument', licenseNumber: 'LAF-26101', jurisdiction: 'Pennsylvania', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/lost-instrument', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-008', description: 'Declaration supporting guardianship accounting',
    strippedText: 'DESERT BLOOM FIDUCIARY OFFICE receives declaration LAF-26116 from [DECLARANT_REDACTED] explaining annual guardianship expenditures. Signature under penalty of perjury is dated August 25, 2026. Arizona jurisdiction and Guardianship Accounting are set out in the caption.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Desert Bloom Fiduciary Office', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-08-25', fieldOfStudy: 'Guardianship Accounting', licenseNumber: 'LAF-26116', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/guardianship-accounting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-009', description: 'Affidavit with obscuring notary-stamp noise',
    strippedText: 'CAPE FEAR LAND COUNSEL logs boundary affidavit LAF-26132 from [DECLARANT_REDACTED]. A heavy circular notary stamp crosses two heading letters but leaves the oath date, September 10, 2026, readable. North Carolina jurisdiction; Boundary Observation subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Cape Fear Land Counsel', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-09-10', fieldOfStudy: 'Boundary Observation', licenseNumber: 'LAF-26132', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/stamp-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'edge', 'stamp-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-010', description: 'Affidavit with event-date decoy',
    strippedText: 'BAYOU INSURANCE COUNSEL holds affidavit LAF-26149 from [DECLARANT_REDACTED] about storm inventory observed on August 3. The affidavit itself was executed October 6, 2026, which is the issuance date. Louisiana jurisdiction; Property Inventory subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Bayou Insurance Counsel', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-10-06', fieldOfStudy: 'Property Inventory', licenseNumber: 'LAF-26149', jurisdiction: 'Louisiana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-011', description: 'Affidavit notarized through a separate provider',
    strippedText: 'PUGET MARITIME LAW authored vessel-maintenance affidavit LAF-26165 for [DECLARANT_REDACTED] on November 17, 2026. Rainshadow Mobile Notary administered the oath but did not issue the legal statement. Washington jurisdiction and Vessel Maintenance identify its scope.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Puget Maritime Law', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-11-17', fieldOfStudy: 'Vessel Maintenance', licenseNumber: 'LAF-26165', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LAF-012', description: 'Sworn declaration captioned verification letter',
    strippedText: 'VERIFICATION LETTER heads document LAF-26182, yet [DECLARANT_REDACTED] swears factual statements under penalty of perjury before EVERGREEN PUBLIC INTEREST COUNSEL. Execution occurred December 11, 2026. Oregon jurisdiction and Public Benefit Use define the declaration.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Evergreen Public Interest Counsel', recipientIdentifier: '[DECLARANT_REDACTED]', issuedDate: '2026-12-11', fieldOfStudy: 'Public Benefit Use', licenseNumber: 'LAF-26182', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-08-affidavit-declaration/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'affidavit-declaration', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_POWERS_OF_ATTORNEY: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LPA-001', description: 'Durable financial power of attorney',
    strippedText: 'MAPLE HOLLOW ESTATE COUNSEL prepares durable authority LPA-26012 for [PRINCIPAL_REDACTED], appointing a protected agent for banking and property matters. The principal executed it January 19, 2026. Michigan law governs; Durable Financial Authority is the instrument scope.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Maple Hollow Estate Counsel', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-01-19', fieldOfStudy: 'Durable Financial Authority', licenseNumber: 'LPA-26012', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/durable-financial', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-002', description: 'Limited real-estate power of attorney',
    strippedText: 'CHESAPEAKE TITLE LAW drafts limited delegation LPA-26027 for [PRINCIPAL_REDACTED] covering one recorded parcel closing. Signature and acknowledgment are dated February 18, 2026. Maryland jurisdiction and Limited Real Estate Closing describe the authorized acts.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Chesapeake Title Law', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-02-18', fieldOfStudy: 'Limited Real Estate Closing', licenseNumber: 'LPA-26027', jurisdiction: 'Maryland', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/real-estate-closing', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-003', description: 'Health-care power of attorney',
    strippedText: 'PRAIRIE OAK ELDER LAW records health-care appointment LPA-26041 for [PRINCIPAL_REDACTED], naming an agent for treatment decisions upon incapacity. It was executed March 26, 2026. Illinois jurisdiction and Health Care Decisions appear in the directive heading.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Prairie Oak Elder Law', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-03-26', fieldOfStudy: 'Health Care Decisions', licenseNumber: 'LPA-26041', jurisdiction: 'Illinois', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/health-care', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-004', description: 'Vehicle-transfer power of attorney',
    strippedText: 'COPPER STATE MOBILITY COUNSEL issues special agency instrument LPA-26058 for [PRINCIPAL_REDACTED] to sign a single vehicle-title transfer. Principal and witnesses completed it April 7, 2026. Arizona jurisdiction and Vehicle Title Transfer limit the delegation.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Copper State Mobility Counsel', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-04-07', fieldOfStudy: 'Vehicle Title Transfer', licenseNumber: 'LPA-26058', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/vehicle-transfer', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-005', description: 'Tax-filing power of attorney',
    strippedText: 'TWIN RIVER TAX COUNSEL files authorization LPA-26073 for [PRINCIPAL_REDACTED] allowing representation for specified state returns. The appointment was signed May 12, 2026. Kentucky jurisdiction and State Tax Representation are printed beside the authorization number.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Twin River Tax Counsel', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-05-12', fieldOfStudy: 'State Tax Representation', licenseNumber: 'LPA-26073', jurisdiction: 'Kentucky', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/tax-representation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-006', description: 'Business-operating power of attorney',
    strippedText: 'LOWCOUNTRY COMMERCIAL LAW creates operating delegation LPA-26089 for [PRINCIPAL_REDACTED], authorizing inventory purchases during a defined absence. The instrument took effect June 28, 2026. South Carolina jurisdiction and Temporary Business Operations state its boundaries.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Lowcountry Commercial Law', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-06-28', fieldOfStudy: 'Temporary Business Operations', licenseNumber: 'LPA-26089', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/business-operations', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-007', description: 'Child-care delegation of parental authority',
    strippedText: 'ROCKY FORK FAMILY COUNSEL prepares delegation LPA-26104 for [PRINCIPAL_REDACTED], granting temporary school and routine-care authority to a named adult. Execution occurred July 16, 2026. Tennessee jurisdiction and Temporary Child Care identify the limited purpose.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Rocky Fork Family Counsel', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-07-16', fieldOfStudy: 'Temporary Child Care', licenseNumber: 'LPA-26104', jurisdiction: 'Tennessee', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/child-care', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-008', description: 'Securities-account power of attorney',
    strippedText: 'EMPIRE FIDUCIARY LAW records investment-account authority LPA-26121 for [PRINCIPAL_REDACTED], permitting designated instructions but no beneficiary changes. The principal signed August 20, 2026. New York jurisdiction and Limited Securities Direction define the authorization.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Empire Fiduciary Law', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-08-20', fieldOfStudy: 'Limited Securities Direction', licenseNumber: 'LPA-26121', jurisdiction: 'New York', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/securities-direction', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-009', description: 'OCR-degraded durable authority',
    strippedText: 'N0RTHERN PlNES ESTATE LAW prepares durable property authority LPA-26136 for [PRINCIPAL_REDACTED]. The signed date is September 23, 2026; OCR substitutions affect the firm heading only. Wisconsin jurisdiction and Durable Property Management remain plainly stated.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Northern Pines Estate Law', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-09-23', fieldOfStudy: 'Durable Property Management', licenseNumber: 'LPA-26136', jurisdiction: 'Wisconsin', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-010', description: 'Power of attorney with future-use date trap',
    strippedText: 'GULF MARSH LEGAL SERVICES issues property-management authority LPA-26153 for [PRINCIPAL_REDACTED]. It was executed October 15, 2026; December 1 is merely the anticipated first use. Louisiana jurisdiction and Rental Property Management state the delegated subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Gulf Marsh Legal Services', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-10-15', fieldOfStudy: 'Rental Property Management', licenseNumber: 'LPA-26153', jurisdiction: 'Louisiana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-011', description: 'Authority with unrelated filing receipt number',
    strippedText: 'WHITE PINE RURAL LAW drafts farm-operations agency LPA-26169 for [PRINCIPAL_REDACTED] on November 9, 2026. Receipt R-7748 in the corner tracks scanning fees and is not the instrument number. Maine jurisdiction; Seasonal Farm Operations subject.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'White Pine Rural Law', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-11-09', fieldOfStudy: 'Seasonal Farm Operations', licenseNumber: 'LPA-26169', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LPA-012', description: 'Power of attorney titled agency certificate',
    strippedText: 'AGENCY CERTIFICATE captions LPA-26184, but the clauses grant legal authority from [PRINCIPAL_REDACTED] to an agent for cooperative voting. GLACIER COMMUNITY COUNSEL supervised execution on December 13, 2026. Alaska jurisdiction and Cooperative Voting Authority control classification.',
    credentialTypeHint: 'LEGAL', groundTruth: { credentialType: 'LEGAL', subType: 'affidavit', issuerName: 'Glacier Community Counsel', recipientIdentifier: '[PRINCIPAL_REDACTED]', issuedDate: '2026-12-13', fieldOfStudy: 'Cooperative Voting Authority', licenseNumber: 'LPA-26184', jurisdiction: 'Alaska', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-09-power-of-attorney/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'power-of-attorney', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const LEGAL_BAR_ADMISSIONS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-LBA-001', description: 'General state bar admission certificate',
    strippedText: 'NORTH STAR BOARD OF LAW EXAMINERS certifies [ATTORNEY_REDACTED] for admission to legal practice. Credential LBA-26018 was issued January 27, 2026 and remains active through January 31, 2027. Minnesota Supreme Court is the admitting authority; field is Law.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'North Star Board of Law Examiners', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-01-27', expiryDate: '2027-01-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26018', accreditingBody: 'Minnesota Supreme Court', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/general-admission', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-002', description: 'Admission following transferred score',
    strippedText: 'COLUMBIA BASIN BAR ADMISSIONS OFFICE records [ATTORNEY_REDACTED] as admitted after review of a transferred examination score. Bar number LBA-26034 was granted February 24, 2026, with status through February 28, 2027. Washington Supreme Court authorizes the license.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Columbia Basin Bar Admissions Office', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-02-24', expiryDate: '2027-02-28', fieldOfStudy: 'Law', licenseNumber: 'LBA-26034', accreditingBody: 'Washington Supreme Court', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/transferred-score', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-003', description: 'Bar admission by reciprocity',
    strippedText: 'GREEN MOUNTAIN ATTORNEY LICENSING certifies reciprocal admission for [ATTORNEY_REDACTED]. License LBA-26049 began March 19, 2026 and carries a current-status date of March 31, 2027. Vermont Supreme Court is the admitting body and Law is the licensed field.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Green Mountain Attorney Licensing', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-03-19', expiryDate: '2027-03-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26049', accreditingBody: 'Vermont Supreme Court', jurisdiction: 'Vermont', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/reciprocity', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-004', description: 'Limited in-house counsel admission',
    strippedText: 'PEACH STATE PROFESSIONAL ADMISSIONS registers [ATTORNEY_REDACTED] for limited in-house legal practice. Registration LBA-26063 was issued April 15, 2026 and is valid until April 30, 2027. Georgia Supreme Court supplies authority; licensed discipline is Law.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Peach State Professional Admissions', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-04-15', expiryDate: '2027-04-30', fieldOfStudy: 'Law', licenseNumber: 'LBA-26063', accreditingBody: 'Georgia Supreme Court', jurisdiction: 'Georgia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/in-house-counsel', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-005', description: 'Admission after state examination',
    strippedText: 'BADLANDS LAW EXAMINER COMMISSION enters [ATTORNEY_REDACTED] on the roll of licensed attorneys after successful examination. Number LBA-26078 issued May 22, 2026; current registration extends to May 31, 2027. North Dakota Supreme Court approves the Law credential.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Badlands Law Examiner Commission', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-05-22', expiryDate: '2027-05-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26078', accreditingBody: 'North Dakota Supreme Court', jurisdiction: 'North Dakota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/examination', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-006', description: 'Uniform-score bar admission',
    strippedText: 'MOUNTAIN WEST BAR LICENSING DIVISION admits [ATTORNEY_REDACTED] based on a qualifying uniform score and character review. Bar ID LBA-26094 began June 18, 2026 and remains current through June 30, 2027. Utah Supreme Court authorizes practice of Law.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Mountain West Bar Licensing Division', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-06-18', expiryDate: '2027-06-30', fieldOfStudy: 'Law', licenseNumber: 'LBA-26094', accreditingBody: 'Utah Supreme Court', jurisdiction: 'Utah', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/uniform-score', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-007', description: 'Attorney admission with active annual registration',
    strippedText: 'LAKE SHORE ATTORNEY REGISTRATION enrolls [ATTORNEY_REDACTED] for unrestricted legal practice. Certificate LBA-26109 bears July 29, 2026 and annual standing through July 31, 2027. Wisconsin Supreme Court is the admitting authority; credential field is Law.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Lake Shore Attorney Registration', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-07-29', expiryDate: '2027-07-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26109', accreditingBody: 'Wisconsin Supreme Court', jurisdiction: 'Wisconsin', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/annual-registration', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-008', description: 'Rural practice bar admission',
    strippedText: 'PINE TREE BOARD OF BAR EXAMINERS certifies [ATTORNEY_REDACTED] for general Law practice after oath administration. Admission LBA-26125 was effective August 12, 2026, with active registration until August 31, 2027. Maine Supreme Judicial Court provides the authority.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Pine Tree Board of Bar Examiners', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-08-12', expiryDate: '2027-08-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26125', accreditingBody: 'Maine Supreme Judicial Court', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/rural-practice', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-009', description: 'OCR-degraded bar admission card',
    strippedText: '0CEAN STATE ATT0RNEY LlCENSlNG admits [ATTORNEY_REDACTED] to Law practice under LBA-26140. Issue date September 15, 2026; active through September 30, 2027. OCR affects the agency line only. Rhode Island Supreme Court remains clear.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Ocean State Attorney Licensing', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-09-15', expiryDate: '2027-09-30', fieldOfStudy: 'Law', licenseNumber: 'LBA-26140', accreditingBody: 'Rhode Island Supreme Court', jurisdiction: 'Rhode Island', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-010', description: 'Bar admission with oath-date decoy',
    strippedText: 'BLUEGRASS BAR ADMISSIONS registers [ATTORNEY_REDACTED] under LBA-26156 for Law practice. The license issued October 28, 2026 and is current until October 31, 2027; October 9 was the oath ceremony. Kentucky Supreme Court is the admitting body.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Bluegrass Bar Admissions', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-10-28', expiryDate: '2027-10-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26156', accreditingBody: 'Kentucky Supreme Court', jurisdiction: 'Kentucky', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-011', description: 'Admission card with application-number decoy',
    strippedText: 'SUNFLOWER ATTORNEY LICENSING grants [ATTORNEY_REDACTED] Law license LBA-26172 on November 20, 2026, active through November 30, 2027. Application reference APP-5931 is not the license number. Kansas Supreme Court supplies admitting authority.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Sunflower Attorney Licensing', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-11-20', expiryDate: '2027-11-30', fieldOfStudy: 'Law', licenseNumber: 'LBA-26172', accreditingBody: 'Kansas Supreme Court', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-LBA-012', description: 'Bar admission labeled professional certificate',
    strippedText: 'PROFESSIONAL CERTIFICATE is the display heading, but SIERRA BAR EXAMINERS formally admits [ATTORNEY_REDACTED] to Law practice. License LBA-26190 issued December 16, 2026 and remains active until December 31, 2027. Nevada Supreme Court authorizes admission.',
    credentialTypeHint: 'LICENSE', groundTruth: { credentialType: 'LICENSE', subType: 'law_bar_admission', issuerName: 'Sierra Bar Examiners', recipientIdentifier: '[ATTORNEY_REDACTED]', issuedDate: '2026-12-16', expiryDate: '2027-12-31', fieldOfStudy: 'Law', licenseNumber: 'LBA-26190', accreditingBody: 'Nevada Supreme Court', jurisdiction: 'Nevada', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/legal-10-bar-admission/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'legal', 'bar-admission', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_AID_AWARDS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FFA-001', description: 'Undergraduate need-based aid award',
    strippedText: 'CEDAR RIDGE UNIVERSITY Financial Support Office presents [STUDENT_REDACTED] with an aid package for undergraduate environmental studies. Award notice dated January 11, 2026 covers through December 18, 2026. Federal Student Aid standards apply, and Colorado is the institutional jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Cedar Ridge University Financial Support Office', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-01-11', expiryDate: '2026-12-18', fieldOfStudy: 'Undergraduate Financial Aid Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/need-based-undergraduate', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-002', description: 'Graduate research fellowship award',
    strippedText: 'LAKEVIEW INSTITUTE OF SCIENCE awards [STUDENT_REDACTED] a graduate research fellowship for applied hydrology. The financial notice was issued February 8, 2026 for support ending January 31, 2027. Federal Student Aid guidance is cited; Wisconsin is the campus jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Lakeview Institute of Science', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-02-08', expiryDate: '2027-01-31', fieldOfStudy: 'Graduate Research Fellowship Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Wisconsin', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/research-fellowship', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-003', description: 'Community-college tuition grant award',
    strippedText: 'PRAIRIE BEND COMMUNITY COLLEGE notifies [STUDENT_REDACTED] of a tuition grant for the advanced manufacturing program. The award statement carries March 3, 2026 and remains applicable through December 20, 2026. Federal Student Aid rules govern; Kansas jurisdiction is shown.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Prairie Bend Community College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-03-03', expiryDate: '2026-12-20', fieldOfStudy: 'Tuition Grant Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/tuition-grant', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-004', description: 'Merit scholarship and work-study package',
    strippedText: 'BLUE HERON COLLEGE combines a merit scholarship and campus work-study allocation for [STUDENT_REDACTED] in public history. Package issue date is April 21, 2026, with eligibility through May 15, 2027. Federal Student Aid oversight and Virginia jurisdiction are specified.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Blue Heron College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-04-21', expiryDate: '2027-05-15', fieldOfStudy: 'Scholarship and Work-Study Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/merit-work-study', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-005', description: 'Veteran-dependent education grant notice',
    strippedText: 'IRONWOOD STATE UNIVERSITY approves [STUDENT_REDACTED] for an institutional veteran-dependent education grant in supply-chain management. Notice issued May 13, 2026 authorizes funding until April 30, 2027. Federal Student Aid controls are referenced; Michigan is the jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Ironwood State University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-05-13', expiryDate: '2027-04-30', fieldOfStudy: 'Veteran-Dependent Education Grant', accreditingBody: 'Federal Student Aid', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/veteran-dependent-grant', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-006', description: 'Nursing service scholarship award',
    strippedText: 'COASTAL PLAIN HEALTH COLLEGE grants [STUDENT_REDACTED] a nursing service scholarship tied to clinical placement. The financial award was issued June 7, 2026 for a term concluding May 22, 2027. Federal Student Aid requirements apply; North Carolina jurisdiction is listed.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Coastal Plain Health College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-06-07', expiryDate: '2027-05-22', fieldOfStudy: 'Nursing Service Scholarship', accreditingBody: 'Federal Student Aid', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/nursing-service-scholarship', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-007', description: 'Transfer-student completion award',
    strippedText: 'PALMETTO TECHNICAL UNIVERSITY extends a completion award to [STUDENT_REDACTED] for transferred studies in information systems. The package date is July 18, 2026 and funding eligibility ends June 30, 2027. Federal Student Aid is the referenced authority; South Carolina jurisdiction applies.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Palmetto Technical University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-07-18', expiryDate: '2027-06-30', fieldOfStudy: 'Transfer Completion Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/transfer-completion', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-008', description: 'Agricultural leadership stipend award',
    strippedText: 'RED RIVER AGRICULTURAL ACADEMY awards [STUDENT_REDACTED] a leadership stipend for sustainable crop systems. Financial aid notification was completed August 9, 2026 and applies through July 31, 2027. Federal Student Aid guidance and Oklahoma jurisdiction appear in the certification.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Red River Agricultural Academy', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-08-09', expiryDate: '2027-07-31', fieldOfStudy: 'Agricultural Leadership Stipend', accreditingBody: 'Federal Student Aid', jurisdiction: 'Oklahoma', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/agricultural-stipend', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-009', description: 'OCR-degraded aid award notice',
    strippedText: 'M0UNTAlN LlGHT C0LLEGE awards [STUDENT_REDACTED] renewable aid for geographic information science. Notice date September 6, 2026; eligibility through August 31, 2027. OCR substitutions affect the school masthead. Federal Student Aid and Montana remain readable.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Mountain Light College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-09-06', expiryDate: '2027-08-31', fieldOfStudy: 'Renewable Academic Aid Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Montana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-010', description: 'Award with acceptance-deadline date trap',
    strippedText: 'GOLDEN FIELD UNIVERSITY issues [STUDENT_REDACTED] an urban-planning aid award on October 17, 2026, valid through September 30, 2027. November 5 is only the student acceptance deadline. Federal Student Aid rules and California jurisdiction are stated.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Golden Field University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-10-17', expiryDate: '2027-09-30', fieldOfStudy: 'Urban Planning Aid Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-011', description: 'Award with third-party scholarship administrator',
    strippedText: 'SOUNDVIEW UNIVERSITY is the issuer of [STUDENT_REDACTED]’s marine-policy aid package dated November 8, 2026, effective through October 31, 2027. Harbor Scholars Network administers one component but does not issue the full award. Federal Student Aid; Washington jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Soundview University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-11-08', expiryDate: '2027-10-31', fieldOfStudy: 'Marine Policy Aid Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFA-012', description: 'Aid award titled enrollment certificate',
    strippedText: 'ENROLLMENT CERTIFICATE appears in the portal header, but EVERGLADE COAST COLLEGE itemizes grants and loans awarded to [STUDENT_REDACTED]. The financial statement issued December 4, 2026 covers through November 30, 2027. Federal Student Aid oversight; Florida jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Everglade Coast College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-12-04', expiryDate: '2027-11-30', fieldOfStudy: 'Student Financial Aid Award', accreditingBody: 'Federal Student Aid', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-06-financial-aid-award/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-aid-award', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_TAX_RETURNS_ASSESSMENTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FTR-001', description: 'Federal individual return summary',
    strippedText: 'CLEARWATER TAX PRACTICE prepares the 2025 federal individual return summary for [TAXPAYER_REDACTED]. Filing copy issued January 29, 2026 reports the completed income-tax return without exposing account identifiers. Internal Revenue Service rules govern; Idaho is the preparation jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Clearwater Tax Practice', recipientIdentifier: '[TAXPAYER_REDACTED]', issuedDate: '2026-01-29', fieldOfStudy: 'Federal Individual Income Tax Return', accreditingBody: 'Internal Revenue Service', jurisdiction: 'Idaho', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/federal-individual', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-002', description: 'State income-tax assessment notice',
    strippedText: 'VERMONT DEPARTMENT OF TAXES addresses [TAXPAYER_REDACTED] with a reviewed 2025 income-tax assessment. Notice date February 17, 2026 states the recalculated balance and omits personal identifiers. State Revenue Commission authority and Vermont jurisdiction are printed in the footer.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Vermont Department of Taxes', recipientIdentifier: '[TAXPAYER_REDACTED]', issuedDate: '2026-02-17', fieldOfStudy: 'State Income Tax Assessment', accreditingBody: 'Vermont State Revenue Commission', jurisdiction: 'Vermont', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/state-income-assessment', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-003', description: 'Partnership return filing record',
    strippedText: 'SILVER PINE ACCOUNTING compiles the 2025 partnership return for [ENTITY_REDACTED], with partner schedules separately redacted. The client filing record was issued March 12, 2026. Internal Revenue Service filing requirements apply, and Montana is the practice jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Silver Pine Accounting', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-03-12', fieldOfStudy: 'Partnership Tax Return', accreditingBody: 'Internal Revenue Service', jurisdiction: 'Montana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/partnership-return', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-004', description: 'Corporate excise return assessment',
    strippedText: 'OREGON DEPARTMENT OF REVENUE evaluates [ENTITY_REDACTED] for the 2025 corporate excise filing. Assessment issued April 23, 2026 documents accepted adjustments and masks taxpayer account data. Oregon Revenue Commission is the governing authority; jurisdiction is Oregon.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Oregon Department of Revenue', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-04-23', fieldOfStudy: 'Corporate Excise Tax Assessment', accreditingBody: 'Oregon Revenue Commission', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/corporate-excise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-005', description: 'Nonprofit information-return summary',
    strippedText: 'MEADOWBROOK EXEMPT ORGANIZATION SERVICES prepares a 2025 information return for [ENTITY_REDACTED]. The public-inspection summary bears May 16, 2026 and excludes donor identity fields. Internal Revenue Service exempt-organization standards apply; Missouri is the preparation jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Meadowbrook Exempt Organization Services', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-05-16', fieldOfStudy: 'Nonprofit Information Tax Return', accreditingBody: 'Internal Revenue Service', jurisdiction: 'Missouri', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/nonprofit-information-return', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-006', description: 'Property-tax reassessment statement',
    strippedText: 'SANDHILLS COUNTY ASSESSOR sends [PROPERTY_OWNER_REDACTED] the 2026 reassessment statement for an agricultural parcel. The tax determination was issued June 25, 2026, with parcel identifiers suppressed. Nebraska Property Tax Commission authority and Nebraska jurisdiction are stated.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Sandhills County Assessor', recipientIdentifier: '[PROPERTY_OWNER_REDACTED]', issuedDate: '2026-06-25', fieldOfStudy: 'Property Tax Reassessment', accreditingBody: 'Nebraska Property Tax Commission', jurisdiction: 'Nebraska', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/property-reassessment', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-007', description: 'Sales-and-use tax return record',
    strippedText: 'GULF PINE TAX ADVISORY produces a sales-and-use return record for [ENTITY_REDACTED] covering the second quarter of 2026. Client copy dated July 10, 2026 omits registration details. Florida Department of Revenue guidance applies, with Florida as jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Gulf Pine Tax Advisory', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-07-10', fieldOfStudy: 'Sales and Use Tax Return', accreditingBody: 'Florida Department of Revenue', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/sales-use-return', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-008', description: 'Fiduciary income-tax return summary',
    strippedText: 'BLUE MESA FIDUCIARY ACCOUNTING completes a 2025 estate income return for [ESTATE_REDACTED]. Summary issued August 14, 2026 retains financial totals while withholding beneficiary details. Internal Revenue Service fiduciary standards govern, and New Mexico is the jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Blue Mesa Fiduciary Accounting', recipientIdentifier: '[ESTATE_REDACTED]', issuedDate: '2026-08-14', fieldOfStudy: 'Fiduciary Income Tax Return', accreditingBody: 'Internal Revenue Service', jurisdiction: 'New Mexico', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/fiduciary-return', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-009', description: 'OCR-degraded municipal tax assessment',
    strippedText: 'GRANlTE ClTY REVENUE 0FFlCE assesses [ENTITY_REDACTED] for 2026 business occupancy tax. Notice issued September 21, 2026; OCR substitutions touch the masthead, not the financial figures. Virginia Tax Commissioner authority and Virginia jurisdiction remain legible.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Granite City Revenue Office', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-09-21', fieldOfStudy: 'Business Occupancy Tax Assessment', accreditingBody: 'Virginia Tax Commissioner', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-010', description: 'Assessment with tax-period date trap',
    strippedText: 'DELAWARE DIVISION OF REVENUE issues [ENTITY_REDACTED] a franchise-tax assessment on October 30, 2026. December 31, 2025 marks the reporting-period close, not issuance. Delaware Tax Appeals Board oversight and Delaware jurisdiction appear on the assessment.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Delaware Division of Revenue', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-10-30', fieldOfStudy: 'Franchise Tax Assessment', accreditingBody: 'Delaware Tax Appeals Board', jurisdiction: 'Delaware', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-011', description: 'Tax return with payment-confirmation decoy ID',
    strippedText: 'REDWOOD TAX COLLABORATIVE prepares the 2025 pass-through return for [ENTITY_REDACTED], issuing the filing copy November 13, 2026. Payment confirmation PAY-4816 is not a taxpayer or return identifier. Internal Revenue Service rules apply; California jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Redwood Tax Collaborative', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-11-13', fieldOfStudy: 'Pass-Through Entity Tax Return', accreditingBody: 'Internal Revenue Service', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FTR-012', description: 'Tax assessment labeled account statement',
    strippedText: 'ACCOUNT STATEMENT appears at top, but ARIZONA DEPARTMENT OF REVENUE recalculates transaction-privilege tax for [ENTITY_REDACTED]. The assessment was issued December 22, 2026. Arizona Tax Appeals authority is cited; Transaction Privilege Tax Assessment is the financial subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'tax_return', issuerName: 'Arizona Department of Revenue', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-12-22', fieldOfStudy: 'Transaction Privilege Tax Assessment', accreditingBody: 'Arizona Tax Appeals Office', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-07-tax-return-assessment/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'tax-return-assessment', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_AUDIT_REPORTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FAR-001', description: 'Unmodified nonprofit financial audit',
    strippedText: 'NORTH CHANNEL ASSURANCE LLP delivers an unmodified independent audit report to [ENTITY_REDACTED] for its charitable financial statements. Auditor signature date is January 24, 2026. AICPA Auditing Standards govern the engagement, conducted in Michigan; subject is Nonprofit Financial Audit.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'North Channel Assurance LLP', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-01-24', fieldOfStudy: 'Nonprofit Financial Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/nonprofit-unmodified', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-002', description: 'Qualified inventory audit opinion',
    strippedText: 'PRAIRIE LEDGER & CO. reports a qualified opinion to [ENTITY_REDACTED] because one remote inventory count lacked sufficient evidence. The independent auditor dated the report February 26, 2026. AICPA standards apply in Iowa; Inventory Valuation Audit is the engagement subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Prairie Ledger & Co.', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-02-26', fieldOfStudy: 'Inventory Valuation Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Iowa', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/qualified-inventory', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-003', description: 'Municipal single-audit report',
    strippedText: 'COAST RANGE PUBLIC ACCOUNTING issues [MUNICIPALITY_REDACTED] a single-audit report covering federal awards and internal controls. The report date is March 30, 2026. Government Auditing Standards provide authority, Oregon is the jurisdiction, and Federal Awards Audit defines the subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Coast Range Public Accounting', recipientIdentifier: '[MUNICIPALITY_REDACTED]', issuedDate: '2026-03-30', fieldOfStudy: 'Federal Awards Audit', accreditingBody: 'Government Accountability Office', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/municipal-single-audit', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-004', description: 'Credit-union annual audit report',
    strippedText: 'BLUE CANYON AUDIT PARTNERS addresses an annual financial audit to [ENTITY_REDACTED], a regional credit union. The partners signed on April 18, 2026 after testing member-loan controls. AICPA audit authority applies in Colorado; Credit Union Financial Audit is the subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Blue Canyon Audit Partners', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-04-18', fieldOfStudy: 'Credit Union Financial Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/credit-union', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-005', description: 'Employee-benefit plan audit',
    strippedText: 'HARBOR STONE CPAS submits an independent employee-benefit plan audit to [PLAN_REDACTED]. The opinion was dated May 27, 2026 following contribution and investment testing. Employee Benefit Plan Audit Quality Center guidance applies in Delaware; Retirement Plan Audit identifies the subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Harbor Stone CPAs', recipientIdentifier: '[PLAN_REDACTED]', issuedDate: '2026-05-27', fieldOfStudy: 'Retirement Plan Audit', accreditingBody: 'AICPA Employee Benefit Plan Audit Quality Center', jurisdiction: 'Delaware', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/benefit-plan', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-006', description: 'Manufacturing company PCAOB audit',
    strippedText: 'REDWOOD INDEPENDENT AUDITORS provides [ENTITY_REDACTED] an integrated audit of consolidated accounts and internal control. Report signature occurred June 21, 2026. Public Company Accounting Oversight Board standards govern in California; Integrated Manufacturing Audit describes the engagement.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Redwood Independent Auditors', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-06-21', fieldOfStudy: 'Integrated Manufacturing Audit', accreditingBody: 'Public Company Accounting Oversight Board', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/manufacturing-pcaob', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-007', description: 'Housing authority compliance audit',
    strippedText: 'MAGNOLIA GOVERNMENT ASSURANCE reports to [AUTHORITY_REDACTED] on financial statements and housing-program compliance. Independent auditor date is July 25, 2026. Government Auditing Standards are cited, Mississippi is the jurisdiction, and Housing Program Compliance Audit is the report subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Magnolia Government Assurance', recipientIdentifier: '[AUTHORITY_REDACTED]', issuedDate: '2026-07-25', fieldOfStudy: 'Housing Program Compliance Audit', accreditingBody: 'Government Accountability Office', jurisdiction: 'Mississippi', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/housing-compliance', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-008', description: 'University foundation audit',
    strippedText: 'GREAT LAKES ASSURANCE GROUP sends [FOUNDATION_REDACTED] an unmodified audit of endowment and operating statements. The audit opinion bears August 29, 2026. AICPA Auditing Standards Board authority applies in Ohio; University Foundation Audit is the financial subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Great Lakes Assurance Group', recipientIdentifier: '[FOUNDATION_REDACTED]', issuedDate: '2026-08-29', fieldOfStudy: 'University Foundation Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/university-foundation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-009', description: 'OCR-degraded cooperative audit report',
    strippedText: 'SUNFlELD ASSURANCE C0LLAB0RATlVE audits [COOPERATIVE_REDACTED] for grain-inventory and patronage accounts. Report dated September 26, 2026. OCR noise alters the firm heading only. AICPA Auditing Standards Board and Kansas jurisdiction remain clear; Cooperative Financial Audit subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Sunfield Assurance Collaborative', recipientIdentifier: '[COOPERATIVE_REDACTED]', issuedDate: '2026-09-26', fieldOfStudy: 'Cooperative Financial Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-010', description: 'Audit with fiscal-period date trap',
    strippedText: 'PENOBSCOT PUBLIC ACCOUNTANTS audits [DISTRICT_REDACTED] for water-system finances. The opinion was signed October 22, 2026; June 30, 2026 is the fiscal period close, not issue date. Government Auditing Standards govern in Maine; Utility District Audit subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Penobscot Public Accountants', recipientIdentifier: '[DISTRICT_REDACTED]', issuedDate: '2026-10-22', fieldOfStudy: 'Utility District Audit', accreditingBody: 'Government Accountability Office', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-011', description: 'Audit jointly supported by a specialist',
    strippedText: 'DESERT ARCH ASSURANCE LLP issues the audit opinion to [ENTITY_REDACTED] on November 24, 2026. Mesa Valuation Specialists supplied appraisal work but did not issue the report. AICPA Auditing Standards Board governs in Arizona; Commercial Real Estate Audit is the subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Desert Arch Assurance LLP', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-11-24', fieldOfStudy: 'Commercial Real Estate Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FAR-012', description: 'Independent audit labeled management review',
    strippedText: 'MANAGEMENT REVIEW labels the portal tab, but TIDE COUNTRY CPAS expresses an independent audit opinion for [ENTITY_REDACTED]. Signature date December 28, 2026. AICPA Auditing Standards Board authority applies in Virginia; Regional Transit Financial Audit is the actual subject.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'audit_report', issuerName: 'Tide Country CPAs', recipientIdentifier: '[ENTITY_REDACTED]', issuedDate: '2026-12-28', fieldOfStudy: 'Regional Transit Financial Audit', accreditingBody: 'AICPA Auditing Standards Board', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-08-audit-report/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'audit-report', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_STATEMENTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FFS-001', description: 'Manufacturing consolidated financial statements',
    strippedText: 'COPPER BRIDGE INDUSTRIES Finance Office releases consolidated statements to [BOARD_REDACTED] on January 20, 2026, presenting balance sheet, operations, and cash flows. Financial Accounting Standards Board guidance governs the Manufacturing Consolidated Statements prepared in Ohio jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Copper Bridge Industries Finance Office', recipientIdentifier: '[BOARD_REDACTED]', issuedDate: '2026-01-20', fieldOfStudy: 'Manufacturing Consolidated Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/manufacturing-consolidated', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-002', description: 'Community foundation fund statements',
    strippedText: 'RIVERSTONE COMMUNITY FOUNDATION presents [TRUSTEES_REDACTED] with statements of financial position and changes in net assets. Publication date is February 22, 2026. Financial Accounting Standards Board rules apply to the Foundation Fund Statements in Kentucky jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Riverstone Community Foundation', recipientIdentifier: '[TRUSTEES_REDACTED]', issuedDate: '2026-02-22', fieldOfStudy: 'Foundation Fund Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Kentucky', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/community-foundation', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-003', description: 'Municipal enterprise-fund statements',
    strippedText: 'RED MESA WATER AUTHORITY issues enterprise-fund financial statements to [COUNCIL_REDACTED] on March 27, 2026. They include net position, revenues, expenses, and cash flows. Governmental Accounting Standards Board authority governs the Utility Enterprise Statements in New Mexico.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Red Mesa Water Authority', recipientIdentifier: '[COUNCIL_REDACTED]', issuedDate: '2026-03-27', fieldOfStudy: 'Utility Enterprise Statements', accreditingBody: 'Governmental Accounting Standards Board', jurisdiction: 'New Mexico', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/utility-enterprise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-004', description: 'Agricultural cooperative statements',
    strippedText: 'SUN PRAIRIE GRAIN COOPERATIVE circulates annual financial statements to [MEMBERS_REDACTED]. The authorized release date is April 24, 2026, and schedules cover patronage equity and inventory. Financial Accounting Standards Board guidance applies to Cooperative Annual Statements in Kansas.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Sun Prairie Grain Cooperative', recipientIdentifier: '[MEMBERS_REDACTED]', issuedDate: '2026-04-24', fieldOfStudy: 'Cooperative Annual Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/agricultural-cooperative', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-005', description: 'Regional hospital financial statements',
    strippedText: 'PINE COAST REGIONAL HOSPITAL publishes financial position, activities, and cash-flow statements for [GOVERNORS_REDACTED]. Release occurred May 28, 2026. Financial Accounting Standards Board requirements govern the Nonprofit Hospital Statements in Maine jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Pine Coast Regional Hospital', recipientIdentifier: '[GOVERNORS_REDACTED]', issuedDate: '2026-05-28', fieldOfStudy: 'Nonprofit Hospital Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/regional-hospital', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-006', description: 'Renewable-energy partnership statements',
    strippedText: 'HIGH DESERT RENEWABLE PARTNERS prepares combined financial statements for [PARTNERS_REDACTED], including project assets and operating distributions. Management authorized them June 20, 2026. Financial Accounting Standards Board rules guide the Renewable Partnership Statements in Nevada.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'High Desert Renewable Partners', recipientIdentifier: '[PARTNERS_REDACTED]', issuedDate: '2026-06-20', fieldOfStudy: 'Renewable Partnership Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Nevada', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/renewable-partnership', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-007', description: 'Transit district governmental statements',
    strippedText: 'CASCADE VALLEY TRANSIT DISTRICT delivers government-wide statements and fund schedules to [COMMISSION_REDACTED] on July 23, 2026. Governmental Accounting Standards Board principles control the Public Transit Financial Statements issued under Oregon jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Cascade Valley Transit District', recipientIdentifier: '[COMMISSION_REDACTED]', issuedDate: '2026-07-23', fieldOfStudy: 'Public Transit Financial Statements', accreditingBody: 'Governmental Accounting Standards Board', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/transit-district', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-008', description: 'Software company interim statements',
    strippedText: 'FOOTHILL LEDGER SYSTEMS provides unaudited interim statements to [DIRECTORS_REDACTED], presenting recurring revenue, expenses, and liquidity. The finance committee approved release August 26, 2026. Financial Accounting Standards Board guidance applies to Software Interim Statements in California.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Foothill Ledger Systems', recipientIdentifier: '[DIRECTORS_REDACTED]', issuedDate: '2026-08-26', fieldOfStudy: 'Software Interim Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/software-interim', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-009', description: 'Statements with thousands-versus-millions unit trap',
    strippedText: 'BLUEGRASS LOGISTICS HOLDINGS releases [INVESTORS_REDACTED] consolidated statements on September 25, 2026. Tables are explicitly presented in thousands, while a narrative comparison mentions millions; units must not be conflated. Financial Accounting Standards Board; Kentucky; Logistics Consolidated Statements.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Bluegrass Logistics Holdings', recipientIdentifier: '[INVESTORS_REDACTED]', issuedDate: '2026-09-25', fieldOfStudy: 'Logistics Consolidated Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Kentucky', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/unit-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'edge', 'unit-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-010', description: 'Statements with period-end date trap',
    strippedText: 'TIDEWATER PORT SERVICES authorizes [OWNERS_REDACTED] financial statements on October 21, 2026. June 30, 2026 is the reporting cutoff rather than issue date. Financial Accounting Standards Board authority governs the Port Operations Statements prepared in Virginia jurisdiction.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Tidewater Port Services', recipientIdentifier: '[OWNERS_REDACTED]', issuedDate: '2026-10-21', fieldOfStudy: 'Port Operations Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-011', description: 'Statements assembled by an external bookkeeper',
    strippedText: 'GARDEN STATE ARTS COUNCIL issues [TRUSTEES_REDACTED] its annual financial statements on November 19, 2026. Harbor Bookkeeping assembled schedules but is not the issuing entity. Governmental Accounting Standards Board rules apply to Arts Council Statements in New Jersey.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Garden State Arts Council', recipientIdentifier: '[TRUSTEES_REDACTED]', issuedDate: '2026-11-19', fieldOfStudy: 'Arts Council Financial Statements', accreditingBody: 'Governmental Accounting Standards Board', jurisdiction: 'New Jersey', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FFS-012', description: 'Financial statements captioned performance certificate',
    strippedText: 'PERFORMANCE CERTIFICATE labels the dashboard export, but ALASKA COAST FERRY COOPERATIVE presents [MEMBERS_REDACTED] with position, operations, and cash-flow statements. Release date December 23, 2026. Financial Accounting Standards Board; Alaska; Ferry Cooperative Statements.',
    credentialTypeHint: 'FINANCIAL', groundTruth: { credentialType: 'FINANCIAL', subType: 'financial_statement', issuerName: 'Alaska Coast Ferry Cooperative', recipientIdentifier: '[MEMBERS_REDACTED]', issuedDate: '2026-12-23', fieldOfStudy: 'Ferry Cooperative Statements', accreditingBody: 'Financial Accounting Standards Board', jurisdiction: 'Alaska', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-09-financial-statements/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'financial-statements', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const FINANCIAL_SEC_10K_FILINGS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-FSK-001', description: 'Industrial controls company Form 10-K',
    strippedText: 'CEDAR VALVE SYSTEMS submits its annual Form 10-K to [SEC_RECIPIENT] on January 28, 2026. Filing accession FSK-26016 covers industrial controls operations, audited results, and material risks. Securities and Exchange Commission oversight applies; the registrant is organized in Delaware.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Cedar Valve Systems', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-01-28', fieldOfStudy: 'Industrial Controls Annual Report', licenseNumber: 'FSK-26016', jurisdiction: 'Delaware', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/industrial-controls', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-002', description: 'Regional logistics Form 10-K',
    strippedText: 'HARBORLINE FREIGHT GROUP files a Form 10-K with [SEC_RECIPIENT] dated February 25, 2026. Accession FSK-26033 reports fleet assets, route revenue, liquidity, and risk factors. Securities and Exchange Commission filing authority is stated; corporate jurisdiction is Virginia.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Harborline Freight Group', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-02-25', fieldOfStudy: 'Freight Logistics Annual Report', licenseNumber: 'FSK-26033', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/freight-logistics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-003', description: 'Renewable materials Form 10-K',
    strippedText: 'PRAIRIE COMPOSITE MATERIALS delivers its yearly Form 10-K to [SEC_RECIPIENT] on March 31, 2026. Accession number FSK-26051 includes consolidated results, manufacturing capacity, and climate-related exposures. Securities and Exchange Commission oversight applies; Kansas is the incorporation jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Prairie Composite Materials', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-03-31', fieldOfStudy: 'Renewable Materials Annual Report', licenseNumber: 'FSK-26051', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/renewable-materials', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-004', description: 'Community banking Form 10-K',
    strippedText: 'SOUND RIDGE BANCORP transmits Form 10-K accession FSK-26067 to [SEC_RECIPIENT] on April 29, 2026. The report addresses deposits, loan quality, capital, and cybersecurity risks. Securities and Exchange Commission authority is named; Washington is the registrant jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Sound Ridge Bancorp', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-04-29', fieldOfStudy: 'Community Banking Annual Report', licenseNumber: 'FSK-26067', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/community-banking', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-005', description: 'Medical device Form 10-K',
    strippedText: 'BLUE MESA MEDICAL DEVICES submits annual report FSK-26082 to [SEC_RECIPIENT] on May 26, 2026. The Form 10-K contains device revenue, regulatory contingencies, and audited financial schedules. Securities and Exchange Commission rules govern; New Mexico is the corporation jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Blue Mesa Medical Devices', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-05-26', fieldOfStudy: 'Medical Device Annual Report', licenseNumber: 'FSK-26082', jurisdiction: 'New Mexico', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/medical-devices', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-006', description: 'Water technology Form 10-K',
    strippedText: 'GREAT LAKES WATER TECHNOLOGY files Form 10-K FSK-26098 for [SEC_RECIPIENT] on June 30, 2026. Annual disclosures cover treatment systems, service contracts, debt, and market risks. Securities and Exchange Commission filing requirements apply; Michigan is the jurisdiction of incorporation.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Great Lakes Water Technology', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-06-30', fieldOfStudy: 'Water Technology Annual Report', licenseNumber: 'FSK-26098', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/water-technology', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-007', description: 'Specialty foods Form 10-K',
    strippedText: 'MAGNOLIA SPECIALTY FOODS provides [SEC_RECIPIENT] with Form 10-K accession FSK-26113 on July 28, 2026. It reports segment sales, commodity exposure, controls, and consolidated statements. Securities and Exchange Commission oversight is cited; Mississippi is the registrant jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Magnolia Specialty Foods', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-07-28', fieldOfStudy: 'Specialty Foods Annual Report', licenseNumber: 'FSK-26113', jurisdiction: 'Mississippi', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/specialty-foods', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-008', description: 'Cloud infrastructure Form 10-K',
    strippedText: 'CASCADE CLOUD INFRASTRUCTURE files annual Form 10-K FSK-26129 with [SEC_RECIPIENT] on August 31, 2026. The submission discusses subscription revenue, data centers, security, and audited accounts. Securities and Exchange Commission authority applies; Oregon is the corporate jurisdiction.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Cascade Cloud Infrastructure', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-08-31', fieldOfStudy: 'Cloud Infrastructure Annual Report', licenseNumber: 'FSK-26129', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/cloud-infrastructure', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-009', description: 'OCR-degraded energy storage Form 10-K',
    strippedText: 'DESERT ST0RAGE P0WER files F0RM 10-K FSK-26144 for [SEC_RECIPIENT] on September 29, 2026. OCR substitutions affect the title line, while battery revenue and risk disclosures remain intact. Securities and Exchange Commission; Arizona jurisdiction; Energy Storage Annual Report.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Desert Storage Power', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-09-29', fieldOfStudy: 'Energy Storage Annual Report', licenseNumber: 'FSK-26144', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-010', description: 'Form 10-K with fiscal-year date trap',
    strippedText: 'ALLEGHENY SENSOR NETWORKS submits Form 10-K FSK-26160 to [SEC_RECIPIENT] on October 27, 2026. June 30, 2026 is the fiscal year end rather than filing date. Securities and Exchange Commission oversight; Pennsylvania jurisdiction; Sensor Network Annual Report.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Allegheny Sensor Networks', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-10-27', fieldOfStudy: 'Sensor Network Annual Report', licenseNumber: 'FSK-26160', jurisdiction: 'Pennsylvania', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-011', description: 'Form 10-K with exhibit-number decoy',
    strippedText: 'PALMETTO MOBILITY GROUP files annual report accession FSK-26176 for [SEC_RECIPIENT] on November 25, 2026. Exhibit 10.14 is a contract index and not the filing identifier. Securities and Exchange Commission; South Carolina jurisdiction; Mobility Services Annual Report.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Palmetto Mobility Group', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-11-25', fieldOfStudy: 'Mobility Services Annual Report', licenseNumber: 'FSK-26176', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/decoy-id', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'edge', 'decoy-id'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-FSK-012', description: 'Form 10-K portal-labeled sustainability report',
    strippedText: 'SUSTAINABILITY REPORT labels the download tile, but NORTHERN TIMBER ANALYTICS files a complete Form 10-K with [SEC_RECIPIENT]. Accession FSK-26192 was submitted December 29, 2026. Securities and Exchange Commission authority; Maine jurisdiction; Forest Analytics Annual Report.',
    credentialTypeHint: 'SEC_FILING', groundTruth: { credentialType: 'SEC_FILING', subType: 'form_10k', issuerName: 'Northern Timber Analytics', recipientIdentifier: '[SEC_RECIPIENT]', issuedDate: '2026-12-29', fieldOfStudy: 'Forest Analytics Annual Report', licenseNumber: 'FSK-26192', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/financial-10-sec-10k/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'financial', 'sec-10k', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_OFFICIAL_UNDERGRADUATE_TRANSCRIPTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EUT-001', description: 'Official bachelor-level biology transcript',
    strippedText: 'CEDAR VALLEY UNIVERSITY Registrar certifies the official undergraduate transcript of [STUDENT_REDACTED] on January 15, 2026. Coursework documents a Bachelor level Biology program with completed laboratory credits. Midwestern Collegiate Commission accredits the institution in Iowa.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Cedar Valley University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-01-15', fieldOfStudy: 'Biology', degreeLevel: 'Bachelor', accreditingBody: 'Midwestern Collegiate Commission', jurisdiction: 'Iowa', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/biology', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-002', description: 'Official associate-level network systems transcript',
    strippedText: 'PINE HARBOR COMMUNITY COLLEGE issues [STUDENT_REDACTED] an official undergraduate transcript dated February 10, 2026. The record covers an Associate level Network Systems curriculum and cumulative academic standing. New England Technical Colleges Council provides accreditation in Maine.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Pine Harbor Community College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-02-10', fieldOfStudy: 'Network Systems', degreeLevel: 'Associate', accreditingBody: 'New England Technical Colleges Council', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/network-systems', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-003', description: 'Official bachelor-level civil engineering transcript',
    strippedText: 'RED MESA POLYTECHNIC transmits an official academic transcript for [STUDENT_REDACTED] on March 14, 2026. Bachelor level Civil Engineering courses, credits, and final standing are registrar-authenticated. Southwest Engineering Education Council accredits the program in New Mexico.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Red Mesa Polytechnic', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-03-14', fieldOfStudy: 'Civil Engineering', degreeLevel: 'Bachelor', accreditingBody: 'Southwest Engineering Education Council', jurisdiction: 'New Mexico', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/civil-engineering', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-004', description: 'Official bachelor-level public health transcript',
    strippedText: 'BLUE RIDGE COLLEGE OF HEALTH verifies [STUDENT_REDACTED] through an official undergraduate transcript released April 12, 2026. The record identifies Bachelor level Public Health study and completed practicum credit. Appalachian Higher Education Commission accredits the college in Virginia.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Blue Ridge College of Health', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-04-12', fieldOfStudy: 'Public Health', degreeLevel: 'Bachelor', accreditingBody: 'Appalachian Higher Education Commission', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/public-health', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-005', description: 'Official bachelor-level accounting transcript',
    strippedText: 'GREAT LAKES BUSINESS UNIVERSITY seals the official undergraduate record of [STUDENT_REDACTED] on May 17, 2026. It lists Bachelor level Accounting courses, transferred credits, and institutional grades. Northern Business Schools Association accredits the program in Michigan.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Great Lakes Business University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-05-17', fieldOfStudy: 'Accounting', degreeLevel: 'Bachelor', accreditingBody: 'Northern Business Schools Association', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/accounting', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-006', description: 'Official associate-level renewable energy transcript',
    strippedText: 'SUN PRAIRIE TECHNICAL COLLEGE certifies an official transcript for [STUDENT_REDACTED] on June 11, 2026. Associate level Renewable Energy Technology modules and shop credits appear in chronological order. Plains Career Education Council accredits the college in Kansas.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Sun Prairie Technical College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-06-11', fieldOfStudy: 'Renewable Energy Technology', degreeLevel: 'Associate', accreditingBody: 'Plains Career Education Council', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/renewable-energy', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-007', description: 'Official bachelor-level geographic science transcript',
    strippedText: 'MOUNTAIN LIGHT UNIVERSITY Registrar releases [STUDENT_REDACTED]’s official undergraduate transcript on July 19, 2026. Bachelor level Geographic Information Science coursework includes mapping, databases, and field methods. Northwest Universities Commission accredits the institution in Montana.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Mountain Light University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-07-19', fieldOfStudy: 'Geographic Information Science', degreeLevel: 'Bachelor', accreditingBody: 'Northwest Universities Commission', jurisdiction: 'Montana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/geographic-science', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-008', description: 'Official bachelor-level communication transcript',
    strippedText: 'PALMETTO COAST UNIVERSITY authenticates the official undergraduate transcript of [STUDENT_REDACTED] on August 16, 2026. The registrar record documents Bachelor level Communication Studies and completed capstone credit. Atlantic Collegiate Review Board accredits the university in South Carolina.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Palmetto Coast University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-08-16', fieldOfStudy: 'Communication Studies', degreeLevel: 'Bachelor', accreditingBody: 'Atlantic Collegiate Review Board', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/communication-studies', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-009', description: 'OCR-degraded official undergraduate transcript',
    strippedText: 'C0PPER CAN Y0N UNlVERSlTY certifies [STUDENT_REDACTED]’s official transcript on September 13, 2026. OCR damage affects the registrar heading, not Bachelor level Environmental Design coursework. Western Design Education Council accredits the institution in Arizona.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Copper Canyon University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-09-13', fieldOfStudy: 'Environmental Design', degreeLevel: 'Bachelor', accreditingBody: 'Western Design Education Council', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-010', description: 'Official transcript with multiple course formats',
    strippedText: 'TIDEWATER LIBERAL ARTS COLLEGE issues an official undergraduate transcript for [STUDENT_REDACTED] on October 18, 2026. Semester, intensive, and transfer courses all support a Bachelor level History program. Southern Collegiate Commission accredits the college in Maryland.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Tidewater Liberal Arts College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-10-18', fieldOfStudy: 'History', degreeLevel: 'Bachelor', accreditingBody: 'Southern Collegiate Commission', jurisdiction: 'Maryland', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/multi-course', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'edge', 'multi-course'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-011', description: 'Transcript with graduation-date decoy',
    strippedText: 'EVERGREEN SOUND COLLEGE releases [STUDENT_REDACTED]’s official undergraduate transcript on November 21, 2026. May 14, 2027 is an anticipated graduation date, not transcript issuance. Bachelor level Marine Policy; Northwest Universities Commission; Washington jurisdiction.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Evergreen Sound College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-11-21', fieldOfStudy: 'Marine Policy', degreeLevel: 'Bachelor', accreditingBody: 'Northwest Universities Commission', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUT-012', description: 'Official transcript portal-labeled grade certificate',
    strippedText: 'GRADE CERTIFICATE labels the download, yet FLORIDA HAMMOCK UNIVERSITY Registrar authenticates a complete official undergraduate transcript for [STUDENT_REDACTED] on December 18, 2026. Bachelor level Hospitality Management; Gulf States Collegiate Commission; Florida jurisdiction.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_undergraduate', issuerName: 'Florida Hammock University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-12-18', fieldOfStudy: 'Hospitality Management', degreeLevel: 'Bachelor', accreditingBody: 'Gulf States Collegiate Commission', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-06-official-undergraduate-transcript/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-undergraduate-transcript', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_OFFICIAL_GRADUATE_TRANSCRIPTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EGT-001', description: 'Official master-level analytics transcript',
    strippedText: 'HARBOR RIDGE GRADUATE UNIVERSITY certifies [STUDENT_REDACTED]’s official graduate transcript on January 23, 2026. Master level Applied Analytics seminars and thesis credits appear in the sealed record. Atlantic Graduate Education Council accredits the institution in Massachusetts.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Harbor Ridge Graduate University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-01-23', fieldOfStudy: 'Applied Analytics', degreeLevel: 'Master', accreditingBody: 'Atlantic Graduate Education Council', jurisdiction: 'Massachusetts', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/applied-analytics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-002', description: 'Official doctorate-level ecology transcript',
    strippedText: 'CASCADE RESEARCH UNIVERSITY Registrar issues an official graduate record for [STUDENT_REDACTED] on February 20, 2026. Doctorate level Forest Ecology coursework, qualifying examination, and dissertation hours are verified. Northwest Research Universities Board accredits the university in Oregon.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Cascade Research University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-02-20', fieldOfStudy: 'Forest Ecology', degreeLevel: 'Doctorate', accreditingBody: 'Northwest Research Universities Board', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/forest-ecology', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-003', description: 'Official master-level public administration transcript',
    strippedText: 'CAPITOL PRAIRIE SCHOOL OF GOVERNANCE releases [STUDENT_REDACTED]’s official graduate transcript dated March 22, 2026. The registrar confirms Master level Public Administration courses and policy practicum credit. Central States Professional Schools Council accredits the school in Illinois.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Capitol Prairie School of Governance', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-03-22', fieldOfStudy: 'Public Administration', degreeLevel: 'Master', accreditingBody: 'Central States Professional Schools Council', jurisdiction: 'Illinois', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/public-administration', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-004', description: 'Official master-level clinical informatics transcript',
    strippedText: 'BLUE LAKE HEALTH SCIENCES INSTITUTE authenticates an official graduate transcript for [STUDENT_REDACTED] on April 20, 2026. Master level Clinical Informatics study includes systems, ethics, and capstone work. Great Lakes Health Education Commission accredits the institute in Michigan.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Blue Lake Health Sciences Institute', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-04-20', fieldOfStudy: 'Clinical Informatics', degreeLevel: 'Master', accreditingBody: 'Great Lakes Health Education Commission', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/clinical-informatics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-005', description: 'Official doctorate-level materials transcript',
    strippedText: 'MESA FRONTIER INSTITUTE OF TECHNOLOGY seals [STUDENT_REDACTED]’s official graduate transcript on May 24, 2026. Doctorate level Materials Science research rotations and candidacy milestones are documented. Southwest Advanced Education Board accredits the institute in Arizona.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Mesa Frontier Institute of Technology', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-05-24', fieldOfStudy: 'Materials Science', degreeLevel: 'Doctorate', accreditingBody: 'Southwest Advanced Education Board', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/materials-science', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-006', description: 'Official master-level educational leadership transcript',
    strippedText: 'PIEDMONT COLLEGE OF EDUCATION records an official graduate transcript for [STUDENT_REDACTED] on June 19, 2026. Master level Educational Leadership courses and supervised residency are registrar-certified. Southern Educator Preparation Council accredits the college in North Carolina.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Piedmont College of Education', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-06-19', fieldOfStudy: 'Educational Leadership', degreeLevel: 'Master', accreditingBody: 'Southern Educator Preparation Council', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/educational-leadership', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-007', description: 'Official master-level water resources transcript',
    strippedText: 'RED RIVER GRADUATE COLLEGE sends [STUDENT_REDACTED] an official transcript certified July 24, 2026. Master level Water Resources Engineering classes, design studio, and research credits are listed. Plains Engineering Graduate Council accredits the college in Oklahoma.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Red River Graduate College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-07-24', fieldOfStudy: 'Water Resources Engineering', degreeLevel: 'Master', accreditingBody: 'Plains Engineering Graduate Council', jurisdiction: 'Oklahoma', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/water-resources', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-008', description: 'Official doctorate-level social policy transcript',
    strippedText: 'KEYSTONE UNIVERSITY Graduate Registrar certifies [STUDENT_REDACTED]’s official record on August 22, 2026. Doctorate level Social Policy seminars, comprehensive review, and dissertation registration are included. Mid-Atlantic Universities Commission accredits the institution in Pennsylvania.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Keystone University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-08-22', fieldOfStudy: 'Social Policy', degreeLevel: 'Doctorate', accreditingBody: 'Mid-Atlantic Universities Commission', jurisdiction: 'Pennsylvania', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/social-policy', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-009', description: 'OCR-degraded official graduate transcript',
    strippedText: 'SlLVER FERN GRADUATE ACADEMY certifies [STUDENT_REDACTED]’s official record on September 20, 2026. OCR substitutions affect the seal text; Master level Conservation Finance remains legible. Mountain Graduate Schools Commission accredits the academy in Colorado.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Silver Fern Graduate Academy', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-09-20', fieldOfStudy: 'Conservation Finance', degreeLevel: 'Master', accreditingBody: 'Mountain Graduate Schools Commission', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-010', description: 'Graduate transcript with modular and semester courses',
    strippedText: 'GULF COAST POLICY UNIVERSITY issues an official graduate transcript for [STUDENT_REDACTED] on October 23, 2026. Modular intensives and semester courses together satisfy Master level Emergency Management. Gulf Graduate Education Council accredits the university in Florida.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Gulf Coast Policy University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-10-23', fieldOfStudy: 'Emergency Management', degreeLevel: 'Master', accreditingBody: 'Gulf Graduate Education Council', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/multi-course', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'edge', 'multi-course'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-011', description: 'Graduate transcript with defense-date trap',
    strippedText: 'NORTH WOODS UNIVERSITY releases [STUDENT_REDACTED]’s official graduate transcript on November 26, 2026. October 7 marks the thesis defense and is not transcript issuance. Master level Rural Economics; Northern Graduate Accreditation Board; Minnesota jurisdiction.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'North Woods University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-11-26', fieldOfStudy: 'Rural Economics', degreeLevel: 'Master', accreditingBody: 'Northern Graduate Accreditation Board', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EGT-012', description: 'Official graduate transcript captioned research certificate',
    strippedText: 'RESEARCH CERTIFICATE is the archive label, but GOLDEN VALLEY UNIVERSITY provides [STUDENT_REDACTED] a registrar-sealed official graduate transcript on December 21, 2026. Doctorate level Agricultural Genomics; Western Research Education Commission; California jurisdiction.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'official_graduate', issuerName: 'Golden Valley University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-12-21', fieldOfStudy: 'Agricultural Genomics', degreeLevel: 'Doctorate', accreditingBody: 'Western Research Education Commission', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-07-official-graduate-transcript/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'official-graduate-transcript', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_UNOFFICIAL_TRANSCRIPTS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EUN-001', description: 'Unofficial bachelor-level economics transcript',
    strippedText: 'OAK MEADOW UNIVERSITY student portal generates an unofficial transcript for [STUDENT_REDACTED] on January 18, 2026. The advising copy lists Bachelor level Economics coursework and cumulative standing without a registrar seal. Central Collegiate Commission accredits the institution in Missouri.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Oak Meadow University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-01-18', fieldOfStudy: 'Economics', degreeLevel: 'Bachelor', accreditingBody: 'Central Collegiate Commission', jurisdiction: 'Missouri', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/economics', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-002', description: 'Unofficial associate-level culinary transcript',
    strippedText: 'BAYOU TECHNICAL COLLEGE creates [STUDENT_REDACTED]’s unofficial academic record on February 15, 2026 for advising use. Associate level Culinary Operations courses and kitchen practica appear without institutional certification. Gulf Career Colleges Board accredits the school in Louisiana.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Bayou Technical College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-02-15', fieldOfStudy: 'Culinary Operations', degreeLevel: 'Associate', accreditingBody: 'Gulf Career Colleges Board', jurisdiction: 'Louisiana', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/culinary-operations', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-003', description: 'Unofficial master-level supply chain transcript',
    strippedText: 'PRAIRIE COMMERCE UNIVERSITY exports an unofficial transcript for [STUDENT_REDACTED] on March 18, 2026. The self-service record displays Master level Supply Chain Strategy classes and current progress. Plains Business Education Council accredits the university in Kansas.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Prairie Commerce University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-03-18', fieldOfStudy: 'Supply Chain Strategy', degreeLevel: 'Master', accreditingBody: 'Plains Business Education Council', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/supply-chain', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-004', description: 'Unofficial bachelor-level architecture transcript',
    strippedText: 'COAST RANGE SCHOOL OF DESIGN produces [STUDENT_REDACTED] an unofficial transcript dated April 14, 2026. Bachelor level Architecture studios and technical courses are visible, while the page states it is not certified. Western Design Schools Commission accredits the school in Oregon.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Coast Range School of Design', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-04-14', fieldOfStudy: 'Architecture', degreeLevel: 'Bachelor', accreditingBody: 'Western Design Schools Commission', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/architecture', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-005', description: 'Unofficial bachelor-level information security transcript',
    strippedText: 'NORTH CHANNEL TECHNOLOGY COLLEGE portal prints an unofficial student record for [STUDENT_REDACTED] on May 21, 2026. Bachelor level Information Security courses and in-progress credits are included. Great Lakes Technical Accreditation Council accredits the college in Michigan.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'North Channel Technology College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-05-21', fieldOfStudy: 'Information Security', degreeLevel: 'Bachelor', accreditingBody: 'Great Lakes Technical Accreditation Council', jurisdiction: 'Michigan', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/information-security', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-006', description: 'Unofficial doctorate-level education transcript',
    strippedText: 'BLUEGRASS GRADUATE COLLEGE gives [STUDENT_REDACTED] an unofficial progress transcript on June 17, 2026. Doctorate level Curriculum Studies seminars and dissertation enrollment appear in the unsigned record. Appalachian Graduate Education Board accredits the college in Kentucky.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Bluegrass Graduate College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-06-17', fieldOfStudy: 'Curriculum Studies', degreeLevel: 'Doctorate', accreditingBody: 'Appalachian Graduate Education Board', jurisdiction: 'Kentucky', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/curriculum-studies', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-007', description: 'Unofficial associate-level emergency services transcript',
    strippedText: 'TIDE COUNTRY COMMUNITY COLLEGE downloads an unofficial advising record for [STUDENT_REDACTED] on July 15, 2026. Associate level Emergency Services courses and clinical credits are shown. Atlantic Community Colleges Association accredits the institution in Virginia.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Tide Country Community College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-07-15', fieldOfStudy: 'Emergency Services', degreeLevel: 'Associate', accreditingBody: 'Atlantic Community Colleges Association', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/emergency-services', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-008', description: 'Unofficial bachelor-level environmental policy transcript',
    strippedText: 'EVERGREEN BASIN UNIVERSITY generates [STUDENT_REDACTED]’s unofficial portal transcript on August 19, 2026. Bachelor level Environmental Policy classes and transferred units appear with an unofficial watermark. Northwest Universities Commission accredits the university in Washington.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Evergreen Basin University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-08-19', fieldOfStudy: 'Environmental Policy', degreeLevel: 'Bachelor', accreditingBody: 'Northwest Universities Commission', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/environmental-policy', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-009', description: 'OCR-degraded unofficial transcript',
    strippedText: 'SUN C0AST C0LLEGE portal record for [STUDENT_REDACTED] was generated September 16, 2026. OCR affects the watermark and school heading, while Bachelor level Tourism Management remains readable. Gulf States Collegiate Commission accredits the college in Florida.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Sun Coast College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-09-16', fieldOfStudy: 'Tourism Management', degreeLevel: 'Bachelor', accreditingBody: 'Gulf States Collegiate Commission', jurisdiction: 'Florida', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-010', description: 'Unofficial transcript with mixed academic calendars',
    strippedText: 'FRONTIER ARTS UNIVERSITY supplies [STUDENT_REDACTED] an unofficial transcript on October 13, 2026. Quarter, summer block, and semester courses jointly support Bachelor level Digital Media. Mountain Arts Education Council accredits the university in Colorado.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Frontier Arts University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-10-13', fieldOfStudy: 'Digital Media', degreeLevel: 'Bachelor', accreditingBody: 'Mountain Arts Education Council', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/multi-course', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'edge', 'multi-course'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-011', description: 'Unofficial transcript with term-date trap',
    strippedText: 'COPPER PLAINS UNIVERSITY generates an unofficial transcript for [STUDENT_REDACTED] on November 18, 2026. August 24 is the fall-term opening date, not the record issue date. Bachelor level Agribusiness; Southwest Collegiate Review Board; Arizona jurisdiction.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Copper Plains University', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-11-18', fieldOfStudy: 'Agribusiness', degreeLevel: 'Bachelor', accreditingBody: 'Southwest Collegiate Review Board', jurisdiction: 'Arizona', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EUN-012', description: 'Unofficial record labeled official transcript preview',
    strippedText: 'OFFICIAL TRANSCRIPT PREVIEW is the portal button, but PRAIRIE LAKE COLLEGE marks the downloaded [STUDENT_REDACTED] record unofficial and unsigned. It was generated December 15, 2026. Associate level Veterinary Technology; Midwest Career Education Council; Minnesota jurisdiction.',
    credentialTypeHint: 'TRANSCRIPT', groundTruth: { credentialType: 'TRANSCRIPT', subType: 'unofficial', issuerName: 'Prairie Lake College', recipientIdentifier: '[STUDENT_REDACTED]', issuedDate: '2026-12-15', fieldOfStudy: 'Veterinary Technology', degreeLevel: 'Associate', accreditingBody: 'Midwest Career Education Council', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-08-unofficial-transcript/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'unofficial-transcript', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_HIGH_SCHOOL_DIPLOMAS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EHD-001', description: 'Comprehensive high school diploma',
    strippedText: 'CEDAR GROVE HIGH SCHOOL awards [GRADUATE_REDACTED] a completion diploma on January 30, 2026 after satisfying the comprehensive secondary curriculum. Diploma EHD-26015 is recognized by the Iowa Secondary Schools Commission within Iowa jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Cedar Grove High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-01-30', fieldOfStudy: 'High School Diploma', licenseNumber: 'EHD-26015', accreditingBody: 'Iowa Secondary Schools Commission', jurisdiction: 'Iowa', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/comprehensive', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-002', description: 'STEM academy high school diploma',
    strippedText: 'CASCADE STEM ACADEMY confers a secondary completion diploma upon [GRADUATE_REDACTED] on February 27, 2026. Identifier EHD-26032 records a science and engineering emphasis. Northwest Independent Schools Council accredits the academy in Washington.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Cascade STEM Academy', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-02-27', fieldOfStudy: 'STEM High School Diploma', licenseNumber: 'EHD-26032', accreditingBody: 'Northwest Independent Schools Council', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/stem-academy', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-003', description: 'Classical studies high school diploma',
    strippedText: 'BLUE HARBOR PREPARATORY SCHOOL certifies [GRADUATE_REDACTED]’s secondary completion on March 28, 2026. Diploma EHD-26050 reflects a classical studies pathway. New England Preparatory Accreditation Board recognizes the school in Massachusetts jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Blue Harbor Preparatory School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-03-28', fieldOfStudy: 'Classical Studies High School Diploma', licenseNumber: 'EHD-26050', accreditingBody: 'New England Preparatory Accreditation Board', jurisdiction: 'Massachusetts', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/classical-studies', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-004', description: 'Technical pathway high school diploma',
    strippedText: 'RED CLAY CAREER HIGH SCHOOL issues [GRADUATE_REDACTED] diploma EHD-26066 on April 25, 2026 for completed secondary and technical requirements. The pathway emphasizes advanced manufacturing. Southern Career Schools Authority accredits the school in Alabama.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Red Clay Career High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-04-25', fieldOfStudy: 'Technical High School Diploma', licenseNumber: 'EHD-26066', accreditingBody: 'Southern Career Schools Authority', jurisdiction: 'Alabama', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/technical-pathway', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-005', description: 'Arts conservatory high school diploma',
    strippedText: 'HUDSON VALLEY ARTS HIGH SCHOOL grants [GRADUATE_REDACTED] a secondary diploma in the visual arts pathway on May 29, 2026. Credential EHD-26081 confirms completion. New York Independent Education Council accredits the school in New York jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Hudson Valley Arts High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-05-29', fieldOfStudy: 'Arts High School Diploma', licenseNumber: 'EHD-26081', accreditingBody: 'New York Independent Education Council', jurisdiction: 'New York', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/arts-conservatory', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-006', description: 'Agricultural sciences high school diploma',
    strippedText: 'SUN PRAIRIE REGIONAL SCHOOL awards [GRADUATE_REDACTED] diploma EHD-26097 on June 26, 2026 after an agricultural sciences secondary program. The Kansas School Quality Commission accredits the institution within Kansas jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Sun Prairie Regional School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-06-26', fieldOfStudy: 'Agricultural Sciences High School Diploma', licenseNumber: 'EHD-26097', accreditingBody: 'Kansas School Quality Commission', jurisdiction: 'Kansas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/agricultural-sciences', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-007', description: 'International studies high school diploma',
    strippedText: 'COASTAL PINES SECONDARY ACADEMY recognizes [GRADUATE_REDACTED] with diploma EHD-26112 on July 31, 2026 for the international studies pathway. Atlantic Secondary Education Association accredits the academy under North Carolina jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Coastal Pines Secondary Academy', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-07-31', fieldOfStudy: 'International Studies High School Diploma', licenseNumber: 'EHD-26112', accreditingBody: 'Atlantic Secondary Education Association', jurisdiction: 'North Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/international-studies', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-008', description: 'Public service high school diploma',
    strippedText: 'GREAT BASIN CIVIC HIGH SCHOOL confers diploma EHD-26128 upon [GRADUATE_REDACTED] on August 28, 2026. The completed program carries a public service emphasis. Nevada Secondary Accreditation Council recognizes the school within Nevada jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Great Basin Civic High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-08-28', fieldOfStudy: 'Public Service High School Diploma', licenseNumber: 'EHD-26128', accreditingBody: 'Nevada Secondary Accreditation Council', jurisdiction: 'Nevada', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/public-service', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-009', description: 'OCR-degraded high school diploma',
    strippedText: 'M0UNTAlN BR00K HlGH SCH00L awards [GRADUATE_REDACTED] diploma EHD-26143 on September 25, 2026. OCR substitutions affect the school name, not the secondary completion language. Colorado School Standards Board accredits the institution in Colorado.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Mountain Brook High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-09-25', fieldOfStudy: 'High School Diploma', licenseNumber: 'EHD-26143', accreditingBody: 'Colorado School Standards Board', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-010', description: 'Diploma with embossed-seal text noise',
    strippedText: 'PALMETTO RIVER HIGH SCHOOL issues EHD-26159 to [GRADUATE_REDACTED] on October 30, 2026 for college-preparatory completion. An embossed seal obscures two decorative words but not the award. South Carolina School Accreditation Board; South Carolina jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Palmetto River High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-10-30', fieldOfStudy: 'College Preparatory High School Diploma', licenseNumber: 'EHD-26159', accreditingBody: 'South Carolina School Accreditation Board', jurisdiction: 'South Carolina', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/stamp-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'edge', 'stamp-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-011', description: 'Diploma with commencement-date trap',
    strippedText: 'REDWOOD COAST SECONDARY SCHOOL awards [GRADUATE_REDACTED] diploma EHD-26175 on November 27, 2026. December 12 is the commencement ceremony, not issuance. California Independent Schools Commission accredits the Environmental Studies diploma in California.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Redwood Coast Secondary School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-11-27', fieldOfStudy: 'Environmental Studies High School Diploma', licenseNumber: 'EHD-26175', accreditingBody: 'California Independent Schools Commission', jurisdiction: 'California', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EHD-012', description: 'Diploma portal-labeled attendance certificate',
    strippedText: 'ATTENDANCE CERTIFICATE labels the archive image, yet BLUE SPRUCE HIGH SCHOOL expressly grants [GRADUATE_REDACTED] diploma EHD-26191 for complete secondary requirements on December 30, 2026. Rocky Mountain School Commission; Colorado jurisdiction; General High School Diploma.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'completion_certificate', issuerName: 'Blue Spruce High School', recipientIdentifier: '[GRADUATE_REDACTED]', issuedDate: '2026-12-30', fieldOfStudy: 'General High School Diploma', licenseNumber: 'EHD-26191', accreditingBody: 'Rocky Mountain School Commission', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-09-high-school-diploma/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'high-school-diploma', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

const EDUCATION_PROFESSIONAL_CERTIFICATIONS: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-W2-EPC-001', description: 'Certified water systems analyst credential',
    strippedText: 'NATIONAL WATER SYSTEMS INSTITUTE certifies [PROFESSIONAL_REDACTED] as a Water Systems Analyst. Credential EPC-26013 issued January 16, 2026 remains valid through January 31, 2029. Infrastructure Certification Standards Council accredits the program in Colorado jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'National Water Systems Institute', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-01-16', expiryDate: '2029-01-31', fieldOfStudy: 'Water Systems Analysis', licenseNumber: 'EPC-26013', accreditingBody: 'Infrastructure Certification Standards Council', jurisdiction: 'Colorado', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/water-systems-analyst', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-002', description: 'Supply network planning certification',
    strippedText: 'AMERICAN SUPPLY NETWORK COUNCIL awards [PROFESSIONAL_REDACTED] the Supply Network Planner certification. EPC-26030 began February 19, 2026 and expires February 28, 2029. Professional Operations Accreditation Board recognizes the program under Illinois jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'American Supply Network Council', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-02-19', expiryDate: '2029-02-28', fieldOfStudy: 'Supply Network Planning', licenseNumber: 'EPC-26030', accreditingBody: 'Professional Operations Accreditation Board', jurisdiction: 'Illinois', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/supply-network-planning', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-003', description: 'Community resilience specialist certification',
    strippedText: 'RESILIENCE PRACTICE ASSOCIATION designates [PROFESSIONAL_REDACTED] a Community Resilience Specialist. Certificate EPC-26046 was issued March 25, 2026 with renewal due March 31, 2029. Public Service Credentialing Commission accredits it in Virginia jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Resilience Practice Association', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-03-25', expiryDate: '2029-03-31', fieldOfStudy: 'Community Resilience', licenseNumber: 'EPC-26046', accreditingBody: 'Public Service Credentialing Commission', jurisdiction: 'Virginia', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/community-resilience', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-004', description: 'Clinical data quality certification',
    strippedText: 'CLINICAL INFORMATION QUALITY BOARD certifies [PROFESSIONAL_REDACTED] in Clinical Data Quality. Credential EPC-26061 carries an April 22, 2026 issue date and April 30, 2029 expiration. Health Information Credentialing Alliance accredits the certification in Minnesota.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Clinical Information Quality Board', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-04-22', expiryDate: '2029-04-30', fieldOfStudy: 'Clinical Data Quality', licenseNumber: 'EPC-26061', accreditingBody: 'Health Information Credentialing Alliance', jurisdiction: 'Minnesota', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/clinical-data-quality', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-005', description: 'Sustainable facilities certification',
    strippedText: 'GREEN FACILITIES PROFESSIONAL SOCIETY recognizes [PROFESSIONAL_REDACTED] as a Sustainable Facilities Strategist. Certificate EPC-26077 issued May 20, 2026 is current until May 31, 2029. Built Environment Accreditation Council recognizes it in Oregon jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Green Facilities Professional Society', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-05-20', expiryDate: '2029-05-31', fieldOfStudy: 'Sustainable Facilities Strategy', licenseNumber: 'EPC-26077', accreditingBody: 'Built Environment Accreditation Council', jurisdiction: 'Oregon', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/sustainable-facilities', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-006', description: 'Agricultural risk management certification',
    strippedText: 'AGRICULTURAL RISK INSTITUTE grants [PROFESSIONAL_REDACTED] the Agricultural Risk Manager certification. Number EPC-26092 began June 24, 2026 and requires renewal by June 30, 2029. Rural Finance Credentialing Board accredits the program in Iowa.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Agricultural Risk Institute', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-06-24', expiryDate: '2029-06-30', fieldOfStudy: 'Agricultural Risk Management', licenseNumber: 'EPC-26092', accreditingBody: 'Rural Finance Credentialing Board', jurisdiction: 'Iowa', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/agricultural-risk', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-007', description: 'Digital accessibility specialist certification',
    strippedText: 'ACCESSIBLE TECHNOLOGY STANDARDS GROUP certifies [PROFESSIONAL_REDACTED] as a Digital Accessibility Specialist. EPC-26107 issued July 22, 2026 expires July 31, 2029. Inclusive Technology Accreditation Forum recognizes the credential within Washington jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Accessible Technology Standards Group', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-07-22', expiryDate: '2029-07-31', fieldOfStudy: 'Digital Accessibility', licenseNumber: 'EPC-26107', accreditingBody: 'Inclusive Technology Accreditation Forum', jurisdiction: 'Washington', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/digital-accessibility', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-008', description: 'Municipal finance analysis certification',
    strippedText: 'MUNICIPAL FINANCE PRACTICE COUNCIL awards [PROFESSIONAL_REDACTED] certification as a Public Finance Analyst. Credential EPC-26123 was issued August 26, 2026 and remains valid to August 31, 2029. Government Finance Credentialing Commission accredits it in Ohio.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Municipal Finance Practice Council', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-08-26', expiryDate: '2029-08-31', fieldOfStudy: 'Public Finance Analysis', licenseNumber: 'EPC-26123', accreditingBody: 'Government Finance Credentialing Commission', jurisdiction: 'Ohio', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/municipal-finance', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'clean'], provenance: 'authored-s33-lane4', edgeCase: false, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-009', description: 'OCR-degraded professional certification',
    strippedText: 'C0ASTAL RlSK PR0FESSl0NALS certifies [PROFESSIONAL_REDACTED] in Marine Risk Assessment under EPC-26138. Issued September 23, 2026; expires September 30, 2029. OCR affects the heading only. Maritime Credentialing Standards Council; Maine jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Coastal Risk Professionals', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-09-23', expiryDate: '2029-09-30', fieldOfStudy: 'Marine Risk Assessment', licenseNumber: 'EPC-26138', accreditingBody: 'Maritime Credentialing Standards Council', jurisdiction: 'Maine', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/ocr-noise', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'edge', 'ocr-noise'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-010', description: 'Certification with examination-date trap',
    strippedText: 'DATA STEWARDSHIP ASSOCIATION grants [PROFESSIONAL_REDACTED] credential EPC-26154 on October 28, 2026, valid through October 31, 2029. October 3 was the examination date, not issuance. Information Governance Accreditation Board; Delaware jurisdiction; Data Stewardship field.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Data Stewardship Association', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-10-28', expiryDate: '2029-10-31', fieldOfStudy: 'Data Stewardship', licenseNumber: 'EPC-26154', accreditingBody: 'Information Governance Accreditation Board', jurisdiction: 'Delaware', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/date-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'edge', 'date-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-011', description: 'Certification administered by a testing vendor',
    strippedText: 'PUBLIC PROCUREMENT CERTIFICATION BOARD issues EPC-26170 to [PROFESSIONAL_REDACTED] on November 25, 2026, valid through November 30, 2029. Granite Testing Services administered the exam but is not issuer. Procurement Standards Accreditation Council; Pennsylvania jurisdiction.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Public Procurement Certification Board', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-11-25', expiryDate: '2029-11-30', fieldOfStudy: 'Public Procurement', licenseNumber: 'EPC-26170', accreditingBody: 'Procurement Standards Accreditation Council', jurisdiction: 'Pennsylvania', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/ambiguous-provider', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'edge', 'ambiguous-provider'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-W2-EPC-012', description: 'Professional certification labeled course completion',
    strippedText: 'COURSE COMPLETION appears in the portal header, but ENERGY OPERATIONS CREDENTIALING INSTITUTE awards [PROFESSIONAL_REDACTED] renewable certification EPC-26186. Issued December 23, 2026; expires December 31, 2029. Energy Workforce Accreditation Council; Texas jurisdiction; Grid Operations field.',
    credentialTypeHint: 'CERTIFICATE', groundTruth: { credentialType: 'CERTIFICATE', subType: 'professional_certification', issuerName: 'Energy Operations Credentialing Institute', recipientIdentifier: '[PROFESSIONAL_REDACTED]', issuedDate: '2026-12-23', expiryDate: '2029-12-31', fieldOfStudy: 'Grid Operations', licenseNumber: 'EPC-26186', accreditingBody: 'Energy Workforce Accreditation Council', jurisdiction: 'Texas', fraudSignals: [] },
    source: 'authored/s33-wave2/top15-06-10/education-10-professional-certification/hint-trap', category: 's33-wave2-top15-heldout', tags: ['held-out', 's33', 'authored', 'top15', 'education', 'professional-certification', 'edge', 'hint-trap'], provenance: 'authored-s33-lane4', edgeCase: true, jurisdictionSlice: 'US',
  },
];

export const S33_WAVE2_TOP15_06_10_HELDOUT: S33HeldoutEntry[] = [
  ...LEGAL_COURT_ORDERS,
  ...LEGAL_CUSTODY_DIVORCE_DECREES,
  ...LEGAL_AFFIDAVITS_DECLARATIONS,
  ...LEGAL_POWERS_OF_ATTORNEY,
  ...LEGAL_BAR_ADMISSIONS,
  ...FINANCIAL_AID_AWARDS,
  ...FINANCIAL_TAX_RETURNS_ASSESSMENTS,
  ...FINANCIAL_AUDIT_REPORTS,
  ...FINANCIAL_STATEMENTS,
  ...FINANCIAL_SEC_10K_FILINGS,
  ...EDUCATION_OFFICIAL_UNDERGRADUATE_TRANSCRIPTS,
  ...EDUCATION_OFFICIAL_GRADUATE_TRANSCRIPTS,
  ...EDUCATION_UNOFFICIAL_TRANSCRIPTS,
  ...EDUCATION_HIGH_SCHOOL_DIPLOMAS,
  ...EDUCATION_PROFESSIONAL_CERTIFICATIONS,
];
