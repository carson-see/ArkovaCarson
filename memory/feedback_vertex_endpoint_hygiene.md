---
name: vertex-endpoint-hygiene
description: Audit `gcloud ai endpoints list` BEFORE and AFTER every tuning / eval / deploy run. Target 1–2 deployed in steady state. Never keep a cold-spare endpoint deployed — model artifacts preserve the redeploy path at no cost.
type: feedback
---

A deployed Vertex endpoint bills whether or not anything calls it. The model artifact does not. So an endpoint kept "just in case" is pure burn with a free alternative sitting right next to it: redeploy from the preserved artifact when you actually need it.

**Rule (CLAUDE.md §0 rule 7):** audit before and after every tuning, eval, or deploy run. Steady state is **1–2 endpoints deployed**. Zero cold spares.

**Why:** The sprawl is real and repeated. A 2026-06-05 sweep found **five duplicate `arkova-gemini-fraud-v1` endpoints**; a later §7 sweep found **six empty Vertex endpoints plus ~10 staging rigs**. On the Cloud Run side, four soak rigs were discovered pinned at `min-instances=1` — always-on billing for soaks that had already matured. Every one of these was created by a run that never audited afterwards. The healthy state is achievable: `docs/sprint-0/S0-E6-infra-hygiene-report.md` and multiple HANDOFF entries record `gcloud ai endpoints list` = 0 or 1, verified.

**How to apply:**
- Run `gcloud ai endpoints list` before the run (know your baseline) and after (know what you left behind). Undeploy anything you created that is not serving.
- **Enumerate every region you have ever tuned in**, not just `us-central1`. Recent verified sweeps cover `us-central1`, `us-east4`, and `europe-west4`.
- Undeploying is not deleting the model. Keep the artifact; redeploy costs nothing but time.
- **Standing infra-cost sweep at release close / end of sprint (CLAUDE.md §7)** — beyond the per-run audit, sweep BOTH `gcloud ai endpoints list` AND the Supabase project inventory (MCP `list_projects`). Tear down done/empty isolated soak rigs and their paired `*-staging` Cloud Run services. Also check Cloud Run `min-instances` on any surviving rig.
- **Paid Supabase projects cannot be paused via MCP `pause_project`** — it requires a free-tier downgrade first. So either delete the rig, or flag it for Carson to pause/downgrade from the dashboard. An orphaned paid project runs ~$10/mo indefinitely (`xrefmwydaatppieoxfxn`, PR #1055's exact-head rig, was the documented case).
- Never tear down a rig that HANDOFF.md lists as an **active soak**. Confirm against HANDOFF before deleting anything; a mid-soak teardown destroys frozen evidence.

**Enforcement:** Documentation only. There is no CI check for cloud inventory — the gate is the before/after audit habit and the end-of-sprint sweep, both recorded with their gcloud/MCP output in HANDOFF.md.

**Override label:** none.
