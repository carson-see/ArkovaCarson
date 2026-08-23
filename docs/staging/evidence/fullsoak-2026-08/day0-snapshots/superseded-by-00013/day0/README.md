# Day-0 snapshots — fullsoak-2026-08

Captured **2026-08-12T13:53:30Z** by `270018525501-compute@developer.gserviceaccount.com` with
`scripts/staging/fullsoak-daily-check.sh --day0`.

These files are the **immutable** comparison basis for every daily
rig/prod parity check (premortem BL-1 criterion 4, rollback trigger R13).
Re-capturing them invalidates every comparison already made against them;
the script refuses to overwrite without `--force`.

| File | What it pins |
|---|---|
| `rig-env-dump.txt` | Rig Cloud Run env var names + non-secret values; secret-backed vars appear as `-> SECRET_REF: <name>` only. Also pins CPU/memory limits and min/max scale. |
| `switchboard-flags-material.txt` | `flag_key\|enabled` for every row, sorted. The behaviour-bearing projection. |
| `switchboard-flags-full.tsv` | Same plus `updated_at`, for forensics when the material hash moves. |
| `scheduler-census.txt` | `name\|schedule\|state\|timeZone` for every Cloud Scheduler job in `us-central1` (rig **and** prod). |
| `monitoring-census.txt` | The SOAK alert policies and uptime checks, with enabled state. |
| `uptime-baseline.json` | Rig `/health.uptime` at Day 0 — the floor for the monotonic restart detector. |
| `build-baseline.txt` | git_sha / revision / image digest on both sides, plus the two freeze switches. |
| `hashes.txt` | sha256 of each of the above, so a daily run can assert in one comparison. |

**No secret values are present in any file here.** Secret-backed environment
variables are recorded by secret *name* only.
