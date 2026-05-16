# services/worker/scripts/intelligence-dataset/kau

KAU-05/06 (SCRUM-753/754) Kenya and Australia credential types and data-breach procedures. Extends Nessie's jurisdiction coverage beyond the US.

## Files

- `credentials.ts` — Canonical credential-type taxonomy for Kenya (KNEC, TSC, KMPDC, etc.) and Australia (AHPRA, TEQSA, CA ANZ, CPA, etc.). Extractors and classifiers must use these IDs verbatim.
- `golden-scenarios.ts` — Scenario generator producing 20+ scenarios per jurisdiction from the credential registry. 3 wording variants per credential (formal, colloquial, partial OCR). Pure function, no LLM calls.
- `golden-scenarios.test.ts` — Tests for scenario generation.
- `kau.test.ts` — Integration tests for KAU modules.
- `ndb-sources.ts` — KAU-06 notifiable data-breach source registry for Kenya (KDPA 2019 s43, 72h notification) and Australia (Privacy Act Part IIIC, 30-day assessment, OAIC forms). Same shape as FCRA/HIPAA/FERPA registries.

## Constraints

- No free-text credential names — always use canonical IDs from `credentials.ts`.
- NVI gate must close before these datasets feed any training run.
