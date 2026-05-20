import { describe, expect, it } from 'vitest';
import { buildCleExtractionPrompt } from './cle-extraction-prompt.js';
import { buildCpeExtractionPrompt } from './cpe-extraction-prompt.js';

const piiEvidence = {
  schemaVersion: 'credential_evidence_v1',
  source: {
    provider: 'udemy',
    url: 'https://www.udemy.com/certificate/UC-123',
    id: 'UC-123',
    fetchedAt: '2026-05-20T12:00:00.000Z',
  },
  credential: {
    type: 'CERTIFICATE',
    title: 'Advanced Tax Planning',
    issuerName: 'Udemy',
    issuedAt: '2026-05-01',
    recipientName: 'Jamie Demo',
    recipientEmail: 'jamie.demo@example.com',
    recipientAddress: '123 Maple Street, Detroit, MI 48201',
    barNumber: 'NY-123456',
  },
  evidence: {
    verificationLevel: 'captured_url',
    extractionMethod: 'ai_extraction',
    confidence: 0.88,
  },
};

describe('professional education extraction prompts', () => {
  it('builds a CPE prompt without recipient PII', () => {
    const prompt = buildCpeExtractionPrompt(piiEvidence);

    expect(prompt).toContain('CpeMetadata');
    expect(prompt).toContain('credit_hours');
    expect(prompt).toContain('NASBA');
    expect(prompt).not.toContain('Jamie Demo');
    expect(prompt).not.toContain('jamie.demo@example.com');
    expect(prompt).not.toContain('123 Maple Street');
  });

  it('builds a CLE prompt without attorney PII and keeps ethics_hours explicit', () => {
    const prompt = buildCleExtractionPrompt(piiEvidence);

    expect(prompt).toContain('CleMetadata');
    expect(prompt).toContain('ethics_hours');
    expect(prompt).toContain('never infer ethics_hours');
    expect(prompt).not.toContain('Jamie Demo');
    expect(prompt).not.toContain('jamie.demo@example.com');
    expect(prompt).not.toContain('NY-123456');
  });
});
