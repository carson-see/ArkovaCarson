import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { parseS33ProducerModuleWithLimit } from './s33-wave1-producer-parser.js';
import {
  S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS,
  buildS33HeldoutCorpusAuthentication,
  validateS33HeldoutCorpusAuthenticationRequest,
  validateS33HeldoutCorpusIdentityIndex,
  validateS33HeldoutCorpusSignatureArtifact,
  verifyS33HeldoutCorpusSignature,
  type S33V71ExportIdentityInput,
} from './s33-wave3-corpus-authentication.js';

const workerRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const repositoryRoot = resolve(workerRoot, '../..');
const evidenceRoot = resolve(repositoryRoot, 'docs/lane3/evidence');

interface MutableIdentityIndex {
  heldout: {
    rows: Array<{ id: string; normalizedInputSha256: string }>;
  };
  v71: {
    train: Array<{ id: string }>;
    validation: Array<{ normalizedInputSha256: string }>;
  };
}

const parseJson = (name: string): unknown => JSON.parse(
  readFileSync(resolve(evidenceRoot, name), 'utf8'),
);

function sourceInputs() {
  return S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.sources.map((source) => {
    const sourceText = readFileSync(resolve(repositoryRoot, source.path), 'utf8');
    return {
      ...source,
      sourceText,
      rows: parseS33ProducerModuleWithLimit(
        sourceText,
        source.path,
        source.exportName,
        source.expectedCount,
      ),
    };
  });
}

describe('S3.3 held-out corpus authentication', () => {
  it('re-derives the exact 621-row corpus and zero-overlap index', () => {
    const committedIndex = validateS33HeldoutCorpusIdentityIndex(
      parseJson('s33-heldout-corpus-zero-overlap-index.json'),
    );
    const rebuilt = buildS33HeldoutCorpusAuthentication({
      sources: sourceInputs(),
      v71: committedIndex.v71 as S33V71ExportIdentityInput,
    });

    expect(rebuilt.identityIndex).toEqual(committedIndex);
    expect(rebuilt.identityIndex.heldout).toMatchObject({
      count: 621,
      uniqueIdCount: 621,
      uniqueNormalizedContentCount: 621,
    });
    expect(rebuilt.identityIndex.v71).toMatchObject({
      trainCount: 865,
      validationCount: 96,
      uniqueIdCount: 961,
    });
    expect(rebuilt.identityIndex.overlap).toEqual({
      heldoutToV71IdCount: 0,
      heldoutToV71NormalizedContentCount: 0,
      heldoutToV71Ids: [],
      heldoutToV71NormalizedContentSha256: [],
    });
  });

  it('matches the committed canonical request and exact raw signing bytes', () => {
    const committedIndex = validateS33HeldoutCorpusIdentityIndex(
      parseJson('s33-heldout-corpus-zero-overlap-index.json'),
    );
    const rebuilt = buildS33HeldoutCorpusAuthentication({
      sources: sourceInputs(),
      v71: committedIndex.v71 as S33V71ExportIdentityInput,
    });
    const request = validateS33HeldoutCorpusAuthenticationRequest(
      parseJson('s33-heldout-corpus-authentication-v1.request.json'),
    );
    const rawSigningBytes = readFileSync(
      resolve(evidenceRoot, 's33-heldout-corpus-authentication-v1.signing-bytes'),
    );

    expect(request).toEqual(rebuilt.request);
    expect(rawSigningBytes.equals(Buffer.from(request.signingBytesBase64Url, 'base64url')))
      .toBe(true);
    expect(request.payloadCanonicalJson).toBe(canonicaliseJson(request.payload));
  });

  it('verifies the separate production signature under the code-bound public root', () => {
    const request = validateS33HeldoutCorpusAuthenticationRequest(
      parseJson('s33-heldout-corpus-authentication-v1.request.json'),
    );
    const signature = validateS33HeldoutCorpusSignatureArtifact(
      parseJson('s33-heldout-corpus-authentication-v1.signature.json'),
    );

    expect(verifyS33HeldoutCorpusSignature(request, signature)).toEqual(signature);
  });

  it.each([
    ['held-out id', (index: MutableIdentityIndex) => { index.heldout.rows[0].id = 'tampered'; }],
    ['held-out content', (index: MutableIdentityIndex) => {
      index.heldout.rows[0].normalizedInputSha256 = '0'.repeat(64);
    }],
    ['v7.1 train identity', (index: MutableIdentityIndex) => { index.v71.train[0].id = 'tampered'; }],
    ['v7.1 validation content', (index: MutableIdentityIndex) => {
      index.v71.validation[0].normalizedInputSha256 = '0'.repeat(64);
    }],
  ])('rejects a tampered %s before signature verification', (_name, mutate) => {
    const candidate = structuredClone(
      parseJson('s33-heldout-corpus-zero-overlap-index.json'),
    ) as MutableIdentityIndex;
    mutate(candidate);
    expect(() => validateS33HeldoutCorpusIdentityIndex(candidate)).toThrow(/digest|overlap|binding/iu);
  });
});
