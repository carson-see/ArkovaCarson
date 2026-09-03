/**
 * MFA Grace-Period Nudge — SCRUM-3167.
 *
 * Rendered by AuthGuard ABOVE `children` (children still render underneath
 * — this is a nudge, not a gate) when the current user's role WILL require
 * MFA once enforcement activates, but the enforcement date has not arrived
 * yet (`mfaGraceActive` from `useMfaEnrollmentRequirement`). Gives an
 * ORG_ADMIN / platform admin advance notice instead of a surprise
 * non-skippable enrollment screen on the enforcement date.
 *
 * DISMISSAL: per-tab-session (`sessionStorage`), keyed by the resolved
 * enforcement ISO date (`arkova_mfa_grace_dismissed:<enforceFromISO>`). If
 * the date changes (Carson moves the rollout via `VITE_MFA_ENFORCE_FROM` +
 * redeploy), the key changes too — a prior dismissal against an old
 * deadline never silently suppresses the nudge for a NEW one. Storage
 * access is wrapped in try/catch: a private-browsing or storage-disabled
 * environment must degrade to "always show" (the nudge reappearing every
 * load), never to a crash.
 *
 * `enforceFrom` prop (PR #2637 review, item 18/EA4): `AuthGuard` resolves
 * the enforcement date once per render (via `useMfaEnrollmentRequirement`'s
 * `enforceFromIso`) and passes it here, so this component doesn't
 * re-resolve the same env/localStorage inputs a second/third time in the
 * same render. Optional and defaults to resolving it itself, so standalone
 * rendering (and this file's own tests) still works without a caller.
 *
 * Root element uses `aria-live="polite"` (SonarCloud typescript:S6819, item
 * 27) rather than `role="status"` — the rule's own suggested alternative
 * for a container whose content model (nested block-level layout, a link,
 * a button) doesn't fit the phrasing-content-only `<output>` element.
 */

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';
import { MFA_GRACE_NUDGE_LABELS } from '@/lib/copy';
import { resolveMfaEnforceFrom, getMfaGraceDaysRemaining } from '@/lib/mfaPolicy';

interface MfaGraceNudgeProps {
  enforceFrom?: string;
}

function dismissalStorageKey(enforceFromIso: string): string {
  return `arkova_mfa_grace_dismissed:${enforceFromIso}`;
}

function readDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(key: string): void {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // Storage unavailable — worst case the nudge reappears on the next
    // render/reload. Not a functional regression, just a lost convenience.
  }
}

export function MfaGraceNudge({ enforceFrom }: Readonly<MfaGraceNudgeProps> = {}) {
  const enforceFromIso = enforceFrom ?? resolveMfaEnforceFrom();
  const storageKey = dismissalStorageKey(enforceFromIso);
  const [dismissed, setDismissed] = useState(() => readDismissed(storageKey));

  const handleDismiss = useCallback(() => {
    writeDismissed(storageKey);
    setDismissed(true);
  }, [storageKey]);

  if (dismissed) return null;

  const daysRemaining = getMfaGraceDaysRemaining(undefined, enforceFromIso);

  return (
    <div
      aria-live="polite"
      data-testid="mfa-grace-nudge"
      className="flex flex-col gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">{MFA_GRACE_NUDGE_LABELS.TITLE}</p>
          <p className="text-sm text-muted-foreground">
            {MFA_GRACE_NUDGE_LABELS.DAYS_REMAINING(daysRemaining)}
          </p>
          <p className="text-sm text-muted-foreground">{MFA_GRACE_NUDGE_LABELS.BODY}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" asChild data-testid="mfa-grace-nudge-cta">
          <Link to={ROUTES.SETTINGS}>{MFA_GRACE_NUDGE_LABELS.CTA}</Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="mfa-grace-nudge-dismiss"
          aria-label={MFA_GRACE_NUDGE_LABELS.DISMISS}
          onClick={handleDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
