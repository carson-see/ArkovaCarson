#!/usr/bin/env bash
# Seals the consolidated-mm-2026-08 window: rolls up every in-window cycle
# artifact into one window summary. Filters to cycles <= END_ISO so post-close
# cycles can never fold into the sealed window.
set -uo pipefail
D="$HOME/arkova-soak/consolidated-mm-2026-08"
. "$D/env.cmm"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
python3 - "$OUTDIR" "$CLOCK_START" "$END_ISO" "$HEAD_SHA" "$REVISION" <<'PY'
import json, sys, os, glob, re
outdir, start, end, head, rev = sys.argv[1:6]
endkey = re.sub(r'[-:TZ]', '', end)
cycles = []
for f in sorted(glob.glob(os.path.join(outdir, "load-*.json"))):
    stamp = os.path.basename(f)[5:-5].replace("T", "").replace("Z", "")
    if stamp > endkey:
        continue
    try: cycles.append(json.load(open(f)))
    except Exception: pass
flushes = []
for f in sorted(glob.glob(os.path.join(outdir, "flush-*.json"))):
    try: flushes.append(json.load(open(f)))
    except Exception: pass
volumes = []
for f in sorted(glob.glob(os.path.join(outdir, "volume-*.json"))):
    try: volumes.append(json.load(open(f)))
    except Exception: pass
per = {}
for c in cycles:
    for p in c.get("probes", []):
        d = per.setdefault(p["name"], {"pass": 0, "fail": 0})
        d[p["status"]] = d.get(p["status"], 0) + 1
maxsec = max((c.get("chain_observation", {}).get("secured") or 0) for c in cycles) if cycles else 0
maxtx = max((c.get("chain_observation", {}).get("distinct_chain_txids_recent") or 0) for c in cycles) if cycles else 0
summary = {
    "soak": "consolidated-mm-2026-08",
    "rc": "RC-2026-08-22-deferred-basedrift-exit",
    "tier": "T3", "head_sha": head, "worker_revision": rev,
    "window": {"start": start, "end": end},
    "cycles_in_window": len(cycles),
    "cycles_failed": len([c for c in cycles if c.get("status") == "fail"]),
    "per_probe": per,
    "daily_flush_observations": flushes,
    "volume_phases": volumes,
    "max_secured_observed": maxsec,
    "max_distinct_txids_observed": maxtx,
}
out = os.path.join(outdir, "window-summary.json")
json.dump(summary, open(out, "w"), indent=1)
print("sealed:", out, "cycles:", len(cycles), "failed:", summary["cycles_failed"])
PY
