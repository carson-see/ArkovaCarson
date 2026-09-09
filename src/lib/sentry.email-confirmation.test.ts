import { describe, expect, it } from 'vitest';
import { scrubPiiFromEvent, scrubPiiFromBreadcrumb } from './sentry';

describe('mailbox proof never reaches telemetry', () => {
  it.each(['token', 'token_hash', 'email_confirmation'])('redacts nonhex %s in event and navigation URLs', (key) => {
    const url = `https://app.arkova.ai/signup#${key}=opaque-credential-value&type=oauth_confirmation`;
    const event = scrubPiiFromEvent({ message: url, request: { url }, exception: { values: [{ value: url }] } });
    const crumb = scrubPiiFromBreadcrumb({ category: 'navigation', data: { from: url, to: url, url }, message: url });
    expect(JSON.stringify({ event, crumb })).not.toContain('opaque-credential-value');
  });
});
