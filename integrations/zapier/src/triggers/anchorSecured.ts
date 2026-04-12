/**
 * Trigger: New Anchor Secured
 *
 * Fires when a document has been anchored to Bitcoin and reaches SECURED status.
 * Uses Arkova webhooks (REST hooks) — Zapier subscribes/unsubscribes automatically.
 */

import { BASE_URL } from '../constants';

const subscribeHook = async (z: any, bundle: any) => {
  const response = await z.request({
    url: `${BASE_URL}/api/v1/webhooks`,
    method: 'POST',
    headers: { 'X-API-Key': bundle.authData.apiKey },
    body: {
      url: bundle.targetUrl,
      events: ['anchor.secured'],
      description: `Zapier trigger: anchor.secured (zap ${bundle.meta?.zap?.id ?? 'unknown'})`,
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
  // Zapier delivers the webhook payload in bundle.cleanedRequest
  const payload = bundle.cleanedRequest;
  return [
    {
      id: payload.event_id ?? payload.id ?? Date.now().toString(),
      public_id: payload.data?.public_id ?? payload.public_id,
      fingerprint: payload.data?.fingerprint ?? payload.fingerprint,
      status: payload.data?.status ?? 'SECURED',
      credential_type: payload.data?.credential_type,
      issuer_name: payload.data?.issuer_name,
      anchor_timestamp: payload.data?.anchor_timestamp,
      network_receipt_id: payload.data?.network_receipt_id,
      record_uri: payload.data?.record_uri,
      event_type: payload.event_type ?? 'anchor.secured',
      delivered_at: payload.delivered_at ?? new Date().toISOString(),
    },
  ];
};

const performList = async (z: any, bundle: any) => {
  // Polling fallback for testing in Zapier editor
  const response = await z.request({
    url: `${BASE_URL}/api/v1/verify/batch`,
    method: 'POST',
    headers: { 'X-API-Key': bundle.authData.apiKey },
    body: { public_ids: [] },
  });
  return [
    {
      id: 'sample-1',
      public_id: 'ARK-2026-SAMPLE',
      fingerprint: 'a'.repeat(64),
      status: 'SECURED',
      credential_type: 'DEGREE',
      issuer_name: 'Arkova Sample',
      anchor_timestamp: new Date().toISOString(),
      network_receipt_id: 'sample-tx',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-SAMPLE',
      event_type: 'anchor.secured',
      delivered_at: new Date().toISOString(),
    },
  ];
};

export const anchorSecuredTrigger = {
  key: 'anchor_secured',
  noun: 'Secured Anchor',
  display: {
    label: 'New Anchor Secured',
    description: 'Triggers when a document is anchored to Bitcoin and reaches SECURED status.',
    important: true,
  },
  operation: {
    type: 'hook' as const,
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: parsePayload,
    performList,
    sample: {
      id: 'evt-sample',
      public_id: 'ARK-2026-001',
      fingerprint: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      status: 'SECURED',
      credential_type: 'DEGREE',
      issuer_name: 'University of Michigan',
      anchor_timestamp: '2026-04-12T00:00:00Z',
      network_receipt_id: 'abc123def456',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
      event_type: 'anchor.secured',
      delivered_at: '2026-04-12T00:00:01Z',
    },
    outputFields: [
      { key: 'public_id', label: 'Public ID', type: 'string' },
      { key: 'fingerprint', label: 'Fingerprint (SHA-256)', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'credential_type', label: 'Credential Type', type: 'string' },
      { key: 'issuer_name', label: 'Issuer', type: 'string' },
      { key: 'anchor_timestamp', label: 'Anchor Timestamp', type: 'datetime' },
      { key: 'network_receipt_id', label: 'Network Receipt ID', type: 'string' },
      { key: 'record_uri', label: 'Verification URL', type: 'string' },
    ],
  },
};
