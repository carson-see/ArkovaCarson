/**
 * KAU-01/02: Kenya compliance data fetcher.
 * Thin wrapper around jurisdictionFetcher with Kenya-specific statutes and case law config.
 *
 * KAU-06 (SCRUM-754): Adds Notifiable Data Breach procedures backfill. The
 * 72-hour KDPA §43 timeline + ODPC guidance get ingested as dedicated
 * records so Nessie RAG can answer breach-notification questions with
 * authoritative citations.
 */

import { fetchJurisdictionCompliance, type JurisdictionFetchResult, type StatuteDefinition } from './jurisdictionFetcher.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const KENYA_STATUTES: StatuteDefinition[] = [
  {
    title: 'Kenya Data Protection Act, 2019',
    sourceId: 'KE-DPA-2019',
    url: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/2019/TheDataProtectionAct__No24of2019.pdf',
    sections: [
      { id: 'KE-DPA-2019-S1', title: 'Preliminary — Short title and commencement', section: 'Part I' },
      { id: 'KE-DPA-2019-S2', title: 'Interpretation and definitions', section: 'Part I' },
      { id: 'KE-DPA-2019-S25', title: 'Principles of data processing', section: 'Part III' },
      { id: 'KE-DPA-2019-S26', title: 'Rights of data subjects', section: 'Part IV' },
      { id: 'KE-DPA-2019-S27', title: 'Obligations of data controllers', section: 'Part V' },
      { id: 'KE-DPA-2019-S41', title: 'Transfer of personal data outside Kenya', section: 'Part VI' },
      { id: 'KE-DPA-2019-S43', title: 'Offences and penalties', section: 'Part VII' },
      { id: 'KE-DPA-2019-S46', title: 'Data Protection Impact Assessment', section: 'Part VIII' },
      { id: 'KE-DPA-2019-S50', title: 'Registration of data controllers and processors', section: 'Part IX' },
      { id: 'KE-DPA-2019-S56', title: 'Enforcement by the Commissioner', section: 'Part X' },
    ],
  },
  {
    title: 'Kenya Data Protection (General) Regulations, 2021',
    sourceId: 'KE-DPR-2021',
    url: 'https://www.odpc.go.ke/regulations/',
    sections: [
      { id: 'KE-DPR-2021-R3', title: 'Registration requirements', section: 'Part II' },
      { id: 'KE-DPR-2021-R7', title: 'Data protection impact assessment', section: 'Part III' },
      { id: 'KE-DPR-2021-R12', title: 'Cross-border data transfer', section: 'Part IV' },
      { id: 'KE-DPR-2021-R18', title: 'Data breach notification', section: 'Part V' },
      { id: 'KE-DPR-2021-R22', title: 'Complaints handling', section: 'Part VI' },
    ],
  },
  // KAU-06 (SCRUM-754): Kenya Notifiable Data Breach procedures.
  {
    title: 'Kenya ODPC Data Breach Notification Procedures (KDPA §43)',
    sourceId: 'KE-ODPC-NDB',
    url: 'https://www.odpc.go.ke/data-breach-notification-procedures/',
    sections: [
      {
        id: 'KE-ODPC-NDB-01',
        title: 'KDPA §43(1) — Mandatory breach notification to Commissioner within 72 hours of becoming aware',
        section: 'NDB Procedures',
      },
      {
        id: 'KE-ODPC-NDB-02',
        title: 'KDPA §43(2) — Notification to affected data subjects without undue delay when high risk to rights and freedoms',
        section: 'NDB Procedures',
      },
      {
        id: 'KE-ODPC-NDB-03',
        title: 'KDPA §43(3) — Required content: nature of breach, categories + approximate number of records, likely consequences, mitigation measures taken',
        section: 'NDB Procedures',
      },
      {
        id: 'KE-ODPC-NDB-04',
        title: 'KDPA §43(4) — Processor obligation: notify controller without undue delay',
        section: 'NDB Procedures',
      },
      {
        id: 'KE-ODPC-NDB-05',
        title: 'KDPA §63 — Penalties: up to KES 5,000,000 or 1% of annual turnover, whichever is lower, per contravention',
        section: 'NDB Procedures',
      },
      {
        id: 'KE-ODPC-NDB-06',
        title: 'ODPC Guidance Note 2022 — Exemption for breaches unlikely to result in risk to rights and freedoms',
        section: 'NDB Procedures',
      },
      {
        id: 'KE-ODPC-NDB-07',
        title: 'ODPC Form BR-1 — Breach notification template (controller, timeline, categories, mitigation, contact)',
        section: 'NDB Procedures',
      },
    ],
  },
  {
    title: 'Kenya Employment Act, 2007',
    sourceId: 'KE-EA-2007',
    url: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/EmploymentAct_Cap226.pdf',
    sections: [
      { id: 'KE-EA-2007-S5', title: 'Prohibition of forced labour', section: 'Part II' },
      { id: 'KE-EA-2007-S44', title: 'Termination of employment', section: 'Part VII' },
      { id: 'KE-EA-2007-S47', title: 'Unfair termination', section: 'Part VII' },
    ],
  },
];

export async function fetchKenyaComplianceData(
  supabase: SupabaseClient,
): Promise<JurisdictionFetchResult> {
  return fetchJurisdictionCompliance(supabase, {
    jurisdiction: 'Kenya',
    jurisdictionCode: 'KE',
    statuteSource: 'kenya_law',
    statutes: KENYA_STATUTES,
    caseLaw: {
      searchUrl: 'http://kenyalaw.org/caselaw/cases/advanced_search?q={TERM}&type=Judgment&format=json',
      searchTerms: [
        'data protection',
        'employment termination',
        'professional license',
        'medical practitioner',
        'advocate disciplinary',
      ],
      source: 'kenya_caselaw',
      court: 'Kenya Courts',
      parseResults: (body) => {
        try {
          const data = JSON.parse(body) as { results?: Array<{ id: string; title: string; url: string; summary?: string }> };
          return (data.results ?? []).map((c) => ({
            id: `KE-CASE-${c.id}`,
            title: c.title,
            url: c.url || `http://kenyalaw.org/caselaw/cases/view/${c.id}`,
            summary: c.summary,
          }));
        } catch {
          return [];
        }
      },
    },
  });
}
