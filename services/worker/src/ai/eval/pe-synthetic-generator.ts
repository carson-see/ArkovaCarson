/**
 * Synthetic professional-education TRAIN-split generator (SCRUM-2200 Track A).
 *
 * Produces thousands of CPE/CLE certificate entries whose ground truth is
 * emitted *by construction* — the fields are sampled first, then the
 * certificate text is rendered around them, so every label is correct for
 * free. This is the scale lever: hand-labeling thousands of real documents is
 * the bottleneck, but synthetic data carries perfect labels at no labeling
 * cost.
 *
 * Realism, not toy data: the pools below are seeded from real NASBA fields of
 * study, real NASBA delivery methods, real CPE/CLE provider names, and real
 * course-ID shapes. Text is varied across templates, label phrasings, date
 * formats, optional-field presence, and (for a minority) light OCR noise, so a
 * model trained on this set sees the surface variation real scans exhibit.
 *
 * SPLIT DISCIPLINE (critical):
 *  - This is the TRAIN split. It is NEVER scored by the merge gates
 *    (eval-gates.ts excludes the `synthetic-train` tag) and NEVER reported as
 *    model quality. Reported quality comes only from the curated gate fixtures
 *    and the real held-out TEST set (golden-dataset-pe-heldout.ts + future
 *    prod-harvest split).
 *  - Synthetic-only training has a ceiling bounded by how faithfully this
 *    generator mimics real document messiness. The real held-out set is the
 *    early-warning system for that gap — do not treat high synthetic scores as
 *    proof of quality.
 *
 * PII rule (Constitution §1.6): rendered text models the on-device-stripped
 * payload. Individual names are always the [NAME_REDACTED] placeholder; no raw
 * email/SSN/phone is ever emitted.
 */

import type { GoldenDatasetEntry, GroundTruthFields } from './types.js';

export interface PeSyntheticOptions {
  /** Number of entries to generate. */
  count: number;
  /** Seed for reproducible output. Same seed + count + mix → identical set. */
  seed?: number;
  /** Credential mix. Defaults to an even CPE/CLE split. Values are normalized. */
  mix?: { cpe: number; cle: number };
}

/** Deterministic PRNG (mulberry32) — no external deps, fully reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const PAD = (n: number, width: number) => String(n).padStart(width, '0');

// --- Realistic public metadata pools ---------------------------------------

interface ProviderSeed {
  name: string;
  code: string;
}

const CPE_PROVIDERS: readonly ProviderSeed[] = [
  { name: 'AICPA', code: 'AICPA' },
  { name: 'Becker', code: 'BECKER' },
  { name: 'Surgent', code: 'SURGENT' },
  { name: 'Gleim', code: 'GLEIM' },
  { name: 'Wiley', code: 'WILEY' },
  { name: 'KPMG Executive Education', code: 'KPMG' },
  { name: 'PwC', code: 'PWC' },
  { name: 'Western CPE', code: 'WCPE' },
  { name: 'CPE Inc', code: 'CPEINC' },
  { name: 'Ohio Society of CPAs', code: 'OSCPA' },
  { name: 'California Society of CPAs', code: 'CALCPA' },
  { name: 'Illinois CPA Society', code: 'ICPAS' },
];

const CLE_PROVIDERS: readonly ProviderSeed[] = [
  { name: 'Practising Law Institute', code: 'PLI' },
  { name: 'National Institute for Trial Advocacy', code: 'NITA' },
  { name: 'BARBRI', code: 'BARBRI' },
  { name: 'New York State Bar Association', code: 'NYSBA' },
  { name: 'American Bar Association', code: 'ABA' },
  { name: 'Lawline', code: 'LAWLINE' },
  { name: 'National Business Institute', code: 'NBI' },
  { name: 'The Florida Bar', code: 'FLABAR' },
  { name: 'State Bar of Texas', code: 'TXBAR' },
  { name: 'State Bar of California', code: 'CALBAR' },
];

// NASBA official fields of study (subset of the 23) + realistic course titles.
const CPE_FIELDS: readonly { field: string; topic: string; titles: readonly string[] }[] = [
  { field: 'Taxes', topic: 'TAX', titles: ['Advanced Tax Planning Strategies', 'Partnership Taxation Update', 'State & Local Tax Nexus', 'Individual Tax Update'] },
  { field: 'Auditing', topic: 'AUD', titles: ['Advanced Auditing Standards', 'Risk-Based Audit Approaches', 'Audit Sampling Techniques'] },
  { field: 'Accounting', topic: 'ACC', titles: ['Financial Accounting & Reporting Update', 'Lease Accounting Under ASC 842', 'Revenue Recognition Deep Dive'] },
  { field: 'Regulatory Ethics', topic: 'ETH', titles: ['Ethics in Tax Practice', 'CPA Ethics and Independence Update', 'Professional Conduct Standards'] },
  { field: 'Information Technology', topic: 'IT', titles: ['Data Analytics for Auditors', 'Cybersecurity Fundamentals for CPAs', 'Cloud Accounting Systems'] },
  { field: 'Finance', topic: 'FIN', titles: ['Corporate Finance Essentials', 'Valuation Methods for Closely Held Businesses'] },
  { field: 'Management Services', topic: 'MGT', titles: ['Strategic Management for Firms', 'Practice Management Update'] },
];

const CLE_FIELDS: readonly { field: string; topic: string; titles: readonly string[] }[] = [
  { field: 'Trial Advocacy', topic: 'TA', titles: ['Trial Advocacy Intensive', 'Cross-Examination Techniques'] },
  { field: 'Professional Responsibility', topic: 'PR', titles: ['Professional Responsibility & Civility', 'Conflicts of Interest in Practice'] },
  { field: 'Evidence', topic: 'EVID', titles: ['Evidence & Trial Practice', 'Digital Evidence Update'] },
  { field: 'Taxes', topic: 'TAX', titles: ['Tax Controversy & IRS Practice', 'Estate & Gift Tax for Lawyers'] },
  { field: 'Regulatory Compliance', topic: 'REG', titles: ['Anti-Money Laundering Update', 'Securities Regulation Update'] },
  { field: 'Intellectual Property', topic: 'IP', titles: ['Patent Litigation Essentials', 'Trademark Practice Update'] },
  { field: 'Legal Ethics', topic: 'ETH', titles: ['Legal Ethics & Professionalism', 'Attorney-Client Privilege Update'] },
];

const CPE_DELIVERY: readonly { value: string; phrasings: readonly string[] }[] = [
  { value: 'Group Internet Based', phrasings: ['Group Internet Based', 'Group Internet-Based', 'Live Webcast (Group Internet Based)'] },
  { value: 'Group Live', phrasings: ['Group Live', 'In-Person (Group Live)', 'Live Classroom'] },
  { value: 'QAS Self-Study', phrasings: ['QAS Self-Study', 'QAS Self Study'] },
  { value: 'Self-Study', phrasings: ['Self-Study', 'On-demand recorded webcast (no live instructor)', 'Self-Study (online)'] },
  { value: 'Nano-Learning', phrasings: ['Nano-Learning', 'Nano Learning'] },
];

const CLE_DELIVERY: readonly { value: string; phrasings: readonly string[] }[] = [
  { value: 'In-Person', phrasings: ['In-Person', 'Attended in person', 'Live (in person)'] },
  { value: 'Live Webcast', phrasings: ['Live Webcast', 'Live Webinar', 'Webcast (live)'] },
  { value: 'Self-Study', phrasings: ['Self-Study', 'On-demand recording', 'Online self-study'] },
];

const CPE_JURISDICTIONS = ['United States', 'Ohio', 'California', 'Illinois', 'New York', 'Texas', 'Florida'] as const;
const CLE_JURISDICTIONS = ['New York', 'California', 'Texas', 'Florida', 'Illinois', 'Pennsylvania', 'New Jersey', 'Georgia'] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

// --- OCR noise --------------------------------------------------------------

const OCR_MAP: Record<string, string> = { '0': 'O', '1': 'l', I: 'l' };

/** Lightly corrupt a string the way OCR does (digit/letter confusions). */
function ocrNoise(rng: () => number, text: string): string {
  return text
    .split('')
    .map((ch) => (OCR_MAP[ch] && chance(rng, 0.35) ? OCR_MAP[ch] : ch))
    .join('');
}

// --- Field samplers ---------------------------------------------------------

function makeCourseId(rng: () => number, code: string, topic: string, year: number): string {
  const serial = PAD(randInt(rng, 1, 999), 3);
  const delimiter = pick(rng, ['-', '-', '-', '/', '.']); // mostly hyphen
  return [code, topic, year, serial].join('-').replace(/-(\d{3})$/, `${delimiter}$1`);
}

function formatDate(rng: () => number, year: number): { display: string; iso: string } {
  const month = randInt(rng, 1, 12);
  const day = randInt(rng, 1, 28);
  const iso = `${year}-${PAD(month, 2)}-${PAD(day, 2)}`;
  const style = randInt(rng, 0, 2);
  let display: string;
  if (style === 0) display = `${MONTHS[month - 1]} ${day}, ${year}`;
  else if (style === 1) display = `${PAD(month, 2)}/${PAD(day, 2)}/${year}`;
  else display = `${day} ${MONTHS[month - 1]} ${year}`;
  return { display, iso };
}

/** Credit hours: realistic CPE/CLE values, including halves. */
function sampleCreditHours(rng: () => number): number {
  const half = chance(rng, 0.25);
  const whole = randInt(rng, 1, 16);
  return half ? whole + 0.5 : whole;
}

// --- CPE entry --------------------------------------------------------------

function generateCpeEntry(rng: () => number, index: number): GoldenDatasetEntry {
  const provider = pick(rng, CPE_PROVIDERS);
  const fos = pick(rng, CPE_FIELDS);
  const title = pick(rng, fos.titles);
  const delivery = pick(rng, CPE_DELIVERY);
  const year = randInt(rng, 2024, 2026);
  const creditHours = sampleCreditHours(rng);
  const isEthics = fos.field === 'Regulatory Ethics';
  const ethicsHours = isEthics ? creditHours : undefined;
  const nasbaActive = chance(rng, 0.85);
  const hasCourseId = chance(rng, 0.85);
  const courseId = hasCourseId ? makeCourseId(rng, provider.code, fos.topic, year) : undefined;
  const jurisdiction = pick(rng, CPE_JURISDICTIONS);
  const date = formatDate(rng, year);
  const applyOcr = chance(rng, 0.18);

  const gt: GroundTruthFields = {
    credentialType: 'CPE',
    issuerName: provider.name,
    issuedDate: date.iso,
    fieldOfStudy: fos.field,
    accreditingBody: 'NASBA',
    jurisdiction,
    creditHours,
    creditType: isEthics ? 'CPE Ethics' : 'CPE',
    providerName: provider.name,
    deliveryMethod: delivery.value,
    nasbaStatus: nasbaActive ? 'active' : 'inactive',
    fraudSignals: nasbaActive ? [] : ['nasba_sponsor_inactive'],
  };
  if (courseId) {
    gt.courseId = courseId;
    gt.activityNumber = courseId;
  }
  if (ethicsHours !== undefined) gt.ethicsHours = ethicsHours;

  const creditLabel = pick(rng, ['CPE Credits', 'Credit Hours', 'CPE Credit Hours', 'Credits Awarded']);
  const lines: string[] = [];
  lines.push(pick(rng, ['Certificate of Continuing Professional Education.', 'CPE Certificate of Completion.', 'Continuing Professional Education Certificate.']));
  lines.push('Participant: [NAME_REDACTED], CPA.');
  lines.push(`Course: ${title}.`);
  if (courseId) lines.push(`${pick(rng, ['Course ID', 'Program Code', 'Course Number'])}: ${courseId}.`);
  const ethicsClause = ethicsHours !== undefined ? ` (including ${ethicsHours} Regulatory Ethics)` : '';
  lines.push(`${creditLabel}: ${creditHours}${ethicsClause}.`);
  lines.push(`Field of Study: ${fos.field}.`);
  lines.push(`Delivery Method: ${pick(rng, delivery.phrasings)}.`);
  lines.push(`Provider: ${provider.name}.`);
  lines.push(`NASBA Registry Status: ${nasbaActive ? 'Active' : 'INACTIVE'}.`);
  lines.push(`Completion Date: ${date.display}.`);

  const separator = pick(rng, [' ', '\n']);
  let text = lines.join(separator);
  if (applyOcr) text = ocrNoise(rng, text);

  const tags = ['synthetic', 'synthetic-train', 'professional-education', 'cpe'];
  if (courseId) tags.push('course-id');
  if (isEthics) tags.push('ethics');
  if (!nasbaActive) tags.push('inactive-sponsor');
  if (applyOcr) tags.push('ocr-noise');

  return {
    id: `GD-PE-SYN-${PAD(index, 5)}`,
    description: `Synthetic CPE — ${fos.field} via ${provider.name}`,
    strippedText: text,
    credentialTypeHint: 'CPE',
    groundTruth: gt,
    source: 'synthetic/pe-train/cpe',
    category: 'professional-education-synthetic',
    tags,
  };
}

// --- CLE entry --------------------------------------------------------------

function generateCleEntry(rng: () => number, index: number): GoldenDatasetEntry {
  const provider = pick(rng, CLE_PROVIDERS);
  const fos = pick(rng, CLE_FIELDS);
  const title = pick(rng, fos.titles);
  const delivery = pick(rng, CLE_DELIVERY);
  const year = randInt(rng, 2024, 2026);
  const creditHours = sampleCreditHours(rng);
  const hasEthics = fos.field === 'Legal Ethics' || fos.field === 'Professional Responsibility' || chance(rng, 0.3);
  // Ethics is a subset of total credit (at most all of it), in half-hour steps.
  const ethicsHours = hasEthics ? Math.min(creditHours, (randInt(rng, 1, Math.max(1, Math.floor(creditHours * 2))) / 2)) : undefined;
  const hasCourseId = chance(rng, 0.85);
  const courseId = hasCourseId ? makeCourseId(rng, provider.code, fos.topic, year) : undefined;
  const jurisdiction = pick(rng, CLE_JURISDICTIONS);
  const date = formatDate(rng, year);
  const applyOcr = chance(rng, 0.18);

  const gt: GroundTruthFields = {
    credentialType: 'CLE',
    issuerName: provider.name,
    issuedDate: date.iso,
    fieldOfStudy: fos.field,
    jurisdiction,
    creditHours,
    creditType: hasEthics ? 'CLE Ethics' : 'CLE',
    providerName: provider.name,
    deliveryMethod: delivery.value,
    fraudSignals: [],
  };
  if (courseId) {
    gt.courseId = courseId;
    gt.activityNumber = courseId;
  }
  if (ethicsHours !== undefined) gt.ethicsHours = ethicsHours;

  const creditLabel = pick(rng, ['CLE Credit Hours', 'Total CLE Credits', 'Credits', 'Credit Hours']);
  const lines: string[] = [];
  lines.push(pick(rng, ['CLE Certificate of Attendance.', 'STATE BAR CLE CERTIFICATE.', 'Continuing Legal Education Certificate.']));
  lines.push('Attendee: [NAME_REDACTED].');
  lines.push(`Program: ${title}.`);
  if (courseId) lines.push(`${pick(rng, ['Program Number', 'Activity ID', 'Course ID'])}: ${courseId}.`);
  const ethicsClause = ethicsHours !== undefined ? ` (including ${ethicsHours} Ethics)` : '';
  lines.push(`${creditLabel}: ${creditHours}${ethicsClause}.`);
  lines.push(`Field of Study: ${fos.field}.`);
  lines.push(`Format: ${pick(rng, delivery.phrasings)}.`);
  lines.push(`Provider: ${provider.name}.`);
  lines.push(`Jurisdiction: ${jurisdiction}.`);
  lines.push(`Completion Date: ${date.display}.`);

  const separator = pick(rng, [' ', '\n']);
  let text = lines.join(separator);
  if (applyOcr) text = ocrNoise(rng, text);

  const tags = ['synthetic', 'synthetic-train', 'professional-education', 'cle'];
  if (courseId) tags.push('course-id');
  if (hasEthics) tags.push('ethics');
  if (applyOcr) tags.push('ocr-noise');

  return {
    id: `GD-PE-SYN-${PAD(index, 5)}`,
    description: `Synthetic CLE — ${fos.field} via ${provider.name}`,
    strippedText: text,
    credentialTypeHint: 'CLE',
    groundTruth: gt,
    source: 'synthetic/pe-train/cle',
    category: 'professional-education-synthetic',
    tags,
  };
}

/**
 * Generate a reproducible synthetic PE TRAIN dataset.
 *
 * Same `seed`, `count`, and `mix` always yield byte-identical output.
 */
export function generatePeSyntheticDataset(options: PeSyntheticOptions): GoldenDatasetEntry[] {
  const { count, seed = 0xa11ce, mix = { cpe: 0.5, cle: 0.5 } } = options;
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer (got ${String(count)})`);
  }
  if (
    !Number.isFinite(mix.cpe) ||
    !Number.isFinite(mix.cle) ||
    mix.cpe < 0 ||
    mix.cle < 0
  ) {
    throw new RangeError('mix.cpe and mix.cle must be finite non-negative numbers');
  }
  const rng = mulberry32(seed);
  const total = mix.cpe + mix.cle;
  const cpeShare = total > 0 ? mix.cpe / total : 0.5;

  const entries: GoldenDatasetEntry[] = [];
  for (let i = 0; i < count; i++) {
    const isCpe = chance(rng, cpeShare);
    entries.push(isCpe ? generateCpeEntry(rng, i + 1) : generateCleEntry(rng, i + 1));
  }
  return entries;
}
