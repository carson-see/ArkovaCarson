/**
 * KAU-03/04: Australia compliance data fetcher.
 * Thin wrapper around jurisdictionFetcher with Australian statutes and case law config.
 *
 * KAU-06 (SCRUM-754): Adds OAIC Notifiable Data Breach Scheme Part IIIC
 * procedure records. 30-day assessment window + eligible-breach criteria
 * get ingested as dedicated records so Nessie RAG can cite OAIC guidance.
 */

import { fetchJurisdictionCompliance, type JurisdictionFetchResult, type StatuteDefinition } from './jurisdictionFetcher.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const AU_STATUTES: StatuteDefinition[] = [
  {
    title: 'Privacy Act 1988 (Cth)',
    sourceId: 'AU-PA-1988',
    url: 'https://www.legislation.gov.au/C2004A03712/latest/text',
    sections: [
      { id: 'AU-PA-1988-S6', title: 'Interpretation — definitions', section: 'Part I' },
      { id: 'AU-PA-1988-S6C', title: 'Organisations — meaning', section: 'Part I' },
      { id: 'AU-PA-1988-S13', title: 'Interference with privacy', section: 'Part II' },
      { id: 'AU-PA-1988-S15', title: 'APP entities', section: 'Part III' },
      { id: 'AU-PA-1988-S16A', title: 'Australian Privacy Principles', section: 'Part III' },
      { id: 'AU-PA-1988-S26WA', title: 'Notifiable Data Breaches scheme', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S26WB', title: 'Notification to Commissioner', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S26WC', title: 'Notification to affected individuals', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S26WE', title: 'Assessment of suspected breach', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S36', title: 'Complaints to Commissioner', section: 'Part V' },
      { id: 'AU-PA-1988-S40', title: 'Investigation by Commissioner', section: 'Part V' },
      { id: 'AU-PA-1988-S52', title: 'Determinations by Commissioner', section: 'Part V' },
      { id: 'AU-PA-1988-S80W', title: 'Civil penalty provisions', section: 'Part VIA' },
    ],
  },
  {
    title: 'Australian Privacy Principles (Schedule 1)',
    sourceId: 'AU-APP',
    url: 'https://www.oaic.gov.au/privacy/australian-privacy-principles',
    sections: [
      { id: 'AU-APP-01', title: 'APP 1 — Open and transparent management of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-02', title: 'APP 2 — Anonymity and pseudonymity', section: 'Schedule 1' },
      { id: 'AU-APP-03', title: 'APP 3 — Collection of solicited personal information', section: 'Schedule 1' },
      { id: 'AU-APP-04', title: 'APP 4 — Dealing with unsolicited personal information', section: 'Schedule 1' },
      { id: 'AU-APP-05', title: 'APP 5 — Notification of collection', section: 'Schedule 1' },
      { id: 'AU-APP-06', title: 'APP 6 — Use or disclosure of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-07', title: 'APP 7 — Direct marketing', section: 'Schedule 1' },
      { id: 'AU-APP-08', title: 'APP 8 — Cross-border disclosure of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-09', title: 'APP 9 — Adoption, use or disclosure of government related identifiers', section: 'Schedule 1' },
      { id: 'AU-APP-10', title: 'APP 10 — Quality of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-11', title: 'APP 11 — Security of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-12', title: 'APP 12 — Access to personal information', section: 'Schedule 1' },
      { id: 'AU-APP-13', title: 'APP 13 — Correction of personal information', section: 'Schedule 1' },
    ],
  },
  {
    title: 'Notifiable Data Breaches Scheme Guidelines',
    sourceId: 'AU-NDB',
    url: 'https://www.oaic.gov.au/privacy/notifiable-data-breaches',
    sections: [
      { id: 'AU-NDB-01', title: 'What is an eligible data breach', section: 'NDB Scheme' },
      { id: 'AU-NDB-02', title: 'Reasonable steps to prevent harm', section: 'NDB Scheme' },
      { id: 'AU-NDB-03', title: 'Assessing a suspected breach', section: 'NDB Scheme' },
      { id: 'AU-NDB-04', title: 'Notifying the Commissioner', section: 'NDB Scheme' },
      { id: 'AU-NDB-05', title: 'Notifying individuals', section: 'NDB Scheme' },
    ],
  },
  // KAU-06 (SCRUM-754): Privacy Act Part IIIC detailed NDB procedure records.
  // These are separate from the AU-NDB overview guidelines above — each record
  // answers one specific RAG question ("what is the assessment window",
  // "who must be notified", etc.) with the statutory citation.
  {
    title: 'Privacy Act Part IIIC — Notifiable Data Breach Scheme detailed procedures',
    sourceId: 'AU-OAIC-NDB',
    url: 'https://www.oaic.gov.au/privacy/notifiable-data-breaches/preparing-for-and-responding-to-data-breaches',
    sections: [
      {
        id: 'AU-OAIC-NDB-01',
        title: 'Privacy Act s26WA — Eligible data breach: unauthorised access/disclosure or loss AND likely to result in serious harm to any affected individual',
        section: 'Part IIIC',
      },
      {
        id: 'AU-OAIC-NDB-02',
        title: 'Privacy Act s26WE — Suspected breach assessment must complete within 30 days of APP entity becoming aware',
        section: 'Part IIIC',
      },
      {
        id: 'AU-OAIC-NDB-03',
        title: 'Privacy Act s26WB/C — Notification without undue delay after assessment: Commissioner (s26WB) and affected individuals (s26WC) in parallel',
        section: 'Part IIIC',
      },
      {
        id: 'AU-OAIC-NDB-04',
        title: 'Privacy Act s26WK — Required statement content: identity of entity, description of breach, kinds of information involved, recommended steps for affected individuals',
        section: 'Part IIIC',
      },
      {
        id: 'AU-OAIC-NDB-05',
        title: 'Privacy Act s26WF — Exemption: remedial action taken before serious harm likely, and no longer an eligible breach',
        section: 'Part IIIC',
      },
      {
        id: 'AU-OAIC-NDB-06',
        title: 'Privacy Act s13G/80W — Civil penalties: up to AUD 50M / 30% of adjusted turnover / 3x benefit for serious or repeated interference with privacy (post-2022 uplift)',
        section: 'Part IIIC',
      },
      {
        id: 'AU-OAIC-NDB-07',
        title: 'OAIC annual NDB statistics: health providers, finance, education, recruitment, legal — top 5 sectors for reported eligible breaches',
        section: 'Part IIIC',
      },
    ],
  },
];

export async function fetchAustraliaComplianceData(
  supabase: SupabaseClient,
): Promise<JurisdictionFetchResult> {
  return fetchJurisdictionCompliance(supabase, {
    jurisdiction: 'Australia',
    jurisdictionCode: 'AU',
    statuteSource: 'australia_law',
    statutes: AU_STATUTES,
    caseLaw: {
      searchUrl: 'http://www8.austlii.edu.au/cgi-bin/sinosrch.cgi?query={TERM}&meta=/au/cases/cth/FCA&results=20&method=auto',
      searchTerms: [
        'privacy breach notification',
        'Australian Privacy Principle',
        'data protection personal information',
        'ACNC charity compliance',
        'health practitioner registration',
      ],
      source: 'australia_caselaw',
      court: 'Federal Court of Australia',
      parseResults: (html) => {
        const cases: Array<{ id: string; title: string; url: string }> = [];
        const matches = html.matchAll(/<a href="(\/cgi-bin\/viewdoc\/au\/cases\/cth\/[^"]+)"[^>]*>([^<]+)<\/a>/gi);
        for (const m of matches) {
          const path = m[1];
          const title = m[2]?.trim();
          if (!title || title.length < 5) continue;
          cases.push({
            id: `AU-CASE-${path.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 100)}`,
            title,
            url: `http://www.austlii.edu.au${path}`,
          });
        }
        return cases;
      },
    },
  });
}
