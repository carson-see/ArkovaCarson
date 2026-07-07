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
import {
  COMPLIANCE_CONTROLS,
  ALL_FRAMEWORKS,
  getComplianceControls,
  getComplianceFrameworks,
} from '../lib/complianceMapping.js';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/**
 * Strip TS/JSX comments so the reworded-reappearance guard fires on LIVE code
 * (a rendered string / returned framework label) and NOT on the explanatory
 * SCRUM-2283 comments that legitimately name the removed DPF claim to document
 * why it was pulled. Order matters: block comments (including the JSX comment
 * form) first, then line comments.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (also the JSX comment body)
    .replace(/^[ \t]*\/\/.*$/gm, ''); // line comments
}

function readCode(rel: string): string {
  return stripComments(read(rel));
}

const COPY = 'src/lib/copy.ts';
const PRIVACY_PAGE = 'src/pages/PrivacyPage.tsx';
const JURISDICTION_NOTICES = 'src/components/compliance/JurisdictionPrivacyNotices.tsx';
const COMPLIANCE_MAPPING = 'src/lib/complianceMapping.ts';

// The false self-certification claim, in the forms it appears across the 3 spots.
const FALSE_CLAIM_PATTERNS = [
  /Arkova self-certifies under the EU-US Data Privacy Framework/i,
  /self-certif\w*\s+under\s+the\s+EU-US Data Privacy Framework/i,
  /EU-US Data Privacy Framework self-certification/i,
];

// Broader guard (MEDIUM finding): the false EU-US DPF external-status claim can
// reappear in reworded forms — a framework pill, an "under the Framework" notice
// principle, a "participates in"/"certified under" phrasing — none of which the
// 3 narrow self-cert patterns above catch. Any of these asserting Arkova's DPF
// participation/certification is a live R-7/§1.5 false external-status claim.
// (Neutral references — e.g. "EU–US Personal Data Transfers" or explaining the
// basis is under counsel review — are NOT matched.)
const DPF_STATUS_CLAIM_PATTERNS = [
  /'EU-US DPF'/, // the framework badge/pill label rendered on secured anchors
  /EU-US Data Privacy Framework/i,
  /\bunder the Framework\b/i,
  /(participat\w*|certif\w*|self-certif\w*|adhere\w*|enrol\w*|member\w*)\b[^.]{0,40}\bData Privacy Framework/i,
  /Data Privacy Framework\b[^.]{0,40}\b(participat\w*|certif\w*|adhere\w*|enrol\w*|member\w*)/i,
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

  // ─── 4th live spot (HIGH finding) ──────────────────────────────────────
  // complianceMapping.ts put DPF-NOTICE + DPF-ACCOUNTABILITY into
  // UNIVERSAL_CONTROLS, so getComplianceControls()/getComplianceFrameworks()
  // returned an 'EU-US DPF' framework for EVERY SECURED anchor — rendered as a
  // framework pill on the UNAUTHENTICATED public verification page and the
  // compliance dashboard. That is the identical false external-status claim,
  // asserted on every secured credential. It must be removed at the source.
  it('getComplianceControls no longer returns any EU-US DPF control on a secured anchor', () => {
    for (const type of ['OTHER', 'DEGREE', 'LICENSE', 'INSURANCE', 'LEGAL', 'FINANCIAL', null, undefined]) {
      const controls = getComplianceControls(type, true);
      // Compare as string: 'EU-US DPF' is (correctly) no longer in the framework
      // union type, so a direct literal compare is a TS "no overlap" error.
      expect(controls.some((c) => (c.framework as string) === 'EU-US DPF')).toBe(false);
      expect(controls.some((c) => c.id.startsWith('DPF-'))).toBe(false);
    }
  });

  it('getComplianceFrameworks never lists EU-US DPF', () => {
    for (const type of ['OTHER', 'DEGREE', 'LICENSE', 'INSURANCE', 'LEGAL', null, undefined]) {
      expect(getComplianceFrameworks(type, true)).not.toContain('EU-US DPF');
    }
  });

  it('ALL_FRAMEWORKS (compliance dashboard source) does not include EU-US DPF', () => {
    expect(ALL_FRAMEWORKS).not.toContain('EU-US DPF');
  });

  it('COMPLIANCE_CONTROLS defines no DPF control and no EU-US DPF framework', () => {
    for (const [id, control] of Object.entries(COMPLIANCE_CONTROLS)) {
      expect(id.startsWith('DPF-')).toBe(false);
      expect(control.framework as string).not.toBe('EU-US DPF');
    }
  });

  it('complianceMapping.ts source carries no EU-US DPF status/participation claim', () => {
    // Comment-stripped: an explanatory "// SCRUM-2283 removed the EU-US DPF …"
    // note is allowed; a live control label / framework literal is not.
    const src = readCode(COMPLIANCE_MAPPING);
    for (const pattern of DPF_STATUS_CLAIM_PATTERNS) {
      expect(src).not.toMatch(pattern);
    }
  });

  // ─── reworded-reappearance coverage (MEDIUM finding) ───────────────────
  // The broadened guard must also protect the 3 already-swept privacy-copy
  // spots against a DPF status claim creeping back in different words.
  it('no DPF status/participation claim reappears in the privacy-copy spots', () => {
    for (const rel of [COPY, PRIVACY_PAGE, JURISDICTION_NOTICES]) {
      const src = readCode(rel); // allow the removal comments; catch live copy
      for (const pattern of DPF_STATUS_CLAIM_PATTERNS) {
        expect(src, `${rel} must not assert EU-US DPF status`).not.toMatch(pattern);
      }
    }
  });
});
