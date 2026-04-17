# Nessie Attorney-Review Process (NVI-05 / SCRUM-809)

_Last updated: 2026-04-17_

## Purpose

NVI-01 through NVI-04 produce a quarantine pool: sources that fail
structural verification against authoritative primary text. Not every
quarantined item needs a lawyer's eyes. This document defines the
tiered triage process so attorney time is spent on judgement calls,
not mechanical verification.

## Tier definitions

| Tier | Review by | Typical failure modes | Turnaround |
|------|-----------|-----------------------|-----------|
| **Tier 1 — Mechanical** | Dataset maintainer (engineering) | Soft warnings (missing reporter cite), statute-quote where the fix is a direct section-text paste, trailing whitespace, canonical-format nits | Same-day |
| **Tier 2 — LLM-assisted** | Claude Opus + GPT-4o consensus (scripted) | Agency-bulletin ambiguity, statute quotes where the correct primary text is itself a judgement call | 24–48 h |
| **Tier 3 — Attorney** | External FCRA compliance counsel | Case-law interpretation, state-overlay edge cases, multi-statute conflicts, adversarial/novel scenarios, orphans | 5–10 business days |

## Classification rules

Implemented in [`services/worker/scripts/intelligence-dataset/review-workflow.ts`](../../services/worker/scripts/intelligence-dataset/review-workflow.ts):

1. **Orphans** (no validator applicable) → Tier 3. Attorney must
   determine whether the citation is even the right *kind* of source.
2. **Case-law hard-fail** → Tier 3. Year / reporter-cite / party-name
   issues on a case cite usually indicate a deeper interpretation
   mismatch.
3. **State-statute hard-fail** → Tier 3. Code-label mismatches often
   mask wrong-statute problems that require state-bar knowledge.
4. **Soft-fail-only** (no hard-fails) → Tier 1. Warnings like
   "no reporter cite detected" are mechanical paper-cuts.
5. **Statute-quote hard-fail (only)** → Tier 1. Substitute the real
   15 U.S.C. text and re-verify.
6. **Everything else** (agency-bulletin hard-fail, mixed failures) →
   Tier 2. Run the LLM consensus prompt.

## Running the workflow

```bash
# 1. Verify sources (NVI-01..04 validators):
cd services/worker
npx tsx scripts/intelligence-dataset/validators/verify-sources.ts \
  --regulation all

# 2. Route the failures:
npx tsx scripts/intelligence-dataset/review-workflow.ts \
  --out out/nvi-review
```

Output:

```
out/nvi-review/
  index.md                    # summary + counts
  tier1-mechanical.md         # one-liner per Tier 1 source
  tier2-llm-assisted.md       # one-liner per Tier 2 source
  tier3-attorney/
    <source-id>.md            # one full packet per Tier 3 source
```

## Tier 1 — Mechanical fix

1. Read `tier1-mechanical.md`.
2. For each entry, open the source in
   `services/worker/scripts/intelligence-dataset/sources/<reg>-sources.ts`.
3. Apply the obvious fix (paste the real statute text, add the
   missing section-number reference, fix the URL host).
4. Re-run `verify-sources.ts` and commit.

## Tier 2 — LLM-assisted review

1. Read `tier2-llm-assisted.md`.
2. For each entry, pipe the source + failure notes to two models
   (Claude Opus 4.7 + GPT-4o) with the consensus prompt
   (see `services/worker/scripts/intelligence-dataset/prompts.ts`).
3. If both models agree on a fix → dataset maintainer applies it.
4. If they disagree → escalate to Tier 3.

## Tier 3 — Attorney review

1. Upload every markdown file under `tier3-attorney/` to a shared
   Google Doc folder (or Notion workspace) whose access is granted
   to engaged counsel.
2. Attorney completes the "Proposed fix" and "Attorney verdict"
   sections in each packet.
3. Approved packets flow into
   `services/worker/scripts/intelligence-dataset/sources/<reg>-sources-attorney-verified.ts`
   (gate: the dataset maintainer copies the approved source back
   into the main `<reg>-sources.ts` registry with the `lastVerified`
   date bumped to the attorney-review date).
4. Rejected packets are removed from the registry and any scenarios
   that cited them are re-grounded against an alternative source or
   dropped.

## External counsel engagement

- **Target firms:** Morgan Lewis (FCRA practice), Seyfarth Shaw
  (labor + FCRA), or boutique FCRA specialists (e.g. Francis
  Mailman Soumilas).
- **Scope:** Review the Tier 3 packet directory, mark each
  citation approved / modify / reject, provide the corrected
  wording for "modify" items.
- **Budget:** $2,000–$5,000 per review cycle (roughly 10–25
  packets at $150–$300/hr).
- **SLA:** 5–10 business days end-to-end per cycle.

## Open items

- [ ] Identify + engage external counsel (procurement + MSA).
- [ ] First Tier 3 review cycle (FCRA: ~27 packets).
- [ ] Establish re-review cadence (quarterly rolling, plus any time
      NVI validators go red on a previously approved source).

## Related

- `services/worker/scripts/intelligence-dataset/validators/` — NVI-01..04 validators.
- `services/worker/scripts/intelligence-dataset/verification-status.json` — input registry.
- CLAUDE.md §0 NVI Gate Mandate — gating policy for downstream training.
