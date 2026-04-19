/**
 * KAU-06 (SCRUM-754) — Kenya + Australia Notifiable Data Breach procedures.
 *
 * Structured knowledge base for NDB compliance. Mirrors the shape of the
 * FCRA/HIPAA/FERPA source registries so the same RAG retrieval works
 * across regulations. Every entry is anchored to the primary source and
 * carries a `lastVerified` date.
 *
 * Kenya — KDPA 2019 §43, ODPC guidance, 72-hour notification.
 * Australia — Privacy Act 1988 Part IIIC (NDB scheme), OAIC guidance,
 * 30-day assessment, eligible-data-breach test, OAIC notification form.
 */

import type { IntelligenceSource } from '../types.js';

const V = '2026-04-18';

export const KAU_NDB_SOURCES: IntelligenceSource[] = [
  // Kenya — statute
  {
    id: 'kdpa-43-notification',
    quote: 'KDPA §43 — a data controller must notify the Data Commissioner and affected data subjects of a personal data breach within 72 hours of becoming aware, where feasible, where the breach is likely to result in a real risk of harm',
    source: 'Kenya Data Protection Act 2019 §43',
    url: 'https://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/2019/TheDataProtectionAct__No24of2019.pdf',
    lastVerified: V,
    tags: ['kenya', 'ndb', 'statute', 'notification-timeline'],
    jurisdiction: 'KE',
  },
  {
    id: 'kdpa-odpc-notification-form',
    quote: 'ODPC Guidance Note on Data Breach Notification — notification must include: nature of breach, categories and approximate number of data subjects affected, likely consequences, mitigation steps, and DPO contact',
    source: 'ODPC Guidance Note on Breach Notification',
    url: 'https://www.odpc.go.ke/',
    lastVerified: V,
    tags: ['kenya', 'ndb', 'guidance', 'notification-content'],
    jurisdiction: 'KE',
  },
  {
    id: 'kdpa-penalty-section-63',
    quote: 'KDPA §63 — failure to report a notifiable breach within the required timeframe is an offence punishable by a fine not exceeding KES 5,000,000 or 1% of annual turnover, whichever is lower',
    source: 'Kenya Data Protection Act 2019 §63',
    lastVerified: V,
    tags: ['kenya', 'ndb', 'penalty'],
    jurisdiction: 'KE',
  },
  // Australia — statute
  {
    id: 'au-privacy-part-iiic',
    quote: 'Privacy Act 1988 (Cth) Part IIIC — the NDB scheme requires APP entities to notify affected individuals and the OAIC when a data breach is likely to result in serious harm and remediation is insufficient',
    source: 'Privacy Act 1988 (Cth) Part IIIC',
    url: 'https://www.legislation.gov.au/C2004A03712/latest/text',
    lastVerified: V,
    tags: ['australia', 'ndb', 'statute'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-ndb-eligible-breach',
    quote: 'Privacy Act §26WE — an eligible data breach is (a) unauthorised access to or disclosure of, or loss of, personal information, and (b) a reasonable person would conclude the access/disclosure/loss is likely to result in serious harm to any of the individuals to whom the information relates, unless remedial action prevents that harm',
    source: 'Privacy Act 1988 (Cth) §26WE',
    lastVerified: V,
    tags: ['australia', 'ndb', 'statute', 'eligibility-test'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-ndb-assessment-30-days',
    quote: 'Privacy Act §26WH — where an entity has reasonable grounds to suspect (not confirm) an eligible breach, it must carry out a reasonable and expeditious assessment within 30 days to determine whether there has been an eligible breach',
    source: 'Privacy Act 1988 (Cth) §26WH',
    lastVerified: V,
    tags: ['australia', 'ndb', 'assessment-timeline'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-ndb-notification-content',
    quote: 'Privacy Act §26WK — notification must include: identity and contact details of the entity, description of the breach, kinds of information involved, recommended steps for individuals in response',
    source: 'Privacy Act 1988 (Cth) §26WK',
    lastVerified: V,
    tags: ['australia', 'ndb', 'notification-content'],
    jurisdiction: 'AU',
  },
  {
    id: 'au-oaic-ndb-form',
    quote: 'OAIC — notifiable data breach form must be submitted online at oaic.gov.au; the form collects all §26WK content plus an incident reference',
    source: 'OAIC NDB notification form (administrative)',
    url: 'https://www.oaic.gov.au/privacy/notifiable-data-breaches/report-a-data-breach',
    lastVerified: V,
    tags: ['australia', 'ndb', 'guidance', 'form'],
    jurisdiction: 'AU',
  },
];

export interface NdbProcedure {
  jurisdiction: 'KE' | 'AU';
  /** ISO-8601 duration-ish string — '72h', '30d'. */
  timeline: string;
  /** Ordered list of source ids that anchor each part of the procedure. */
  anchorSources: string[];
  /** Required content fields. */
  requiredContent: string[];
  /** Max monetary penalty (informational; statutes vary). */
  maxPenalty: string;
  /** Plain-language summary used as the retrieval "answer" in eval. */
  summary: string;
}

export const KAU_NDB_PROCEDURES: NdbProcedure[] = [
  {
    jurisdiction: 'KE',
    timeline: '72h',
    anchorSources: ['kdpa-43-notification', 'kdpa-odpc-notification-form', 'kdpa-penalty-section-63'],
    requiredContent: [
      'nature of the breach',
      'categories and approximate number of affected data subjects',
      'likely consequences',
      'mitigation steps taken',
      'DPO contact',
    ],
    maxPenalty: 'KES 5,000,000 or 1% of annual turnover (whichever is lower)',
    summary:
      'Kenya KDPA §43 requires notification to the Data Commissioner and affected subjects within 72 hours of awareness where the breach poses real risk of harm. Content fields are set by the ODPC Guidance Note. Non-compliance is an offence under §63.',
  },
  {
    jurisdiction: 'AU',
    timeline: '30d',
    anchorSources: [
      'au-privacy-part-iiic',
      'au-ndb-eligible-breach',
      'au-ndb-assessment-30-days',
      'au-ndb-notification-content',
      'au-oaic-ndb-form',
    ],
    requiredContent: [
      'entity identity and contact details',
      'description of the breach',
      'kinds of information involved',
      'recommended steps for affected individuals',
    ],
    maxPenalty: 'Up to AUD 50M per contravention (Privacy Act civil penalty provisions)',
    summary:
      'Australia Privacy Act Part IIIC requires APP entities to assess suspected eligible breaches within 30 days; confirmed eligible breaches must be reported to the OAIC and affected individuals without delay. Eligibility turns on the §26WE serious-harm test; content fields are set by §26WK; form is submitted via oaic.gov.au.',
  },
];

export function ndbSource(id: string): IntelligenceSource {
  const s = KAU_NDB_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`NDB source id not found: ${id}`);
  return s;
}

export function getNdbProcedure(jurisdiction: 'KE' | 'AU'): NdbProcedure {
  const p = KAU_NDB_PROCEDURES.find((x) => x.jurisdiction === jurisdiction);
  if (!p) throw new Error(`No NDB procedure defined for ${jurisdiction}`);
  return p;
}

/**
 * Retrieval test shape used by KAU-06 acceptance criteria. Given a user
 * query, return the jurisdiction the RAG pipeline should route to and the
 * anchored sources it should cite.
 */
export interface NdbRetrievalExpectation {
  query: string;
  jurisdiction: 'KE' | 'AU';
  mustCiteAnyOf: string[];
}

export const KAU_NDB_RETRIEVAL_TESTS: NdbRetrievalExpectation[] = [
  {
    query: 'Kenya breach notification timeline',
    jurisdiction: 'KE',
    mustCiteAnyOf: ['kdpa-43-notification'],
  },
  {
    query: 'What is the ODPC Kenya notification content requirement?',
    jurisdiction: 'KE',
    mustCiteAnyOf: ['kdpa-odpc-notification-form'],
  },
  {
    query: 'Australia eligible data breach criteria',
    jurisdiction: 'AU',
    mustCiteAnyOf: ['au-ndb-eligible-breach', 'au-privacy-part-iiic'],
  },
  {
    query: 'How long do I have to assess a suspected OAIC-reportable breach?',
    jurisdiction: 'AU',
    mustCiteAnyOf: ['au-ndb-assessment-30-days'],
  },
  {
    query: 'What must an Australian NDB notification include?',
    jurisdiction: 'AU',
    mustCiteAnyOf: ['au-ndb-notification-content'],
  },
];

/**
 * Validate the KAU NDB source registry — every retrieval test must
 * reference sources that exist, every procedure must anchor to sources
 * that exist, and every source id must be unique.
 */
export function validateKauNdb(): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const s of KAU_NDB_SOURCES) {
    if (ids.has(s.id)) errs.push(`duplicate NDB source id: ${s.id}`);
    ids.add(s.id);
  }
  for (const p of KAU_NDB_PROCEDURES) {
    for (const a of p.anchorSources) {
      if (!ids.has(a)) errs.push(`procedure ${p.jurisdiction} anchors to missing source: ${a}`);
    }
  }
  for (const t of KAU_NDB_RETRIEVAL_TESTS) {
    for (const a of t.mustCiteAnyOf) {
      if (!ids.has(a)) errs.push(`retrieval test "${t.query}" references missing source: ${a}`);
    }
  }
  return errs;
}
