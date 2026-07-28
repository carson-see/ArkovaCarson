# 2026-07-28 — `agents.md` union-merge-driver silent-drop: remediation

## Mechanism

A local `.git/config` in this checkout carried:

```
[merge "union"]
    driver = true
```

`.gitattributes` declares `agents.md merge=union` for ~200 files, so that
parallel PRs touching the same notes file get combined rather than
conflicting. Naming a git **built-in** driver (`union`) in `merge.<name>.driver`
overrides the real algorithm; `true` is the shell no-op — it writes nothing to
`%A` and exits `0`. Git therefore recorded a **clean merge** while silently
keeping "ours" (or, just as often, "theirs" — see below) and discarding the
other side's unique content. No conflict markers, no error, no non-zero exit
code. The config was local and uncommitted, so it never reached CI or another
clone; it is now unset, and PR #1734 adds two guards against recurrence (see
"Guards" below).

## Re-derived methodology (independent of any prior audit numbers)

The task brief for this session cited "169 lines across 31 commits." PR #1734,
opened independently the same day, cites "86 lines across 19 commits." Neither
number was trusted; both are superseded by the derivation below, which used a
different technique from either and should be read as the reconciling source.

**Why a pure 2-parent merge-commit scan is insufficient here.** The initial
approach was to walk every 2-parent merge commit on `main`'s first-parent
chain since 2026-05-01 and compare the merge result against both parents
verbatim. That surfaced 88 commit/file events (330 lines) where the merge
result was **byte-identical to one parent** while the parents differed — the
mechanical signature of the bug, confirmed at the git-object level (not a
heuristic). Example, mechanically verified:

```
git diff aa59e50774ef761b1d4cd5fe028831e5e8b78ac1 585277c3bb9d34c0a20710b8837d0b3b4f363a0e -- services/worker/agents.md
# (empty — the merge result exactly equals the PR-branch parent; the
#  mainline-exclusive content from the OTHER parent is completely gone)
```

But a sample confirmed-lost example named in the task brief — `PlatformAdminRoute`
dropped by `f8059cba` ("test(sidebar): fix flaky assertion...", #1675) — turned
out to be a **single-parent** commit:

```
git log -1 --format='%P' f8059cba53f199cf44885fd66f6d70280e0ea21c
5ee0708c9a268edc8372b52a3283fb05d85b86e9   # one parent — a squash/direct commit
```

This repo lands many PRs as squash commits. The union-driver bug still fires
in that flow — it happens during a **local** `git merge` (syncing a feature
branch with `main`, or resolving a rebase) inside a contributor's own
checkout, before the branch is squashed into one commit on `main`. The
resulting single commit on `main` already reflects the corrupted branch state;
no 2-parent merge commit for the loss ever lands on `main` at all. A
merge-commit-only scan structurally cannot find these.

**Final method:** walk `main`'s full first-parent chain since a baseline
commit just before 2026-05-01 (`02594dbc`, 2026-04-29) — 745 steps, mixing
2-parent merges and 1-parent squash/direct commits — and at each step diff
each `agents.md` file against its immediate predecessor. Flag a line as
dropped when it is present in the predecessor and **absent from the successor
by exact match**, with two false-positive filters applied before flagging (see
below). This is the same append-only-violation shape PR #1734's
`check-agents-md-append-only.ts` uses, generalized from "one PR" to "every
step in history."

Result: 119 commit/file events, 410 candidate dropped lines, across 48 files.
Of the 88 confirmed-at-git-object-level events (330 lines), all matched this
independent line-level derivation, cross-validating both methods.

### False-positive classes filtered out

1. **In-place edits (reworded lines).** A line deleted from the predecessor is
   not flagged if any line newly added in the successor shares ≥50% token
   (Jaccard) overlap with it — an edit, not a drop.
2. **Table rows rewritten wholesale.** Markdown table rows (`| \`0361\` | ... |`)
   are matched by their **first cell** (e.g. a migration number or ticket ID),
   not prose similarity — a reservation row that gets its status column
   rewritten from "RESERVED" to "merged ✓" is an edit of the same row, not a
   drop, even though the prose shares few tokens.
3. **Whole-file deletions.** `sdks/typescript/src/agents.md` (9 lines) flagged
   as "dropped," but the entire `sdks/typescript/` directory was deliberately
   removed (`chore/remove-stale-sdk-duplicate`, #1506) — verified via
   `git show origin/main:sdks/typescript/src/agents.md` → "path does not
   exist." Not a bug symptom; excluded.
4. **Superseded-by-later-legitimate-rewrite.** The line-level diff only proves
   content was missing at one point in history — it says nothing about
   whether a *later, unrelated* commit already rewrote that section for
   real reasons. Three confirmed examples, individually verified and
   **excluded from restoration**:
   - `services/worker/src/webhooks/agents.md` (41 lines, dropped 2026-05-09):
     the file has since been completely restructured into a live reference
     doc (event-type table, HMAC signing detail) that explicitly marks
     `anchor.expired` as "Live" where the old dropped text called it
     "Pending in-flight." Restoring the old text would reintroduce a false
     claim.
   - `src/components/verification/agents.md` (`isPreSecured` paragraph,
     5 lines): the symbol was renamed to `isPreSecuredStatus` and the whole
     hero-state-machine section was rewritten with `normalizePublicVerificationStatus()`
     and `ACTIVE`-alias handling neither of which existed at the time of the
     drop.
   - `services/worker/src/ai/agents.md` (`nessie-json-parse.ts`, 4 lines): the
     *current* doc explicitly states this file "does not [exist] on this
     branch/main; it exists only on a separate, unmerged PR (#1660)" —
     restoring the dropped text would assert something the current doc
     itself says is false.
5. **Living-ledger churn.** `supabase/migrations/agents.md` (61 of the
   remaining lines) is a constantly-rewritten migration-reservation ledger by
   design (see CLAUDE.md §6's own entry on this file colliding across PRs).
   Every flagged "drop" here is a reservation-status update for a migration
   that has since merged, been renumbered, or been struck — restoring
   weeks-old "RESERVED — pre-soak" text for a migration that is long since
   `merged ✓` would reintroduce stale, actively wrong ledger state. Excluded
   as a category.

## Loss table (condensed)

Full per-commit detail (119 events) is reproducible via the method above;
condensed by file, largest first. **Class** = `MERGE` (git-object-confirmed:
merge result byte-equals one parent) or `SQUASH` (single-parent commit,
confirmed only by line-level diff — includes the task's own #1675 example).

| File | Lines | Class | Commit(s) | Restored? |
|---|---|---|---|---|
| `services/worker/agents.md` | 74 | MERGE + SQUASH | `585277c3` (#1255), `4a6e0737` (#1552) | **Yes** (this session: 62 lines SCRUM-1791/2492; other agent's `391cc7a0`: 10 lines S3.3 Wave 3 quotas) |
| `supabase/migrations/agents.md` | 61 | mixed | many | No — living ledger churn (§ above) |
| `services/worker/src/webhooks/agents.md` | 41 | MERGE (`734921a`→`1ccdf4f2`, #734) | — | No — superseded by later rewrite (§ above) |
| `scripts/staging/agents.md` | 18 | mixed | several | No — not reviewed this session; flagged for follow-up |
| `services/worker/src/middleware/agents.md` | 16 | MERGE (`9d3b4f8a`, #1606) | — | **Yes** (full) |
| `services/worker/src/jobs/agents.md` | 16 | MERGE (`003550d0` #1631, `8c1ba1f1` #1510) | — | **Yes** (full, plus 5 extended `## Files` bullets for genuinely-current but undocumented job modules) |
| `src/lib/agents.md` | 15 | mixed | several | **Yes** (10 of 15; 5 lines were already superseded by more-detailed current text — piiStripper.ts/aiExtraction.ts/sentry.ts short bullets, "Known gap" pre-CLOSED text) |
| `services/worker/src/api/v1/agents.md` | 10 | MERGE | `fd72dfb5` (#1660), `8c1ba1f1` (#1510) | **Yes** (full: CTDL import route + AI-03 byte-smuggling guard) |
| `sdks/typescript/src/agents.md` | 9 | MERGE | `4ff2e197` (#1506) | No — whole directory deliberately deleted (§ above) |
| `src/components/verification/agents.md` | 7 | MERGE | `f7bb1b79` (#784), `9d70effd` (#1602) | Partial — restored the still-current SCRUM-2938 terminology entry (1 of 2); skipped the superseded `isPreSecured` paragraph (§ above) |
| `src/pages/agents.md` | 6 | SQUASH + MERGE | `f8059cba` (#1675), `6cd761b1` (#1658) | **Yes** (this session + `391cc7a0`, deduplicated post-rebase) |
| `services/worker/src/utils/agents.md` | 5 | MERGE | several | No — all 5 already superseded by more-detailed current bullets (verified individually) |
| `scripts/ci/agents.md` | 5 | mixed | several | No — not reviewed this session (1 of 5 confirmed superseded — base-drift gate rewrite; rest untriaged) |
| `services/worker/src/types/agents.md` | 5 | SQUASH | `4a6e0737` (#1552) | **Yes** (other agent's `391cc7a0`: x402 request context) |
| `packages/verifier-cli/agents.md` | 5 | SQUASH | `64d4a4d5` (#1411) | No — not reviewed this session |
| `services/worker/src/ai/agents.md` | 5 | MERGE | `e122431c` (#1661) | No — superseded, see § above |
| `e2e/agents.md` | 4 | MERGE + SQUASH | `15e708a7`, `855323bd` (#1269) | **Yes** (SCRUM-2938 via `391cc7a0`; extraction-csp-fail-closed row this session) |
| `src/hooks/agents.md` | 4 | MERGE | `4e876a1b` (#1439) | **Yes** (full: 3 hooks) |
| `src/components/anchor/agents.md` | 5 | mixed | `d504191c`, `6cd761b1`, `f8059cba` | **Yes** (4 of 5 — the 5th, an old short `SecureDocumentDialog.tsx` bullet, is superseded by the current detailed one) |
| `src/components/auth/agents.md` | 2 | SQUASH | `f8059cba` (#1675) | **Yes** (the confirmed task example — `PlatformAdminRoute`) |
| `src/components/layout/agents.md` | 2 | mixed | `4d07253d`, `f8059cba` | **Yes** (1 of 2 — the Sidebar Account-section bullet; `RouteErrorBoundary.tsx` short bullet is superseded) |
| `src/components/organization/agents.md` | 3 | mixed | `52d387d1`, `1c741518`, `f8059cba` | **Yes** (1 of 3 — the SCRUM-3010 addendum merged into the existing `OrgRegistryTable.tsx` bullet; other 2 are old short bullets superseded by current detail) |
| remaining 27 files | ≤2 each, 26 total | mixed | many | No — below the line for this session's time budget; listed for follow-up |

**Restored this session: services/worker/agents.md, services/worker/src/middleware/agents.md,
services/worker/src/jobs/agents.md, services/worker/src/api/v1/agents.md,
src/lib/agents.md, src/hooks/agents.md, src/components/anchor/agents.md,
src/components/auth/agents.md, src/components/layout/agents.md,
src/components/organization/agents.md, src/components/verification/agents.md,
src/pages/agents.md (jointly with the parallel session below), e2e/agents.md
(jointly).**

## A second, parallel restoration in flight

While this audit was running, `origin/main` advanced by commit `391cc7a0`
("docs(agents): restore 6 agents.md sections dropped by the broken union
merge driver"), authored in a different session working the same incident
concurrently. It restored overlapping content in
`services/worker/agents.md`, `src/components/auth/agents.md`,
`src/pages/agents.md`, `services/worker/src/types/agents.md`, and
`e2e/agents.md`. Per this task's explicit caution about concurrent pushes:
this branch was rebased onto `origin/main` mid-session and the three files
with true duplicate sections (`services/worker/agents.md` had no duplicate —
the two sessions restored *different* dropped sections to it;
`src/components/auth/agents.md` and `src/pages/agents.md` had exact-duplicate
`## 2026-07-22 PlatformAdminRoute` / `## SCRUM-3010 STEP 1` /
`## 2026-07-22 Platform-admin role-source cutover` headers from both sessions)
were manually deduplicated, keeping one clean copy of each section. Content
was verified present exactly once per section after dedup, not merely that
the rebase completed without conflict markers.

## Guards now in place (PR #1734, open at time of writing)

1. **`scripts/agent/check-git-merge-config.sh`** — refuses any
   `merge.<builtin>.driver` definition or a no-op driver command, at any git
   config scope. Wired into `ack-claude-bootstrap.sh`, which every session
   runs before touching git. Catches the *cause* (the config can't reappear
   undetected in a checkout that runs bootstrap).
2. **`scripts/ci/check-agents-md-append-only.ts`** — a committed, cause-agnostic
   CI backstop. Computes `merge-base(BASE_REF_SHA, HEAD)` for a PR and flags
   any line present at the base but absent at head, using the same two
   false-positive filters described above (token-similarity edit-matching,
   table-row first-cell matching). Catches the *symptom* regardless of
   mechanism — a future contributor without the buggy config who deletes
   documented content by accident (or intentionally without the override
   label) still gets caught. Override label: `agents-md-deletion-approved`.

Both guards were unmerged (PR #1734 open, in review) as of this remediation.

## What remains open

- `scripts/staging/agents.md` (18 lines), `scripts/ci/agents.md` (4 of 5
  remaining), `packages/verifier-cli/agents.md` (5 lines), and 27 smaller
  files (≤2 lines each, 26 lines total) were identified as genuine drop
  candidates by the methodology above but not individually triaged this
  session (each needs the same superseded-vs-still-valid judgement call
  applied to every restored file above; none are pre-verified either way).
  Re-run the derivation method against current `main` HEAD to re-surface
  them — the `chain_drops.json` / `final_restore_candidates.json` working
  files used for this audit were session-scratch and are not committed.
- `supabase/migrations/agents.md`'s 61 flagged lines are deliberately not
  restored (living-ledger churn, see above) but were not individually
  spot-checked for the rare case of a genuine non-ledger loss hiding in that
  file; a targeted look would need to separate table rows (safe to skip —
  first-cell matching already excludes edited-in-place rows) from prose
  narration sections that might contain a real one-off loss.

_Last refreshed: 2026-07-28 by RTE session (Claude, Arkova RTE lane) — claims verified via `git diff`/`git show` against `origin/main`, cross-checked against the parallel `391cc7a0` restoration and PR #1734._
