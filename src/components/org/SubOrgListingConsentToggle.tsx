/**
 * SubOrgListingConsentToggle (SCRUM-3864, epic SCRUM-3863)
 *
 * One organization's half of the two-party consent added by migration 0429.
 * An affiliation (parent shows child / child shows parent) appears on ANY
 * public surface — `get_public_org_profile`, `get_org_subtree` — ONLY when
 * BOTH `sub_org_listing_parent_optin` AND `sub_org_listing_child_optin` are
 * true. This component renders and toggles exactly ONE of those two columns;
 * it never shows the other org's raw flag value as a togglable control (an
 * org cannot set the other side's consent — the DB trigger refuses that
 * write), only as read-only "waiting on..." status text so the admin
 * understands why nothing is published yet.
 *
 * Side-agnostic by design: the caller supplies `onToggle`, which is either
 * `useOrganization().updateOrganization` (child consenting on its own row) or
 * `useAffiliateListingConsent().setParentListingOptin` (parent consenting on
 * a child's row). This component does not know or care which.
 *
 * @see supabase/migrations/0429_suborg_tenancy_foundations.sql
 */

import { Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SUB_ORG_LABELS } from '@/lib/copy';

export interface SubOrgListingConsentToggleProps {
  /** Unique per-instance id — ManageSubOrgs renders one of these per row. */
  id: string;
  /** This organization's own half of the consent. */
  ownValue: boolean;
  /** The other organization's half — read-only here, never set from this control. */
  otherPartyValue: boolean;
  /** True while a toggle request for THIS instance is in flight. */
  busy?: boolean;
  disabled?: boolean;
  /**
   * Shown when `ownValue` is true but `otherPartyValue` is false — tells the
   * admin who they are waiting on. Pass
   * `SUB_ORG_LABELS.LISTING_CONSENT_WAITING_ON_CHILD` from the parent side,
   * `SUB_ORG_LABELS.LISTING_CONSENT_WAITING_ON_PARENT` from the child side.
   */
  waitingLabel: string;
  /**
   * Performs the write. Returns the value that actually landed, or `null` on
   * failure (the caller already surfaced a toast) — this component does not
   * optimistically flip the switch past what the write confirmed.
   */
  onToggle: (next: boolean) => Promise<boolean | null>;
  /** Called with the confirmed value after a successful toggle. */
  onChanged: (next: boolean) => void;
}

export function SubOrgListingConsentToggle({
  id,
  ownValue,
  otherPartyValue,
  busy = false,
  disabled = false,
  waitingLabel,
  onToggle,
  onChanged,
}: SubOrgListingConsentToggleProps) {
  const statusText = !ownValue
    ? SUB_ORG_LABELS.LISTING_CONSENT_OFF
    : otherPartyValue
      ? SUB_ORG_LABELS.LISTING_CONSENT_ON
      : waitingLabel;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs font-medium">
          {SUB_ORG_LABELS.LISTING_CONSENT_LABEL}
        </Label>
        <p className="text-xs text-muted-foreground">{SUB_ORG_LABELS.LISTING_CONSENT_HELP}</p>
        <p className="text-xs text-muted-foreground mt-0.5" data-testid={`${id}-status`}>
          {statusText}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Switch
          id={id}
          checked={ownValue}
          disabled={disabled || busy}
          onCheckedChange={(next: boolean) => {
            void onToggle(next).then((landed) => {
              if (landed !== null) onChanged(landed);
            });
          }}
        />
      </div>
    </div>
  );
}
