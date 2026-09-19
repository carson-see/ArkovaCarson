import { describe, expect, it } from 'vitest';
import { webhookPublicReference } from './public-reference.js';

describe('webhookPublicReference', () => {
  it('is deterministic, domain separated, and does not expose the internal id', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const job = webhookPublicReference('job', id);
    expect(job).toMatch(/^job_[a-f0-9]{32}$/);
    expect(webhookPublicReference('job', id)).toBe(job);
    expect(webhookPublicReference('cert', id).slice(5)).not.toBe(job.slice(4));
    expect(job).not.toContain(id);
  });
});
