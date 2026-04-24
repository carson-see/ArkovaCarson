/**
 * SCRUM-1055 (SEC-HARDEN-02) — drift-audit unit tests.
 * See scripts/secrets/README.md for context.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDeployWorkerSecrets,
  auditDrift,
  EXPECTED_SECRETS,
} from '../../scripts/secrets/audit-env';

describe('parseDeployWorkerSecrets', () => {
  it('extracts ENV→secret-path bindings from a single --set-secrets line', () => {
    const yaml = `
            --set-secrets "FOO=foo-secret:latest,BAR=bar-secret:latest" \\
            --set-env-vars "NODE_ENV=production"
    `;
    const bindings = parseDeployWorkerSecrets(yaml);
    expect(bindings).toEqual([
      { envVar: 'FOO', secretPath: 'foo-secret:latest' },
      { envVar: 'BAR', secretPath: 'bar-secret:latest' },
    ]);
  });

  it('returns empty list when no --set-secrets line is present', () => {
    expect(parseDeployWorkerSecrets('something else entirely')).toEqual([]);
  });

  it('skips malformed pairs (no = sign) instead of returning bogus bindings', () => {
    const yaml = '--set-secrets "OK=ok:latest,malformed,ALSO=also:latest"';
    const bindings = parseDeployWorkerSecrets(yaml);
    expect(bindings.map((b) => b.envVar)).toEqual(['OK', 'ALSO']);
  });

  it('handles secret paths that themselves contain colons (version selectors)', () => {
    const yaml = '--set-secrets "X=projects/arkova1/secrets/x:5"';
    expect(parseDeployWorkerSecrets(yaml)).toEqual([
      { envVar: 'X', secretPath: 'projects/arkova1/secrets/x:5' },
    ]);
  });

  it('accumulates bindings from multiple --set-secrets lines (defends against workflow split)', () => {
    const yaml = `
            --set-secrets "FOO=foo-secret:latest,BAR=bar-secret:latest" \\
            --set-env-vars "NODE_ENV=production" \\
            --set-secrets "BAZ=baz-secret:latest"
    `;
    const bindings = parseDeployWorkerSecrets(yaml);
    expect(bindings.map((b) => b.envVar)).toEqual(['FOO', 'BAR', 'BAZ']);
  });
});

describe('auditDrift', () => {
  it('marks each expected secret bound or unbound', () => {
    const rows = auditDrift(
      [{ envVar: 'A', secretPath: 'a:latest' }],
      ['A', 'B'],
    );
    expect(rows).toEqual([
      { envVar: 'A', bound: true, secretPath: 'a:latest' },
      { envVar: 'B', bound: false, secretPath: null },
    ]);
  });

  it('preserves the order of the expected list (deterministic report)', () => {
    const rows = auditDrift([], ['Z', 'A', 'M']);
    expect(rows.map((r) => r.envVar)).toEqual(['Z', 'A', 'M']);
  });

  it('ignores bindings that are NOT in the expected list (not our concern)', () => {
    const rows = auditDrift(
      [
        { envVar: 'EXPECTED', secretPath: 'e:latest' },
        { envVar: 'EXTRA_FROM_PROD', secretPath: 'x:latest' },
      ],
      ['EXPECTED'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ envVar: 'EXPECTED', bound: true, secretPath: 'e:latest' });
  });
});

describe('EXPECTED_SECRETS contract', () => {
  it('includes every secret named in the Jira AC', () => {
    // Spot-check the high-risk subset; the full list is the source of truth in audit-env.ts.
    const required = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'BITCOIN_TREASURY_WIF',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
      'API_KEY_HMAC_SECRET',
      'CRON_SECRET',
      'SENTRY_DSN',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_TUNNEL_TOKEN',
      'SAM_GOV_API_KEY',
      'ANTHROPIC_API_KEY',
      'RUNPOD_API_KEY',
    ];
    for (const r of required) expect(EXPECTED_SECRETS).toContain(r);
  });

  it('has no duplicate entries', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const s of EXPECTED_SECRETS) {
      if (seen.has(s)) dupes.push(s);
      seen.add(s);
    }
    expect(dupes).toEqual([]);
  });
});
