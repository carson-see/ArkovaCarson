# services/worker/scripts/intelligence-dataset/scenarios/fcra/multi-turn

NVI-08 multi-turn FCRA conversation scenarios. 10 archetypes with 2 seed scenarios each, producing ~12 multi-turn scenarios for training conversational compliance reasoning.

## Files

- `archetypes-1-5.ts` — Multi-turn scenarios for archetypes 1 through 5.
- `archetypes-6-10.ts` — Multi-turn scenarios for archetypes 6 through 10.
- `index.ts` — Combines both archetype files into a single exported array.

## Constraints

- Lift to production volume via NVI-07 distillation (chain-of-thought retrofit + Opus teacher).
- Each scenario must follow the `MultiTurnScenario` type from the parent `multi-turn` module.
