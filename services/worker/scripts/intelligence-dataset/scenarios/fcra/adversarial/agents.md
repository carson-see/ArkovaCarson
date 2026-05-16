# services/worker/scripts/intelligence-dataset/scenarios/fcra/adversarial

NVI-10 (SCRUM-814) adversarial and humility FCRA scenarios. Trains the model to refuse or escalate when it should not answer confidently.

## Files

- `humility-scenarios.ts` — 15 seed scenarios covering: open legal questions, insufficient facts, trick questions, multi-regulation conflicts, evolving law, adversarial prompts, jurisdiction confusion. All have `should_refuse: true`, `escalation_trigger: true`, confidence <= 0.70, and at least one counsel-consultation recommendation.
- `index.ts` — Re-exports the adversarial scenario array.

## Constraints

- Every scenario must set `should_refuse: true` and `escalation_trigger: true`.
- Target: 50+ scenarios via NVI-07 distillation lift.
