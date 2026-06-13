# T2/T3 Rollout Status - 2026-06-08

Status: historical. Superseded by `memory/release_drain_sync_20260613.md` and the top of `HANDOFF.md`; do not use this file as current release state.

The former content captured the 2026-06-08 pre-#1055 launch gate, including obsolete main/head SHAs, old #1055 launch-gate language, and stale Train A/B bases. Those facts are no longer live.

Current release-drain facts as of 2026-06-13:

- #1055 is already merged to `main` at `3f906c991988f9b2ed6e71e1a70b64020cebd2fb`.
- Train A final evidence: `/Volumes/Extreme/Arkova/release-evidence/train-a/soak-train-a-t3-cron-20260611T141256Z.json`, `2880/2880` ok, zero failures.
- Train B final evidence: `/Volumes/Extreme/Arkova/release-evidence/train-b/soak-train-b-t3-cron-20260611T141256Z.json`, `2880/2880` ok, zero failures.
- Merged drain PRs: #1047, #1101, #1100, #971, #1038.
- Remaining strict migration order: #1111 -> #1112 -> #1114 -> #1107 -> #1122.
- Clean Extreme and Crucial main mirrors are sync targets at `1b32847632bd75e24ddcaa7e380f6cb3919d4b3f`; the active Extreme repo remains intentionally dirty with release coordination artifacts.

Keep this file as an archive pointer only.
