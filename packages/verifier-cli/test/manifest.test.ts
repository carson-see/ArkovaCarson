/**
 * S3-B manifest conformance — the TypeScript side of the three-way agreement
 * (TS == Python == manifest).
 *
 * fixtures/manifest.json is the SINGLE versioned list of every fixture and the
 * exact { verdict, reason_code } each must produce. This suite:
 *   1. freezes the reason enum (manifest reason_codes == src/lib/reason-codes.ts);
 *   2. runs EVERY manifest entry through verifyProof() and asserts the verdict
 *      AND machine reason code match the manifest exactly;
 *   3. asserts manifest coverage is complete (every fixture in every source
 *      file is listed; every reason code is exercised at least once);
 *   4. pins the materialized PROOF-08 signature vectors to the corpus so the
 *      adversarial copies can never drift from proof-fixtures.json.
 *
 * Fully offline — canned node responses only, no network.
 */

import { describe, it, expect } from 'vitest';
import { verifyProof } from '../src/verify.js';
import { REASON_CODES } from '../src/lib/reason-codes.js';
import {
  loadManifest,
  loadSyntheticFixtures,
  loadAdversarialFixtures,
  loadProof08,
  resolveManifestEntry,
  offlineNode,
} from './helpers.js';
import type { VerifierFixture } from '../src/types.js';

const manifest = loadManifest();

async function runFixture(fixture: VerifierFixture, mode: string) {
  return verifyProof(fixture.packet, {
    chain: mode === 'chain' && fixture.node ? offlineNode(fixture) : undefined,
    signedBundle: mode === 'signature' ? fixture.signedBundle : undefined,
    publishedKeys: mode === 'signature' ? fixture.publishedKeys : undefined,
  });
}

describe('reason enum freeze', () => {
  it('the manifest reason_codes and src/lib/reason-codes.ts REASON_CODES are identical', () => {
    expect(manifest.reason_codes).toEqual([...REASON_CODES]);
  });

  it('every manifest expectation uses a frozen reason code (or null on VERIFIED)', () => {
    for (const entry of manifest.fixtures) {
      if (entry.expected.verdict === 'VERIFIED') {
        expect(entry.expected.reason_code, entry.id).toBeNull();
      } else {
        expect(REASON_CODES, `${entry.id} uses unknown code ${entry.expected.reason_code}`).toContain(
          entry.expected.reason_code,
        );
      }
    }
  });
});

describe('manifest conformance (TS verifier == manifest)', () => {
  for (const entry of manifest.fixtures) {
    it(`${entry.id} [${entry.mode}] → ${entry.expected.verdict}${entry.expected.reason_code ? ` / ${entry.expected.reason_code}` : ''}`, async () => {
      const fixture = resolveManifestEntry(entry);
      const report = await runFixture(fixture, entry.mode);

      expect(report.ok, `verdict for ${entry.id}`).toBe(entry.expected.verdict === 'VERIFIED');
      expect(report.reasonCode ?? null, `reason code for ${entry.id}`).toBe(
        entry.expected.reason_code,
      );
      if (entry.expected.signature) {
        expect(report.signature.status, `signature status for ${entry.id}`).toBe(
          entry.expected.signature,
        );
      }
      // When the source fixture pins a human-readable reason substring, the
      // rendered step details must still carry it (auditor-legible reporting).
      const reasonIncludes = (fixture.expect as { reasonIncludes?: string }).reasonIncludes;
      if (reasonIncludes) {
        const allDetail = report.steps.map((s) => s.detail).join(' | ');
        expect(allDetail, `detail for ${entry.id}`).toContain(reasonIncludes);
      }
    });
  }
});

describe('manifest coverage is complete', () => {
  it('every synthetic fixture is listed exactly once', () => {
    const listed = manifest.fixtures.filter((f) => f.source === 'synthetic').map((f) => f.ref);
    const actual = loadSyntheticFixtures().map((f) => f.name);
    expect(listed.sort()).toEqual(actual.sort());
  });

  it('every adversarial fixture is listed exactly once', () => {
    const listed = manifest.fixtures.filter((f) => f.source === 'adversarial').map((f) => f.ref);
    const actual = loadAdversarialFixtures().map((f) => f.name);
    expect(listed.sort()).toEqual(actual.sort());
  });

  it('every PROOF-08 vector is either listed or explicitly excluded with a rationale', () => {
    const corpus = loadProof08();
    const listed = new Set(manifest.fixtures.filter((f) => f.source === 'proof08').map((f) => f.ref));
    const excluded = new Set(manifest.excluded.map((e) => e.ref));
    const vectorIds: string[] = ['valid-inclusion', ...corpus.invalid.map((i: { id: string }) => i.id)];
    for (const id of vectorIds) {
      expect(listed.has(id) || excluded.has(id), `PROOF-08 vector ${id} unaccounted for`).toBe(true);
    }
    for (const e of manifest.excluded) {
      expect(e.why.length, `excluded ${e.id} needs a rationale`).toBeGreaterThan(20);
    }
  });

  it('every frozen reason code is exercised by at least one manifest fixture', () => {
    const used = new Set(manifest.fixtures.map((f) => f.expected.reason_code).filter(Boolean));
    for (const code of REASON_CODES) {
      expect(used.has(code), `reason code ${code} has no fixture`).toBe(true);
    }
  });
});

describe('materialized PROOF-08 signature vectors cannot drift from the corpus', () => {
  const corpus = loadProof08();
  const adversarial = loadAdversarialFixtures();

  it('adv-valid-signed-bundle embeds the exact corpus valid_bundle + TEST key', () => {
    const f = adversarial.find((x) => x.name === 'adv-valid-signed-bundle')!;
    expect(f.signedBundle).toEqual(corpus.signed_bundle.valid_bundle);
    expect(f.publishedKeys?.keys[0].pem).toBe(corpus.signed_bundle.test_public_key_pem);
    expect(f.publishedKeys?.keys[0].kid).toBe(corpus.signed_bundle.signing_key_id);
  });

  it('adv-forged-signature is the corpus-documented bad_signature_value swap (nothing else changed)', () => {
    const f = adversarial.find((x) => x.name === 'adv-forged-signature')!;
    expect(f.signedBundle?.signature.value).toBe(corpus.signed_bundle.bad_signature_value);
    expect(f.signedBundle?.payload).toEqual(corpus.signed_bundle.valid_bundle.payload);
    expect(f.signedBundle?.signing_key_id).toBe(corpus.signed_bundle.valid_bundle.signing_key_id);
  });

  it('adv-unknown-signing-key-id differs from the corpus bundle ONLY in signing_key_id', () => {
    const f = adversarial.find((x) => x.name === 'adv-unknown-signing-key-id')!;
    expect(f.signedBundle?.payload).toEqual(corpus.signed_bundle.valid_bundle.payload);
    expect(f.signedBundle?.signature).toEqual(corpus.signed_bundle.valid_bundle.signature);
    expect(f.signedBundle?.signing_key_id).not.toBe(corpus.signed_bundle.valid_bundle.signing_key_id);
    expect(f.publishedKeys?.keys.map((k) => k.kid)).not.toContain(f.signedBundle?.signing_key_id);
  });
});
