# Fixed-A compatibility worker independent review

Reviewed 2026-09-27 against foundation baseline `fc9c8a6543ed3482239e5b6ae9d5c9ce1d141c23`.

- Historical reviewed artifact: `46f3ac519741c1c0cf71be84308bd9c9009800f8` (`codex/fixed-a-compat-20260927`). The range is two commits and seven intended worker paths.
- `3f7238d5a` replaces the generic agent router with an authenticated maintenance router. Reads still reach the original router. Generic register, non-status/status PATCH, revoke, and key mint return the fixed 503 envelope with `Retry-After: 300` before agent-table access. Provider routes remain outside that router; the operator prerequisite `ENABLE_COMPUTEID_INTEGRATION=false` is therefore required.
- `46f3ac519` hardens owned-outbox claim parsing while retaining the foundation drainer. `delivery.ts` is byte-identical to the reviewed candidate implementation at `0d006b61e` for that file, so it can drain Build-B-owned rows and rejects malformed/cancelled claim shapes before network delivery.
- Authentication remains before the maintenance router. The tests cover unauthenticated rejection, all four generic mutation route patterns, mounted retry draining, malformed claims, cancellation, and persisted-body delivery.
- The working tree is clean. No deployment, image, migration, production, or soak acceptance was inferred.

Verdict: source is reviewer-ready as the compatibility rollback floor, conditional on the documented operator controls: migration 0491 remains retained; this exact immutable image is available; ComputeID admission is disabled; and every pre-A background-capable revision is quiesced before Build B can create owned rows. This review does not establish those live conditions.

## Successor gate review

The seven-path successor diff `deb8ee72313a87db170fe920c18a4d6db89382e83ea7671c752e6a4b6bdc6ccb` independently passed source review. It retains the recipient pepper but adds a default-off gate that requires literal `true` before recipient hashing, lookup, auth/profile creation, linking, or activation email. It is committed locally at `10459180091b9cb4d88313b5e7108ccc297d57f2`; its image, runtime configuration, and rehearsal remain open; historical `46f3ac519` is not the final rollback floor.
