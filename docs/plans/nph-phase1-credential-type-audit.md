# NPH Phase 1 — Credential-Type Mapping Audit

**Confluence mirror:** [Top-10 Sprint Batch 3 — 2026-04-17 §9](https://arkova.atlassian.net/wiki/spaces/A/pages/13795329) — "NPH Phase-1 Credential-Type Audit — SCRUM-697"
**Jira:** [SCRUM-697 / NPH Epic](https://arkova.atlassian.net/browse/SCRUM-697)
**Last updated:** 2026-04-17
**Owner:** AI Platform (Carson, Engineering)
**Source of truth:** [services/worker/src/jobs/publicRecordAnchor.ts:101-132](../../services/worker/src/jobs/publicRecordAnchor.ts#L101-L132) (`mapCredentialType`)
**Gate:** This is Phase 1 Nessie-production-hardening work. **Training and dataset expansion are gated by the NVI gate (SCRUM-804).** Source-level mapping corrections are NOT gated — they can ship while the NVI gate is still open, since they only affect pipeline classification, not Nessie training.

---

## How to use this document

Phase 1 of the NPH epic is "Fix What Exists." This audit tells you, per source, whether its current `mapCredentialType` output is correct, over-broad, or wrong.

Five concrete steps to close Phase 1:

1. **Read** §Current mapping table (per-source truth as of commit time).
2. **Act** on any row marked **FIX** (§Phase-1 fixes) — each is a narrow PR.
3. **Re-run** `mapCredentialType` validation test (adding a case for each row) — see §Validation.
4. **Backfill** affected anchored records: a one-time `UPDATE` migration that corrects the `credential_type` on rows matching the fixed source.
5. **Close** Phase 1 by updating Section 5 of CLAUDE.md and the NPH Jira epic.

Phase 2 (new sources) and Phase 3 (training data pipeline) remain downstream and are separately ticketed.

---

## Current mapping table

Generated 2026-04-17 by reading `publicRecordAnchor.ts:101-132`. 25 source codes wired up.

| Source code | Current `credential_type` | Fetcher status | Correctness | Phase-1 action |
|-------------|---------------------------|----------------|-------------|----------------|
| `edgar` | `SEC_FILING` | Active | ✅ correct | none |
| `uspto` | `PATENT` | **0 records in DB despite fetcher existing** | ⚠️ mapping correct, fetcher broken | FIX — debug USPTO PatentsView S3 bulk fetcher |
| `openalex` | `PUBLICATION` | Active (dominant — ~85% of pipeline volume) | ✅ correct | none |
| `federal_register` | `REGULATION` | Active | ✅ correct | none |
| `courtlistener` | `LEGAL` | Active | ✅ correct | none |
| `npi` | `MEDICAL` | Active | ✅ correct (NPH-01 already fixed from PROFESSIONAL) | none |
| `finra` | `FINANCIAL` | Active | ✅ correct (NPH-01 already fixed from PROFESSIONAL) | none |
| `sec_iapd` | `FINANCIAL` | Active | ✅ correct | none |
| `dapip` | `ACCREDITATION` | Active | ✅ correct (NPH-01 already fixed from OTHER) | none |
| `calbar` | `LICENSE` | Active | ✅ correct | none |
| `acnc` | `CHARITY` | Active | ✅ correct | none |
| `fcc` | `LICENSE` | Active | ✅ correct (FCC ULS is a licence database) | none |
| `openstates` | `REGULATION` | Active | ⚠️ arguable (bills ≠ regulations once enacted) | **DECIDE** — see §Decision: openstates |
| `sam_gov` | `CERTIFICATE` | Active | ⚠️ debatable (SAM registration is a gov-contractor credential, closer to `BUSINESS_ENTITY` or dedicated `GOV_CONTRACTOR`) | **DECIDE** — see §Decision: sam_gov |
| `sam_gov_exclusions` | `CERTIFICATE` | Active | ❌ wrong (exclusion is the opposite of a credential) | **FIX** — add `EXCLUSION` enum or map to `LEGAL` |
| `sos_de/ca/ny/tx` | `BUSINESS_ENTITY` | Active | ✅ correct | none |
| `ipeds` | `ACCREDITATION` | Active | ✅ correct (institution-level accreditation) | none |
| `insurance_ca_cdi` | `INSURANCE` | Active | ✅ correct | none |
| `cle_ny`, `cle_tx` | `CLE` | Active | ✅ correct | none |
| `cert_cfa`, `cert_comptia`, `cert_pmi` | `CERTIFICATE` | Active | ⚠️ the story explicitly says "Professional cert bodies → BADGE" | **DECIDE** — see §Decision: cert bodies |
| `license_*` (fallback pattern) | `LICENSE` | Conditional | ✅ correct | none |
| default | `OTHER` | Fallback | ✅ correct by design | none |

**Coverage:** 25 source codes mapped to **14 of 23 canonical credential types**. 9 canonical types still have **zero pipeline coverage**: `IDENTITY`, `RESUME`, `MILITARY`, `BADGE` (unless re-mapped from CERTIFICATE), `DEGREE`, `TRANSCRIPT`, `CHARITY` (covered by `acnc` — OK), `ATTESTATION`, `DISCLOSURE`.

---

## Phase-1 fixes (code-ready)

### FIX #1 — `sam_gov_exclusions`

Change `mapCredentialType('sam_gov_exclusions')` from `CERTIFICATE` to `LEGAL` (closest existing enum to "federal exclusion / debarment order") **OR** introduce a new enum value `EXCLUSION`.

**Recommendation:** map to `LEGAL` short-term (zero migration cost). If we later want Nessie to distinguish exclusion from court case, introduce `EXCLUSION` and ship a backfill.

**PR scope:**

- Edit `mapCredentialType` at [publicRecordAnchor.ts:119](../../services/worker/src/jobs/publicRecordAnchor.ts#L119).
- Add test case in [__tests__/publicRecordAnchor.test.ts](../../services/worker/src/jobs/__tests__/publicRecordAnchor.test.ts).
- Data migration: `UPDATE anchors SET credential_type='LEGAL' WHERE source='sam_gov_exclusions'` (one-shot, wrapped in a migration for audit trail).

### FIX #2 — USPTO fetcher returns 0 records

Mapping is correct; the fetcher itself isn't landing records. Root cause hypotheses (investigate in order):

1. PatentsView bulk TSV S3 bucket URL moved or rate-limit header changed.
2. Cron job disabled in Cloud Scheduler.
3. `public_records.source = 'uspto'` INSERTs failing silently (check `pgrst` logs).
4. USPTO fetcher is behind a feature flag that defaults off.

**PR scope:**

- Run `services/worker/scripts/ops/verify-public-record-keys.ts` (per NPH-16 runbook) to confirm credentials.
- Re-run USPTO fetcher in DRY-RUN locally; capture result.
- Fix root cause; commit with a test that asserts at least one record inserts per run.

### DECIDE — `openstates`

OpenStates returns state bill data. A bill is a **proposed** rule, not an enacted regulation; `REGULATION` is defensible but imprecise. Options:

| Option | Trade-off |
|--------|-----------|
| Keep `REGULATION` | Lowest churn; Nessie already trained on REGULATION-labelled openstates records |
| Map to `LEGAL` | Matches court-case model (pre-decision); but harms "LEGAL = judicial" semantics |
| Introduce `LEGISLATION` | Most accurate; requires enum migration + Nessie retraining (which is NVI-gated) |

**Recommendation:** keep `REGULATION` until NVI gate closes and retraining becomes allowed. Then introduce `LEGISLATION`.

### DECIDE — `sam_gov` (non-exclusion)

SAM.gov registration represents a gov-contractor credential. Current `CERTIFICATE` is the closest but too broad (certificates include CFA, CompTIA, PMI which are professional accreditations). Options:

| Option | Trade-off |
|--------|-----------|
| Keep `CERTIFICATE` | Lowest churn |
| Map to `BUSINESS_ENTITY` | Accurate (org-level identity); conflicts with sos_* rows in same bucket |
| Introduce `GOV_CONTRACTOR` | Precise; requires enum migration + retraining |

**Recommendation:** keep `CERTIFICATE` until NVI gate closes; revisit with `sam_gov_exclusions` at the same time.

### DECIDE — cert bodies (CFA/CompTIA/PMI)

Story says these should map to `BADGE`, but code maps to `CERTIFICATE`. Distinction matters for Nessie F1 per type:

- `CERTIFICATE` in the golden dataset is mostly gov-issued (HVAC permits, export certificates).
- `BADGE` in the golden dataset is professional skill-badges (Credly, Accredible).
- CFA/CompTIA/PMI credentials are arguably professional skill certifications — closer to BADGE.

**Recommendation:** remap `cert_cfa`, `cert_comptia`, `cert_pmi` to `BADGE`. This can ship NOW (no retraining gate — BADGE is already in Nessie v5 training with 67.6% F1 and more balanced data will *help* not hurt).

**PR scope:**

- Edit `mapCredentialType` cert cases.
- Add test cases.
- Backfill migration: `UPDATE anchors SET credential_type='BADGE' WHERE source IN ('cert_cfa','cert_comptia','cert_pmi')`.

---

## Validation

Every change above needs a test. Pattern:

```ts
// services/worker/src/jobs/__tests__/publicRecordAnchor.test.ts
describe('mapCredentialType', () => {
  it.each([
    ['edgar', 'SEC_FILING'],
    ['uspto', 'PATENT'],
    ['npi', 'MEDICAL'],
    ['finra', 'FINANCIAL'],
    ['dapip', 'ACCREDITATION'],
    ['sam_gov_exclusions', 'LEGAL'],        // FIX #1
    ['cert_cfa', 'BADGE'],                   // DECIDE — cert bodies
    ['cert_comptia', 'BADGE'],
    ['cert_pmi', 'BADGE'],
    ['unknown_source', 'OTHER'],
  ])('maps %s to %s', (source, expected) => {
    expect(mapCredentialType(source)).toBe(expected);
  });
});
```

---

## Backfill migration pattern

Any mapping change against a live DB requires a one-shot backfill. Pattern:

```sql
-- supabase/migrations/0219_nph_phase1_remap_cert_bodies.sql
-- Remap cert_cfa / cert_comptia / cert_pmi from CERTIFICATE to BADGE.
-- Rollback: UPDATE back to CERTIFICATE (safe — no data loss, only label shift).
BEGIN;

UPDATE anchors
SET credential_type = 'BADGE'::credential_type
WHERE source IN ('cert_cfa', 'cert_comptia', 'cert_pmi')
  AND credential_type = 'CERTIFICATE'::credential_type;

COMMIT;

-- ROLLBACK:
-- UPDATE anchors SET credential_type = 'CERTIFICATE'::credential_type
--   WHERE source IN ('cert_cfa', 'cert_comptia', 'cert_pmi')
--     AND credential_type = 'BADGE'::credential_type;
```

Do not batch multiple mapping changes in a single migration — one fix per migration, so a single regression is reversible without compensating-migration gymnastics.

---

## Interaction with the NVI gate

Per CLAUDE.md NVI GATE MANDATE (2026-04-16):

- **Allowed now:** pipeline classification fixes (mapping corrections + USPTO fetcher fix + missing-source coverage).
- **Not allowed now:** any Nessie retrain, new regulation dataset expansion, Gemini Golden regeneration based on these re-classifications.
- **After NVI gate closes:** re-run the 50-entry eval per credential type; confirm BADGE F1 improves from the remap.

---

## Definition of Done for Phase 1 (SCRUM-697 epic scope)

- [ ] FIX #1 (`sam_gov_exclusions` → LEGAL) merged + backfill applied.
- [ ] FIX #2 (USPTO fetcher restored) merged; first new USPTO records anchor successfully.
- [ ] DECIDE — cert bodies re-mapped to BADGE + backfill applied.
- [ ] Pipeline admin page shows per-credential-type record counts (separate ticket, Phase 1 scope).
- [ ] 1.34M unembedded records back-filled into `document_embeddings` (separate ticket, Phase 1 scope).
- [ ] CLAUDE.md Section 5 Nessie table updated to reflect corrected type distribution.
