/**
 * International Compliance Fetchers — INTL-01/02/03
 *
 * Statute ingestion for:
 *   - Brazil (LGPD) — INTL-01
 *   - Singapore (PDPA) — INTL-02
 *   - Mexico (LFPDPPP) — INTL-03
 *
 * Uses the shared jurisdictionFetcher pattern from KAU-01.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { StatuteDefinition, JurisdictionFetchResult } from './jurisdictionFetcher.js';
import { fetchJurisdictionCompliance } from './jurisdictionFetcher.js';

const BRAZIL_STATUTES: StatuteDefinition[] = [
  {
    title: 'Lei Geral de Proteção de Dados (LGPD) — Lei nº 13.709/2018',
    sourceId: 'BR-LGPD-2018',
    url: 'https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm',
    sections: [
      { id: 'BR-LGPD-ART6', title: 'Principles of data processing', section: 'Art. 6' },
      { id: 'BR-LGPD-ART7', title: 'Legal bases for processing', section: 'Art. 7' },
      { id: 'BR-LGPD-ART11', title: 'Sensitive personal data processing', section: 'Art. 11' },
      { id: 'BR-LGPD-ART14', title: "Children's and adolescents' data", section: 'Art. 14' },
      { id: 'BR-LGPD-ART18', title: 'Data subject rights', section: 'Art. 18' },
      { id: 'BR-LGPD-ART33', title: 'International data transfer conditions', section: 'Art. 33' },
      { id: 'BR-LGPD-ART37', title: 'Records of processing activities', section: 'Art. 37' },
      { id: 'BR-LGPD-ART41', title: 'Data Protection Officer appointment', section: 'Art. 41' },
      { id: 'BR-LGPD-ART46', title: 'Security measures and technical safeguards', section: 'Art. 46' },
      { id: 'BR-LGPD-ART48', title: 'Breach notification to ANPD and data subjects', section: 'Art. 48' },
      { id: 'BR-LGPD-ART50', title: 'Codes of conduct and good practices', section: 'Art. 50' },
      { id: 'BR-LGPD-ART52', title: 'Administrative sanctions (up to 2% revenue / BRL 50M)', section: 'Art. 52' },
    ],
  },
];

const SINGAPORE_STATUTES: StatuteDefinition[] = [
  {
    title: 'Personal Data Protection Act 2012 (PDPA)',
    sourceId: 'SG-PDPA-2012',
    url: 'https://sso.agc.gov.sg/Act/PDPA2012',
    sections: [
      { id: 'SG-PDPA-S13', title: 'Consent obligation', section: '§13' },
      { id: 'SG-PDPA-S16', title: 'Withdrawal of consent', section: '§16' },
      { id: 'SG-PDPA-S18', title: 'Purpose limitation obligation', section: '§18' },
      { id: 'SG-PDPA-S20', title: 'Notification obligation', section: '§20' },
      { id: 'SG-PDPA-S21', title: 'Access obligation', section: '§21' },
      { id: 'SG-PDPA-S22', title: 'Correction obligation', section: '§22' },
      { id: 'SG-PDPA-S24', title: 'Protection obligation (security)', section: '§24' },
      { id: 'SG-PDPA-S25', title: 'Retention limitation obligation', section: '§25' },
      { id: 'SG-PDPA-S26', title: 'Transfer limitation obligation (cross-border)', section: '§26' },
      { id: 'SG-PDPA-S26D', title: 'Data breach notification (3 calendar days)', section: '§26D' },
      { id: 'SG-PDPA-S26H', title: 'Data portability obligation', section: '§26H' },
      { id: 'SG-PDPA-S29', title: 'DPO appointment and PDPC notification', section: '§29' },
    ],
  },
];

const MEXICO_STATUTES: StatuteDefinition[] = [
  {
    title: 'Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP)',
    sourceId: 'MX-LFPDPPP-2010',
    url: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf',
    sections: [
      { id: 'MX-LFPDPPP-ART6', title: 'Data protection principles', section: 'Art. 6' },
      { id: 'MX-LFPDPPP-ART8', title: 'Consent requirements', section: 'Art. 8' },
      { id: 'MX-LFPDPPP-ART15', title: 'Privacy notice (aviso de privacidad) requirements', section: 'Art. 15' },
      { id: 'MX-LFPDPPP-ART22', title: 'ARCO rights: access, rectification, cancellation, opposition', section: 'Art. 22' },
      { id: 'MX-LFPDPPP-ART36', title: 'International data transfer conditions', section: 'Art. 36' },
      { id: 'MX-LFPDPPP-ART37', title: 'Exceptions to transfer consent', section: 'Art. 37' },
      { id: 'MX-LFPDPPP-ART19', title: 'Security measures for personal data', section: 'Art. 19' },
      { id: 'MX-LFPDPPP-ART63', title: 'Administrative sanctions and penalties', section: 'Art. 63' },
    ],
  },
];

export async function fetchBrazilComplianceData(
  supabase: SupabaseClient,
): Promise<JurisdictionFetchResult> {
  return fetchJurisdictionCompliance(supabase, {
    jurisdiction: 'Brazil',
    jurisdictionCode: 'BR',
    statuteSource: 'brazil_law',
    statutes: BRAZIL_STATUTES,
  });
}

export async function fetchSingaporeComplianceData(
  supabase: SupabaseClient,
): Promise<JurisdictionFetchResult> {
  return fetchJurisdictionCompliance(supabase, {
    jurisdiction: 'Singapore',
    jurisdictionCode: 'SG',
    statuteSource: 'singapore_law',
    statutes: SINGAPORE_STATUTES,
  });
}

export async function fetchMexicoComplianceData(
  supabase: SupabaseClient,
): Promise<JurisdictionFetchResult> {
  return fetchJurisdictionCompliance(supabase, {
    jurisdiction: 'Mexico',
    jurisdictionCode: 'MX',
    statuteSource: 'mexico_law',
    statutes: MEXICO_STATUTES,
  });
}
