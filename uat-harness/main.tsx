import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReferralPanel } from '@/components/org/ReferralPanel';
import { REFERRAL_LABELS } from '@/lib/copy';
import '@/index.css';

createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-background p-4">
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{REFERRAL_LABELS.PAGE_TITLE}</h1>
        <p className="text-sm text-muted-foreground">{REFERRAL_LABELS.PAGE_DESCRIPTION}</p>
      </div>
      <ReferralPanel orgId="org-uat-referrer" canManage />
    </div>
  </div>,
);
