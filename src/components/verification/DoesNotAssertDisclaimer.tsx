/**
 * Does-Not-Assert Disclaimer (SCRUM-2495 / ABUSE-DISCLAIMER)
 *
 * Always-visible block on the proof/verification surface stating what an
 * Arkova anchor MEASURES, ASSERTS, and does NOT assert — CLAUDE.md §1.5
 * ("Proof packages state what is measured, asserted, and NOT asserted.
 * Jurisdiction tags are informational metadata only.").
 *
 * Deliberately NOT a tooltip and NOT behind a click-to-reveal affordance —
 * it renders inline, always visible, immediately below the cryptographic
 * proof / proof-download section.
 *
 * All copy sourced from src/lib/copy.ts (CLAUDE.md §6 — no text directly in
 * JSX). Copy is scanned by `npm run lint:copy` for the §1.3 banned-terms
 * list (Wallet, Hash, Block, Transaction, Crypto, Blockchain, Bitcoin,
 * Testnet, Mainnet, UTXO, Broadcast).
 *
 * @see SCRUM-2495, CLAUDE.md §1.5, §1.3
 */

import { AlertTriangle } from 'lucide-react';
import { DOES_NOT_ASSERT_LABELS } from '@/lib/copy';

export function DoesNotAssertDisclaimer() {
  return (
    <div
      data-testid="does-not-assert-disclaimer"
      className="rounded-lg bg-muted/50 border border-border p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {DOES_NOT_ASSERT_LABELS.TITLE}
        </p>
      </div>
      <dl className="space-y-2 pl-6">
        <div>
          <dt className="text-xs font-semibold text-foreground">
            {DOES_NOT_ASSERT_LABELS.MEASURED_LABEL}
          </dt>
          <dd className="text-xs text-muted-foreground leading-relaxed">
            {DOES_NOT_ASSERT_LABELS.MEASURED_BODY}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-foreground">
            {DOES_NOT_ASSERT_LABELS.ASSERTED_LABEL}
          </dt>
          <dd className="text-xs text-muted-foreground leading-relaxed">
            {DOES_NOT_ASSERT_LABELS.ASSERTED_BODY}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-foreground">
            {DOES_NOT_ASSERT_LABELS.NOT_ASSERTED_LABEL}
          </dt>
          <dd className="text-xs text-muted-foreground leading-relaxed">
            {DOES_NOT_ASSERT_LABELS.NOT_ASSERTED_BODY}
          </dd>
        </div>
      </dl>
    </div>
  );
}
