/**
 * Jurisdiction-Specific Privacy Notices — REG-14 (SCRUM-575)
 *
 * Displays privacy information relevant to the user's organization jurisdiction.
 * Auto-detects from org country setting (not geolocation).
 * All text sourced from copy.ts per Constitution 1.3.
 */

import { Shield, Scale, Globe } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PRIVACY_NOTICE_LABELS } from '@/lib/copy';

interface JurisdictionNotice {
  id: string;
  title: string;
  description: string;
  regulator: string;
  regulatorUrl: string;
  rights: string[];
  transferBasis: string;
  breachTimeline: string;
  color: string;
  informationOfficer?: string;
}

const JURISDICTION_NOTICES: JurisdictionNotice[] = [
  {
    id: 'ferpa',
    title: PRIVACY_NOTICE_LABELS.FERPA_TITLE,
    description: PRIVACY_NOTICE_LABELS.FERPA_DESCRIPTION,
    regulator: 'U.S. Department of Education',
    regulatorUrl: 'https://studentprivacy.ed.gov/',
    rights: ['Access education records', 'Request amendments', 'Control disclosure', 'Opt out of directory information'],
    transferBasis: 'N/A (domestic)',
    breachTimeline: 'N/A (funding withdrawal mechanism)',
    color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  {
    id: 'hipaa',
    title: PRIVACY_NOTICE_LABELS.HIPAA_TITLE,
    description: PRIVACY_NOTICE_LABELS.HIPAA_DESCRIPTION,
    regulator: 'HHS Office for Civil Rights (OCR)',
    regulatorUrl: 'https://www.hhs.gov/ocr/',
    rights: ['Access PHI', 'Request amendments', 'Accounting of disclosures', 'Request restrictions', 'Confidential communications'],
    transferBasis: 'Business Associate Agreement (BAA)',
    breachTimeline: '60 calendar days (BA to CE)',
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  {
    id: 'kenya',
    title: PRIVACY_NOTICE_LABELS.KENYA_TITLE,
    description: PRIVACY_NOTICE_LABELS.KENYA_DESCRIPTION,
    regulator: 'Office of the Data Protection Commissioner (ODPC)',
    regulatorUrl: 'https://odpc.go.ke',
    rights: ['Access', 'Rectification', 'Erasure', 'Data portability', 'Object to processing'],
    transferBasis: 'Standard Contractual Clauses (Section 48)',
    breachTimeline: '72 hours (controller to ODPC)',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    informationOfficer: 'privacy@arkova.ai',
  },
  {
    id: 'australia',
    title: PRIVACY_NOTICE_LABELS.AUSTRALIA_TITLE,
    description: PRIVACY_NOTICE_LABELS.AUSTRALIA_DESCRIPTION,
    regulator: 'Office of the Australian Information Commissioner (OAIC)',
    regulatorUrl: 'https://www.oaic.gov.au',
    rights: ['Access (APP 12)', 'Correction (APP 13)'],
    transferBasis: 'APP 8 assessment + contractual provisions',
    breachTimeline: '30-day assessment window (NDB scheme)',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  {
    id: 'south-africa',
    title: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_TITLE,
    description: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_DESCRIPTION,
    regulator: 'Information Regulator',
    regulatorUrl: 'https://www.justice.gov.za/inforeg/',
    rights: ['Access (Section 23)', 'Correction/deletion (Section 24)', 'Object to processing (Section 11)'],
    transferBasis: 'Section 72 binding agreement (SCCs)',
    breachTimeline: 'As soon as reasonably possible',
    color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
    informationOfficer: 'privacy@arkova.ai',
  },
  {
    id: 'nigeria',
    title: PRIVACY_NOTICE_LABELS.NIGERIA_TITLE,
    description: PRIVACY_NOTICE_LABELS.NIGERIA_DESCRIPTION,
    regulator: 'Nigeria Data Protection Commission (NDPC)',
    regulatorUrl: 'https://ndpc.gov.ng',
    rights: ['Access', 'Rectification', 'Erasure', 'Data portability', 'Object', 'Restrict processing'],
    transferBasis: 'Standard Contractual Clauses',
    breachTimeline: '72 hours (controller to NDPC)',
    color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    informationOfficer: 'privacy@arkova.ai',
  },
];

interface JurisdictionPrivacyNoticesProps {
  /** Filter to specific jurisdiction IDs (e.g., from org country). If empty/undefined, show all. */
  jurisdictions?: string[];
}

export function JurisdictionPrivacyNotices({ jurisdictions }: JurisdictionPrivacyNoticesProps) {
  const notices = jurisdictions?.length
    ? JURISDICTION_NOTICES.filter(n => jurisdictions.includes(n.id))
    : JURISDICTION_NOTICES;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          {PRIVACY_NOTICE_LABELS.TITLE}
        </h2>
        <p className="text-sm text-muted-foreground">{PRIVACY_NOTICE_LABELS.DESCRIPTION}</p>
      </div>

      <div className="grid gap-4">
        {notices.map((notice) => (
          <Card key={notice.id}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="h-4 w-4" />
                {notice.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="text-muted-foreground">{notice.description}</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    {PRIVACY_NOTICE_LABELS.REGULATOR_LABEL}
                  </p>
                  <a
                    href={notice.regulatorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline text-sm"
                  >
                    {notice.regulator}
                  </a>
                </div>

                <div>
                  <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    {PRIVACY_NOTICE_LABELS.BREACH_TIMELINE_LABEL}
                  </p>
                  <p>{notice.breachTimeline}</p>
                </div>

                <div>
                  <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    {PRIVACY_NOTICE_LABELS.TRANSFER_BASIS_LABEL}
                  </p>
                  <p>{notice.transferBasis}</p>
                </div>

                <div>
                  <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    {PRIVACY_NOTICE_LABELS.RIGHTS_LABEL}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {notice.rights.map((right) => (
                      <Badge key={right} variant="secondary" className="text-xs">
                        {right}
                      </Badge>
                    ))}
                  </div>
                </div>

                {notice.informationOfficer && (
                  <div>
                    <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      Information Officer
                    </p>
                    <a
                      href={`mailto:${notice.informationOfficer}`}
                      className="text-primary hover:underline text-sm"
                    >
                      {notice.informationOfficer}
                    </a>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
