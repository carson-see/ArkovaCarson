# Nessie FCRA Single-Domain Mastery Gate (NVI-14 / SCRUM-818)

_Last updated: 2026-04-17_

## Why this gate exists

2026-04-15 strategy reset established single-domain mastery as the
Nessie training policy: one regulation becomes genuinely expert before
we touch the next. We drifted on 2026-04-16 by deploying FCRA v27.3 +
HIPAA v28.0 + FERPA v29.0 in parallel on thin datasets (277 + 73 + 62
scenarios). FERPA's 27% citation accuracy was the signal that we were
accumulating mediocre domains instead of building one strong one.

This gate reverses that drift. Until FCRA passes, HIPAA / FERPA / SOX
/ GDPR / Kenya / any other regulation work is **paused**.

## The 8 criteria (all must pass)

| ID | Label | Bar |
|----|-------|-----|
| verification | NVI-01..04 | every FCRA source verified; 0 hardFails; 0 orphans |
| attorney-review | NVI-05 | 0 Tier-3 items open in the attorney-review queue |
| chain-of-thought | NVI-06 | CoT on 100% of scenarios |
| distillation | NVI-07 | ≥ 5,000 Opus-distilled accepted Q&A in training data |
| auxiliary | NVI-08 / 09 / 10 | ≥ 100 multi-turn + ≥ 150 document-grounded + ≥ 50 adversarial |
| professional-benchmark | NVI-11 | ≥ 50 attorney-authored benchmark questions |
| benchmark | NVI-12 | Nessie score ≥ base Gemini 2.5 Pro score on the gold-standard |
| canary | NVI-13 | ≥ 100 canary responses reviewed with ≥ 70% match rate |

The gate is programmatically evaluated by
`services/worker/scripts/intelligence-dataset/gate.ts::evaluateFcraMasteryGate`.
Thresholds there are the policy source of truth — change this doc and
the constants in that file together.

## While the gate is closed

- NDD epic (SCRUM-770) work — **paused**
- NSS epic (SCRUM-771) work — **paused**
- HIPAA v28 dataset expansion — **paused** (endpoint stays deployed, no new training)
- FERPA v29 dataset expansion — **paused** (endpoint stays deployed, no new training)
- SOX / GDPR / international regulation training — **paused**
- Any new Nessie regulation — **paused**

### Permitted exception

Bug fixes to v28 HIPAA or v29 FERPA if the production canary reveals a
real customer-facing harm (e.g. fabricated citation). These are
quarantine-response, not expansion, and still must go through NVI-05
tier review before re-deploy.

## When the gate opens

1. Apply the same NVI pipeline to HIPAA — replicate NVI-01 as
   `hipaa-statute-validator.ts`, build HIPAA-specific Claude Opus
   distillation templates, rerun NVI-06..13 on HIPAA.
2. Once HIPAA passes its mastery gate, apply to FERPA.
3. Each new regulation costs roughly $500–$1,000 in attorney + compute
   + ~2–4 weeks wall-clock.

## Status reporting

The gate status markdown is rendered by `renderGateStatusMarkdown()`
in `gate.ts`. Run:

```bash
cd services/worker
npx tsx scripts/intelligence-dataset/gate-status.ts  # future CLI
```

The doc + CLAUDE.md §0 NVI Gate Mandate are the policy layer. The
`gate.ts` evaluator is the executable layer. The NVI epic Jira
dashboard (SCRUM-804) surfaces per-criterion progress.

## Current gate status (2026-04-17 snapshot)

- ❌ verification: 140 pass / 198 total, 19 orphans, 39 hardFails (NVI-01..04 shipped; fixes pending)
- ❌ attorney-review: 27 Tier-3 packets queued, 0 attorney-resolved (NVI-05 framework shipped, counsel not yet engaged)
- ❌ chain-of-thought: scaffolder shipped, TODO markers on 282 of 302 step-3 / 73 step-4 (needs LlmEnricher pass)
- ❌ distillation: 0 validated Q&A (pipeline shipped, live run pending)
- ❌ auxiliary: 12 multi-turn / 9 document-grounded / 15 adversarial (seeds shipped; lift via distillation)
- ❌ professional-benchmark: 2 attorney-seeded, 48 to author
- ❌ benchmark: Nessie vs Gemini 2.5 Pro not yet run
- ❌ canary: 0 reviewed (routing core shipped; production wiring pending)

Gate status: **🛑 HOLD** — expected. The infrastructure for every
criterion has shipped (NVI-05..14 this PR); closing each requires
budget + attorney + production wiring.

## Communication

- Internal: Slack #ai-compliance-intel — weekly status
- Leadership: monthly NVI status memo citing per-criterion progress
- Customer-facing: Nessie remains "preview" status for FCRA; HIPAA +
  FERPA stay "research preview" with the caveat surfaced via
  `src/ai/nessie-quarantine.ts`.

## Related

- CLAUDE.md §0 NVI Gate Mandate — the binding policy.
- `services/worker/scripts/intelligence-dataset/gate.ts` — executable evaluator.
- `docs/plans/nessie-attorney-review-process.md` — NVI-05 tier procedure.
- `docs/plans/nessie-distillation-methodology.md` — NVI-07 pipeline.
- SCRUM-804 — NVI epic.
