/**
 * SCRUM-2938 S2 — terminology-scrub remainder (the "228-occurrence purge").
 *
 * Extends the S1 contract (copy-scrum-2938-terminology.test.ts): per the CTO
 * S3.3 ruling, user-visible "credential(s)" is retired from generic surfaces
 * and replaced with "document(s)" / "record(s)". This test walks EVERY string
 * value exported from copy.ts and fails on any /credential/i hit outside an
 * explicit, categorized allowlist:
 *
 *   1. SCRUM-1672 carve-out — the restricted verified-organization issuance
 *      flow keeps "Issue Credential" (§1.3 exception). ISSUE_CREDENTIAL_LABELS
 *      is additionally locked byte-for-byte below so the carve-out itself
 *      cannot be scrubbed or drift silently.
 *   2. Restricted-issuance adjuncts — the issue-flow toasts
 *      (TOAST.CREDENTIAL_ISSUED / CREDENTIAL_ISSUE_FAILED, the latter
 *      sanctioned in scripts/ci/snapshots/copy-terms-allowlist.json), the
 *      restricted-flow launcher button, and the 'credential.issued' webhook
 *      event description (it describes the restricted issuance event).
 *   3. Different word sense — "sign-in credentials" (login secrets, not the
 *      product noun).
 *   4. Third-party proper nouns / external field names — "Credential Engine"
 *      (organization name; string also locked by copy-claims-gate.test.ts
 *      R-7 wording) and LinkedIn's own "Credential URL" profile field.
 *   5. Frozen API identifiers rendered as code — MCP tool names
 *      verify_credential / search_credentials (§1.8: published contract).
 *
 * Internal code identifiers (export names, object keys like CREDENTIAL_TYPE,
 * DB enum values) are NOT UI copy and are out of scope (§1.3 "Internal code
 * may use technical names") — only string VALUES are walked.
 */

import { describe, expect, it } from 'vitest';
import * as copy from './copy';
import { ISSUE_CREDENTIAL_LABELS } from './copy';

type StringLeaf = { path: string; value: string };

function collectStringLeaves(value: unknown, path: string, out: StringLeaf[]): void {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    collectStringLeaves(child, path === '' ? key : `${path}.${key}`, out);
  }
}

/** Exports preserved wholesale (SCRUM-1672 restricted-issuance carve-out). */
const CARVE_OUT_EXPORTS = new Set(['ISSUE_CREDENTIAL_LABELS']);

/** Individually allowlisted string paths, categorized above. */
const ALLOWED_PATHS = new Set([
  // 2. Restricted-issuance adjuncts (SCRUM-1672 / SCRUM-1755)
  'TOAST.CREDENTIAL_ISSUED',
  'TOAST.CREDENTIAL_ISSUE_FAILED',
  'ORG_PAGE_LABELS.ISSUE_CREDENTIAL',
  'WEBHOOK_EVENT_DESCRIPTIONS.credential.issued',
  // 3. Different word sense — login credentials
  'ACCOUNT_DELETE_LABELS.CONSEQUENCE_2',
  // 4. Third-party proper nouns / external field names
  'CE_PUBLICATION_COPY.STATUS_DETAIL',
  'SOURCE_PROVENANCE_LABELS.SHARE_LINKEDIN_DESCRIPTION',
  'LINKEDIN_SHARE_LABELS.CREDENTIAL_URL_LABEL',
  'LINKEDIN_SHARE_LABELS.NOTE',
  // 5. Frozen API identifiers rendered as code
  'DEVELOPER_PAGE_LABELS.MCP_TOOL_VERIFY',
  'DEVELOPER_PAGE_LABELS.MCP_TOOL_SEARCH',
]);

describe('SCRUM-2938 S2 — no user-visible "credential(s)" outside the carve-outs', () => {
  const leaves: StringLeaf[] = [];
  for (const [exportName, exported] of Object.entries(copy)) {
    if (CARVE_OUT_EXPORTS.has(exportName)) continue;
    if (typeof exported === 'function') continue; // formatters, not copy
    collectStringLeaves(exported, exportName, leaves);
  }

  it('walks a meaningful copy surface (sanity: the walk is not vacuous)', () => {
    expect(leaves.length).toBeGreaterThan(1000);
  });

  it('finds zero non-allowlisted string values containing "credential"', () => {
    const offenders = leaves.filter(
      ({ path, value }) => /credential/i.test(value) && !ALLOWED_PATHS.has(path),
    );
    expect(
      offenders.map(({ path, value }) => `${path}: ${JSON.stringify(value)}`),
    ).toEqual([]);
  });

  it('every allowlisted path still exists (allowlist cannot rot silently)', () => {
    const byPath = new Map(leaves.map((l) => [l.path, l.value]));
    for (const path of ALLOWED_PATHS) {
      expect(byPath.has(path), `allowlisted path missing from copy.ts: ${path}`).toBe(true);
    }
  });
});

describe('SCRUM-2938 S2 — SCRUM-1672 carve-out survives byte-identical', () => {
  it('ISSUE_CREDENTIAL_LABELS is exactly the pre-S2 restricted-issuance copy', () => {
    expect(ISSUE_CREDENTIAL_LABELS).toEqual({
      TITLE: 'Issue Credential',
      DESCRIPTION:
        'Issue a verifiable credential to a recipient. Only verified organizations may issue credentials.',
      PENDING_NOTICE:
        'The credential will be issued with Pending status and assigned a unique verification ID immediately.',
      ISSUING_LOADING: 'Issuing credential...',
      ISSUE_BUTTON: 'Issue Credential',
      ISSUE_ANOTHER: 'Issue another credential',
      VERIFICATION_LINK: 'Verification Link',
      COPY_LINK_ARIA: 'Copy verification link',
      HINT_UPLOAD_DOCUMENT: 'Upload a document to continue.',
      HINT_SELECT_TYPE: 'Select a credential type to continue.',
      HINT_PROOF_URL_INVALID: 'Proof URL must be a valid https:// link.',
      GATE_BLOCKED_TITLE: 'Issue Credential is unavailable',
      GATE_LOADING: 'Checking your organization’s authorization to issue credentials…',
      GATE_QUERY_ERROR:
        'We could not verify your organization’s authorization right now. Please retry in a few seconds; if the issue persists, contact support.',
      GATE_NOT_VERIFIED:
        'Your organization is not yet verified. Verified organizations can issue credentials. Contact support to start verification.',
      GATE_SUSPENDED:
        'Your organization is currently suspended. Issue Credential is unavailable until the suspension is resolved.',
      GATE_PARENT_UNAPPROVED:
        'Your sub-organization affiliation has not been approved by the parent organization. Ask a parent-org admin to approve your affiliation before issuing credentials.',
      GATE_PARENT_UNVERIFIED:
        'Your parent organization is not verified. Sub-organizations can only issue credentials when the parent organization is verified.',
      GATE_PARENT_SUSPENDED:
        'Your parent organization is currently suspended. Issue Credential is unavailable until the parent organization is reinstated.',
      PROOF_URL_LABEL: 'Public Proof URL',
      PROOF_URL_HELP:
        'If this credential is also published online (Udemy, Accredible, LinkedIn Learning, your own website, etc.), paste the public link here. Recipients and verifiers can cross-check the credential against the public record.',
      PROOF_URL_PLACEHOLDER: 'https://www.udemy.com/certificate/UC-…',
      PROOF_URL_OPTIONAL: 'Optional, but strongly recommended when available.',
    });
  });
});
