/**
 * Action: Verify Credential
 *
 * Verifies a credential by its Arkova public ID (ARK-XXXX).
 */

import { BASE_URL } from '../constants';

const perform = async (z: any, bundle: any) => {
  const publicId = bundle.inputData.public_id;

  const response = await z.request({
    url: `${BASE_URL}/api/v1/verify/${encodeURIComponent(publicId)}`,
    method: 'GET',
    headers: { 'X-API-Key': bundle.authData.apiKey },
  });

  if (response.status === 404) {
    return {
      verified: false,
      public_id: publicId,
      error: 'Record not found',
    };
  }

  if (response.status >= 400) {
    const err = response.data;
    throw new z.errors.Error(
      err?.message ?? `Verify failed: HTTP ${response.status}`,
      'VerifyError',
      response.status,
    );
  }

  return {
    ...response.data,
    public_id: publicId,
  };
};

export const verifyCredentialAction = {
  key: 'verify_credential',
  noun: 'Verification',
  display: {
    label: 'Verify Credential',
    description: 'Verify a credential by its Arkova public ID.',
    important: true,
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'public_id',
        label: 'Public ID',
        type: 'string' as const,
        required: true,
        helpText: 'The Arkova public identifier (e.g., ARK-2026-001).',
      },
    ],
    sample: {
      verified: true,
      public_id: 'ARK-2026-001',
      status: 'ACTIVE',
      issuer_name: 'University of Michigan',
      credential_type: 'DEGREE',
      issued_date: '2025-05-15',
      expiry_date: null,
      anchor_timestamp: '2026-04-12T00:00:00Z',
      network_receipt_id: 'abc123def456',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
    },
    outputFields: [
      { key: 'verified', label: 'Verified', type: 'boolean' },
      { key: 'public_id', label: 'Public ID', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'issuer_name', label: 'Issuer', type: 'string' },
      { key: 'credential_type', label: 'Credential Type', type: 'string' },
      { key: 'issued_date', label: 'Issued Date', type: 'string' },
      { key: 'expiry_date', label: 'Expiry Date', type: 'string' },
      { key: 'anchor_timestamp', label: 'Anchor Timestamp', type: 'datetime' },
      { key: 'network_receipt_id', label: 'Network Receipt ID', type: 'string' },
      { key: 'record_uri', label: 'Verification URL', type: 'string' },
    ],
  },
};
