/**
 * Trigger: Anchor Revoked
 *
 * Fires when a previously secured anchor is revoked.
 */

import { BASE_URL } from '../constants';

const subscribeHook = async (z: any, bundle: any) => {
  const response = await z.request({
    url: `${BASE_URL}/api/v1/webhooks`,
    method: 'POST',
    headers: { 'X-API-Key': bundle.authData.apiKey },
    body: {
      url: bundle.targetUrl,
      events: ['anchor.revoked'],
      description: `Zapier trigger: anchor.revoked (zap ${bundle.meta?.zap?.id ?? 'unknown'})`,
    },
  });
  return response.data;
};

const unsubscribeHook = async (z: any, bundle: any) => {
  const webhookId = bundle.subscribeData?.id;
  if (!webhookId) return;
  await z.request({
    url: `${BASE_URL}/api/v1/webhooks/${webhookId}`,
    method: 'DELETE',
    headers: { 'X-API-Key': bundle.authData.apiKey },
  });
};

const parsePayload = (z: any, bundle: any) => {
  const payload = bundle.cleanedRequest;
  return [
    {
      id: payload.event_id ?? payload.id ?? Date.now().toString(),
      public_id: payload.data?.public_id ?? payload.public_id,
      fingerprint: payload.data?.fingerprint ?? payload.fingerprint,
      status: 'REVOKED',
      credential_type: payload.data?.credential_type,
      issuer_name: payload.data?.issuer_name,
      revoked_at: payload.data?.revoked_at ?? payload.delivered_at,
      reason: payload.data?.reason,
      record_uri: payload.data?.record_uri,
      event_type: 'anchor.revoked',
      delivered_at: payload.delivered_at ?? new Date().toISOString(),
    },
  ];
};

const performList = async (_z: any, _bundle: any) => {
  return [
    {
      id: 'sample-revoked-1',
      public_id: 'ARK-2026-SAMPLE-REV',
      fingerprint: 'b'.repeat(64),
      status: 'REVOKED',
      credential_type: 'LICENSE',
      issuer_name: 'Arkova Sample',
      revoked_at: new Date().toISOString(),
      reason: 'Credential expired',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-SAMPLE-REV',
      event_type: 'anchor.revoked',
      delivered_at: new Date().toISOString(),
    },
  ];
};

export const anchorRevokedTrigger = {
  key: 'anchor_revoked',
  noun: 'Revoked Anchor',
  display: {
    label: 'Anchor Revoked',
    description: 'Triggers when a previously secured anchor is revoked.',
    important: true,
  },
  operation: {
    type: 'hook' as const,
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: parsePayload,
    performList,
    sample: {
      id: 'evt-revoked-sample',
      public_id: 'ARK-2026-002',
      fingerprint: 'c'.repeat(64),
      status: 'REVOKED',
      credential_type: 'LICENSE',
      issuer_name: 'State Bar of California',
      revoked_at: '2026-04-12T00:00:00Z',
      reason: 'Credential superseded',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-002',
      event_type: 'anchor.revoked',
      delivered_at: '2026-04-12T00:00:01Z',
    },
    outputFields: [
      { key: 'public_id', label: 'Public ID', type: 'string' },
      { key: 'fingerprint', label: 'Fingerprint (SHA-256)', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'credential_type', label: 'Credential Type', type: 'string' },
      { key: 'issuer_name', label: 'Issuer', type: 'string' },
      { key: 'revoked_at', label: 'Revoked At', type: 'datetime' },
      { key: 'reason', label: 'Revocation Reason', type: 'string' },
      { key: 'record_uri', label: 'Verification URL', type: 'string' },
    ],
  },
};
