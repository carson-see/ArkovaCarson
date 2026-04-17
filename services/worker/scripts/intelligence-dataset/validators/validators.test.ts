/**
 * NVI validators — unit tests.
 *
 * Covers NVI-01 (statute-quote), NVI-02 (case-law), NVI-03
 * (agency-bulletin), NVI-04 (state-statute), plus the registry + trust
 * decision logic that NVI-18 uses to gate CI.
 *
 * All tests are offline (no live HTTP). Time stamps are frozen via
 * ValidateOpts.now for determinism.
 */

import { describe, expect, it } from 'vitest';
import type { IntelligenceSource } from '../types';
import {
  statuteQuoteValidator,
  caseLawValidator,
  agencyBulletinValidator,
  stateStatuteValidator,
  verifySource,
  verifySources,
} from './index';
import {
  decideTrust,
  emptyRegistry,
  upsertVerifications,
} from './verification-registry';

const NOW = '2026-04-17T00:00:00.000Z';

function fed(overrides: Partial<IntelligenceSource>): IntelligenceSource {
  return {
    id: 'test-fed',
    quote: '15 U.S.C. §1681b(b)(3) — before taking adverse action based in whole or in part on a consumer report...',
    source: 'FCRA §604(b)(3)',
    url: 'https://www.law.cornell.edu/uscode/text/15/1681b',
    lastVerified: '2026-04-01',
    tags: ['statute'],
    jurisdiction: 'federal',
    ...overrides,
  };
}

function stateSrc(overrides: Partial<IntelligenceSource>): IntelligenceSource {
  return {
    id: 'test-state',
    quote: 'Cal. Civ. Code §1786.12 — permissible purposes for investigative consumer reports',
    source: 'Cal. Civ. Code §1786.12',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&section=1786.12',
    lastVerified: '2026-04-01',
    tags: ['statute'],
    jurisdiction: 'CA',
    ...overrides,
  };
}

describe('NVI-01 statute-quote validator', () => {
  it('passes canonical FCRA federal-statute source', async () => {
    const r = await statuteQuoteValidator.validate(fed({}), { now: NOW });
    expect(r.passed).toBe(true);
    expect(r.hardFail).toBe(false);
    expect(r.validator).toBe('statute-quote');
    expect(r.verifiedAt).toBe(NOW);
  });

  it('does not apply to state sources', () => {
    const app = statuteQuoteValidator.isApplicable(stateSrc({}));
    expect(app.applicable).toBe(false);
  });

  it('rejects quote without U.S.C. reference or section number', async () => {
    const src = fed({
      quote: 'some prose that does not mention the statute at all but is long enough to pass length check',
      source: 'FCRA §604(b)(3)',
    });
    const r = await statuteQuoteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.hardFail).toBe(true);
    expect(r.notes).toMatch(/does not reference/i);
  });

  it('rejects too-short quote', async () => {
    const r = await statuteQuoteValidator.validate(fed({ quote: 'too short' }), { now: NOW });
    expect(r.passed).toBe(false);
  });

  it('rejects non-authority URL', async () => {
    const r = await statuteQuoteValidator.validate(
      fed({ url: 'https://random-blog.example.com/fcra' }),
      { now: NOW },
    );
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/authority allowlist/);
  });

  it('accepts 45 CFR HIPAA quotes', async () => {
    const src = fed({
      id: 'hipaa-164-524',
      quote: '45 CFR 164.524 — access of individuals to protected health information',
      source: '45 CFR 164.524',
      url: 'https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164',
    });
    const r = await statuteQuoteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(true);
  });

  it('rejects source label with no section number', async () => {
    const src = fed({
      source: 'Some Act',
      quote: '15 U.S.C. §1681 — valid opener but label is useless',
    });
    const r = await statuteQuoteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/no extractable section number/);
  });
});

describe('NVI-02 case-law validator', () => {
  const safeco: IntelligenceSource = {
    id: 'safeco-2007',
    quote: 'Safeco Ins. Co. of America v. Burr, 551 U.S. 47 (2007). The Supreme Court held that a "willful" FCRA violation under §616 requires either knowing or reckless action.',
    source: 'Safeco Ins. Co. of America v. Burr, 551 U.S. 47 (2007)',
    url: 'https://supreme.justia.com/cases/federal/us/551/47/',
    lastVerified: '2026-04-01',
    tags: ['case-law', 'supreme-court'],
    jurisdiction: 'federal',
  };

  it('passes a canonical Supreme Court cite', async () => {
    const r = await caseLawValidator.validate(safeco, { now: NOW });
    expect(r.passed).toBe(true);
  });

  it('soft-fails on missing reporter cite but present year', async () => {
    const src: IntelligenceSource = {
      ...safeco,
      source: 'Safeco Ins. Co. of America v. Burr (2007)',
      quote: 'Safeco v. Burr (2007). The Supreme Court held that a "willful" FCRA violation under §616 requires either knowing or reckless action.',
      url: 'https://supreme.justia.com/cases/federal/us/551/47/',
    };
    const r = await caseLawValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.hardFail).toBe(false); // reporter missing = soft only
    expect(r.notes).toMatch(/reporter cite/);
  });

  it('hard-fails on missing year', async () => {
    const src: IntelligenceSource = { ...safeco, source: 'Safeco Ins. Co. v. Burr', quote: 'no year at all anywhere in here' };
    const r = await caseLawValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.hardFail).toBe(true);
  });

  it('does not apply to non-case sources', () => {
    const app = caseLawValidator.isApplicable(fed({}));
    expect(app.applicable).toBe(false);
  });

  it('rejects non-authority URL', async () => {
    const src: IntelligenceSource = { ...safeco, url: 'https://blog.random.example/safeco' };
    const r = await caseLawValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/authority allowlist/);
  });

  it('detects "In re" form case names', async () => {
    const src: IntelligenceSource = {
      id: 'inre-equifax',
      quote: 'In re Equifax Inc. Customer Data Security Breach Litigation, 362 F.Supp.3d 1295 (N.D. Ga. 2019).',
      source: 'In re Equifax Inc., 362 F.Supp.3d 1295 (N.D. Ga. 2019)',
      url: 'https://www.courtlistener.com/opinion/xyz/',
      lastVerified: '2026-04-01',
      tags: ['case-law'],
      jurisdiction: 'federal',
    };
    expect(caseLawValidator.isApplicable(src).applicable).toBe(true);
    const r = await caseLawValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(true);
  });
});

describe('NVI-03 agency-bulletin validator', () => {
  const cfpb: IntelligenceSource = {
    id: 'cfpb-bulletin-2012-09',
    quote: 'CFPB Bulletin 2012-09 clarifies that debt collectors using consumer reports for account management must comply with FCRA §604.',
    source: 'CFPB Bulletin 2012-09',
    url: 'https://www.consumerfinance.gov/policy-compliance/guidance/compliance-bulletins/',
    lastVerified: '2026-04-01',
    tags: ['agency', 'cfpb', 'bulletin'],
    jurisdiction: 'federal',
  };

  it('passes a canonical CFPB bulletin', async () => {
    const r = await agencyBulletinValidator.validate(cfpb, { now: NOW });
    expect(r.passed).toBe(true);
  });

  it('rejects when no bulletin identifier present', async () => {
    const src: IntelligenceSource = { ...cfpb, source: 'CFPB Guidance', tags: [], quote: 'no identifier text at all in here but long enough' };
    const r = await agencyBulletinValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/issuance identifier/);
  });

  it('rejects URL not on CFPB domain', async () => {
    const src: IntelligenceSource = { ...cfpb, url: 'https://random.example/cfpb-2012-09' };
    const r = await agencyBulletinValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/domain/);
  });

  it('soft-warns when URL absent but issuance identifier present', async () => {
    const src: IntelligenceSource = { ...cfpb, url: undefined };
    const r = await agencyBulletinValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.hardFail).toBe(false); // identifier exists, backfill URL soft
    expect(r.notes).toMatch(/backfill url/);
  });

  it('hard-fails when URL and identifier both absent', async () => {
    const src: IntelligenceSource = {
      ...cfpb,
      url: undefined,
      source: 'CFPB Guidance',
      tags: [],
      quote: 'no identifier text anywhere in this substantive quote here',
    };
    const r = await agencyBulletinValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.hardFail).toBe(true);
    expect(r.notes).toMatch(/no url and no issuance identifier/);
  });

  it('recognizes HHS OCR source', async () => {
    const src: IntelligenceSource = {
      id: 'hhs-ocr-resolution',
      quote: 'HHS OCR Resolution Agreement with Anthem, 2018 — $16M HIPAA fine for inadequate controls.',
      source: 'HHS OCR Resolution Agreement — Anthem (2018)',
      url: 'https://www.hhs.gov/hipaa/for-professionals/compliance-enforcement/examples/anthem/',
      lastVerified: '2026-04-01',
      tags: ['agency', 'hhs-ocr', 'enforcement'],
      jurisdiction: 'federal',
    };
    expect(agencyBulletinValidator.isApplicable(src).applicable).toBe(true);
    const r = await agencyBulletinValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(true);
  });
});

describe('NVI-04 state-statute validator', () => {
  it('passes canonical Cal. Civ. Code cite', async () => {
    const r = await stateStatuteValidator.validate(stateSrc({}), { now: NOW });
    expect(r.passed).toBe(true);
  });

  it('rejects label that does not match state code patterns', async () => {
    const src = stateSrc({ source: 'Some random California law', quote: '§1786.12 of California law' });
    const r = await stateStatuteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/canonical CA code pattern/);
  });

  it('rejects section-number mismatch between label and quote', async () => {
    const src = stateSrc({
      source: 'Cal. Civ. Code §1786.12',
      quote: 'Cal. Civ. Code §9999.99 — this is a fabricated section claiming to be §1786.12',
    });
    const r = await stateStatuteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/section-number mismatch/);
  });

  it('accepts ILCS-format Illinois cite', async () => {
    const src = stateSrc({
      id: 'bipa',
      source: '740 ILCS 14/15 (BIPA)',
      quote: '740 ILCS 14/15 — no private entity may collect, capture, purchase, receive, or obtain biometric identifiers',
      url: 'https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=3004',
      jurisdiction: 'IL',
    });
    const r = await stateStatuteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(true);
  });

  it('accepts N.Y. Gen. Bus. Law cite', async () => {
    const src = stateSrc({
      id: 'ny-gbl-380',
      source: 'N.Y. Gen. Bus. Law §380',
      quote: 'N.Y. Gen. Bus. Law §380 — fair credit reporting — governs consumer reporting agencies operating in New York',
      url: 'https://www.nysenate.gov/legislation/laws/GBS/A25',
      jurisdiction: 'NY',
    });
    const r = await stateStatuteValidator.validate(src, { now: NOW });
    expect(r.passed).toBe(true);
  });

  it('rejects undefined state jurisdiction', async () => {
    const src: IntelligenceSource = stateSrc({});
    // Shadow to an unsupported jurisdiction
    (src as unknown as { jurisdiction: string }).jurisdiction = 'ZZ';
    // isApplicable gates this; but if we call validate directly we get a hard fail
    const app = stateStatuteValidator.isApplicable(src);
    expect(app.applicable).toBe(false);
  });

  it('does not apply to federal sources', () => {
    const app = stateStatuteValidator.isApplicable(fed({}));
    expect(app.applicable).toBe(false);
  });
});

describe('verifySource orchestrator', () => {
  it('runs statute-quote for federal statute sources and nothing else', async () => {
    const v = await verifySource(fed({}), { now: NOW });
    expect(v.results.map((r) => r.validator)).toEqual(['statute-quote']);
    expect(v.overallPassed).toBe(true);
    expect(v.orphaned).toBe(false);
  });

  it('marks source orphaned when no validator is applicable', async () => {
    const src: IntelligenceSource = {
      id: 'orphan',
      quote: 'a quote long enough but unattributed to any agency or statute structure',
      source: 'Unknown Authority',
      lastVerified: '2026-04-01',
      tags: [],
      jurisdiction: 'federal',
    };
    const v = await verifySource(src, { now: NOW });
    expect(v.orphaned).toBe(true);
    expect(v.overallPassed).toBe(false);
  });
});

describe('verification registry + trust decisions', () => {
  it('trusts sources with recent passing verification', async () => {
    const src = fed({});
    const verifications = await verifySources([src], { now: NOW });
    const reg = upsertVerifications(emptyRegistry(), verifications, NOW);
    const decisions = decideTrust(reg, [src.id], { now: new Date(NOW) });
    expect(decisions[0].trusted).toBe(true);
  });

  it('distrusts sources with no entry', () => {
    const decisions = decideTrust(emptyRegistry(), ['nonexistent']);
    expect(decisions[0].trusted).toBe(false);
    expect(decisions[0].reason).toMatch(/no verification record/);
  });

  it('distrusts stale verifications past maxAgeDays', async () => {
    const src = fed({});
    const verifications = await verifySources([src], { now: NOW });
    const reg = upsertVerifications(emptyRegistry(), verifications, NOW);
    const now100dLater = new Date('2026-07-26T00:00:00.000Z'); // 100 days past NOW
    const decisions = decideTrust(reg, [src.id], { now: now100dLater, maxAgeDays: 90 });
    expect(decisions[0].trusted).toBe(false);
    expect(decisions[0].reason).toMatch(/stale/);
  });

  it('distrusts failing verifications', async () => {
    const src = fed({ quote: 'too short' });
    const verifications = await verifySources([src], { now: NOW });
    const reg = upsertVerifications(emptyRegistry(), verifications, NOW);
    const decisions = decideTrust(reg, [src.id], { now: new Date(NOW) });
    expect(decisions[0].trusted).toBe(false);
  });

  it('distrusts orphaned sources', async () => {
    const orphan: IntelligenceSource = {
      id: 'orphan-2',
      quote: 'no validator claims this but it is long enough',
      source: 'Unknown',
      lastVerified: '2026-04-01',
      tags: [],
      jurisdiction: 'federal',
    };
    const verifications = await verifySources([orphan], { now: NOW });
    const reg = upsertVerifications(emptyRegistry(), verifications, NOW);
    const decisions = decideTrust(reg, [orphan.id], { now: new Date(NOW) });
    expect(decisions[0].trusted).toBe(false);
    expect(decisions[0].reason).toMatch(/orphan/i);
  });
});
