import React from 'react';
import { createRoot } from 'react-dom/client';
import { ManageSubOrgs } from '@/components/org/ManageSubOrgs';
import '@/index.css';

const subOrgs = [
  { id: 'child-approved', display_name: 'Nairobi Firm A', domain: 'firm-a.example',
    verification_status: 'UNVERIFIED', parent_approval_status: 'APPROVED',
    created_at: '2026-08-01T10:00:00Z', logo_url: null },
  { id: 'child-approved-2', display_name: 'Mombasa Legal Aid Centre', domain: 'mlac.example',
    verification_status: 'UNVERIFIED', parent_approval_status: 'APPROVED',
    created_at: '2026-08-03T10:00:00Z', logo_url: null },
  { id: 'child-pending', display_name: 'Kisumu Advocates', domain: 'kisumu.example',
    verification_status: 'UNVERIFIED', parent_approval_status: 'PENDING',
    created_at: '2026-08-05T10:00:00Z', logo_url: null },
];

const balances: Record<string, number> = { 'child-approved': 25, 'child-approved-2': 120 };
let parentBalance = 850;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
  const method = init?.method ?? 'GET';
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

  if (url.includes('/sub-orgs/credits') && method === 'GET') {
    return json({ parentBalance, children: Object.entries(balances)
      .map(([childOrgId, balance]) => ({ childOrgId, balance, monthlyAllocation: 0 })) });
  }
  if (url.includes('/sub-orgs/credits') && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.amount > parentBalance) return json({ error: 'insufficient_parent_balance' }, 409);
    parentBalance -= body.amount;
    balances[body.childOrgId] = (balances[body.childOrgId] ?? 0) + body.amount;
    return json({ parentBalance, childBalance: balances[body.childOrgId], amount: body.amount });
  }
  if (url.includes('/sub-orgs')) return json({ subOrgs });
  return json({});
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-background p-4">
    <ManageSubOrgs orgId="org-hakichain" />
  </div>,
);
