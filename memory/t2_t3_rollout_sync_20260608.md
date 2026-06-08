# T2/T3 Rollout Sync Memory - 2026-06-08

Do not treat open T3 PR bodies that say PENDING as active soaks. On 2026-06-08 the only active soak was #1121.

Operational rules for this lane:

- Six T2s (#1098, #1104, #1108, #1110, #1119, #1123) are merged and prod-contained at `bf40e389fd1644aea94557366e367b7b66df7616`.
- #1121 must finish its 12h T2 soak, pass final evidence, merge, and prove prod-active before any #1055 T3 clock starts.
- There is no `prod` branch/ref; prod-active proof is Deploy Worker + Revision Drift Alert + `/health.git_sha` + targeted prod smoke.
- #1055 is guarded by `PR1055_T2_LANE_PROD_VERIFIED=1` and `PR1055_T2_LANE_PROD_PROOF`; do not override this guard before #1121 proof exists.
- #1055 exact-head prep passed locally on 2026-06-08T14:28:50Z (`verify-local`: typecheck + 6 focused worker test files / 258 tests), but this is prep only, not soak evidence.
- T3 migration chains cannot all be honestly soaked on stale bases. Refresh/restack after #1121, then start exact-head 48h windows as close together as dependency order and clean staging isolation allow.
- Actual T3 migration order from live PR files as of 2026-06-08T15:39Z: #1047 `0327`, #971 `0328`, #1038 `0329`, #1101 `0333`, #1100 `0334`, #1111 `0335`, #1112 `0336`, #1114 `0337`, #1107 `0338`, #1122 `0339`. No open PR owns `0332`; stale ledger/reservation text must be cleaned before that lane is merge-grade.
- Never count old #1055 12h mixed artifacts as current 48h T3 evidence.

Latest durable checkpoint: 2026-06-08T15:40:45Z read-only #1121 audit had 1,738 rows, zero bad rows/anomalies, live screen/process, summary absent, and finalization disallowed until the 2026-06-08T17:17:41.305Z clock plus final gates.

Detailed status: `docs/staging/t2-t3-rollout-status-20260608.md`.
