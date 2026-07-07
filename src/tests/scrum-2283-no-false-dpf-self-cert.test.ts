/**
 * SCRUM-2283 — remove the FALSE "Arkova self-certifies under the EU-US DPF" claim.
 *
 * Arkova does NOT hold an active EU-US Data Privacy Framework self-certification.
 * Asserting it in user-facing privacy copy is a false compliance claim (R-7
 * claims gate + §1.5 measured/asserted/NOT-asserted discipline) and a
 * regulatory exposure. PR #1117 fixed only the /enterprise card; this removes it
 * from the 3 still-live spots:
 *   - src/lib/copy.ts                                DPF_DESCRIPTION
 *   - src/pages/PrivacyPage.tsx                      §5 International Data Transfers
 *   - src/components/compliance/JurisdictionPrivacyNotices.tsx  DPF transferBasis
 *
 * The replacement lawful-transfer basis (e.g. executed EU SCCs) is COUNSEL-GATED
 * — we do NOT invent substitute legal language. Each spot must carry a VISIBLE
 * counsel-required placeholder instead. Removing a false claim is fine; asserting
 * a new UNVERIFIED basis would be worse than the original.
 *
 * Content-guard test (reads source directly) — no live DB / render needed.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const COPY = 'src/lib/copy.ts';
const PRIVACY_PAGE = 'src/pages/PrivacyPage.tsx';
const JURISDICTION_NOTICES = 'src/components/compliance/JurisdictionPrivacyNotices.tsx';

// The false self-certification claim, in the forms it appears across the 3 spots.
const FALSE_CLAIM_PATTERNS = [
  /Arkova self-certifies under the EU-US Data Privacy Framework/i,
  /self-certif\w*\s+under\s+the\s+EU-US Data Privacy Framework/i,
  /EU-US Data Privacy Framework self-certification/i,
];

// A visible marker proving the copy was deliberately gated on counsel rather
// than silently deleted or replaced with invented legal text.
const COUNSEL_MARKER = /counsel/i;

describe('SCRUM-2283: no false EU-US DPF self-certification claim', () => {
  it('src/lib/copy.ts DPF_DESCRIPTION no longer claims self-certification', () => {
    const src = read(COPY);
    for (const pattern of FALSE_CLAIM_PATTERNS) {
      expect(src).not.toMatch(pattern);
    }
  });

  it('src/lib/copy.ts DPF copy carries a visible counsel-required placeholder', () => {
    const src = read(COPY);
    // DPF_DESCRIPTION should mention that the lawful transfer basis is pending
    // counsel — not assert an unverified basis.
    const dpfDescMatch = src.match(/DPF_DESCRIPTION:\s*'([^']*)'/);
    expect(dpfDescMatch).not.toBeNull();
    expect(dpfDescMatch![1]).toMatch(COUNSEL_MARKER);
  });

  it('PrivacyPage §5 no longer claims DPF self-certification', () => {
    const src = read(PRIVACY_PAGE);
    for (const pattern of FALSE_CLAIM_PATTERNS) {
      expect(src).not.toMatch(pattern);
    }
  });

  it('PrivacyPage carries a visible counsel-required placeholder for the EU→US basis', () => {
    const src = read(PRIVACY_PAGE);
    expect(src).toMatch(COUNSEL_MARKER);
  });

  it('JurisdictionPrivacyNotices transferBasis no longer asserts DPF self-certification', () => {
    const src = read(JURISDICTION_NOTICES);
    expect(src).not.toMatch(/EU-US Data Privacy Framework self-certification/i);
    for (const pattern of FALSE_CLAIM_PATTERNS) {
      expect(src).not.toMatch(pattern);
    }
  });

  it('JurisdictionPrivacyNotices carries a visible counsel-required placeholder', () => {
    const src = read(JURISDICTION_NOTICES);
    expect(src).toMatch(COUNSEL_MARKER);
  });
});
