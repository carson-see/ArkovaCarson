/**
 * S3.3 Lane 4 held-out corpus — OOD-negative slice for abstention scoring
 * (SCRUM-2677 stretch item, CTO R5: abstention class + coverage-accuracy).
 *
 * These documents are deliberately OUTSIDE the credential taxonomy: the
 * correct model behavior is to classify them as OTHER (subType "other")
 * rather than force-fit a credential type. Forced N-way classification on
 * novel documents produces confident garbage (research brief §4); this slice
 * exists to score abstention. Several entries carry deliberately misleading
 * credentialTypeHint values (tag `hint-trap`) modeling a user picking the
 * wrong type at upload.
 *
 * Two entries double as Kenya doc-inventory coverage (NTSA-style vehicle
 * logbook, Ardhi land title) — they are counted HERE, not toward the KE >=10
 * credential floor, because their ground truth is abstention.
 *
 * Zero raw PII; fictional people/orgs; [X_REDACTED] placeholders throughout.
 * Acceptance: Lane 3 (CTO R12).
 */

import type { S33HeldoutEntry } from './golden-dataset-s33-types.js';

export const S33_OOD_NEGATIVES: S33HeldoutEntry[] = [
  {
    id: 'GD-S33-OOD-001',
    description: 'Electricity utility bill uploaded with a CERTIFICATE hint',
    strippedText:
      'SAVANNA POWER & LIGHTING COMPANY — ELECTRICITY BILL. Account: [ACCOUNT_REDACTED]. Customer: [NAME_REDACTED]. Billing Period: 01/05/2026 to 31/05/2026. Meter Reading (previous): 48211. Meter Reading (current): 48540. Consumption: 329 kWh. Fuel cost charge, forex adjustment, and VAT itemised below. Total Due: [AMOUNT_REDACTED]. Due Date: 14/06/2026. Pay via paybill or at any customer service centre.',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'Savanna Power & Lighting Company',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/utility-bill',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'hint-trap'],
    provenance: 'authored-s33-lane4',
    edgeCase: true,
    jurisdictionSlice: 'KE',
  },
  {
    id: 'GD-S33-OOD-002',
    description: 'Airline boarding pass',
    strippedText:
      'BOARDING PASS — KITE STRING AIRWAYS. Passenger: [NAME_REDACTED]. Flight: KS 412. From: Sydney (SYD) To: Nairobi (NBO) via Perth. Date: 22 May 2026. Boarding Time: 08:40. Gate: 23. Seat: 34C. Class: Economy. Booking Reference: [PNR_REDACTED]. Frequent flyer tier benefits do not apply on this fare. Baggage allowance: 23kg.',
    credentialTypeHint: 'OTHER',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'Kite String Airways',
      issuedDate: '2026-05-22',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/boarding-pass',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention'],
    provenance: 'authored-s33-lane4',
    edgeCase: false,
    jurisdictionSlice: 'AU',
  },
  {
    id: 'GD-S33-OOD-003',
    description: 'Restaurant tax invoice / receipt',
    strippedText:
      'TAX INVOICE — THE COPPER KETTLE BISTRO. Table 9. Server: [NAME_REDACTED]. Date: 03/04/2026 19:42. 1x Slow Roasted Lamb Shoulder; 2x Garden Salad; 1x Sparkling Water 750ml; 2x Flat White. Subtotal, service charge (10%), and tax itemised. Total: [AMOUNT_REDACTED]. Payment: card ending [REDACTED]. Thank you for dining with us — no refunds on discounted items.',
    credentialTypeHint: 'OTHER',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'The Copper Kettle Bistro',
      issuedDate: '2026-04-03',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/restaurant-receipt',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention'],
    provenance: 'authored-s33-lane4',
    edgeCase: false,
    jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-OOD-004',
    description: 'Kenya vehicle registration logbook (NTSA-style) — outside credential taxonomy',
    strippedText:
      'REPUBLIC OF KENYA — NATIONAL TRANSPORT AND SAFETY AUTHORITY. MOTOR VEHICLE REGISTRATION CERTIFICATE (LOGBOOK). Registration Number: [PLATE_REDACTED]. Chassis/Frame Number: [CHASSIS_REDACTED]. Make: Toyota. Model: Hilux. Year of Manufacture: 2019. Engine Capacity: 2400cc. Fuel: Diesel. Registered Owner: [NAME_REDACTED]. Date of Registration: 07/08/2023. Duplicate logbook issued 15/01/2026 following owner application. Transfer of ownership must be recorded through the NTSA TIMS portal.',
    credentialTypeHint: 'LICENSE',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'National Transport and Safety Authority',
      issuedDate: '2026-01-15',
      jurisdiction: 'Kenya',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/ke-ntsa-logbook',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'ke', 'hint-trap'],
    provenance: 'authored-s33-lane4',
    edgeCase: true,
    jurisdictionSlice: 'KE',
  },
  {
    id: 'GD-S33-OOD-005',
    description: 'Kenya land title (Ardhi-register style) — outside credential taxonomy',
    strippedText:
      'REPUBLIC OF KENYA — MINISTRY OF LANDS. CERTIFICATE OF TITLE issued under the Land Registration Act, 2012. Title Number: NAIROBI/BLOCK[REDACTED]/1204. Proprietor: [NAME_REDACTED], of P.O. Box [REDACTED], Nairobi. Nature of Title: Absolute. Approximate Area: 0.045 hectares. Encumbrances: Charge registered in favour of [BANK_REDACTED] on 21/10/2024. Registered on 18/06/2021 at the Nairobi Land Registry. Land Registrar. Entries may be verified on the Ardhisasa platform.',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'Ministry of Lands',
      issuedDate: '2021-06-18',
      jurisdiction: 'Kenya',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/ke-land-title',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'ke', 'hint-trap'],
    provenance: 'authored-s33-lane4',
    edgeCase: true,
    jurisdictionSlice: 'KE',
  },
  {
    id: 'GD-S33-OOD-006',
    description: 'Hotel folio invoice with GST line items',
    strippedText:
      'GUEST FOLIO — WATTLE & BAY HOTEL, MELBOURNE. Guest: [NAME_REDACTED]. Room: 1108, King Deluxe. Arrival: 11/03/2026. Departure: 14/03/2026. Nightly rate x 3, minibar, valet parking, and late checkout fee itemised. GST included in total. Folio Number: WB-118842. Payment received in full on departure. ABN: 51 316 044 882. We hope you enjoyed your stay.',
    credentialTypeHint: 'OTHER',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'Wattle & Bay Hotel',
      issuedDate: '2026-03-14',
      jurisdiction: 'Australia',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/au-hotel-folio',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'au'],
    provenance: 'authored-s33-lane4',
    edgeCase: false,
    jurisdictionSlice: 'AU',
  },
  {
    id: 'GD-S33-OOD-007',
    description: 'Gym membership welcome letter — near the PROFESSIONAL/membership boundary',
    strippedText:
      'WELCOME TO IRONBARK FITNESS CLUB. Dear [NAME_REDACTED], your 12-month membership starts on 01/02/2026 and renews automatically unless cancelled with 30 days notice. Membership tier: Gold — includes group classes, sauna, and one guest pass per month. Direct debit of the monthly fee begins 01/03/2026. Your access band will be issued at reception on your first visit. Please bring photo identification. See you at the club.',
    credentialTypeHint: 'PROFESSIONAL',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'Ironbark Fitness Club',
      issuedDate: '2026-02-01',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/gym-membership-letter',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'hint-trap'],
    provenance: 'authored-s33-lane4',
    edgeCase: true,
    jurisdictionSlice: 'US',
  },
  {
    id: 'GD-S33-OOD-008',
    description: 'Product warranty registration confirmation',
    strippedText:
      'WARRANTY REGISTRATION CONFIRMED. Product: TorrentFlow 2200W Pressure Washer. Serial: [SERIAL_REDACTED]. Purchaser: [NAME_REDACTED]. Purchase Date: 09/04/2026. Retailer: Hardware Barn. Warranty Term: 3 years parts and labour from date of purchase, registered under our consumer guarantee program. Keep your receipt; proof of purchase is required for claims. Manufacturer: Cascade Outdoor Equipment Pty Ltd.',
    credentialTypeHint: 'CERTIFICATE',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'Cascade Outdoor Equipment Pty Ltd',
      issuedDate: '2026-04-09',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/warranty-registration',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'hint-trap'],
    provenance: 'authored-s33-lane4',
    edgeCase: true,
    jurisdictionSlice: 'AU',
  },
  {
    id: 'GD-S33-OOD-009',
    description: 'Conference registration confirmation (no credit awarded) with a CPE hint',
    strippedText:
      'REGISTRATION CONFIRMATION — LEDGERCON 2026. Registrant: [NAME_REDACTED]. Confirmation Code: LC26-77412. Package: Full Conference Pass (3 days) + Networking Dinner. Venue: Riverside Convention Centre. Dates: 16-18 September 2026. This email confirms payment and registration only. Continuing education certificates, where applicable, are issued separately AFTER the event based on verified session attendance. Badge pickup opens at 07:30 daily.',
    credentialTypeHint: 'CPE',
    groundTruth: {
      credentialType: 'OTHER',
      subType: 'other',
      issuerName: 'LedgerCon',
      issuedDate: '2026-09-16',
      fraudSignals: [],
    },
    source: 'authored/s33-lane4/ood/conference-registration',
    category: 's33-ood-negative',
    tags: ['held-out', 's33', 'authored', 'ood', 'abstention', 'hard', 'hint-trap'],
    provenance: 'authored-s33-lane4',
    edgeCase: true,
    jurisdictionSlice: 'US',
  },
];
