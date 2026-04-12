/**
 * Action: Batch Verify
 *
 * Verify up to 20 credentials in a single request.
 * Returns results in the same order as input.
 */

import { BASE_URL, BATCH_SYNC_LIMIT } from '../constants';

const perform = async (z: any, bundle: any) => {
  const rawIds = bundle.inputData.public_ids;
  const publicIds: string[] = typeof rawIds === 'string'
    ? rawIds.split(',').map((s: string) => s.trim()).filter(Boolean)
    : Array.isArray(rawIds) ? rawIds : [];

  if (publicIds.length === 0) {
    return { results: [], count: 0 };
  }

  if (publicIds.length > BATCH_SYNC_LIMIT) {
    throw new z.errors.Error(
      `Batch verify accepts at most ${BATCH_SYNC_LIMIT} public IDs. Got ${publicIds.length}.`,
      'BatchTooLargeError',
      400,
    );
  }

  const response = await z.request({
    url: `${BASE_URL}/api/v1/verify/batch`,
    method: 'POST',
    headers: { 'X-API-Key': bundle.authData.apiKey },
    body: { public_ids: publicIds },
  });

  if (response.status >= 400) {
    const err = response.data;
    throw new z.errors.Error(
      err?.message ?? `Batch verify failed: HTTP ${response.status}`,
      'BatchVerifyError',
      response.status,
    );
  }

  const data = response.data;
  return {
    results: data.results ?? [],
    count: data.results?.length ?? 0,
  };
};

export const batchVerifyAction = {
  key: 'batch_verify',
  noun: 'Batch Verification',
  display: {
    label: 'Batch Verify Credentials',
    description: 'Verify up to 20 credentials in a single request.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'public_ids',
        label: 'Public IDs',
        type: 'string' as const,
        required: true,
        helpText:
          'Comma-separated list of Arkova public IDs (e.g., ARK-2026-001, ARK-2026-002). Max 20.',
        list: false,
      },
    ],
    sample: {
      results: [
        {
          verified: true,
          status: 'ACTIVE',
          issuer_name: 'University A',
          credential_type: 'DEGREE',
        },
        {
          verified: false,
          status: 'REVOKED',
          issuer_name: 'University B',
          credential_type: 'LICENSE',
        },
      ],
      count: 2,
    },
    outputFields: [
      { key: 'count', label: 'Result Count', type: 'integer' },
    ],
  },
};
