/**
 * Zapier Integration Tests (INT-05)
 *
 * Tests Zapier app structure, trigger payloads, and action logic.
 * No real API calls — tests validate the Zapier app definition shape.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import App from '../src/index';
import { BASE_URL, BATCH_SYNC_LIMIT, VALID_EVENTS } from '../src/constants';
import { CANONICAL_SURFACE, readSurface } from '../../../scripts/ci/check-webhook-event-registration-drift';

const CANONICAL_SURFACE_SOURCE_SCRIPT = 'scripts/ci/check-webhook-event-registration-drift.ts';

describe('Constants — default host', () => {
  // 2026-09-21 (SCRUM-3888): the raw Cloud Run host has no Cloudflare origin
  // guard in front of it and is slated to be 403'd directly once that guard
  // enforces — every default base URL in this repo must point at the public
  // gateway host instead. See integrations/shared/src/constants.ts and
  // packages/sdk/src/client.ts for the sibling fixes.
  it('BASE_URL is the public API gateway, not the raw Cloud Run host', () => {
    expect(BASE_URL).toBe('https://api.arkova.ai');
  });

  it('makecom.json baseUrl matches (Make.com module manifest, not read by TS code)', () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const makecom = JSON.parse(readFileSync(resolve(packageRoot, 'src', 'makecom.json'), 'utf8')) as {
      baseUrl?: string;
    };
    expect(makecom.baseUrl).toBe(BASE_URL);
  });
});

describe('Zapier App Structure', () => {
  it('exports a valid Zapier app definition', () => {
    expect(App.version).toBe('1.0.0');
    expect(App.platformVersion).toBe('18.6.0');
    expect(App.authentication).toBeDefined();
    expect(App.authentication.type).toBe('custom');
  });

  it('has required triggers', () => {
    expect(App.triggers.anchor_secured).toBeDefined();
    expect(App.triggers.anchor_revoked).toBeDefined();
  });

  it('has required actions', () => {
    expect(App.creates.anchor_document).toBeDefined();
    expect(App.creates.verify_anchor).toBeDefined();
    expect(App.creates.batch_verify).toBeDefined();
  });

  it('triggers use hook type (REST hooks)', () => {
    expect(App.triggers.anchor_secured.operation.type).toBe('hook');
    expect(App.triggers.anchor_revoked.operation.type).toBe('hook');
  });
});

describe('Authentication', () => {
  it('requires apiKey field', () => {
    const fields = App.authentication.fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('apiKey');
    expect(fields[0].required).toBe(true);
  });

  it('has a connection label', () => {
    expect(App.authentication.connectionLabel).toContain('Arkova');
  });
});

describe('Anchor Secured Trigger', () => {
  const trigger = App.triggers.anchor_secured;

  it('has correct display metadata', () => {
    expect(trigger.display.label).toBe('New Anchor Secured');
    expect(trigger.display.description).toContain('SECURED');
  });

  it('provides output fields', () => {
    const fields = trigger.operation.outputFields;
    const keys = fields.map((f: any) => f.key);
    expect(keys).toContain('public_id');
    expect(keys).toContain('fingerprint');
    expect(keys).toContain('status');
    expect(keys).toContain('credential_type');
    expect(keys).toContain('network_receipt_id');
  });

  it('provides a sample', () => {
    const sample = trigger.operation.sample;
    expect(sample.public_id).toMatch(/^ARK-/);
    expect(sample.status).toBe('SECURED');
    expect(sample.event_type).toBe('anchor.secured');
  });

  it('has subscribe and unsubscribe hooks', () => {
    expect(typeof trigger.operation.performSubscribe).toBe('function');
    expect(typeof trigger.operation.performUnsubscribe).toBe('function');
    expect(typeof trigger.operation.perform).toBe('function');
    expect(typeof trigger.operation.performList).toBe('function');
  });
});

describe('Anchor Revoked Trigger', () => {
  const trigger = App.triggers.anchor_revoked;

  it('has correct display metadata', () => {
    expect(trigger.display.label).toBe('Anchor Revoked');
  });

  it('provides revocation-specific fields', () => {
    const keys = trigger.operation.outputFields.map((f: any) => f.key);
    expect(keys).toContain('revoked_at');
    expect(keys).toContain('reason');
  });

  it('sample shows REVOKED status', () => {
    expect(trigger.operation.sample.status).toBe('REVOKED');
    expect(trigger.operation.sample.event_type).toBe('anchor.revoked');
  });
});

describe('Anchor Document Action', () => {
  const action = App.creates.anchor_document;

  it('requires fingerprint input', () => {
    const fields = action.operation.inputFields;
    const fp = fields.find((f: any) => f.key === 'fingerprint');
    expect(fp).toBeDefined();
    expect(fp.required).toBe(true);
  });

  it('offers credential type choices', () => {
    const fields = action.operation.inputFields;
    const ct = fields.find((f: any) => f.key === 'credential_type');
    expect(ct).toBeDefined();
    expect(ct.choices).toContain('DEGREE');
    expect(ct.choices).toContain('LICENSE');
    expect(ct.required).toBe(false);
  });

  it('has sample output with public_id', () => {
    expect(action.operation.sample.public_id).toMatch(/^ARK-/);
    expect(action.operation.sample.status).toBe('PENDING');
  });
});

describe('Verify Anchor Action', () => {
  const action = App.creates.verify_anchor;

  it('requires public_id input', () => {
    const fields = action.operation.inputFields;
    const pid = fields.find((f: any) => f.key === 'public_id');
    expect(pid).toBeDefined();
    expect(pid.required).toBe(true);
  });

  it('sample shows verified result', () => {
    expect(action.operation.sample.verified).toBe(true);
    expect(action.operation.sample.status).toBe('ACTIVE');
  });
});

describe('Batch Verify Action', () => {
  const action = App.creates.batch_verify;

  it('requires public_ids input', () => {
    const fields = action.operation.inputFields;
    const ids = fields.find((f: any) => f.key === 'public_ids');
    expect(ids).toBeDefined();
    expect(ids.required).toBe(true);
  });

  it('sample returns array of results', () => {
    expect(action.operation.sample.results).toHaveLength(2);
    expect(action.operation.sample.count).toBe(2);
  });
});

// P10: "Credential" is deliberately dropped from every action's Zapier-editor
// display copy (label/description/key) — "Verify Anchor" / "Batch Verify
// Anchors" — per CLAUDE.md §1.3 terminology. The `credential_type` FIELD name
// (an input/output/sample key, not display copy) is explicitly kept, so this
// only inspects `key`, `display.label`, and `display.description`.
describe('action display copy has no "credential" wording (§1.3)', () => {
  const actions = [App.creates.anchor_document, App.creates.verify_anchor, App.creates.batch_verify];

  it('no action key, label, or description contains "credential" (case-insensitive)', () => {
    for (const action of actions) {
      expect(action.key.toLowerCase()).not.toContain('credential');
      expect(action.display.label.toLowerCase()).not.toContain('credential');
      expect(action.display.description.toLowerCase()).not.toContain('credential');
    }
  });
});

describe('Constants', () => {
  it('batch sync limit is 20', () => {
    expect(BATCH_SYNC_LIMIT).toBe(20);
  });

  it('valid events are defined', () => {
    expect(VALID_EVENTS).toContain('anchor.secured');
    expect(VALID_EVENTS).toContain('anchor.revoked');
    expect(VALID_EVENTS).toContain('anchor.expired');
  });

  // Drift guard (DI-775 / SCRUM-3538). `VALID_EVENTS` mirrors the worker's
  // `VALID_WEBHOOK_EVENTS`, which is DERIVED from the keys of
  // `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` in
  // services/worker/src/webhooks/payload-schemas.ts. `anchor.superseded` was
  // dispatchable and subscribable in the worker for months while a prior,
  // hand-copied version of this list omitted it — and the 4 `folder.*` /
  // `record.folder_changed` events added by #2968 the same way.
  //
  // Kept as TWO checks on purpose (2026-09-21, SCRUM-3888 rebase): a
  // hardcoded pin and a derived, source-read check catch different failure
  // modes, and the pin was cheap to keep once it was updated anyway.
  //
  // 1) The pin below is exact-value regression coverage: it fails the
  //    instant `VALID_EVENTS` itself is hand-edited, with a diff you can
  //    read in the test output. It does NOT fire when the worker map grows
  //    and this list stands still — it's a hardcoded array, so drift
  //    between it and the worker is invisible until someone remembers to
  //    update both. That was exactly the gap that let `anchor.superseded`
  //    and the 4 `folder.*` / `record.folder_changed` events (#2968) go
  //    unpinned for a while.
  it('mirrors the worker allowlist exactly (drift guard — pinned)', () => {
    expect([...VALID_EVENTS]).toEqual([
      'anchor.submitted',
      'anchor.secured',
      'anchor.revoked',
      'anchor.expired',
      'anchor.superseded',
      'anchor.batch_secured',
      'credential.issued',
      'credential.verified',
      'credential.status_changed',
      'compliance.document_expiring',
      'job.completed',
      'compliance.certificate_expiring',
      'compliance.anchor_delayed',
      'compliance.signature_revoked',
      'compliance.timestamp_coverage_low',
      'attestation.created',
      'attestation.revoked',
      'folder.created',
      'folder.updated',
      'folder.deleted',
      'record.folder_changed',
      'anchor.revocation_anchored',
      'attestation.active',
      'suborg.created',
      'suborg.approved',
      'suborg.revoked',
      'suborg.credits_allocated',
      'suborg.credits_reclaimed',
      'suborg.suspended',
      'suborg.offboarded',
    ]);
  });

  // 2) The check below is the general-purpose gate this package was missing:
  //    rather than re-hand-copying the worker's id list yet again (the same
  //    class of drift, just moved one file over), this reads the worker's
  //    own source file directly with the exact same static parser
  //    `scripts/ci/check-webhook-event-registration-drift.ts` uses for its
  //    root-CI-gated cross-surface check (`CANONICAL_SURFACE` / `readSurface`)
  //    — no cross-workspace RUNTIME import of worker code is needed, since
  //    the parser only reads worker source as text via `node:fs`. This
  //    fires when the worker map grows and this file stands still (the pin
  //    above cannot detect that), and it runs in this package's own
  //    `npm test`, independent of whether root CI ever exercises this
  //    workspace. If the pin above and this ever disagree, this one is
  //    right — it's reading the worker's actual source, not a copy.
  it('mirrors the worker allowlist exactly (drift guard, read from the worker source of truth)', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const canonical = readSurface(CANONICAL_SURFACE, repoRoot);
    expect(canonical.unresolved, `could not locate ${CANONICAL_SURFACE.file}'s event map`).toBeUndefined();
    expect(canonical.ids.length).toBeGreaterThan(0);
    expect([...VALID_EVENTS]).toEqual(canonical.ids);
  });

  // The CI job that actually runs this suite (`.github/workflows/ci.yml`'s
  // "Validate Zapier clean installation and build" step) does `npm ci
  // --ignore-scripts --no-fund` with working-directory `integrations/zapier`
  // ONLY — it never installs the repo root's node_modules. The import above
  // reaches outside this package into scripts/ci/, so if that script ever
  // grew a dependency on an external (non-`node:`) package, this whole test
  // file would fail to even load in that CI job — not with a clear "missing
  // dependency" message, but as an opaque module-resolution error, because
  // the package that would supply it was never installed. Read the
  // script's own import lines and assert they name only `node:` builtins,
  // so a future edit to it that adds an external import fails HERE, in a
  // test whose name says exactly why, rather than silently breaking that
  // CI job the next time someone touches the drift-guard script.
  it('the imported CI drift-guard script imports only node: builtins (so it needs no install here)', () => {
    const scriptPath = resolve(
      fileURLToPath(new URL('../../..', import.meta.url)),
      CANONICAL_SURFACE_SOURCE_SCRIPT,
    );
    const source = readFileSync(scriptPath, 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line, `non-node: import found: ${line}`).toMatch(/from\s+['"]node:/);
    }
  });
});
