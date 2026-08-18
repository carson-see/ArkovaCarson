/**
 * Jurisdiction-Specific Privacy Notices — REG-14 (SCRUM-575)
 *
 * Displays privacy information relevant to the user's organization jurisdiction.
 * Auto-detects from org country setting (not geolocation).
 * All text sourced from copy.ts per Constitution 1.3.
 */

import { Shield, Globe } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PRIVACY_NOTICE_LABELS, PRIVACY_CONTACT_EMAIL } from '@/lib/copy';

interface JurisdictionNotice {
  id: string;
  title: string;
  description: string;
  regulator: string;
  regulatorUrl: string;
  /** `readonly` because the rights arrays are `as const` values from copy.ts. */
  rights: readonly string[];
  /**
   * Optional (hotfix/kenya-transfer-basis-removal, 2026-08-18): Kenya's prior
   * value asserted SCCs — a EU GDPR mechanism — as its Kenya DPA 2019 §48
   * transfer basis, which is not correct. Counsel ordered the claim removed,
   * not reworded, and has not supplied a replacement yet, so this jurisdiction
   * omits the field rather than render a placeholder. The row below is
   * conditional on this being set, matching `informationOfficer`.
   */
  transferBasis?: string;
  breachTimeline: string;
  informationOfficer?: string;
}

const JURISDICTION_NOTICES: JurisdictionNotice[] = [
  {
    id: 'ferpa',
    title: PRIVACY_NOTICE_LABELS.FERPA_TITLE,
    description: PRIVACY_NOTICE_LABELS.FERPA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.FERPA_REGULATOR,
    regulatorUrl: 'https://studentprivacy.ed.gov/',
    rights: PRIVACY_NOTICE_LABELS.FERPA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.FERPA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.FERPA_BREACH_TIMELINE,
  },
  {
    id: 'hipaa',
    title: PRIVACY_NOTICE_LABELS.HIPAA_TITLE,
    description: PRIVACY_NOTICE_LABELS.HIPAA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.HIPAA_REGULATOR,
    regulatorUrl: 'https://www.hhs.gov/ocr/',
    rights: PRIVACY_NOTICE_LABELS.HIPAA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.HIPAA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.HIPAA_BREACH_TIMELINE,
  },
  // Counsel-ordered removal 2026-08-18 (hotfix/kenya-transfer-basis-removal):
  // no `transferBasis` field. The prior value falsely named EU GDPR Standard
  // Contractual Clauses as the basis under Kenya DPA 2019 §48 — SCCs are not
  // a Kenya DPA mechanism. Removed, not reworded; replacement wording awaits
  // counsel. See the KENYA_BREACH_TIMELINE comment in copy.ts.
  {
    id: 'kenya',
    title: PRIVACY_NOTICE_LABELS.KENYA_TITLE,
    description: PRIVACY_NOTICE_LABELS.KENYA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.KENYA_REGULATOR,
    regulatorUrl: 'https://odpc.go.ke',
    rights: PRIVACY_NOTICE_LABELS.KENYA_RIGHTS,
    breachTimeline: PRIVACY_NOTICE_LABELS.KENYA_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'australia',
    title: PRIVACY_NOTICE_LABELS.AUSTRALIA_TITLE,
    description: PRIVACY_NOTICE_LABELS.AUSTRALIA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.AUSTRALIA_REGULATOR,
    regulatorUrl: 'https://www.oaic.gov.au',
    rights: PRIVACY_NOTICE_LABELS.AUSTRALIA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.AUSTRALIA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.AUSTRALIA_BREACH_TIMELINE,
  },
  {
    id: 'south-africa',
    title: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_TITLE,
    description: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_REGULATOR,
    regulatorUrl: 'https://www.justice.gov.za/inforeg/',
    rights: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.SOUTH_AFRICA_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'nigeria',
    title: PRIVACY_NOTICE_LABELS.NIGERIA_TITLE,
    description: PRIVACY_NOTICE_LABELS.NIGERIA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.NIGERIA_REGULATOR,
    regulatorUrl: 'https://ndpc.gov.ng',
    rights: PRIVACY_NOTICE_LABELS.NIGERIA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.NIGERIA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.NIGERIA_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'brazil',
    title: PRIVACY_NOTICE_LABELS.BRAZIL_TITLE,
    description: PRIVACY_NOTICE_LABELS.BRAZIL_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.BRAZIL_REGULATOR,
    regulatorUrl: 'https://www.gov.br/anpd/',
    rights: PRIVACY_NOTICE_LABELS.BRAZIL_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.BRAZIL_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.BRAZIL_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'singapore',
    title: PRIVACY_NOTICE_LABELS.SINGAPORE_TITLE,
    description: PRIVACY_NOTICE_LABELS.SINGAPORE_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.SINGAPORE_REGULATOR,
    regulatorUrl: 'https://www.pdpc.gov.sg',
    rights: PRIVACY_NOTICE_LABELS.SINGAPORE_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.SINGAPORE_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.SINGAPORE_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'mexico',
    title: PRIVACY_NOTICE_LABELS.MEXICO_TITLE,
    description: PRIVACY_NOTICE_LABELS.MEXICO_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.MEXICO_REGULATOR,
    regulatorUrl: 'https://www.gob.mx/sabg',
    rights: PRIVACY_NOTICE_LABELS.MEXICO_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.MEXICO_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.MEXICO_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'colombia',
    title: PRIVACY_NOTICE_LABELS.COLOMBIA_TITLE,
    description: PRIVACY_NOTICE_LABELS.COLOMBIA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.COLOMBIA_REGULATOR,
    regulatorUrl: 'https://www.sic.gov.co/',
    rights: PRIVACY_NOTICE_LABELS.COLOMBIA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.COLOMBIA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.COLOMBIA_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'thailand',
    title: PRIVACY_NOTICE_LABELS.THAILAND_TITLE,
    description: PRIVACY_NOTICE_LABELS.THAILAND_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.THAILAND_REGULATOR,
    regulatorUrl: 'https://www.pdpc.or.th/',
    rights: PRIVACY_NOTICE_LABELS.THAILAND_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.THAILAND_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.THAILAND_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  {
    id: 'malaysia',
    title: PRIVACY_NOTICE_LABELS.MALAYSIA_TITLE,
    description: PRIVACY_NOTICE_LABELS.MALAYSIA_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.MALAYSIA_REGULATOR,
    regulatorUrl: 'https://www.pdp.gov.my/',
    rights: PRIVACY_NOTICE_LABELS.MALAYSIA_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.MALAYSIA_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.MALAYSIA_BREACH_TIMELINE,
    informationOfficer: PRIVACY_CONTACT_EMAIL,
  },
  // SCRUM-2283 / R-7: the EU→US transfer basis is counsel-gated — no DPF
  // self-certification is held and no transfer mechanism may be named. The
  // rule lives at the DPF_* keys in copy.ts.
  {
    id: 'eu-us-transfer',
    title: PRIVACY_NOTICE_LABELS.DPF_TITLE,
    description: PRIVACY_NOTICE_LABELS.DPF_DESCRIPTION,
    regulator: PRIVACY_NOTICE_LABELS.DPF_REGULATOR,
    regulatorUrl: 'https://www.edpb.europa.eu/about-edpb/about-edpb/members_en',
    rights: PRIVACY_NOTICE_LABELS.DPF_RIGHTS,
    transferBasis: PRIVACY_NOTICE_LABELS.DPF_TRANSFER_BASIS,
    breachTimeline: PRIVACY_NOTICE_LABELS.DPF_BREACH_TIMELINE,
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

                {notice.transferBasis && (
                  <div>
                    <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      {PRIVACY_NOTICE_LABELS.TRANSFER_BASIS_LABEL}
                    </p>
                    <p>{notice.transferBasis}</p>
                  </div>
                )}

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
                      {PRIVACY_NOTICE_LABELS.INFORMATION_OFFICER_LABEL}
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
