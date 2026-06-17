# Mergify / Stacked-PR Playbook + Tiered-Merge Codification

> **Story:** S0-4.3 (epic S0-E4 — Parallel-Safe Pipeline). RTE-owned.
> **Engineering note, not Confluence documentation** (CLAUDE.md §0 rule 4): the
> canonical S0-E4 spec lives in the Sprint 0 doc + Confluence Sprint-0 AUDIT page
> (83689473). This runbook is the operational playbook the train follows when
> running concurrent PRs through Mergify, plus the tiered-merge contract.
>
> Config: `.mergify.yml` · Tier detector: `scripts/ci/check-staging-evidence.ts`
> (`requiredTierFor` / `PATH_RULES`) · Merge-authority: `scripts/ci/compute-merge-authority.ts`
> · agents.md collision lint: `scripts/ci/check-agents-md-migration-collision.ts`
>
> **Why this exists:** concurrent agent PRs were producing ~45% rebase churn and
> a string of avoidable Mergify dequeues — most painfully **#1031 dequeued behind
> #1022** on 2026-06-01/05 when both appended a bare `## Recent migrations` block
> at EOF of `supabase/migrations/agents.md` and collided on the projected merge
> state (HANDOFF.md 2026-06-05 close). This playbook codifies the hygiene that
> prevents the repeat, and the tiered-merge rules that keep T2/T3 surfaces gated
> to Carson.

---

## Part 1 — Stacked-PR / queue hygiene playbook

Three rules, each grounded in a real incident. Internalize all three before
opening a second concurrent PR.

### 1.1 Title every `agents.md` migrations block `## Recent migrations (PR #NNNN)`

**The incident.** Two migration PRs (#1022, #1031) each appended a bare
`## Recent migrations` heading at the end of `supabase/migrations/agents.md`.
Git can't merge two identical appended sections at the same anchor without a
conflict; Mergify computes the projected post-merge state, hit the collision,
and **dequeued the loser (#1031) behind #1022** — pure churn, no review value
(CLAUDE.md §6, last row).

**The rule (CLAUDE.md §6).** Every `## Recent migrations` block in
`supabase/migrations/agents.md` MUST carry a `(PR #NNNN)` discriminator:

```markdown
## Recent migrations (PR #1022)
- 0330_get_unembedded_public_records_perf.sql — index + statement-timeout fix.

## Recent migrations (PR #1031)
- 0331_public_anchor_cpe_cle_metadata.sql — CPE/CLE columns on public anchors.
```

- **Insert in PR-number order**, not blindly at EOF. Distinct headings at
  distinct anchors don't collide, so the merge is a clean union — resolve any
  residual conflict as **doc-only (no re-soak required)**.
- **Prefer per-PR notes in the PR description.** The shared `agents.md` should
  carry only the durable post-merge summary; transient per-PR detail belongs in
  the PR body, not in the shared file that every concurrent PR also touches.
- **Enforced in CI** by `scripts/ci/check-agents-md-migration-collision.ts`:
  it fails the PR if any `## Recent migrations` header lacks a `(PR #NNNN)`
  discriminator, or if two blocks share the same PR number. The lint is scoped
  strictly to `supabase/migrations/agents.md` and only to that heading — it
  never flags ordinary `agents.md` edits (pre-mortem P8).

### 1.2 Delete the base branch to auto-retarget a stack

When you stack PR B on top of PR A (B's base is A's branch, not `main`), GitHub
**auto-retargets B onto `main` the moment A's branch is deleted** after A
merges. So:

- Stack deliberately: open B against A's head branch while A is in flight.
- When A merges, **delete A's branch** (Mergify deletes it on merge if
  configured; otherwise delete it manually). GitHub then retargets B → `main`
  automatically — no manual `git rebase`, no force-push, no base-edit dance.
- Do **not** manually rewrite B's base while A is still open/queued; let the
  merge-and-delete of A do the retarget. Manual base edits churn the queue
  (see 1.3).
- HANDOFF.md (2026-06-16) shows the train already stacking this way:
  `feat/train-d-credit-foundation` rebased onto `feat/train-d-proof-foundation`
  with the conflict pre-resolved so the authoritative typecheck/test runs at
  PR-open CI **before** any soak. Pre-resolve conflicts in the stack; let
  branch-deletion do the retarget.

### 1.3 Dequeue before you edit a queued PR

**The rule (CLAUDE.md §6).** A push to — or edit of — a PR **while it is in the
Mergify queue** resets that PR's queue progress and re-runs the speculative
checks against a freshly projected merge state. That is pure churn: minutes
burned, position lost, and (when migrations/`agents.md` are involved) a fresh
chance to collide with whatever else is queued.

- **Check queue state first.** Before any push or PR-body edit, confirm the PR
  is not currently queued (Mergify check-run / PR timeline). If it is queued and
  the change is not truly necessary, **don't touch it.**
- **If a change is genuinely required**, dequeue deliberately (add `do-not-merge`
  or `work-in-progress` — both block queue entry per `.mergify.yml` `queue_conditions`),
  make the edit, then remove the label to re-queue. Don't push into a live queue
  slot and hope.
- **Batching interaction.** The `default` queue batches `batch_size: 3` with a
  `batch_max_wait_time: 5 min`. A mid-batch push can invalidate the whole
  speculative batch, not just your PR — so the cost of an ill-timed edit is
  borne by every PR batched with you.
- **Migration PRs serialize.** Any PR touching `supabase/migrations/` is
  serialized in the queue (ordering matters) and auto-labeled `migration`;
  Mergify comments the serialization notice. This is expected, not a bottleneck,
  unless multiple migration PRs stack up — which is exactly when 1.1 and 1.3
  matter most.

### 1.4 Quick checklist before opening a concurrent PR

- [ ] If it touches `supabase/migrations/agents.md`: my block is titled
      `## Recent migrations (PR #NNNN)`, inserted in PR-number order.
- [ ] If it's stacked: base is the parent branch; I will rely on
      branch-deletion auto-retarget, not manual base edits.
- [ ] Migration numeric prefixes are reserved/ordered per `agents.md`
      (merge in prefix order).
- [ ] I will not push to this PR once it's queued without dequeuing first.
- [ ] Tier declared in the PR body matches `requiredTierFor` (see Part 2).

---

## Part 2 — Tiered-merge codification

### 2.1 The contract

| Tier | Surfaces (illustrative) | Merge authority |
|---|---|---|
| **T0 / T1** | Docs, tests, CI/tooling, low-risk frontend / config | **Council** (Tech Lead + RTE + Release Manager) — delegated |
| **T2 / T3** | Migrations, RLS/schema, chain/treasury, credits/billing, anchor lifecycle, security, public API/contract, **`CLAUDE.md`** | **Carson — sole merge** |

Carson holds **sole** merge authority on every T2/T3 surface. The council holds
**delegated** authority for T0/T1 only. This is a refinement of — never a
loophole around — CLAUDE.md §0 rule 1 ("Never merge a PR to `main`" for the
agent / Sarah's agent): the council delegation is for **human** release-train
roles, and only at T0/T1. The agent harness still blocks `gh pr ready` /
`gh pr merge` per CLAUDE.md §1.11 / §1.11A; nothing here grants the agent merge.

### 2.2 How the tier is computed — one detector, fails closed

The tier is **not** hand-declared for authority purposes. It is computed by the
single battle-tested path→tier detector — `requiredTierFor(files)` in
`scripts/ci/check-staging-evidence.ts` (the same `PATH_RULES` that gate staging
soak evidence). There is deliberately **no second detector** to drift out of
sync (S0-E4 refinement §1.2 / pre-mortem P4).

`scripts/ci/compute-merge-authority.ts` wraps that detector:

- Reuses `requiredTierFor` — identical path rules as the soak gate.
- Maps `T0 | T1 → council`, `T2 | T3 → needs-carson`.
- **Fails closed:** any thrown error, unknown surface, or detection failure
  resolves to `authority: 'needs-carson'`, `tier: 'T3'` — it only ever emits
  `council` when `requiredTierFor` returns T0/T1 with zero error. Unit-tested
  with a chain/migration path → `needs-carson` (pre-mortem P4).
- **Advisory only.** The script emits a GitHub Actions output
  (`merge_authority=…`, `tier=…`) and a `::notice::`, and always exits 0. The
  *enforcing* control is branch protection + Mergify, which only Carson applies
  (see Part 3). The script annotates; it does not gate.

Because the same `PATH_RULES` drive both the soak-evidence gate and the
merge-authority computation, a PR that is forced up to T2/T3 for soak purposes
(e.g. touching `services/worker/src/chain/` → T3) is automatically and
consistently routed to `needs-carson` for merge — no chance of a PR being "T3
for soak" but "council-mergeable for authority."

### 2.3 Daily digest

To keep the council's delegated lane honest and give Carson a single pane over
the `needs-carson` backlog, run a **daily merge-authority digest**:

- For every open PR to `main`, compute `mergeAuthorityFor(changedFiles)`.
- Group by authority: a **council-mergeable** list (T0/T1 — the council can
  clear these) and a **needs-Carson** list (T2/T3 — awaiting Carson).
- Post the digest to the release channel each morning. It is the standing
  worklist: the council drains the T0/T1 column; the T2/T3 column is Carson's
  queue and must never be merged by anyone else.
- The digest is read-only reporting built on the same advisory script — it
  changes nothing and gates nothing; it surfaces who-owns-what so PRs don't
  stall in the wrong lane.

---

## Part 3 — PROPOSED branch-protection + `.mergify.yml` change (subtask 4.3d)

> **PROPOSED — apply by Carson, do not auto-apply.**
>
> Editing `.mergify.yml` or branch protection from the train would silently
> change *who can merge* — a T2 control-plane change owned solely by Carson
> (CLAUDE.md §0 rule 1; S0-E4 pre-mortem **P7**). The train ships only this
> drafted diff. `.mergify.yml` and branch protection are left **untouched** on
> this branch. Carson reviews and applies.

The design: a CI job runs `compute-merge-authority.ts`; when it computes
`needs-carson`, a `needs-carson-merge` label is applied to the PR; Mergify
refuses to auto-merge any PR carrying that label, so T2/T3 PRs fall to Carson's
manual merge while T0/T1 PRs continue to auto-queue for the council.

### 3a. Workflow — produce the label from the advisory script (NEW file)

```yaml
# PROPOSED — apply by Carson, do not auto-apply.
# .github/workflows/merge-authority.yml  (NEW)
name: Merge Authority
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  compute:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # to (un)label
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - id: authority
        run: npx tsx scripts/ci/compute-merge-authority.ts
        # exits 0 always; sets outputs merge_authority + tier via $GITHUB_OUTPUT
      - name: Apply needs-carson-merge label
        if: steps.authority.outputs.merge_authority == 'needs-carson'
        run: gh pr edit "$PR" --add-label needs-carson-merge
        env: { GH_TOKEN: '${{ github.token }}', PR: '${{ github.event.number }}' }
      - name: Remove needs-carson-merge label (T0/T1)
        if: steps.authority.outputs.merge_authority == 'council'
        run: gh pr edit "$PR" --remove-label needs-carson-merge || true
        env: { GH_TOKEN: '${{ github.token }}', PR: '${{ github.event.number }}' }
```

### 3b. `.mergify.yml` — block auto-merge when the label is present (drafted diff)

```diff
# PROPOSED — apply by Carson, do not auto-apply. .mergify.yml left untouched on this branch.
 queue_rules:
   - name: default
     queue_conditions:
       - -draft
       - -label = work-in-progress
       - -label = do-not-merge
       - -label = hotfix
+      # Tiered-merge (S0-4.3): T2/T3 PRs carry needs-carson-merge (set by the
+      # Merge Authority workflow from compute-merge-authority.ts). The council
+      # queue may not auto-merge them; Carson merges them manually.
+      - -label = needs-carson-merge
       - "#changes-requested-reviews-by = 0"
       - check-success = Staging Soak Evidence Gate
 ...
 pull_request_rules:
   - name: Queue CI-green PRs
     conditions:
       - base = main
       - -draft
       - -label = work-in-progress
       - -label = do-not-merge
       - -label = hotfix
+      - -label = needs-carson-merge
       - "#changes-requested-reviews-by = 0"
       - check-success = Staging Soak Evidence Gate
     actions:
       queue:
         name: default
```

> Note: leave the `urgent`/`hotfix` queue able to bypass `needs-carson-merge`
> only if Carson wants hotfixes to remain self-serve; otherwise add
> `- -label = needs-carson-merge` to the `urgent` queue's `queue_conditions`
> too. Defaulting to **also gate hotfixes** is the fail-closed choice.

### 3c. Branch protection — make the computation a required signal (settings, not code)

Applied via repo Settings → Branches → `main` (or `gh api`), by Carson:

- **Require status checks to pass:** add **`Merge Authority`** to the required
  checks so the label is always computed before merge is possible.
- Keep linear history / up-to-date-branch settings as-is.
- **Do not** rely on branch protection alone to *block* the merge — GitHub
  branch protection can't gate on a label. The label→Mergify path in 3a/3b is
  what actually withholds auto-merge; branch protection's role is only to
  guarantee the label is *computed*. Carson's manual merge of a labeled PR is
  the intended, recorded exception (Carson is admin and the sole T2/T3 merger).

### 3d. Alternative considered — CODEOWNERS

A `CODEOWNERS` mapping the T2/T3 paths (`supabase/migrations/`,
`services/worker/src/{chain,security,billing}/`, `services/worker/src/api/`,
public-API/SDK paths, `CLAUDE.md`) to Carson, plus "require review from Code
Owners" branch protection, would also force Carson's sign-off on those surfaces.
It is **complementary**, not a replacement: CODEOWNERS gates *review*, the
label→Mergify path gates *auto-merge*. The label approach is preferred as the
primary control because it reuses the single `requiredTierFor` detector (one
source of truth for tiering) instead of maintaining a parallel path list in
`CODEOWNERS` that could drift from `PATH_RULES`. If Carson wants
defense-in-depth, apply both — but `PATH_RULES` remains the canonical tier map.

---

_S0-4.3 deliverable 4.3c. Train artifact is T0 (docs). The genuinely T2 actions
above (Mergify apply, branch-protection apply, CODEOWNERS apply) are carved out
to Carson per pre-mortem P7 and are drafted here, not applied._
