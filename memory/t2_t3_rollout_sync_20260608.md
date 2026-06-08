# T2/T3 Rollout Sync Memory - 2026-06-08

Do not treat open T3 PR bodies that say PENDING as active soaks. On 2026-06-08 the only active soak was #1121.

Operational rules for this lane:

- Six T2s (#1098, #1104, #1108, #1110, #1119, #1123) are merged and prod-contained at `bf40e389fd1644aea94557366e367b7b66df7616`.
- #1121 must finish its 12h T2 soak, pass final evidence, merge, and prove prod-active before any #1055 T3 clock starts.
- There is no `prod` branch/ref; prod-active proof is Deploy Worker + Revision Drift Alert + `/health.git_sha` + targeted prod smoke.
- #1055 is guarded by `PR1055_T2_LANE_PROD_VERIFIED=1` and `PR1055_T2_LANE_PROD_PROOF`; do not override this guard before #1121 proof exists.
- T3 migration chains cannot all be honestly soaked on stale bases. Refresh/restack after #1121, then start exact-head 48h windows as close together as dependency order and clean staging isolation allow.
- Never count old #1055 12h mixed artifacts as current 48h T3 evidence.

Detailed status: `docs/staging/t2-t3-rollout-status-20260608.md`.
