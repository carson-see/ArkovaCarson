/**
 * SCRUM-2913 — REAL Credential Engine Registry records must parse clean
 * end-to-end (CTO ruling). All fixtures under `__fixtures__/` are VERBATIM
 * public CE Registry documents (org/credential metadata, no person PII),
 * fetched 2026-07-21 with `curl -H 'Accept: application/json'`:
 *
 *  - ce-real-resource-ce-a4c0a549….json
 *      https://credentialengineregistry.org/resources/ce-a4c0a549-aed3-4704-ade2-e81a5d76865b
 *      Single-node /resources form: string @context, no @graph, ownedBy as an
 *      array of bare URI strings, language-map ceterms:name,
 *      ceterms:credentialStatusType (NOT lifecycleStatusType).
 *  - ce-real-graph-ce-a4c0a549….json
 *      https://credentialengineregistry.org/graph/ce-a4c0a549-aed3-4704-ade2-e81a5d76865b
 *      @graph envelope: 1 ceterms:Certification + 5 ceterms:QACredentialOrganization
 *      blank nodes (`_:` @ids). THE JUNK BUG: without a credential-class filter
 *      this yields 6 records, 5 of them org junk (~83% junk on this record).
 *  - ce-real-org-ce-9bd8c615….json
 *      https://credentialengineregistry.org/resources/ce-9bd8c615-9f3c-40e6-9c20-6d9f811844e6
 *      Credential Engine's OWN CredentialOrganization record (found via the
 *      registry fts search). Uses `ceterms:lifeCycleStatusType` — capital C —
 *      a real-record spelling the importer must read.
 *
 * These tests exercise READ/parse behavior only; nothing here writes anywhere.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CTDL_CREDENTIAL_CLASSES,
  isCtdlCredentialClass,
  parseCtdlCredentials,
  parseCtdlDocument,
  parseCtdlEnvelope,
  type ParseCtdlOptions,
} from './ctdl-importer.js';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');
const CRED_CTID = 'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b';
const OWNER_CTID = 'ce-6a62b250-a1a2-4d31-a702-cdc2437efd31';
const CE_ORG_CTID = 'ce-9bd8c615-9f3c-40e6-9c20-6d9f811844e6';

const RESOURCE_RAW = fs.readFileSync(
  path.join(FIXTURES_DIR, `ce-real-resource-${CRED_CTID}.json`),
  'utf-8',
);
const GRAPH_RAW = fs.readFileSync(
  path.join(FIXTURES_DIR, `ce-real-graph-${CRED_CTID}.json`),
  'utf-8',
);
const ORG_RAW = fs.readFileSync(
  path.join(FIXTURES_DIR, `ce-real-org-${CE_ORG_CTID}.json`),
  'utf-8',
);

const NOW = new Date('2026-07-21T00:00:00.000Z');
const OPTS: ParseCtdlOptions = { now: NOW };

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

describe('real CE record — /resources single-node form', () => {
  it('parses to exactly ONE clean record with every core field populated', () => {
    const records = parseCtdlEnvelope(RESOURCE_RAW, OPTS);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.type).toBe('ceterms:Certification');
    expect(record.name).toBe('Electronics'); // language map {"en-US": "Electronics"}
    expect(record.sourceId).toBe(CRED_CTID);
    expect(record.registryUrl).toBe(
      `https://credentialengineregistry.org/resources/${CRED_CTID}`,
    );
    expect(record.sourceUrl).toBe(
      'https://www.nocti.org/wp-content/uploads/Blueprints/JRElectronics3034.pdf',
    );
    expect(record.issuedAt).toBe('2014-09-01');
    // ownedBy is an array of BARE URI strings → id + extracted ctid, name null.
    expect(record.issuer).toEqual({
      id: `https://credentialengineregistry.org/resources/${OWNER_CTID}`,
      ctid: OWNER_CTID,
      name: null,
    });
    // The REAL record carries ceterms:credentialStatusType (credentialStat:Active),
    // not ceterms:lifecycleStatusType — the importer must still see 'active'.
    expect(record.sourceStatus).toBe('active');
    expect(record.status).toBe('active');
    expect(record.resourceAvailableUntil).toBeNull();
    expect(record.ceEnvelopeSha256).toBe(sha256(RESOURCE_RAW));
    expect(record.retrievedAt).toBe(NOW.toISOString());
  });

  it('tolerates @context as an ARRAY (JSON-LD permits both)', () => {
    const doc = JSON.parse(RESOURCE_RAW) as Record<string, unknown>;
    doc['@context'] = [doc['@context'], { ceterms: 'https://purl.org/ctdl/terms/' }];
    const records = parseCtdlDocument(doc, OPTS);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('Electronics');
    expect(records[0].sourceId).toBe(CRED_CTID);
  });
});

describe('real CE record — /graph envelope form (the ~junk bug)', () => {
  it('parseCtdlCredentials emits ONLY the credential node — org nodes emit nothing', () => {
    const records = parseCtdlCredentials(JSON.parse(GRAPH_RAW), OPTS);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.type).toBe('ceterms:Certification');
    expect(record.name).toBe('Electronics');
    expect(record.sourceId).toBe(CRED_CTID);
    expect(record.registryUrl).toBe(
      `https://credentialengineregistry.org/resources/${CRED_CTID}`,
    );
    expect(record.sourceUrl).toBe(
      'https://www.nocti.org/wp-content/uploads/Blueprints/JRElectronics3034.pdf',
    );
    expect(record.issuedAt).toBe('2014-09-01');
    expect(record.sourceStatus).toBe('active');
  });

  it('parseCtdlEnvelope honors credentialNodesOnly and stamps the envelope hash', () => {
    const records = parseCtdlEnvelope(GRAPH_RAW, { ...OPTS, credentialNodesOnly: true });
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ceterms:Certification');
    expect(records[0].ceEnvelopeSha256).toBe(sha256(GRAPH_RAW));
  });

  it('default parseCtdlDocument is UNCHANGED (all 6 nodes — documents the junk rate)', () => {
    // Backwards-compatible surface: without the opt-in filter, the real graph
    // still yields one record per node (1 credential + 5 org junk records).
    const records = parseCtdlDocument(JSON.parse(GRAPH_RAW), OPTS);
    expect(records).toHaveLength(6);
    const junk = records.filter((r) => r.type === 'ceterms:QACredentialOrganization');
    expect(junk).toHaveLength(5);
  });

  it('blank-node org records never produce a registryUrl and never crash ctid extraction', () => {
    const records = parseCtdlDocument(JSON.parse(GRAPH_RAW), OPTS);
    const blanks = records.filter((r) => r.type === 'ceterms:QACredentialOrganization');
    expect(blanks).toHaveLength(5);
    for (const record of blanks) {
      expect(record.registryUrl).toBeNull();
      expect(record.sourceId).toBeNull();
    }
  });

  it('cross-@id issuer resolution: an owner org node PRESENT in the @graph resolves the issuer name', () => {
    const doc = JSON.parse(GRAPH_RAW) as { '@graph': unknown[] };
    // The real graph's ownedBy target is NOT among its nodes. Augment a copy
    // with the real owner node's essentials (from its own /resources record).
    doc['@graph'].push({
      '@id': `https://credentialengineregistry.org/resources/${OWNER_CTID}`,
      '@type': 'ceterms:CredentialOrganization',
      'ceterms:ctid': OWNER_CTID,
      'ceterms:name': { 'en-US': 'NOCTI' },
    });
    const records = parseCtdlCredentials(doc, OPTS);
    expect(records).toHaveLength(1); // the appended org node still emits NO record
    expect(records[0].issuer).toEqual({
      id: `https://credentialengineregistry.org/resources/${OWNER_CTID}`,
      ctid: OWNER_CTID,
      name: 'NOCTI',
    });
  });

  it('cross-@id resolution stays bounded: absent owner node leaves issuer name null (no network)', () => {
    const records = parseCtdlCredentials(JSON.parse(GRAPH_RAW), OPTS);
    expect(records[0].issuer).toEqual({
      id: `https://credentialengineregistry.org/resources/${OWNER_CTID}`,
      ctid: OWNER_CTID,
      name: null,
    });
  });
});

describe("real CE record — Credential Engine's OWN organization record", () => {
  it('parses clean as a node (capital-C ceterms:lifeCycleStatusType is read)', () => {
    const records = parseCtdlEnvelope(ORG_RAW, OPTS);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.type).toBe('ceterms:CredentialOrganization');
    expect(record.name).toBe('Credential Engine');
    expect(record.sourceId).toBe(CE_ORG_CTID);
    expect(record.registryUrl).toBe(
      `https://credentialengineregistry.org/resources/${CE_ORG_CTID}`,
    );
    // Real-record spelling: `ceterms:lifeCycleStatusType` (capital C).
    expect(record.sourceStatus).toBe('active');
    expect(record.status).toBe('active');
    expect(record.ceEnvelopeSha256).toBe(sha256(ORG_RAW));
  });

  it('is an ORGANIZATION, so the credentials entry-point emits zero records', () => {
    expect(parseCtdlCredentials(JSON.parse(ORG_RAW), OPTS)).toHaveLength(0);
  });
});

describe('CTDL credential-class filter', () => {
  it('accepts every enumerated CTDL credential class', () => {
    for (const cls of CTDL_CREDENTIAL_CLASSES) {
      expect(isCtdlCredentialClass(cls), cls).toBe(true);
    }
    expect(CTDL_CREDENTIAL_CLASSES.size).toBeGreaterThanOrEqual(20);
  });

  it('accepts unenumerated ceterms credential-shaped classes via the fallback pattern', () => {
    for (const cls of [
      'ceterms:SpecialistDegree',
      'ceterms:TradeDiploma',
      'ceterms:StackableCredential',
      'ceterms:WeldingCertificate',
    ]) {
      expect(isCtdlCredentialClass(cls), cls).toBe(true);
    }
  });

  it('rejects organization/support classes even when their name contains "Credential"', () => {
    for (const cls of [
      'ceterms:QACredentialOrganization', // present in the REAL graph fixture
      'ceterms:CredentialOrganization',
      'ceterms:CredentialAlignmentObject',
      'ceterms:CredentialingAction',
      'ceterms:CredentialPerson',
      'ceterms:ConditionProfile',
      'ceterms:CostProfile',
      'ceasn:CompetencyFramework',
      'skos:ConceptScheme',
      'ceterms:Organization',
    ]) {
      expect(isCtdlCredentialClass(cls), cls).toBe(false);
    }
    expect(isCtdlCredentialClass(null)).toBe(false);
    expect(isCtdlCredentialClass('')).toBe(false);
  });

  it('honors @type ARRAYS: a node is a credential if ANY type entry is a credential class', () => {
    const doc = {
      '@graph': [
        { '@type': ['ceterms:Certification', 'schema:Thing'], 'ceterms:name': 'A' },
        { '@type': ['schema:Thing', 'ceterms:CredentialOrganization'], 'ceterms:name': 'B' },
      ],
    };
    const records = parseCtdlCredentials(doc, OPTS);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('A');
  });
});
