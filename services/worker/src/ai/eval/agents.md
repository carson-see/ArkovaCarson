# agents.md — services/worker/src/ai/eval/

_Last updated: 2026-07-14_

## 2026-07-14 CTO ruling 102498305 — active Wave-1 acceptance contract

- `golden-dataset-s33-types.ts` applies the production
  `validateFieldsForType()` sanitizer before measuring ground-truth depth. All
  covered rows must retain at least five substantive fields and a concrete
  non-`other` subtype. Only ids in the fixed `GD-S33-OOD-NNN` set are exempt,
  and their ground truth must be exactly `{ credentialType: 'OTHER', subType:
  'other', fraudSignals: [] }` with no padding.
- `s33-batch-acceptance.ts` strictly validates the committed entry datasheet
  against the manifest and checks the corpus Markdown producer revision,
  manifest SHA, 81-row bijection, support blob/commit, and physical-parent to
  logical-predecessor provenance sentence. The active machine-readable
  acceptance artifact reads the exact #1498 producer head, tree, and manifest
  from Git and binds them to GitHub approval, successful CI checks, exact
  normalized 6–13-gram zero-match evidence, offline production-model replay,
  and diagnostic-only embeddings. No caller supplies Git digests.
- GitHub authentication and CI are the trust root. The active path has no
  external signer, registry, commitment/reveal ceremony, or live endpoint.
  The old signed sampling implementation remains only behind the explicitly
  test-only injected factory for security-regression coverage; its production
  factory always throws the CTO-retirement error.
- `s33-wave1-producer-verifier.ts` is the trusted-main, no-execution producer
  boundary. It parses only a directly exported `const` literal array graph,
  caps expansion at 81 rows, fails if TypeScript diagnostics are unavailable,
  derives the sole parent/tree/source/support blobs and exact six-path diff from
  Git, then validates all 81 rows after production field stripping. Never
  replace it with an import of producer code or accept caller-supplied Git
  facts. The current remote #1498 r10 correctly fails this gate at KE-001
  because its post-validation depth is four; do not weaken the floor.
- `s33-wave1-prerequisite-runner.ts` is the no-retry trusted-main network
  runner. Its exact CLI is `prerequisites --producer-head <sha>
  --raw-output-dir <dir>`. It makes 81 ordered `gemini-2.5-flash` production
  prompt calls, then bounded 3072-dimensional diagnostic embedding batches;
  it rejects model/tuned/schema overrides and publishes both raw reports
  atomically. Its offline response comparator mirrors successful production
  field coercion, professional-education recovery, per-type stripping, and
  cross-field fraud-signal merging without changing runtime `gemini.ts`.
- `s33-wave1-workflow-reports.ts` runs only after producer verification. Its
  CLI is exactly `raw --repository-root <bare> --producer-head <sha>
  --output-dir <dir> --prod-model-diff-raw-path <path>
  --embedding-diagnostic-raw-path <path>` or `final --repository-root <bare>
  --producer-head <sha> --output-dir <dir> --prod-model-diff-final-path <path>
  --embedding-diagnostic-final-path <path>`. It has no environment-variable
  fallback and rejects unknown, duplicate, missing, or mixed-mode flags. RAW
  mode deterministically normalizes private runner output; FINAL mode strictly
  revalidates and byte-preserves authenticated prerequisite finals while
  recomputing the current lexical corpus manifest. It emits the fixed report
  set using the common Team-2 envelope. Lane 3 never authenticates a review or
  emits `cross-review.json`; `s33-wave1-github-evidence.ts` owns that private
  WeakSet-branded GitHub boundary and late-loads the Lane-3 finalizer. The
  lexical report requires zero normalized exact n=6–13 matches, and embedding
  evidence is always diagnostic-only/non-overriding.

## 2026-07-13 S3.3 Lane-4 batch acceptance support (historical pre-ruling harness)

- `s33-batch-acceptance.ts` parses the actual Lane-4 manifest bytes and derives
  the complete entry universe. The strict schema includes the producer/Lane-3
  bindings, three corpus-source blobs, the exact 81-entry id/order contract,
  all three fixed count maps, the exact 11-entry Kenya-first and 9-entry OOD
  sets, and all ten real Wave-1 self-check records/statuses (including the
  declared CTO/L3 blockers); toy `selfChecks.structural` manifests fail closed.
  The credential-type contract is the reviewed r9-r11 11-category distribution,
  not a synthetic prefix-derived taxonomy; a hermetic real-entry seam test must
  reproduce both immutable production digests before parsing with production
  pins.
  The historical test-only harness does not accept supplied ids or a lowered
  fixed `ceil(10%)`, minimum-5 review floor. It uses four distinct records:
  a manifest-free CTO-signed salt commitment, a CTO-signed manifest freeze that
  proves the exact Git blob/ancestor, a CTO-signed selection policy bound to
  both digests, and the later salt reveal. All artifact boundaries accept only
  copied UTF-8 bytes/string, reject duplicate/unknown JSON keys, deep-freeze the
  verified snapshot, and bind raw-byte and canonical-JSON digests separately.
  The module-private, fixed-method audit transcript records commitment < freeze
  < policy < reveal < consumption with a hash chain + fsync. Before append, a
  reveal must prove its freeze and policy bind the same selected commitment and
  batch/revision; mixing valid records from separate ceremony chains fails
  closed without poisoning the legitimate reveal. The transcript is explicitly
  NOT the privileged anti-replay root. One-time consumption is owned by an
  injected external atomic/monotonic `ConsumptionRegistry` keying policy digest
  + batch + revision before any result can return. `s33-acceptance-ledger.ts` is
  intentionally an empty compatibility module with no ledger/append export.
  This machinery is not the active Wave-1 production acceptance path and must
  not be presented as requiring CTO keys, an external registry, or a ceremony.
- The S33-W1 revision-history self-check preserves the exact r2-through-r9
  contract and permits one metadata-only r10 restack. R10 keeps historical
  support anchored to `dd3ae1ed`, binds its logical prior producer revision to
  reviewed r9 `b9bb1d32` (with declared predecessor `506ff623`), and separately binds
  `corpusRevisionParentCommit` plus `directBaseCommit` to the freeze commit's
  sole physical parent: the reviewed final Team-3 support head. Both r10
  support-state bindings must say `LANE3_TOOLING_EXACT_HEAD_REVIEW_PASS`; that
  means tooling review only, never corpus acceptance, merge, production, or
  launch approval. The logical r9 commit need not be reachable in the support
  checkout: r10 declares no corpus or normalized-input changes and is checked
  against the three hard-pinned reviewed-r9 source blobs, the no-LF canonical
  entry-datasheet row digest, and the no-LF canonical ordered normalized-input
  pin digest. A separate no-LF canonical digest pins every four-field manifest
  entry, including domain and credential-type ground truth. The r10 entry
  datasheet may change only its revision and manifest hash metadata; its exact
  schema/static invariants and rows are revalidated.
  The corpus markdown may truthfully describe the r10 restack. Every history
  field remains exact and type-correct substitutions fail closed. The
  support-to-freeze raw diff must contain
  exactly the six manifest-authorized additions as regular non-executable
  `100644` blobs. Extra paths, deletions, renames, copies (including copies from
  unchanged support-tree sources, detected with `--find-copies-harder`),
  executable bits, symlinks, and gitlinks are rejected.
- Production r10 source/blob and canonical metadata pins are one immutable
  code-owned descriptor. Unit tests never resolve the logically prior r9 Git
  object: the explicitly test-only orchestrator factory may receive a validated,
  deep-frozen synthetic pin descriptor for synthetic temporary repositories.
  R10 Git fixtures fetch the exact initial support commit `dd3ae1ed`, create a
  synthetic support-marker child, and never seed from the invoking checkout's
  `HEAD`; all six producer packet paths must be absent from that support child.
  The public parser and retired production factory expose no override seam, and tests
  must never check raw or decodable held-out corpus bytes into the support tree.
- Every selection and lexical result is recursively frozen before it crosses
  the orchestration boundary, including sample ids, metrics/hits, and evidence.
  Audit-transcript reads open the final path with `O_NOFOLLOW`, verify the same
  fd is a single-link regular file with owner-only permissions, and read from
  that fd; the append uses that same validated fd under the lock, with no path
  close/re-open window.
- Lexical acceptance loads policy-bound held-out/corpus text artifacts and
  recomputes every n=6..13 metric at one orchestration boundary. There is no
  public policy-only apply function and no API accepts caller-supplied metrics
  or a caller-supplied universe. Embedding scans reject non-finite inputs and
  derived dot/norm/cosine overflow. Their provider and threshold are supplied
  by the caller, so the exported scan is explicitly `diagnostic-untrusted` and
  cannot serve as Lane-3 acceptance evidence; a future evidence-grade embedding
  path must bind a CTO-signed policy, exact artifacts, and provider identity.
- Harmless cosine rounding overshoot within `1e-12` is clamped to `[-1,1]`, so
  an exact duplicate reports a hit instead of crashing. Grossly out-of-range or
  non-finite arithmetic still fails closed.
- Revision 11 is the exact three-entry governance/truth correction from the
  final Lane-4 same-lane review: AU-002 `issuerName` is source-stated `Ahpra`,
  KE-009 no longer derives an exact expiry date from issue date plus a 12-month
  validity statement, and AU-002/AU-011 issued-date choices remain explicitly
  `BLOCKED_CTO_L3` rather than self-certified. The revision-11 AU-KE blob,
  entry set, normalized-input set, and datasheet-row digests are immutable
  code-owned pins; r2-r10 history remains exact, including the revision-10
  support head. OOD pure-abstention remains a declared CTO/protocol blocker.
- Revision history intentionally passes both a schema/type layer and the exact
  authoritative contract layer. Keep their mutation tests synchronized; the
  duplicated checks are separate fail-closed controls, not interchangeable
  implementations of one parser.
- Sampling sorts ids with explicit ECMAScript UTF-16 code-unit order; never use
  locale/ICU collation because it would make the signed sample host-dependent.
- Legacy-harness tests use the audited Git executable at `/usr/bin/git`.
  Every Git subprocess receives a fixed allowlisted environment;
  inherited `GIT_DIR`, `GIT_WORK_TREE`, object-store alternates, `GIT_CONFIG*`,
  loader, PATH, replacement refs, and external-diff redirection cannot alter
  repository evidence.
  Git object ids are exactly 40-hex SHA-1 or 64-hex SHA-256, never an in-between
  length.
  The transcript lock is deliberately fail-closed and is not auto-reaped. After
  a crash, confirm the PID recorded in `<transcript>.lock` is not running, then
  remove only that `.lock` file; never edit or remove the transcript.
- `golden-dataset-s33-types.ts` is Lane-3-owned support code, separate from the
  Lane-4 corpus packet. Its v6 taxonomy is drift-tested against the live prompt.
  `S33_PROPOSED_SUBTYPES.CPE` remains explicitly unratified and must not enter a
  tuning export or be represented as an acceptance decision.
  The shared covered-entry depth helper excludes `credentialType`, `subType`,
  `fraudSignals`, and evaluator-only control/reasoning metadata from the
  five-field floor so taxonomy/bookkeeping cannot inflate corpus quality. It
  also ignores unknown structural keys and rejects null, blank-string,
  non-finite-number, and empty-array values while preserving legitimate
  zero/false facts. The production post-validation contract now adjudicates
  covered depth and the exact OOD pure-abstention exception as described above.

## 2026-07-06 S3 CPE/CLE golden set + deterministic eval gate (AI-01/AI-02 — SCRUM-2381/2382)

- `golden-dataset-cpe-cle-s3.ts` — 60 synthetic labeled fixtures (30 CPE × 30 CLE), stratified/tagged: `clean` | `degraded-scan` × adversarial classes (`ambiguous-provider`, `near-duplicate-credits`, `fractional-hours`, `multi-credit`). 12-entry `held-out` split; `eval-gates.ts` excludes `held-out` from all merge gates. Counts + held-out fingerprints are version-pinned in `cpe-cle-s3-manifest.json` (regeneration-guarded by tests — regenerate the manifest whenever the dataset changes).
- `heldout-leakage.ts` — leakage control: SHA-256 fingerprints over normalized fixture text; `loadLeakageCorpus` scans `training-data/**` + `src/ai/**` (excluding the dataset/manifest/tests themselves) and the check FAILS on held-out content or id appearing in any committed prompt/few-shot/tuning corpus. NEVER add a held-out fixture (or its id) to a prompt or tuning export.
- `run-pe-gates.ts` gains `--dataset pe|s3`, a `fixture` provider mode (replays `recorded/s3-cpe-cle-recorded.json`, zero live model calls — the CI path), `--seed-recorded` (mock-echo seeding), and runs the leakage check as a fail-closed precondition of every s3 run. Gate `SCRUM-2382` in `eval-gates.ts`: aggregate weighted F1 ≥ 0.80 AND per-field floors (creditHours 0.85, issuedDate 0.80, credentialType 0.80), coverage hard-coded at 48. Reports emit field NAMES + scores only (value-omission is test-locked).
- `recorded/s3-cpe-cle-recorded.json` is a **mock-echo seed** (see `meta.note`) — it proves gate wiring determinism, NOT model quality. Replace via a nightly live-Gemini recording (run with `--provider gemini --dataset s3`, then record) before quoting the F1 as a model score. Held-out ids must never enter this committed file.
- npm scripts: `eval:s3-gate` (deterministic CI gate), `eval:s3-gate:seed` (re-seed after dataset changes).

## 2026-07-06 Round-1 review hardening (PR #1413)

- `golden-dataset-cpe-cle-s3.ts` refactored to `cpe()`/`cle()` fixture builders (Sonar new-code duplication fix): fixtures carry only deltas; shared structure (NASBA, credit-type defaults, provider = issuer, activity number = course id, empty fraud signals) lives in the builders. Emitted entries are byte-identical to the previous literals (verified against a pre-refactor JSON snapshot + the pinned manifest fingerprints). All 60 fixtures preserved.
- `run-pe-gates.ts` replay falsifiability: recorded-fixture `meta` now REQUIRES `promptVersionHash` + `model`; `validateReplayFixture` fail-closes on prompt-version mismatch, dataset-tag mismatch (the seed builder no longer hardcodes `s3-cpe-cle` — it takes the selected dataset's tag), and — in strict mode (`--require-live` / `EVAL_REQUIRE_LIVE=true`) — on `recordedFrom: 'mock-echo'`. Re-seed with `eval:s3-gate:seed` after any prompt change.
- `heldout-leakage.ts`: self-exclusions are EXACT relative paths (+ `.test.ts` suffix) via `isLeakageSelfExclusion`, not substrings; corpus roots now include `scripts/**`; `checkS3LeakagePrecondition` THROWS on an empty corpus (a wrong-root invocation is an error, not a pass) and `run-pe-gates.ts` derives the worker root from the module location, not `process.cwd()`.
- `eval-gates.ts` `computeWeightedF1`: documented the `missing_both`-as-TP caveat — correct abstention inflates aggregate F1 vs the classical definition; the per-field floors (`computeFieldF1` counts a missing field as FN) are the guard. Don't compare the aggregate against externally-reported F1 numbers.

## 2026-05-22 Professional Education Phase 5 Dataset

- `golden-dataset-professional-education.ts` owns SCRUM-1953 fixtures for CPE, CLE, and course-ID extraction coverage. Keep entries synthetic/PII-stripped and keep CPE/CLE/course-ID-only counts aligned with the 20-entry fail-closed gate minimums in `eval-gates.ts`.

## 2026-05-20 Explicit Eval Gates

- `eval-gates.ts` owns SCRUM-1962 and SCRUM-1963 gate configuration. Gates fail closed when matching Phase 5 entries are missing, when aggregate weighted F1 is below threshold, or when required field-level F1 is below threshold.
- CPE entries are selected by the `cpe` tag. CLE entries are selected by `cle` tag and exclude `cpe` so continuing professional education does not satisfy the legal ethics-hours gate.

## What This Folder Contains

AI extraction evaluation framework — golden datasets, scoring engine, calibration, drift detection, and fraud eval. Measures precision/recall/F1 per field and per credential type across providers.

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export for the eval framework |
| `types.ts` | `GoldenDatasetEntry`, `FieldResult`, `EntryEvalResult`, `AggregateMetrics` types |
| `runner.ts` | Eval runner — executes extraction against golden dataset, computes metrics |
| `scoring.ts` | Scoring engine — field comparison, precision/recall/F1, aggregate metrics |
| `calibration.ts` | Confidence calibration analysis — bucketed, Pearson, ECE, isotonic regression |
| `golden-dataset.ts` | Base golden dataset with manually labeled ground truth entries |
| `golden-dataset-phase*.ts` | Phase-specific golden dataset expansions (phases 2-24) |
| `golden-dataset-professional-education.ts` | Phase 5 professional education fixtures for SCRUM-1953/1962/1963 CPE, CLE, and course-ID coverage |
| `golden-dataset-subtype-backfill.ts` | Backfill sub-type labels across existing golden entries |
| `intelligence-eval.ts` | Nessie compliance intelligence eval — citation accuracy, faithfulness, relevance |
| `intelligence-eval-dataset.ts` | Test dataset for intelligence eval queries |
| `semantic-similarity.ts` | Embedding-based cosine similarity scoring (replaces keyword overlap) |
| `baseline-metrics.ts` | Stored metric baselines for regression detection |
| `drift-alert.ts` | Eval drift severity alerting (ok / warning / critical) |
| `eval-gates.ts` | Fail-closed merge gate evaluator for SCRUM-1962 CPE and SCRUM-1963 CLE ethics-hours thresholds |
| `calibration-regression.test.ts` | Regression tests for calibration stability |
| `fraud-eval-dataset.ts` | 100 adversarial examples (50 clean + 50 tampered) for fraud detection eval |
| `fraud-audit.ts` | CLI tool for false positive audit of FLAGGED integrity scores |
| `fraud-training-seed.ts` | 100+ hand-curated fraud patterns from enforcement actions for tuning |
| `fraud-holdout-set.ts` | 20 held-out entries (disjoint from training seed) for generalization F1 |
| `contract-recommendation-registry.ts` | Vetted recommendation URLs for reasoning golden set |
| `run-eval.ts` | CLI entry point for running eval suite |

## Do / Don't Rules

- **DO** run the eval suite before upgrading any model pin in `gemini-config.ts`
- **DO** keep the fraud holdout set strictly disjoint from training seed
- **DO NOT** add entries to both `fraud-training-seed.ts` and `fraud-holdout-set.ts`
