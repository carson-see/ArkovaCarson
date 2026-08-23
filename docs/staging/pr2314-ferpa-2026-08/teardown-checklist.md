# PR #2314 FERPA rig — teardown checklist (pre-staged 2026-08-23)

> **Order matters: nothing here runs until (a) close-capture.sh has sealed the
> clock, (b) rollback-rehearsal.sh has run and its record is written, (c) the
> evidence block is pasted into #2314 and the gate has read it, and (d) #2314 is
> MERGED.** A torn-down rig cannot re-answer questions, and #2314's prod apply
> (0415 to `vzwyaatejekddvltxyye`) happens AFTER merge — keep the rig until the
> prod apply is verified too, so a prod surprise can still be compared against
> the rig. Step 0 is the exception: it runs right after close-capture.

## Step 0 — stop the supervisor (right after close-capture, BEFORE the rehearsal)

The supervisor's end-epoch parse lacks `-u` (the recorded node22 guard bug), so it
will NOT stop at 2026-08-23T19:24:30Z — it would keep driving load until ~23:24Z
and its suppression probes would fail loudly the moment the rollback rehearsal's
Phase A runs. Stop it manually:

```
pkill -f arkova-soak/ferpa2314/supervisor.sh
pkill -f ferpa2314-load-loop.sh
pgrep -fl "ferpa2314" || echo "clean"
```

Post-close driver cycles (between 19:24:30Z and the kill) are already excluded
from the close capture's in-window roll-up; note the kill time in the maturity
record's supervisor row.

## Step 1 — commit the close-out artifacts

From the close dir (`~/arkova-soak/ferpa2314/close-*/`): `summary.md`, the
rollback rehearsal record, `driver-rollup.json`, and the evidence copies land in
`docs/staging/pr2314-ferpa-2026-08/` via the close-out branch (NOT direct to
main — the Mergify queue is busy; docs go on a `docs/*` branch PR). Fill
`maturity-TEMPLATE.md` -> `maturity-<closeUTC>.md`.

## Step 2 — after #2314 MERGES and 0415 is prod-applied+reconciled: delete the Supabase project

Paid project (USD 10/mo) — MCP `pause_project` cannot pause it; deletion is the
sweep-approved end state for a finished isolated rig (§7):

```
# Management API (needs SUPABASE_ACCESS_TOKEN in env — GSM secret supabase_access):
curl -sS -X DELETE -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects/wjuelohtpklodpjklvqy
```

If the token is not at hand, flag for Carson to delete `arkova-ferpa-2314-2026-08`
from the dashboard — do not leave it billing.

## Step 3 — delete the Cloud Run service

Removes `00001-cit` and the rehearsal's `rollback-main` revision together:

```
gcloud run services delete arkova-worker-ferpa2314-staging \
  --project arkova1 --region us-central1 --quiet
```

## Step 4 — delete the three GSM secrets

Names verified against `gcloud secrets list` on 2026-08-23 (exactly these three
match the ferpa-2314 pattern):

```
gcloud secrets delete ip-hash-pepper-ferpa-2314-2026-08-staging            --project arkova1 --quiet
gcloud secrets delete supabase-service-role-key-ferpa-2314-2026-08-staging --project arkova1 --quiet
gcloud secrets delete supabase-url-ferpa-2314-2026-08-staging              --project arkova1 --quiet
```

## Step 5 — release the rig reservation

`docs/staging/rig-reservations.json`: flip this rig's reservation to
`"status": "released"`, then validate:

```
npx tsx scripts/staging/check-rig-reservations.ts docs/staging/rig-reservations.json
```

## Step 6 — local driver hygiene

Archive `~/arkova-soak/ferpa2314/` contents into the close-out dir (close-capture
already copies `load-*.json` + `supervisor.log`). Delete the key material
(`anon.key`, `idtoken`) — the project they open no longer exists after step 2.

## Step 7 — HANDOFF

Remove this window's entry from HANDOFF.md `### Soaks` (docs carve-out applies
once the queue quiets; otherwise it rides the close-out docs PR).
