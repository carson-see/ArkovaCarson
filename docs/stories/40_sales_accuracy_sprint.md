# Sales-Accuracy Sprint — 2026-04-18 (PR #419)

**Epic status:** ALL 4 stories shipped + NCA-FU1 closed (#3, #4, #6).
**Confluence:** [Top-10 Sprint 2026-04-18](https://arkova.atlassian.net/wiki/spaces/A/pages/14843905)
**PR:** [#419](https://github.com/carson-see/ArkovaCarson/pull/419)
**Principle:** every customer-facing claim is backed by code or a dated doc — no more aspirational language.

This doc supports `docs/BACKLOG.md` TIER 0N. It documents the four sales-accuracy stories + the three NCA-FU1 follow-ups that also shipped in the same PR. The content is intentionally compact — full sprint narrative lives in the Confluence page.

---

## SCRUM-899 — KENYA-RES-01 Kenya data-residency evaluation

**Problem:** The 2026-04-17 Hakichain sales response cited "GCP Nairobi" and "AWS af-south-1" as candidate regions. Neither is accurate — GCP has no Nairobi region; `af-south-1` is a Cape Town AWS region and we don't run on AWS (see `memory/feedback_no_aws.md`).

**What shipped:**
- [docs/compliance/kenya/residency-options.md](../compliance/kenya/residency-options.md) — corrected region catalogue + DPA adequacy framing + recommendation (Supabase Frankfurt + GCP `africa-south1` compute with EU SCC 2021 Module 2).
- [services/worker/scripts/bench/kenya-latency.ts](../../services/worker/scripts/bench/kenya-latency.ts) + tests — p50/p95 percentile bench harness using shared `scripts/lib/stats.ts`.
- Exit criteria documented for future Supabase Cape Town availability.

**Follow-up:** run the benchmark from a `africa-south1` test VM + record numbers in §5 of the residency doc.

---

## SCRUM-900 — PROOF-SIG-01 signed proof bundle

**Problem:** The Hakichain sales response described the proof endpoint as a "signed JSON bundle." The legacy endpoint returned only an unsigned Merkle proof.

**What shipped:**
- [services/worker/src/proof/signed-bundle.ts](../../services/worker/src/proof/signed-bundle.ts) — Ed25519 detached signing wrapper with canonical JSON serialisation (shared `utils/canonical-json.ts`), in-band `signing_key_id` for rotation safety, key-object cache at module init.
- `GET /api/v1/verify/:publicId/proof?format=signed` — new query-param path. Default shape unchanged (Constitution 1.8 frozen-schema rule); 503 when signer env vars missing.
- `PROOF_SIGNING_KEY_PEM` + `PROOF_SIGNING_KEY_ID` env vars registered in CLAUDE.md §7.
- 13 new tests (8 in `signed-bundle.test.ts`, 5 in `verify-proof.test.ts`).

**Follow-up:** swap `staticEd25519Signer` for a GCP KMS `asymmetricSign` adapter. Sub-1-day change; `SignerFn` interface is stable.

---

## SCRUM-901 — SELF-HOST-01 reference architecture

**Problem:** The Hakichain sales response claimed a packaged self-hosted reference architecture. Until now it existed only as scattered expertise.

**What shipped:**
- [docs/deployment/self-hosted/README.md](../deployment/self-hosted/README.md) — 4-hour stand-up runbook covering Supabase self-host, Cloud Run worker, GCP KMS bootstrap, Bitcoin treasury options (managed vs sovereign), Constitution 1.6 guard for the frontend.
- [deployment/self-hosted/terraform/main.tf](../../deployment/self-hosted/terraform/main.tf) — GCP-only Terraform skeleton (KMS keyring + Ed25519 proof-signing + secp256k1 treasury + worker service account + Cloud Run v2 service + IAM).

**Follow-up:** first external pilot. §5 of the README holds the evidence table to backfill.

---

## SCRUM-902 — AWS-RM-01 GCP-only scoping

**Problem:** Seven customer-facing docs still cited "AWS KMS" or "AWS + GCP KMS" for Bitcoin treasury signing. Arkova has no AWS account in production.

**What shipped:**
- Customer-facing docs updated: `TECHNICAL_SECURITY_WIKI.md`, `generate-wiki-docx.cjs`, Kenya DPIA, Malaysia TIA, UK Cyber Essentials readiness, tabletop exercise, launch-readiness audit.
- Confluence `14_kms_operations.md` retitled GCP-first; AC3 decision recorded (keep AWS provider as code-level optionality; customer-facing claims are the enforcement line).
- Source-file headers updated: `signing-provider.ts`, `client.ts`, `chain/agents.md`.

**Follow-up:** regenerate `arkova-hakichain-response.docx` with the corrected language.

---

## SCRUM-893 — NCA-FU1 (closed in same PR)

Items #3 (PDF vector gauge), #4 (Nessie contextual recommendation prose — flag-gated by `ENABLE_NESSIE_RAG_RECOMMENDATIONS`, cached singleton provider, timer-leak-free 4s timeout, graceful fallback), and #6 (operator UAT runbook at `docs/runbooks/nca-audit-uat.md`) shipped alongside the sales-accuracy work. Items #1, #2, #5 landed earlier in the same branch cycle.

---

## Test coverage delta

| Bucket | Before | After | Delta |
|---|---|---|---|
| Worker | 3,135 | 3,156 | +21 |
| Frontend | 1,244 | 1,246 | +2 |

+23 new tests. All green. Additionally fixed a pre-existing failing test in `src/lib/complianceMapping.test.ts` where the `validFrameworks` list was missing LGPD, PDPA, LFPDPPP, EU-US DPF after INTL-01..03 + TRUST-03 added those frameworks.

## Simplify-pass refactors (extracted from the sprint diff)

- `services/worker/src/utils/canonical-json.ts` — shared canonical JSON helpers (replaces duplicate `deepSortKeys` in `extraction-manifest.ts`).
- `services/worker/scripts/lib/stats.ts` — shared percentile helper (used by `kenya-latency.ts` + `eval-embedding-benchmark.ts`).
- `recommendation-enrichment.ts` hoisted `NessieProvider` to a module-level singleton via `maybeEnrichWithNessieProvider()`.
- Replaced custom `base64url` helpers with Node's native encoding.
- Score gauge emits one `doc.lines()` path (36 segments) instead of N `doc.line()` calls.

## How to use this document

1. **Before promising any residency region, signed proof, self-host deployment, or KMS provider to a customer**, read the relevant section above + the linked artefact in full.
2. **Before regenerating the sales doc**, grep for `AWS KMS` / `Nairobi` / `af-south-1` one more time — the sales-doc generator doesn't live in this repo, so it won't catch drift automatically.
3. **Before transitioning any of the 4 Jira stories back from Done**, check Confluence first — the audit trail for what shipped is there.
