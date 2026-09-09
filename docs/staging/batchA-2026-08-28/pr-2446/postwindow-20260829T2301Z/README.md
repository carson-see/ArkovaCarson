# PR #2446 — POST-WINDOW verification (NOT an at-close capture)

The 2026-08-29T14:25:51Z -> 16:27:57Z window for PR #2446 was never sealed.
`close-capture.sh` created its close directory with an unchecked `mkdir -p`;
that mkdir returned EPERM ("Operation not permitted") because the detached
supervisor had lost its macOS TCC removable-volume grant for /Volumes/Extreme,
every subsequent redirect failed with ENOENT, and the script still printed
`sealed -> .../pr-2446/close-20260829T162757Z` for a directory that was never
created. That path does not exist. Neither does any other close directory for
this window.

Everything in THIS directory was captured on 2026-08-29 at ~23:01-23:04Z,
hours after the window closed. It is labelled post-window and must not be
cited as at-close evidence.

- `preflight-postwindow.json` — staging-honesty preflight against
  fizyjojbebyalirtjjht, timestamp 2026-08-29T23:01:28.003Z,
  environment_type=clean_mirror, 8/8 checks passed. This is NOT an at-close
  preflight. Together with the pre-clock preflight
  (../../preflight-2026-08-29T1405Z.json, 2026-08-29T14:05:57.160Z,
  clean_mirror, 8/8) it evidences that the rig stayed clean across the whole
  interval, which is a statement about the interval and not about the instant
  of close.
- `5xx-by-path-window.txt` — 5xx responses on revision
  arkova-worker-staging-batcha-2446, timestamp-filtered to
  2026-08-29T14:25:49Z..16:28:09Z. Window-accurate despite being captured
  after the window, because the query is explicitly time-bounded. Every 5xx is
  the driver's own asserted /api/v1/identity/session 500 (Stripe Identity is
  not provisioned on this rig); zero 5xx on any other path.

Surviving per-cycle artifacts: only cycles 1 and 2
(../load-20260829T143601Z.json, ../load-20260829T144609Z.json). Cycles 3-12
lost their artifacts to the same EPERM. Their pass/fail verdict survives in
~/arkova-soak/batchA-2026-08-28/supervisor-2446.log as `cycle N rc=0`; the
driver exits non-zero whenever FAIL > 0, so rc=0 is a real attestation. The
per-status-code counts for those ten cycles are gone and are not
reconstructed or estimated anywhere.
