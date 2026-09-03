/**
 * Security ratchet for BUG-2026-08-12-003 / FD-15.
 *
 * FD-15 relaxed UUID validation on values read back OUT of Postgres, because
 * re-validating a `uuid` column with a STRICTER rule than the database enforces
 * can only false-reject data we ourselves stored. That reasoning applies to
 * DB-sourced values and NOWHERE ELSE.
 *
 * On external input — request bodies, query strings, URL params, webhook
 * payloads, OAuth callbacks — strict `z.string().uuid()` IS the security
 * boundary: nothing upstream has guaranteed the shape, and a permissive check
 * widens what an unauthenticated caller can push into a query. This file pins
 * that boundary so the FD-15 relaxation cannot creep across it.
 *
 * Two independent guards per file:
 *
 *   1. The file must not import `db-row-validation.js`. The permissive helper
 *      has no business at a request boundary, so its mere presence in an
 *      external-input module fails here.
 *   2. The count of strict `.uuid()` call sites must not DROP below the pinned
 *      number. Swapping one for a regex, a `.min(1)`, or `dbUuid()` trips it.
 *
 * If you are here because this test failed:
 *   - Adding a new strict `.uuid()` to one of these files — raise the pinned
 *     count. That is the expected, safe direction.
 *   - REMOVING or relaxing one — do not lower the count to make this green
 *     without establishing that the value is DB-sourced, and say so in the PR.
 *     That is the whole point of the ratchet.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Strict Zod RFC-9562 UUID check — the thing that must stay put. */
const STRICT_UUID_CALL = /\.uuid\(\)/g;

/**
 * Files whose `.uuid()` sites validate data from OUTSIDE the trust boundary,
 * with the number of strict call sites each must retain. Counts verified
 * against the classification in the FD-15 PR body.
 */
const EXTERNAL_INPUT_FILES: Array<{ file: string; minStrictUuidCalls: number; boundary: string }> = [
  { file: 'api/rules-crud.ts', minStrictUuidCalls: 3, boundary: 'req.params.id + req.body' },
  { file: 'api/anchor-revoke.ts', minStrictUuidCalls: 1, boundary: 'req.params' },
  { file: 'api/notifications.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/anchor-lineage.ts', minStrictUuidCalls: 1, boundary: 'req.params.id' },
  { file: 'api/version-resolution.ts', minStrictUuidCalls: 1, boundary: 'req.params.versionId' },
  { file: 'api/queue-resolution.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/compliance-cross-ref.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/signatures.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/ai-integrity.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/attestations.ts', minStrictUuidCalls: 2, boundary: 'req.body + req.query' },
  { file: 'api/v1/grc.ts', minStrictUuidCalls: 1, boundary: 'OAuth callback req.body' },
  { file: 'api/v1/hipaa-audit.ts', minStrictUuidCalls: 1, boundary: 'req.query' },
  { file: 'api/v1/ai-embed.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/orgSubOrgs.ts', minStrictUuidCalls: 3, boundary: 'req.body' },
  { file: 'api/v1/integrations/docusign-member-oauth.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/integrations/docusign-oauth.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'api/v1/integrations/drive-oauth.ts', minStrictUuidCalls: 2, boundary: 'req.body' },
  { file: 'api/v1/integrations/issuer-partnerships.ts', minStrictUuidCalls: 2, boundary: 'req.body' },
  { file: 'routes/cron.ts', minStrictUuidCalls: 2, boundary: 'req.query.org_id / req.body.org_id' },
  { file: 'ai/feedback.ts', minStrictUuidCalls: 1, boundary: 'req.body' },
  { file: 'integrations/connectors/schemas.ts', minStrictUuidCalls: 1, boundary: 'Microsoft Graph webhook body' },
];

/**
 * Sites left strict on purpose even though they are not a clean request
 * boundary. Pinned so a later "consistency" sweep does not relax them by
 * accident — each needs its own decision, not a blanket one.
 */
const DELIBERATELY_STRICT_FILES: Array<{ file: string; minStrictUuidCalls: number; why: string }> = [
  {
    file: 'rules/schemas.ts',
    minStrictUuidCalls: 2,
    why:
      'MIXED provenance. validateRuleConfigs runs over req.body on 3 of 4 call sites; the 4th ' +
      '(rules-crud PATCH) merges stored organization_rules JSONB. Those UUIDs live in jsonb, so ' +
      'Postgres gives NO format guarantee — the only guarantee is that a prior write passed this ' +
      'same schema. Relaxing would widen a live external input to buy nothing on the DB side.',
  },
  {
    file: 'api/v1/contracts/anchor-post-signing.ts',
    minStrictUuidCalls: 1,
    why:
      'PostSigningInsertPayloadSchema has no parse call site anywhere (handler 501s). No value ' +
      'flows through it, so it cannot false-reject; it is a spec pin for SCRUM-1633.',
  },
  {
    file: 'integrations/credential-sources/token-store.ts',
    minStrictUuidCalls: 2,
    why:
      'storeCredentialProviderTokens has no production caller. Its live sibling storeIssuerCredentials ' +
      'is called with orgId straight off req.body, so if this is ever wired it is EXTERNAL and strict ' +
      'is already correct.',
  },
  {
    file: 'jobs/rules-engine-versions.ts',
    minStrictUuidCalls: 1,
    why: 'insertVersionRecord has no production caller. Dead either way; left strict pending wiring.',
  },
  {
    file: 'api/partner-provisioning.ts',
    minStrictUuidCalls: 2,
    why:
      'MIXED. `orgId` on the actor (server-derived principal) was relaxed to DB_UUID_RE; ' +
      '`sponsorOrgId` (caller-supplied request payload) and `partnerOrgId` stay strict. The module ' +
      'has no HTTP routes yet, and nothing structurally stops a future route from passing a ' +
      'client-supplied partnerOrgId, so that one keeps the stricter check.',
  },
];

/**
 * Strip comments before counting. These modules *discuss* `.uuid()` in their
 * FD-15 doc comments; counting prose would make the ratchet report validation
 * that is not there (and, worse, let a real removal hide behind a mention).
 * `//` preceded by `:` is left alone so URLs in string literals do not eat the
 * rest of their line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readSource(relPath: string): string {
  return stripComments(readFileSync(resolve(SRC_ROOT, relPath), 'utf8'));
}

function countStrictUuid(source: string): number {
  return source.match(STRICT_UUID_CALL)?.length ?? 0;
}

describe('external-input UUID validation stays strict (FD-15 ratchet)', () => {
  it.each(EXTERNAL_INPUT_FILES)(
    '$file keeps at least $minStrictUuidCalls strict .uuid() call(s) [$boundary]',
    ({ file, minStrictUuidCalls }) => {
      const source = readSource(file);
      expect(
        countStrictUuid(source),
        `${file} validates ${'external input'} — strict z.string().uuid() must not be relaxed here. ` +
          'If you added a strict uuid, raise the pinned count; if you removed one, justify it as DB-sourced in the PR.',
      ).toBeGreaterThanOrEqual(minStrictUuidCalls);
    },
  );

  it.each(EXTERNAL_INPUT_FILES)('$file does not import the permissive DB-sourced helper', ({ file }) => {
    const source = readSource(file);
    expect(
      source.includes('db-row-validation'),
      `${file} is an external-input boundary. The permissive dbUuid()/DB_UUID_RE helper is for values read ` +
        'back out of Postgres only — using it here would widen what an untrusted caller can submit.',
    ).toBe(false);
  });
});

/**
 * The other direction: the DB-sourced sites FD-15 relaxed must stay relaxed.
 * If someone "tidies" them back to strict `.uuid()`, the org-queue-scheduler
 * outage returns, so pin that too.
 */
const DB_SOURCED_FILES: string[] = [
  'jobs/org-queue-scheduler.ts',
  'jobs/anchorExpirySweep.ts',
  'jobs/rule-action-dispatcher.ts',
  'jobs/ai-credit-reconcile.ts',
  'jobs/connector-artifact-drain.ts',
  'jobs/docusign-notarization-completed.ts',
  'compliance/professional-education.ts',
  'integrations/connectors/drive-artifact-producer.ts',
  'integrations/connectors/docusign.ts',
  'integrations/connectors/drive-changes-runner.ts',
];

describe('deliberately-strict sites stay strict (FD-15)', () => {
  it.each(DELIBERATELY_STRICT_FILES)(
    '$file keeps at least $minStrictUuidCalls strict .uuid() call(s)',
    ({ file, minStrictUuidCalls, why }) => {
      expect(countStrictUuid(readSource(file)), `${file}: ${why}`).toBeGreaterThanOrEqual(minStrictUuidCalls);
    },
  );
});

describe('DB-sourced UUID validation stays permissive (FD-15 regression pin)', () => {
  it.each(DB_SOURCED_FILES)('%s uses dbUuid(), not strict .uuid()', (file) => {
    const source = readSource(file);
    expect(source).toContain('dbUuid');
    expect(
      countStrictUuid(source),
      `${file} reads rows back out of Postgres. Strict RFC .uuid() there rejects UUIDs the database ` +
        'legitimately holds — that is BUG-2026-08-12-003. Use dbUuid() from utils/db-row-validation.ts.',
    ).toBe(0);
  });

  it('org-queue-scheduler parses claimed rows per-row, not as a whole array', () => {
    const source = readSource('jobs/org-queue-scheduler.ts');
    expect(source).toContain('parseDbRows');
    expect(
      /z\.array\([A-Za-z_]+\)\s*\.\s*(safeParse|parse)\(/.test(source),
      'A wholesale z.array(...).safeParse over DB rows lets one malformed row deny service to the ' +
        'entire claim batch — the FD-15 blast radius. Use parseDbRows().',
    ).toBe(false);
  });
});
