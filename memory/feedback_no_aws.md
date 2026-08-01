---
name: no-aws
description: Arkova production runs on GCP + Supabase only. No AWS SDK imports, no `default('aws')`, no `kmsProvider: 'aws'` in production code — and no AWS regions or "AWS KMS" claims in sales/compliance docs.
type: feedback
---

Production is **GCP-only** (Cloud Run, Secret Manager, GCP KMS) plus Supabase. There is no AWS account behind Arkova. Treat every AWS reference in production code as a dead branch that must not grow.

**Why:** BUG-2026-04-18-001 (`docs/bugs/bug_log.md`) — a sales document plus seven compliance documents claimed "AWS KMS" (or "AWS + GCP KMS") for Bitcoin treasury signing. Production has no AWS. Customer procurement would have read a capability we cannot deliver, in exactly the documents auditors and buyers read most carefully. The same drift produced a Hakichain sales response citing `af-south-1` as a candidate region (`docs/stories/40_sales_accuracy_sprint.md`). CLAUDE.md §1.1 pins the truth: WIF in Secret Manager is the active signer, GCP KMS is the fallback code path, **AWS KMS provider is non-deployed**.

**How to apply:**
- Signing goes through the WIF / GCP KMS path in `services/worker/src/chain/`. Do not import `@aws-sdk/*` and do not select `'aws'` as a KMS provider anywhere new.
- Two files are allow-listed as documented dead branches: `services/worker/src/chain/signing-provider.ts` and `services/worker/src/chain/aws-kms-provider.ts`. Don't extend them, and don't wire them into a new call path. Test/spec files are also exempt.
- Answer "what cloud are you on?" as GCP + Supabase. When writing residency, compliance, deployment, or sales copy, use GCP regions only — `docs/compliance/kenya/residency-options.md` and `docs/deployment/self-hosted/README.md` already carry this constraint and ask for a periodic AWS-drift re-audit.
- **CI does not catch doc drift.** The lint only scans changed `.ts`/`.tsx` files. Prose claiming AWS is caught by human review or not at all — check it yourself when touching sales/compliance material.

**Enforcement:** CI lint `scripts/ci/feedback-rules/no-aws.ts` (R0-7 / SCRUM-1253), run by `scripts/ci/check-feedback-rules.ts` on every PR. It fails on `from '@aws-sdk/`, `require('@aws-sdk/`, `.default('aws')`, and `kmsProvider: 'aws'` in changed TypeScript.

**Override label:** `aws-intentional` — turns the failure into a warning. If you reach for it, you are changing the cloud posture; update CLAUDE.md §1.1 and this file in the same PR.
