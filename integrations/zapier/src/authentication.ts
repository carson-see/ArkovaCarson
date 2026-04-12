/**
 * Zapier API Key authentication for Arkova.
 *
 * Users enter their Arkova API key (starts with 'ak_').
 * We validate by calling GET /api/v1/health with the key header.
 */

import { BASE_URL } from './constants';

export const authentication = {
  type: 'custom' as const,
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'string' as const,
      required: true,
      helpText:
        'Your Arkova API key. Find it at [app.arkova.ai/settings/api-keys](https://app.arkova.ai/settings/api-keys). Starts with `ak_`.',
    },
  ],
  test: async (z: any, bundle: any) => {
    const response = await z.request({
      url: `${BASE_URL}/api/v1/health`,
      headers: { 'X-API-Key': bundle.authData.apiKey },
    });
    if (response.status !== 200) {
      throw new z.errors.Error('Invalid API key', 'AuthenticationError', response.status);
    }
    return { status: 'authenticated' };
  },
  connectionLabel: (z: any, bundle: any) => {
    const key = bundle.authData?.apiKey ?? '';
    const masked = key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-4)}` : '****';
    return `Arkova (${masked})`;
  },
};
