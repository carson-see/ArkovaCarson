/**
 * ReferralPanel (SCRUM-5024).
 *
 * The organization's referral code, the link to share, and the organizations
 * that joined through it.
 *
 * Three deliberate behaviours:
 *   1. NO auto-mint. The code is created only when an admin presses the button.
 *   2. A failed load renders an ERROR state with a retry, never an empty table.
 *      "You have referred nobody" and "we could not find out" are different
 *      facts and the partner must be able to tell them apart.
 *   3. The measured/not-asserted sentence (REFERRAL_LABELS.NOT_ASSERTED) is
 *      rendered unconditionally — it is the §1.5 boundary, not a footnote.
 */

import { useState } from 'react';
import { Copy, Check, Loader2, AlertTriangle, Users2, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { REFERRAL_LABELS } from '@/lib/copy';
import { useReferrals } from '@/hooks/useReferrals';

interface ReferralPanelProps {
  orgId: string | null;
  /** Minting is ORG_ADMIN-only; a member still sees the code and the table. */
  canManage: boolean;
}

function formatJoined(iso: string): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReferralPanel({ orgId, canManage }: ReferralPanelProps) {
  const { loading, error, code, shareUrl, referred, minting, mintError, mint, refresh } =
    useReferrals(orgId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function handleCopy(): Promise<void> {
    if (!shareUrl) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embedded
      // contexts. Say so instead of silently doing nothing.
      setCopyError(true);
    }
  }

  if (!orgId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {REFERRAL_LABELS.NO_ORG}
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {REFERRAL_LABELS.LOADING}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            {REFERRAL_LABELS.LOAD_FAILED_TITLE}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            {REFERRAL_LABELS.LOAD_FAILED_RETRY}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5" aria-hidden="true" />
            {code ? REFERRAL_LABELS.CODE_CARD_TITLE : REFERRAL_LABELS.CREATE_TITLE}
          </CardTitle>
          <CardDescription>
            {code ? REFERRAL_LABELS.CODE_CARD_DESCRIPTION : REFERRAL_LABELS.CREATE_DESCRIPTION}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {code ? (
            <>
              <div>
                <p className="text-xs text-muted-foreground">{REFERRAL_LABELS.CODE_LABEL}</p>
                <p className="font-mono text-lg tracking-widest" data-testid="referral-code">
                  {code}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{REFERRAL_LABELS.SHARE_LINK_LABEL}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="referral-share-url">
                    {shareUrl}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
                    {copied ? (
                      <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {copied ? REFERRAL_LABELS.COPY_LINK_DONE : REFERRAL_LABELS.COPY_LINK}
                  </Button>
                </div>
                {copyError && (
                  <p className="mt-1 text-xs text-destructive">{REFERRAL_LABELS.COPY_LINK_FAILED}</p>
                )}
              </div>
            </>
          ) : canManage ? (
            <>
              <Button onClick={() => void mint()} disabled={minting}>
                {minting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {minting ? REFERRAL_LABELS.CREATING : REFERRAL_LABELS.CREATE_BUTTON}
              </Button>
              {mintError && (
                <p className="text-xs text-destructive">{REFERRAL_LABELS.CREATE_FAILED}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{REFERRAL_LABELS.ADMIN_ONLY}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users2 className="h-4 w-4" aria-hidden="true" />
            {REFERRAL_LABELS.TABLE_TITLE}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {referred.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium">{REFERRAL_LABELS.TABLE_EMPTY_TITLE}</p>
              <p className="text-xs text-muted-foreground">
                {REFERRAL_LABELS.TABLE_EMPTY_DESCRIPTION}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">{REFERRAL_LABELS.COLUMN_ORGANIZATION}</th>
                    <th className="pb-2 font-medium">{REFERRAL_LABELS.COLUMN_JOINED}</th>
                    <th className="pb-2 font-medium">{REFERRAL_LABELS.COLUMN_STATUS}</th>
                  </tr>
                </thead>
                <tbody>
                  {referred.map((org) => (
                    <tr
                      // Public id when present; otherwise the (name, date) pair.
                      // Never an internal identifier — none is fetched.
                      key={org.organizationPublicId ?? `${org.displayName}-${org.referredAt}`}
                      className="border-t"
                    >
                      <td className="py-2">{org.displayName}</td>
                      <td className="py-2">{formatJoined(org.referredAt)}</td>
                      <td className="py-2">
                        <Badge variant="outline">{org.verificationStatus}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-muted-foreground">{REFERRAL_LABELS.NOT_ASSERTED}</p>
        </CardContent>
      </Card>
    </div>
  );
}
