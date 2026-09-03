## Staging Soak Evidence

**Tier:** T3

- **PR head SHA:** `4a056d00714a2a7f980ec4953dd3ed5e9ebf324f`
- **Base SHA:** `4dbfe0b4dcf2d4b986927009e937d44d92d34422` (main)
- **Staging project ref:** `kyaecvotcbalsfahwslt` (isolated, us-east-2) — preflight: `clean_mirror`, all checks passed.
- **Cloud Run service / tag URL:** `arkova-worker-docusign-guard-staging` / https://arkova-worker-docusign-guard-staging-270018525501.us-central1.run.app
- **Worker revision / image digest:** `…-00003-hwq` / deployed `sha256:4aa5e8cd…` (OCI image INDEX, what the bfd0aaf5b tag resolves to), running `sha256:1e24dd02…` (its linux/amd64 child, what `gcloud run revisions describe` reports). Same image; both recorded so the two commands reconcile.
- **Deploy log id:** revision created 2026-09-02T13:48:25.795362Z, label arkova-source-head=bfd0aaf5b32ad24db9717f8da1dbcb5ba2dee006
- **Soak start -> end:** 2026-09-02T13:49:03Z -> 2026-09-04T13:49:03Z (clock = Cloud Run worker uptime; --min-instances=1; 0 uptime resets across two deliberate driver restarts)
- **Behavior exercised:** 0423's trigger. Every cycle probes all four branches in ONE psql session; the cycle FAILS unless the result is exactly 1111 (A untrusted+DocuSign -> all 8 keys stripped, benign kept; B untrusted non-DocuSign -> account_id/envelope_id PRESERVED; C service_role -> preserved; D untrusted UPDATE hijack -> reverted). Plus two-tenant anchor lifecycle and the webhook HMAC surface (202 / 401 / replay 200).
- **Health/smoke:** healthy, database ok, anchoring ok, git_sha matches deployed source head.
- **E2E / CI:** TLA+ PASSED 4/4 (real TLC). `Tests` red is main's pre-existing health-detail-auth failure (#2584/#2587), not this PR.
- **Trigger A (size, claimed >= BATCH_SIZE=10000):** PENDING
- **Trigger B (age, pending >= 3000 AND oldest >= 3h):** PENDING
- **Daily flush observation:** forced flush processed a batch every cycle for 209 cycles, each with a real batchId + merkleRoot + txId.
- **Per-org isolation check:** orgs_with_docusign = 2 every cycle; both tenants driven.
- **Rollback plan:** DROP TRIGGER trg_strip_unattested_docusign_metadata_keys; DROP FUNCTION enforce_docusign_metadata_key_authority(); NOTIFY pgrst. **Rehearsal:** PENDING (after window close; doing it mid-soak drops the trigger under test)
- **Risk rationale:** T3 forced by the migrations path detector, and correct on merit — this is the guard that stops a forged DocuSign trust signal rendering.
- **Base drift impact:** T0/CI-only. Main moved 209 commits / 433 files since base `4dbfe0b4`, and exactly ONE intersects this PR: `supabase/migrations/agents.md` — the shared doc note every migration PR appends to, whose collisions CLAUDE.md designates union-resolve, doc-only, NO re-soak. No intervening commit touches the migration, its tests, or the driver. Attests no runtime/schema/migration/staging/soak/deploy impact. **Approver:** PENDING (Carson)
- **Approver:** PENDING (Carson; the gate rejects agent self-attestation)

### Notes for the sealer

TRIGGER A/B WERE NOT EXERCISED BY THE FIRST 209 CYCLES — a real gap, now being closed.
The driver made 2 anchors per 5-min cycle and force-flushed every cycle, so the queue never
exceeded 2, while Trigger A needs claimed >= 10000 and Trigger B needs pending >= 3000 AND
oldest >= 3h. Neither was reachable by construction; triggerA.processed was 0 for all 209.
The cycle JSON field named "triggerB" is /jobs/check-confirmations — a DIFFERENT thing from
triggerB_shouldFireOnAge. Do not read it as trigger evidence.

Closed with real load, not a shortcut. BATCH_ANCHOR_MAX_SIZE=100 would make Trigger A trivial
but needs an env change -> redeploy -> resets the worker uptime that IS the soak clock. Instead:
a reversible hold-flush sentinel pauses the forced flush; 4,002 PENDING anchors seeded as
service_role across both orgs (above B's floor, below A's ceiling); they age genuinely and the
driver's existing NON-forced /jobs/batch-anchors call fires Trigger B on its own at 3h. Trigger A
follows by topping past 10,000. Nothing backdated, nothing forced.

HEAD-VS-IMAGE: PR head 4a056d00 vs image built from bfd0aaf5b. The delta is two commits touching
only the load-test script and a test file — neither runtime, migration, nor prod-executed code.
Rebuilding would have reset the clock; recorded deliberately in the commit messages.

GATE STATE READ, NOT ASSUMED: SOAK_GATE_DISABLED=false — the CI half is live.
