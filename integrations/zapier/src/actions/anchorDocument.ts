/**
 * Action: Anchor Document
 *
 * Takes a fingerprint (SHA-256 hash) and submits it for Bitcoin anchoring.
 * Zapier users compute the hash in a prior step or provide pre-computed value.
 */

import { BASE_URL } from '../constants';

const perform = async (z: any, bundle: any) => {
  const body: Record<string, string> = {
    fingerprint: bundle.inputData.fingerprint,
  };
  if (bundle.inputData.credential_type) {
    body.credential_type = bundle.inputData.credential_type;
  }
  if (bundle.inputData.description) {
    body.description = bundle.inputData.description;
  }

  const response = await z.request({
    url: `${BASE_URL}/api/v1/anchor`,
    method: 'POST',
    headers: { 'X-API-Key': bundle.authData.apiKey },
    body,
  });

  if (response.status >= 400) {
    const err = response.data;
    throw new z.errors.Error(
      err?.message ?? `Anchor failed: HTTP ${response.status}`,
      'AnchorError',
      response.status,
    );
  }

  return response.data;
};

export const anchorDocumentAction = {
  key: 'anchor_document',
  noun: 'Anchor',
  display: {
    label: 'Anchor Document',
    description: 'Submit a document fingerprint (SHA-256) for Bitcoin anchoring.',
    important: true,
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'fingerprint',
        label: 'Document Fingerprint',
        type: 'string' as const,
        required: true,
        helpText:
          '64-character SHA-256 hash of the document. Compute with `sha256sum file.pdf` or use a Code by Zapier step.',
      },
      {
        key: 'credential_type',
        label: 'Credential Type',
        type: 'string' as const,
        required: false,
        choices: [
          'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL',
          'CLE', 'FINANCIAL', 'LEGAL', 'INSURANCE', 'SEC_FILING', 'PATENT',
          'REGULATION', 'PUBLICATION', 'RESUME', 'MEDICAL', 'IDENTITY', 'OTHER',
        ],
        helpText: 'Type of credential being anchored.',
      },
      {
        key: 'description',
        label: 'Description',
        type: 'text' as const,
        required: false,
        helpText: 'Human-readable description of the document.',
      },
    ],
    sample: {
      public_id: 'ARK-2026-001',
      fingerprint: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      status: 'PENDING',
      created_at: '2026-04-12T00:00:00Z',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
    },
    outputFields: [
      { key: 'public_id', label: 'Public ID', type: 'string' },
      { key: 'fingerprint', label: 'Fingerprint', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
      { key: 'record_uri', label: 'Verification URL', type: 'string' },
    ],
  },
};
