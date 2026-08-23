# HakiChain pilot demo runbook

**Status: critical path.** Kenyan counsel verification of HakiChain is complete (Sarah has the
consolidated doc). The two remaining holdups are HakiChain countersigning the pilot contract (LOI
already executed, DocuSign `5BE7302F`) and **scheduling this demo**. Everything below is written to
get a live demo scheduled and run without a surprise.

This is an internal engineering runbook (CLAUDE.md §0 rule 4) — not the system of record. If a
Confluence page exists for the HakiChain partnership, mirror the pre-flight + script sections there.

**Verified against prod 2026-08-20** (Supabase MCP `execute_sql`, read-only, project
`vzwyaatejekddvltxyye`; `gcloud scheduler jobs list`; live fetch of `app.arkova.ai`). Every fact
below is measured on that date unless marked otherwise — re-verify anything time-sensitive the
morning of the actual demo using the pre-flight checklist.

## KPI framing (read this before scripting anything else)

Per founder ruling, **KPI #2 and #3 are about the forward, real-time path** — when HakiChain anchors
a *new* document, it must go SUBMITTED → SECURED → independently verifiable, live, as designed. They
are **not** about the historical anchor count. The demo's center of gravity is therefore: submit
something new, watch it move, verify it independently — not a tour of the 4 anchors already on file.
Those 4 are supporting evidence (history, proof the pipe has worked before), not the point.

## Demo-blocking / high-priority findings (read first)

1. **The Kenya transfer-basis fix is live but fragile — re-verify it the morning of the demo.**
   `app.arkova.ai` currently serves bundle `copy-DEctzTrG.js`, which I fetched and grepped directly:
   zero occurrences of "Section 48," and the `KENYA_TRANSFER_BASIS` / `KENYA_BREACH_TIMELINE` keys
   are absent from the served JS. The fix is live. **But it was shipped as a manual Vercel
   branch-promote from `hotfix/kenya-transfer-basis-removal` (PR #2271), which is still OPEN/DRAFT
   and unmerged.** `origin/main`'s `src/lib/copy.ts` still contains the literal banned string
   (`KENYA_TRANSFER_BASIS: 'Standard Contractual Clauses (Section 48)'`) as of the latest main commit
   (`b6cfad73c`, 2026-08-19). Main has taken 10+ merges since the branch-promote deploy without
   regressing the live bundle, so whatever Vercel's deploy trigger is, it has not re-built from
   `main` since — but nothing prevents a future ordinary deploy (a manual "Redeploy" in the Vercel
   dashboard, a misconfigured CI step, anyone re-triggering from `main`) from silently reintroducing
   the bug. **Mitigation:** re-fetch and grep the live bundle the morning of the demo (command below)
   before you rely on it in front of the partner; better, get PR #2271 merged before the demo so the
   fix is durable instead of a pinned manual deploy.
2. **The "15 allocated" figure is stale — the DB shows 2,000, and either way it renders nowhere in
   HakiChain's own UI.** `org_credits` for HakiChain (`org_id f52cd07a-6d8a-4387-9346-23babec84e5c`)
   currently reads `is_test: true, anchor_quota: 2000, balance: 0`. This is the SCRUM-1740
   partner-sandbox free-quota cap (`services/worker/src/utils/anchorQuotaGate.ts`) — a single field
   that appears to have been raised at some point from an earlier 15 to 2,000 (matching the LOI's
   "up to 2,000 documents" pilot volume), not two different allocation mechanisms. Do not say "15
   allocated" to the partner; if a number comes up, the accurate one is "sandboxed at 2,000, 4 used."
   **The field is admin-only** — it is read exclusively by `src/pages/AdminOrganizationsPage.tsx`
   (a platform-admin surface behind `is_platform_admin`), rendered as a "4/2000 free" badge. It does
   not appear anywhere in HakiChain's own dashboard, billing page, or org profile. **If HakiChain
   asks "how much do we have left," there is no on-screen answer inside their own account — you have
   to say it verbally.** This isn't fatal but it is worth knowing before someone asks the question
   live.
3. **HakiChain's org has been idle since 2026-06-29** — zero anchors, zero queue runs since then
   (`organization_queue_run_state` and `organization_queue_runs` both have **zero rows** for this
   org — `claim_due_org_queue_runs` has never claimed it). Practically this is good news for a first
   live run: because the org has literally never been claimed, it is unconditionally "due," so the
   very next PENDING anchor from HakiChain should be picked up by `org-queue-scheduler` within one
   tick (prod cadence `*/15 * * * *`, confirmed live via `gcloud scheduler jobs list`). **But this
   also means a rehearsal consumes that due window** — see Finding 4.
4. **Do not rehearse the live submission the same day without also rehearsing the fallback.**
   `org-queue-scheduler` only re-offers an org 24 hours after its last run. If you do a full
   pre-flight rehearsal (recommended below) and it succeeds, HakiChain's org now has a fresh
   `last_run_at` and will not be "due" again for 24 hours — so the real demo submission later that
   day will **not** be picked up by the scheduler and will sit PENDING until you intervene. The
   intervention is a single authenticated `curl` (exact command in the fallback section) that bypasses
   the 24-hour timer entirely and force-flushes just HakiChain's org. Know this command before you
   walk into the room; don't discover it live.
5. **Realistic time-to-SECURED is roughly 60–100 minutes, not demo-meeting-length.** Bitcoin mainnet
   requires 6 confirmations before SUBMITTED → SECURED
   (`services/worker/src/jobs/check-confirmations.ts:494`, hardcoded for `bitcoinNetwork === 'mainnet'`),
   averaging ~60 minutes of block time, and `check-confirmations` itself only polls every 30 minutes
   in prod — so worst case add another ~30 minutes on top. **Do not promise the room a live
   PENDING→SUBMITTED→SECURED transition inside a 30–45 minute meeting.** Structure the script (below)
   around a document submitted *before* the meeting so it reaches SECURED during the call, plus a
   second, live submission whose SUBMITTED (broadcast) step you show in real time and whose SECURED
   promotion you follow up on afterward.
6. **FD-CRON-1 is a real, live prod finding, not just a rig artifact — but it does not appear to have
   broken the actual Cloud-Scheduler-triggered flush.** Prod's own logs show 30+
   `[NODE-CRON] missed execution` warnings in the trailing 7 days (confirmed by the soak close-out,
   2026-08-19) — event-loop contention in the worker's *in-process* node-cron scheduler, which
   `services/worker/src/config.ts` (`disableInProcessAnchorCron: boolFlag(false)`) confirms is NOT
   disabled in prod, so it runs redundantly alongside the real Cloud-Scheduler HTTP triggers. The
   prod daily 3am UTC flush I found live via `gcloud scheduler jobs list` is genuinely
   Cloud-Scheduler-driven (`0 3 * * * ENABLED → /jobs/batch-anchors?force=true`), which is a different
   and more resilient path than the in-process cron the rig's FD-CRON-1 miss was about — Cloud
   Scheduler retries on non-2xx; a stalled in-process tick does not silently swallow that HTTP call.
   Whether prod's *own* 3am flush has ever actually missed end-to-end is explicitly **NOT yet
   verified** (named a post-freeze action in the soak close-out docs) — treat the daily flush as
   "probably fine, unconfirmed," and don't rely on it for the demo regardless (see Finding 5 — you
   won't be running the demo at 3am UTC).
7. **HakiChain's ORG_ADMIN login (`hakichain@gmail.com`) has not signed in since account creation**
   (`auth.users.last_sign_in_at = 2026-06-01`, the same day the account was provisioned). All 4
   existing anchors were created via API (`filename` values are `api-*`), never through the UI. If
   the demo plan is "have HakiChain log in and click Upload," this will be the **first time that
   login has ever been used for anything but initial setup** — worth a dry run of the actual login
   flow (password reset if needed) before the meeting, not assumed to just work.
8. **No anchor_proofs row exists for any of the 4 legacy anchors** (0 of 4 — matches the known
   repo-wide proof-materialization gap, not a HakiChain-specific defect). The public verify API
   correctly and honestly reports this (`"proof_availability":"root_only"` with a full
   measured/asserted/not-asserted note), and the frontend renders a clean "Secured & Anchored" empty
   state for it (`PROOF_AVAILABILITY_LABELS.NOT_YET_AVAILABLE_*` in `src/lib/copy.ts`) — **not** a
   broken button or an error. This is fine to show as-is; just don't imply a downloadable
   Merkle-inclusion proof file exists for the 4 historical anchors. A **freshly submitted** anchor
   today *will* get a materialized proof row (the current batch path persists proof rows
   pre-broadcast, per `services/worker/src/jobs/batch-anchor.ts`'s `persistBroadcastIntentProofs`),
   so the live-submitted document is actually the stronger proof-package example — use it for that
   part of the script, not the legacy 4.

None of the above blocks the demo from happening. All are pre-flight items or script-shape decisions.

## Pre-flight checklist (morning of the demo)

Run all of these before the meeting, in order. Budget ~30 minutes.

1. **Re-verify the Kenya fix is still live:**
   ```
   curl -s https://app.arkova.ai/ | grep -oE '/assets/copy-[A-Za-z0-9_-]+\.js'
   curl -s https://app.arkova.ai/assets/copy-<hash>.js | grep -c "Section 48"
   ```
   Expect `0`. If it's not zero, STOP — do not run the demo until this is fixed and re-verified; see
   Finding 1's mitigation. Also glance at PR #2271's state (`gh pr view 2271 --json state,isDraft`) —
   if it has merged since this doc was written, the fix is durable and this check is now redundant
   with a normal deploy, but still worth the 10 seconds.
2. **Confirm prod worker health:**
   ```
   curl -s https://arkova-worker-270018525501.us-central1.run.app/health
   ```
   Expect `status: healthy`, `network: mainnet`, `database/anchoring/kms: ok`.
3. **Confirm the critical flags are on** (Supabase MCP `execute_sql`, read-only, against
   `vzwyaatejekddvltxyye`):
   ```sql
   select flag_key, enabled from switchboard_flags
   where flag_key in ('ENABLE_BATCH_ANCHORING','ENABLE_VERIFICATION_API','ENABLE_PROD_NETWORK_ANCHORING');
   ```
   All three must read `enabled: true` (they did on 2026-08-20).
4. **Check whether HakiChain's org is currently "due" for org-queue-scheduler:**
   ```sql
   select * from organization_queue_run_state where org_id = 'f52cd07a-6d8a-4387-9346-23babec84e5c';
   ```
   Empty or `last_run_at` more than 24h old → due, the live submission should pick up within ~15
   minutes on its own. A recent `last_run_at` (e.g. from an earlier same-day rehearsal) → not due;
   plan to use the forced-flush fallback for the live portion.
5. **Rehearse the login and upload path with the actual HakiChain credentials once**, end-to-end,
   before the room fills up (Finding 7 — this login has never been exercised). If it fails, you want
   40 minutes to fix it, not zero.
6. **Pick and stage the demo document now, not live.** Use a text-layer PDF or DOCX, not a scanned
   image — scanned PDFs hit the client-side OCR "no text found" soft-fail path (known top Kenya-corpus
   gap). Avoid anything that could plausibly read as fraudulent/altered — the Gemini extraction
   `fraudSignals` field can surface a "Fraud signal detected" banner independent of any feature flag
   (BUG-009). A clean, real Kenya legal document (a ruling, a filing, a certificate) with actual text
   content is the safe choice.
7. **Have the forced-flush command ready and pre-tested against a throwaway/no-op case** (or at least
   confirm you have the `X-Cron-Secret` value from Secret Manager, or platform-admin session,
   available) — see the Fallbacks section. Confirm who is in the room with the authority/access to
   run it if the live path stalls.
8. **Open a second browser/device now** (not during the meeting) logged out, ready to hit the public
   verify URL cold, so the "independent verifier" step doesn't cost fumbling time.

## Demo script

**Framing for the room:** this shows the forward pipeline HakiChain will actually use going forward —
submit a document, it clears to the Bitcoin network unattended, and anyone (including someone with no
Arkova account) can verify it independently. The 4 existing anchors are the paper trail proving this
already works; the live submission proves it works right now, for them, today.

1. **Login.** `hakichain@gmail.com` at the standard login page. (Pre-flight step 5 should already have
   confirmed this works — if it didn't, do not attempt this live for the first time.)
2. **Show an existing secured record.** Open one of the 4 existing anchors' public verify page —
   `https://app.arkova.ai/verify/ARK-2026-D2959176` is a good pick (credential type LEGAL,
   description "Ruling Kibera," 6/6 confirmations, `bitcoin_block 952022`). Walk through: Fingerprint,
   Network Record, the explorer link, the "Secured & Anchored" proof section. This establishes the
   pattern before showing it happen live.
3. **Submit the staged document.** Either the UI upload flow (Documents → Secure a Document) or, if
   you want to mirror HakiChain's actual production usage exactly (all 4 of their anchors to date were
   API-submitted, never UI), a `curl` against `/api/v1/anchor` using one of their two existing API
   keys (`ak_live_03a5…` / `ak_live_915f…` — both currently unused, `last_used_at: null`, so test one
   in pre-flight, not live). Either is faithful to the product; the UI path is more visual for a live
   room.
4. **Watch it move to PENDING**, then either wait for the org-queue-scheduler tick (if pre-flight
   step 4 showed the org is due — worst case ~15 minutes, awkward to sit through live) or trigger the
   forced flush immediately after submission so the room sees SUBMITTED within a minute or two. Either
   way, once it's SUBMITTED, show the `chain_tx_id` / mempool.space link — the document is now
   genuinely broadcasting to the Bitcoin network in front of them.
5. **Set expectations on SECURED, honestly.** State plainly: 6 confirmations (Bitcoin's own security
   model, not an Arkova limitation) typically takes about an hour, plus up to 30 minutes for the next
   confirmation-check pass, so SECURED will land roughly 60–100 minutes after this call, automatically,
   with no further action from either side. If you staged a document ~90 minutes before the meeting
   (recommended), reveal at this point that *that* one already reached SECURED during the pre-flight
   window — walk to its public verify page live, showing a document that went SUBMITTED → SECURED
   entirely unattended, on the timeline you just described.
6. **Independent verification on a second device.** On the second browser/device (pre-flight step 8),
   navigate cold — no login — to the public verify URL for the pre-staged now-SECURED document. This
   is the KPI-3 proof point: anyone, including a party with zero Arkova relationship, can verify
   independently. Optionally also show `/verify/independent` (the "verify without Arkova's API" guide
   page) to reinforce vendor independence.
7. **Show the proof package** on the pre-staged (now SECURED) document specifically — it will have a
   materialized `anchor_proofs` row and a real downloadable proof file, unlike the 4 legacy anchors.
   This is the strongest visual close.
8. **Follow up in writing** after the call with the live-submitted document's verify link once it
   reaches SECURED, so HakiChain has independent confirmation the exact document from the live portion
   of the call cleared on the timeline promised.

## Fallbacks if a step hangs

- **Login fails:** password reset via Supabase Auth (standard flow); do not attempt to hand-provision
  a new session live. Fall back to a pre-authenticated session/second window prepared in pre-flight.
- **Upload/submit hangs or errors:** fall back to the API path with one of the two existing API keys
  (tested in pre-flight), narrated as "this is exactly how HakiChain's own systems will call this."
- **PENDING doesn't move to SUBMITTED within a minute or two of submission (the org-queue-scheduler
  tick hasn't landed, or the org isn't due):** force-flush just HakiChain's org directly — this is
  the single most important fallback command in this document:
  ```
  curl -X POST \
    -H "X-Cron-Secret: <value from Secret Manager: CRON_SECRET>" \
    "https://arkova-worker-270018525501.us-central1.run.app/jobs/batch-anchors?force=true&org_id=f52cd07a-6d8a-4387-9346-23babec84e5c"
  ```
  This calls `processBatchAnchors({ force: true, orgId })` directly
  (`services/worker/src/routes/cron.ts:278`) — it bypasses Trigger A/B/D economics entirely AND
  bypasses `org-queue-scheduler`'s 24-hour per-org due timer, so it works regardless of when the org
  was last claimed. Authentication is `X-Cron-Secret` (Secret Manager), a platform-admin Supabase
  Bearer token, or Google OIDC — **any engineer with prod Secret Manager access or platform-admin
  can run this**; it does not require Carson specifically. Response is JSON (`processed`, `batchId`,
  `txId`) — a nonzero `processed` count confirms it worked.
- **SECURED doesn't land during the call:** this is expected (Finding 5) — do not wait for it live.
  Use the pre-staged document (already SECURED) to show the end state, and follow up afterward with
  the live document's link once it clears.
- **Public verify page 404s or errors on the second device:** almost certainly a typo in the
  `public_id` — re-copy it from the first screen rather than retyping. If it's a genuine platform
  error, fall back to one of the 4 known-good legacy anchors
  (`ARK-2026-D2959176`, `ARK-2026-547B119A`, `ARK-2026-1F070188`, `ARK-2026-8F862179` — all confirmed
  `verified:true` live on 2026-08-20).
- **Anything looks wrong on `/privacy` or another page you didn't plan to visit:** don't improvise —
  navigate back to the planned script. See "what not to show" below.

## What NOT to show

- **`/privacy`, unless you re-verified it that same morning.** The public verify page's own footer
  links to it (`src/components/public/PublicVerifyPage.tsx:106`), so it is one accidental click away
  during the independent-verification step. Given Finding 1 (the fix is a manual pin, not a merged
  durability guarantee), don't navigate there in front of the partner unless pre-flight step 1 passed
  *that morning*.
- **Nessie / "compliance intelligence" surfaces.** OFF by standing founder directive — do not enable,
  demo, or reference them, even if a stale internal doc mentions the feature.
- **The AdminOrganizationsPage quota badge or any other platform-admin surface.** It's not something
  HakiChain has access to or should see; it's also where the "4/2000 free" language lives, which reads
  strangely out of context to a partner (Finding 2).
- **Any of the 4 legacy anchors' "Proof Download" as if it were a live capability being newly built.**
  It correctly shows the honest "Secured & Anchored, no downloadable file for this record" empty
  state (Finding 8) — that's fine to show, but frame it as "these four predate the proof-file feature,"
  not as evidence something is missing today. Use the pre-staged fresh anchor for the actual proof-file
  demonstration.
- **A live wait for SECURED inside the meeting.** Don't promise it, don't sit in silence for it — see
  Finding 5 and the demo script's structure.
- **A specific allocation number ("15") unprompted.** If it comes up, the accurate live number is
  "sandboxed testing allotment, 2,000, 4 used" (Finding 2) — and note there's no in-product screen
  that shows it to them, so don't imply there is one.

## Claims discipline (§1.5 — measured vs. asserted vs. NOT asserted)

State explicitly, if it comes up:

- **Measured, can show on screen:** the document's SHA-256 fingerprint; the Bitcoin block height and
  transaction id the anchor is committed in; the confirmation count; that the public verify page
  independently recomputes/displays this without requiring an Arkova login.
- **Asserted, not independently provable by Arkova:** that the uploaded document is what it claims to
  be, or that its content is accurate — Arkova anchors a fingerprint of what was uploaded, not the
  truth of its contents. The `compliance_controls` list returned by the verify API already carries
  this exact disclaimer verbatim — don't say anything stronger than what that field's own note says.
- **Do NOT claim, under any framing:**
  - Credential Engine registry listing. CE approved Arkova *to publish* — that is not the same as
    being listed, and the CE trial expires ~2026-09-09 (R-1 FATAL, unrelated to this demo but do not
    let "registry" language slip in the same conversation).
  - Legal admissibility of an anchored document in Kenyan or any other court. No admissibility opinion
    exists; do not promise one.
  - That HakiChain's org is "Verified" in Arkova's KYB sense — it shows `verification_status:
    UNVERIFIED` (self-serve grade, no completed KYB; `domain_verified: false`), which is fine and
    expected for a pilot, but don't describe the org as verified if asked directly.
  - Anything about the Kenya `/privacy` transfer-basis language beyond "corrected, pending final
    counsel wording" — the LOI/pilot legal review is Sarah's, not an engineering claim to make.
  - A specific SLA for time-to-SECURED. State the mechanism (6 confirmations, ~60–100 minutes typical)
    as how the system behaves today, not as a contracted guarantee.

## Reference: prod facts this runbook relies on (2026-08-20)

- HakiChain org: `f52cd07a-6d8a-4387-9346-23babec84e5c`, slug/public_id `ky6c3yhs9qwc`, `suspended:
  false`, `verification_status: UNVERIFIED`, `domain_verified: false`, `tier: FREE`.
- ORG_ADMIN: profile `23f09d51-f4ea-4b89-9dc3-d5e90eea8d7f`, `hakichain@gmail.com`, `status: ACTIVE`,
  `role: ORG_ADMIN`, created 2026-06-01, never signed in again since.
- 4 SECURED anchors, all `credential_type: LEGAL`, created 2026-06-01 through 2026-06-29:
  `ARK-2026-D2959176`, `ARK-2026-547B119A`, `ARK-2026-1F070188`, `ARK-2026-8F862179`. All verified
  live via `/api/v1/verify/<public_id>` on 2026-08-20; all have real `verification_events` history
  (HakiChain checked their own links repeatedly in June/July).
- `org_credits`: `is_test: true, anchor_quota: 2000, balance: 0` (SCRUM-1740 sandbox cap, not a
  billing balance; admin-only visibility).
- Two API keys on file (`Testing Dev`, `Testing Dev #3`), both `last_used_at: null`.
- Prod worker `/health` on 2026-08-20: `git_sha b6cfad73c73fbaf45bea08e3b155d61501a49daa`, healthy,
  mainnet, db/anchoring/kms ok.
- Prod Cloud Scheduler (`gcloud scheduler jobs list --location=us-central1 --project=arkova1`),
  jobs targeting the real prod worker (not either soak rig): `batch-anchors */30`,
  `check-confirmations */30`, `recover-broadcasts */15`, `org-queue-scheduler */15`,
  `batch-anchors?force=true` daily `0 3 * * *`.
- Switchboard flags on: `ENABLE_BATCH_ANCHORING`, `ENABLE_VERIFICATION_API`,
  `ENABLE_PROD_NETWORK_ANCHORING`.

_Last refreshed: 2026-08-20 by Claude Opus 5 — claims verified against Supabase MCP `execute_sql`
(read-only, `vzwyaatejekddvltxyye`), `gcloud scheduler jobs list` / `gcloud run services describe`,
direct `curl` fetches of `app.arkova.ai` and the prod worker's `/health` and `/api/v1/verify`
endpoints, and `gh pr view 2271`. Neither soak rig
(`arkova-worker-fullsoak-2026-08-staging`, `arkova-worker-staging`) was touched or read for this
runbook — all verification here is against the production project/service._
