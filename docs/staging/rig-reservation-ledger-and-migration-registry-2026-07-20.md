# Rig-Reservation Ledger + Migration-Number Registry (SCRUM-2979)

**Owner:** Release/Train lane (RTE). **Published:** 2026-07-20T19:05Z (24-hour watch window, W2 docs carve-out).
**Purpose:** single source of truth for (a) which staging rig is reserved to which rail/soak so parallel sessions never collide on a rig or write to a soaking one, and (b) the next-free migration prefix so parallel PRs never re-collide on a number. Both were recurring failure modes (hollow-soak Jul-19; the `0327` three-way collision).

Verified this session via `gcloud run services describe`, `gcloud secrets versions access`, and `gh pr view` — not inferred.

---

## A. Rig-reservation ledger (live rigs, us-central1, project arkova1)

| Cloud Run service | Supabase ref | Worker rev | Rail / purpose | Soak status | Owner / disposition |
|---|---|---|---|---|---|
| `arkova-worker-staging` | `ujtlwnoqfhtitcmsnrpq` | 00294-tev | **Permanent shared staging** | n/a | Shared. NOT for credit-ledger soaks (at 0326 per `project_shared_staging_rig_lacks_0341`). |
| `arkova-worker-railb220260719-staging` | `vmulcebjpoawajnetntw` | 00002-cus | **railb2 — chain rail #1552** (0358 txid journal) | **ACTIVE T3, matures 2026-07-21T17:13Z** | 🔴 FROZEN — do not touch (frozen soak evidence). Parallel release-ops drives close-out + 0358 prod-apply-before-merge. |
| `arkova-worker-rcb20260719-staging` | `aqvlmkjfvpywdwjykcic` | 00002-vak | **deps rail (rcb)** — 6 dependabot PRs | Clock 2026-07-20T13:06:26Z → **matures 01:06–01:36Z Jul 21** | Parallel release-ops drives close-out ~02–04Z. RTE verifies. |
| `arkova-worker-rca20260719-staging` | `mhbtgihvjoazwxuypado` | 00004-pab | **wave3 rail (rca)** — #1568/1569/1571/1573/1549/1570 | Window COMPLETE + valid (rc-2026-07-20-wave3.json) | Wave3 merged. Rig scale-to-zero until 1570/1573 fully land; teardown after. |
| `arkova-worker-rcd20260719-staging` | `icworykrfztdhmhidtim` | 00002-wul | **AI rail (rcd)** — #1550/#1555 stacked | Window COMPLETE + valid (rc-2026-07-20-airail.json) | 1550 merged; 1555 retarget/merge in flight. Teardown after 1555 lands. |
| `arkova-worker-s33-rig-b1-staging` | `hyhfundpysaydvejweia` | 00003-rk9 | **PARKED fired-team B1 rig** (hollow 48h soak, invalid) | Invalid / no valid evidence | **TEARDOWN pending — SCRUM-2978.** Checklist delivered 2026-07-20; release-ops sweep Jul-21. |

**Contention rules (standing):**
- ONE rig = ONE concurrent soak. Never write to a rig whose rail is mid-soak (`feedback_no_live_soak_rig_as_validation_target`, `feedback_dont_touch_soaking_prs`).
- New soak work = a NEW isolated rig per `docs/reference/STAGING_RIG.md` + `project_isolated_soak_standup_procedure`, never reuse a reserved one.
- A rig name-pattern (`*rig*`, `*staging*`, `*20260719*`) matches MULTIPLE live services incl. the frozen railb2 — teardown sweeps must delete by **exact service name** (see SCRUM-2978 checklist).
- Supabase refs above are the isolation boundary that Cloud Run tag URLs do NOT provide (CLAUDE.md §1.11A) — a rig's evidence is only as clean as its Supabase project.

**Advisor-train reservation:** the advisor train (post-PI-0.5) reserves **new isolated rigs only** — it does not inherit any rig in this ledger. Stand up fresh per procedure; record here at standup.

---

## B. Migration-number registry (chain-rail `03XX` band)

Next-free rule (CLAUDE.md `feedback_migration_number_vs_reservations`): `next = max(main numeric head, agents.md reservations, open-PR migrations) + 1`. The uniqueness lint only checks main, so reservations here are load-bearing.

| Prefix | Status | Owner | File |
|---|---|---|---|
| ≤ `0354` | consumed / soak-locked band | various merged + pre-soak | (see `supabase/migrations/agents.md`) |
| `0355`, `0356` | RESERVED — security lane (#1457 Sprint-4 carry) | security lane | pre-soak, file-only |
| `0357` | RESERVED — pre-soak, file-only, NOT applied | Lane-1 #1455 (SCRUM-2486) | `0357_scrum2486_secured_chain_integrity_trigger.sql` |
| **`0358`** | **IN-FLIGHT — PR #1552 (railb2 soak)** | SCRUM-2692 | `0358_scrum2692_anchor_txid_journal.sql` — prod-apply BEFORE merge (release-ops), matures 17:13Z Jul 21 |
| `0359` | RESERVED — pre-soak, file-only | Lane-1 **PR #1615** (SCRUM-2917) | `0359_scrum2917_materialize_run_id.sql` |
| `0360` | RESERVED — pre-soak, file-only | Lane-1 **PR #1615** (SCRUM-2917) | `0360_scrum2917_secured_proof_predicate_hardening.sql` |
| `0361` | RESERVED — placeholder, not yet filed | SCRUM-2916 (watermark partial index) | not yet filed |
| `0362` | RESERVED — pre-soak, file-only | Lane-2 **PR #1618** (SCRUM-2913) | `0362_scrum2913_public_anchor_registry_url_allowlist.sql` |
| `0363` | RESERVED — pre-soak, file-only | Lane-2 **PR #1614** (SCRUM-2990 / G4) | `0363_g4_enable_org_credit_enforcement_flag.sql` (renumbered from `0360`, which collided with #1615) |
| `0364+` | RESERVED band → advisor train (post-PI-0.5) | advisor train | not yet filed — claim by adding a row in `supabase/migrations/agents.md` in the same PR |

**CORRECTION (2026-07-21, RTE — SCRUM-2979/#1612 follow-up).** Section B originally reserved `0359+` wholesale to the advisor train. That was **superseded** by the CTO Technical Decision Queue ruling (Confluence 110198785): the materializer (#1615) took `0359`/`0360`, Lane-2 took `0362`/`0363`, and `0361` is the SCRUM-2916 watermark placeholder — so the advisor band starts at `0364`, not `0359`. The verified owners above match `supabase/migrations/agents.md` (the load-bearing canonical file) and the HANDOFF migration band.

> **✅ CANONICAL-RESERVATION GAP — RESOLVED.** The earlier MAJOR gap (nothing reserved `0359+` in the canonical file, so a parallel session would legitimately compute `next=0359` and re-collide) is **closed**: the `## PI-0.5 24h-slice migration reservations (SCRUM-2979)` table in `supabase/migrations/agents.md` now carries explicit rows for `0358`–`0363` + the `0364+` advisor band, which is exactly what the uniqueness lint + `feedback_migration_number_vs_reservations` check. This dated memo is now a *mirror* of that canonical table, not a substitute for it.

**Open-PR migration scan (dry-run uniqueness, re-run 2026-07-21 via `gh pr view --json files` across ALL open PRs):**

| Prefix | Open PR(s) carrying the `.sql` | Collision? |
|---|---|---|
| `0358` | #1552 (`0358_scrum2692_anchor_txid_journal.sql`) | unique |
| `0359` | #1615 (`0359_scrum2917_materialize_run_id.sql`) | unique |
| `0360` | #1615 (`0360_scrum2917_secured_proof_predicate_hardening.sql`) | unique |
| `0362` | #1618 (`0362_scrum2913_public_anchor_registry_url_allowlist.sql`) | unique |
| `0363` | #1614 (`0363_g4_enable_org_credit_enforcement_flag.sql`) | unique |

`0361` is reserved (SCRUM-2916) but no open PR carries the file yet. Main numeric head = `0357`. **Result: NO collisions** — every open-PR migration prefix is unique and each is ≥ the main head. Next-free non-advisor prefix = `0361` (the reserved SCRUM-2916 slot) once filed, else `0365` after the `0364` advisor band.

**Reconciliation note:** after `0358` is prod-applied via MCP, apply the §0-rule-10 numeric-ledger reconcile (`UPDATE supabase_migrations.schema_migrations SET version='0358' WHERE name='0358_scrum2692_anchor_txid_journal.sql' AND version !~ '^[0-9]{4}$';`) and confirm `list_migrations` shows the numeric head before declaring done. Owned by release-ops (RTE-delegated per `feedback_rte_owns_prod_migration_apply`), not this watch lane.

---

_Maintenance: update section A at every rig standup/teardown and section B in the same PR that claims a prefix. This doc is the batched W2 carve-out; queue-state-checked before push._
