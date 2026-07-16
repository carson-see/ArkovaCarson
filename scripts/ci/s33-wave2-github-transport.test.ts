import { describe, expect, it } from 'vitest';
import {
  S33_WAVE2_ACCEPTANCE_COMMENT_MARKER,
  extractS33Wave2AcceptanceEnvelopeFromBody,
  verifyS33Wave2GitHubTransportEvidence,
} from './s33-wave2-github-transport.js';

function envelope(transport: 'github-issue-comment' | 'github-formal-review' = 'github-issue-comment') {
  const id = transport === 'github-issue-comment' ? 123 : 456;
  const anchor = transport === 'github-issue-comment' ? `issuecomment-${id}` : `pullrequestreview-${id}`;
  return {
    schemaVersion: 2,
    artifactType: 'arkova-s33-detached-acceptance-envelope',
    signatureAlgorithm: 'Ed25519',
    signerIdentity: 'arkova-s33-cto-release',
    request: {
      schemaVersion: 2,
      artifactType: 'arkova-s33-detached-signing-request',
      domainSeparator: 'arkova:s33:detached-acceptance:v2\n',
      payload: {
        repositoryIdentity: 'carson-see/ArkovaCarson',
        pullRequestNumber: 1601,
        reviewer: {
          lane: 'Lane 3',
          transport,
          evidence: {
            id,
            nodeId: 'TRANSPORT_NODE',
            url: `https://github.com/carson-see/ArkovaCarson/pull/1601#${anchor}`,
            submittedAtUtc: '2026-07-15T14:00:00.000Z',
            actor: { login: 'carson-see', databaseId: 99, nodeId: 'ACTOR_NODE' },
          },
        },
      },
    },
  };
}

function body(value: unknown): string {
  return `${S33_WAVE2_ACCEPTANCE_COMMENT_MARKER}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

describe('S3.3 Wave-2 GitHub transport', () => {
  it('extracts exactly one strict JSON envelope from the versioned marker', () => {
    expect(extractS33Wave2AcceptanceEnvelopeFromBody(body(envelope()))).toEqual(envelope());
    expect(() => extractS33Wave2AcceptanceEnvelopeFromBody(`${body(envelope())}\n${body(envelope())}`))
      .toThrow(/exactly one/i);
    expect(() => extractS33Wave2AcceptanceEnvelopeFromBody(
      `${S33_WAVE2_ACCEPTANCE_COMMENT_MARKER}\n\`\`\`json\n{"x":1,"x":2}\n\`\`\``,
    )).toThrow(/duplicate/i);
    expect(() => extractS33Wave2AcceptanceEnvelopeFromBody(
      `<!-- arkova-s33-wave2-authenticated-acceptance:v1 -->\n\n\`\`\`json\n${JSON.stringify(envelope())}\n\`\`\``,
    )).toThrow(/versioned marker/i);
  });

  it('verifies issue-comment transport against live stable GitHub identity', () => {
    const result = verifyS33Wave2GitHubTransportEvidence(envelope(), {
      id: 123,
      node_id: 'TRANSPORT_NODE',
      html_url: 'https://github.com/carson-see/ArkovaCarson/pull/1601#issuecomment-123',
      created_at: '2026-07-15T14:00:00Z',
      user: { login: 'carson-see', id: 99, node_id: 'ACTOR_NODE' },
    }, 1601);
    expect(result.transport).toBe('github-issue-comment');
  });

  it('verifies formal-review transport without requiring APPROVED or a distinct login', () => {
    const result = verifyS33Wave2GitHubTransportEvidence(envelope('github-formal-review'), {
      id: 456,
      node_id: 'TRANSPORT_NODE',
      html_url: 'https://github.com/carson-see/ArkovaCarson/pull/1601#pullrequestreview-456',
      submitted_at: '2026-07-15T14:00:00Z',
      user: { login: 'carson-see', id: 99, node_id: 'ACTOR_NODE' },
      state: 'COMMENTED',
    }, 1601);
    expect(result.transport).toBe('github-formal-review');
  });

  it.each([
    ['id', (value: Record<string, unknown>) => { value.id = 999; }],
    ['node', (value: Record<string, unknown>) => { value.node_id = 'WRONG'; }],
    ['url', (value: Record<string, unknown>) => { value.html_url = 'https://example.com'; }],
    ['timestamp', (value: Record<string, unknown>) => { value.created_at = '2026-07-15T15:00:00Z'; }],
    ['actor', (value: Record<string, unknown>) => {
      value.user = { login: 'attacker', id: 99, node_id: 'ACTOR_NODE' };
    }],
  ])('rejects mismatched live %s evidence', (_label, mutate) => {
    const live: Record<string, unknown> = {
      id: 123,
      node_id: 'TRANSPORT_NODE',
      html_url: 'https://github.com/carson-see/ArkovaCarson/pull/1601#issuecomment-123',
      created_at: '2026-07-15T14:00:00Z',
      user: { login: 'carson-see', id: 99, node_id: 'ACTOR_NODE' },
    };
    mutate(live);
    expect(() => verifyS33Wave2GitHubTransportEvidence(envelope(), live, 1601)).toThrow(/transport/i);
  });
});
