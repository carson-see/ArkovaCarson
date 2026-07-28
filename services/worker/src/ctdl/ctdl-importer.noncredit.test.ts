/**
 * L3-A6 — CE Noncredit Data Taxonomy 3.0 anchoring POC (2026-07-28).
 *
 * KEY TECHNICAL FINDING this test file exists to prove: Credential Engine's
 * Noncredit Data Taxonomy 3.0 → CTDL benchmark model
 * (guidance.credentialengine.org/noncredit-data-taxonomy/, published
 * 2026-07-16) maps noncredit program records onto `ceterms:LearningProgram`
 * (a documented CTDL subclass of `ceterms:LearningOpportunityProfile` —
 * credreg.net/page/typeslist, credreg.net/ctdl/terms/LearningOpportunityProfile).
 * That class is NOT in `CTDL_CREDENTIAL_CLASSES` (the SCRUM-2913 / PR #1603
 * 20-class credential enumeration) and does not match its fallback pattern
 * (`Certificat|Licen|Degree|Badge|Diploma|Credential` substrings — "Learning
 * Program" contains none of them). Before this PR, a real noncredit
 * `ceterms:LearningProgram` record fed through `credentialNodesOnly: true`
 * (the exact mode the demo-able `GET /api/v1/credentials/ctdl/import` consumer
 * uses) was SILENTLY DROPPED — filtered out as non-credential junk, the same
 * bucket as `ceterms:CredentialOrganization` / concept / profile nodes. That
 * is the opposite of what this POC needs: noncredit is precisely the record
 * class this initiative anchors.
 *
 * The fixture (`__fixtures__/ce-template-noncredit-learning-program.json`) is
 * a TEMPLATE-SHAPED record authored from the benchmark model's documented
 * class semantics — as of this research pass (2026-07-28) no live noncredit
 * CTID could be found published in the Credential Registry yet (CE's guidance
 * page is actively asking states/institutions to START publishing; see
 * `docs/partners/ce-noncredit-anchoring-poc.md` for the honest research
 * writeup and citations). It is NOT a verbatim registry fetch like the
 * `ce-real-*` fixtures in `ctdl-importer.real-fixtures.test.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CTDL_NONCREDIT_PROGRAM_CLASSES,
  isCtdlCredentialClass,
  isCtdlNoncreditProgramClass,
  parseCtdlEnvelope,
  type ParseCtdlOptions,
} from './ctdl-importer.js';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');
const NONCREDIT_RAW = fs.readFileSync(
  path.join(FIXTURES_DIR, 'ce-template-noncredit-learning-program.json'),
  'utf-8',
);
const PROGRAM_CTID = 'ce-00000000-0000-4000-8000-000000000001';
const OWNER_CTID = 'ce-00000000-0000-4000-8000-000000000002';

const NOW = new Date('2026-07-28T00:00:00.000Z');

describe('isCtdlNoncreditProgramClass', () => {
  it('recognizes the four documented NDT-3.0 benchmark classes', () => {
    expect(CTDL_NONCREDIT_PROGRAM_CLASSES.size).toBe(4);
    expect(isCtdlNoncreditProgramClass('ceterms:LearningProgram')).toBe(true);
    expect(isCtdlNoncreditProgramClass('ceterms:LearningOpportunityProfile')).toBe(true);
    expect(isCtdlNoncreditProgramClass('ceterms:LearningOpportunity')).toBe(true);
    expect(isCtdlNoncreditProgramClass('ceterms:Course')).toBe(true);
  });

  it('does not treat noncredit-program classes as CTDL credential classes', () => {
    // Documents that the two filters are genuinely disjoint — a noncredit
    // program is not a "credential" in CTDL_CREDENTIAL_CLASSES terms, which is
    // exactly why the opt-in flag exists rather than just widening the
    // existing enumeration.
    expect(isCtdlCredentialClass('ceterms:LearningProgram')).toBe(false);
    expect(isCtdlCredentialClass('ceterms:LearningOpportunityProfile')).toBe(false);
    expect(isCtdlCredentialClass('ceterms:LearningOpportunity')).toBe(false);
    expect(isCtdlCredentialClass('ceterms:Course')).toBe(false);
  });

  it('returns false for null/empty/unrelated classes', () => {
    expect(isCtdlNoncreditProgramClass(null)).toBe(false);
    expect(isCtdlNoncreditProgramClass('')).toBe(false);
    expect(isCtdlNoncreditProgramClass('ceterms:Certificate')).toBe(false);
    expect(isCtdlNoncreditProgramClass('ceterms:CredentialOrganization')).toBe(false);
  });
});

describe('THE BUG — credentialNodesOnly alone drops noncredit LearningProgram records', () => {
  it('parseCtdlEnvelope({ credentialNodesOnly: true }) returns ZERO records for a real noncredit graph', () => {
    const options: ParseCtdlOptions = { now: NOW, credentialNodesOnly: true };
    const records = parseCtdlEnvelope(NONCREDIT_RAW, options);
    // This is the finding: without the opt-in, the noncredit LearningProgram
    // node is filtered out exactly like the org node — 0 of the 2 graph nodes
    // survive, even though the LearningProgram node IS the record this POC
    // needs to anchor.
    expect(records).toHaveLength(0);
  });

  it('parseCtdlEnvelope({ credentialNodesOnly: false }) (default per-node surface) DOES see it, unlabeled as a credential', () => {
    // Confirms the node itself parses fine — it is specifically the
    // credential-class FILTER that excludes it, not a parse failure.
    const records = parseCtdlEnvelope(NONCREDIT_RAW, { now: NOW });
    const program = records.find((r) => r.type === 'ceterms:LearningProgram');
    expect(program).toBeDefined();
  });
});

describe('THE FIX — includeNoncreditProgramClasses admits the noncredit LearningProgram record', () => {
  it('parses to exactly ONE record when includeNoncreditProgramClasses is set', () => {
    const options: ParseCtdlOptions = {
      now: NOW,
      credentialNodesOnly: true,
      includeNoncreditProgramClasses: true,
    };
    const records = parseCtdlEnvelope(NONCREDIT_RAW, options);
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record.type).toBe('ceterms:LearningProgram');
    expect(record.name).toBe('Certified Production Technician Noncredit Program');
    expect(record.sourceId).toBe(PROGRAM_CTID);
    expect(record.registryUrl).toBe(
      `https://credentialengineregistry.org/resources/${PROGRAM_CTID}`,
    );
    expect(record.sourceUrl).toBe('https://example-community-college.edu/noncredit/cpt');
    expect(record.sourceStatus).toBe('active');
    expect(record.status).toBe('active');
  });

  it('resolves the issuer name from the sibling CredentialOrganization node in the same @graph', () => {
    const options: ParseCtdlOptions = {
      now: NOW,
      credentialNodesOnly: true,
      includeNoncreditProgramClasses: true,
    };
    const records = parseCtdlEnvelope(NONCREDIT_RAW, options);
    expect(records[0].issuer).toEqual({
      id: `https://credentialengineregistry.org/resources/${OWNER_CTID}`,
      ctid: OWNER_CTID,
      name: 'Example Community College',
    });
  });

  it('still excludes the org node itself — only the LearningProgram node is admitted', () => {
    const options: ParseCtdlOptions = {
      now: NOW,
      credentialNodesOnly: true,
      includeNoncreditProgramClasses: true,
    };
    const records = parseCtdlEnvelope(NONCREDIT_RAW, options);
    expect(records.every((r) => r.type !== 'ceterms:CredentialOrganization')).toBe(true);
  });

  it('does not change behavior for the existing credential-only real fixtures (additive, default false)', () => {
    // Regression guard: includeNoncreditProgramClasses defaults to false, so
    // every existing caller (the SCRUM-2913 consumer route, the fuzz suite,
    // ctdl-importer.real-fixtures.test.ts) is byte-for-byte unaffected.
    const options: ParseCtdlOptions = { now: NOW, credentialNodesOnly: true };
    const records = parseCtdlEnvelope(NONCREDIT_RAW, options);
    expect(records).toHaveLength(0);
  });
});
