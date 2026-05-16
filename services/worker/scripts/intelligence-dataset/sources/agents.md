# services/worker/scripts/intelligence-dataset/sources

Canonical citation registries per regulatory domain. Every citation the model emits must reference an ID from these registries. New sources must be added here before any scenario can cite them.

## Files

- `fcra-sources.ts` — FCRA source registry. Anchored to 15 U.S.C. s1681 et seq., CFPB publications, FTC enforcement dockets, state statutes, federal appellate opinions. Exports `fcraCitation()` helper.
- `ferpa-sources.ts` — FERPA source registry (20 U.S.C. s1232g, 34 CFR Part 99, PTAC guidance). Exports `ferpaCitation()` helper.
- `hipaa-sources.ts` — HIPAA source registry (45 CFR Parts 160/164, HHS guidance, OCR enforcement). Exports `hipaaCitation()` helper.

## Constraints

- Every entry must be cross-checked against the primary source with a `lastVerified` date.
- Scenario files, eval files, and distillation templates all depend on these IDs being stable.
