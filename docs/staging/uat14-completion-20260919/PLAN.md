# UAT-14 completion and T3 soak plan

Draft follow-up to base `ec108c4220787876494c61a9b04c3cc25212de4b`; final candidate/base SHAs must be rebound after parent integration. Tracking: [SCRUM-5274](https://arkova.atlassian.net/browse/SCRUM-5274), [canonical page](https://arkova.atlassian.net/wiki/spaces/A/pages/153223204). No merge, deployment, hosted migration, configuration change, or soak has occurred. Root alone owns publication under the 30-open-PR cap.

## Candidate contract

- Personal photo/banner objects live in a private bucket under opaque public-profile IDs. Anonymous signing is allowed only for the currently referenced object while `is_public_profile=true`; owner access remains available while private.
- Organization logo/banner objects use the exact organization public ID. Current assets are intentionally public because organization registry pages already have no organization visibility toggle. Exact active owner/admin AAL2 authority may upload/read pending objects for rollback cleanup; ordinary members, suspended orgs, deleted/inactive users and AAL1 deny writes.
- The browser upload UI decodes and re-encodes input to bounded PNG before upload. Direct authenticated Storage clients can bypass that browser processing: Storage enforces ownership, PNG MIME and2MB, not byte inspection or decoded dimensions. Do not describe browser sanitization as a server-enforced invariant. Unique objects are written first, the pointer commits second, and only then may the prior same-owner/same-kind object be removed. Failed pointer commits attempt cleanup of only the new object; cleanup failures remain observable orphan/retry risks, not guaranteed deletion.
- Public v2 RPCs add only opaque storage paths to their existing whitelisted DTOs. Pages exchange them for 30-second signed URLs. Personal toggle-off prevents new signatures immediately; a previously issued URL has a bounded 30-second residual lifetime.
- Personal and organization public pages render safe http(s) social links, responsive brand media, and a QR encoding the canonical profile URL. Legacy media fallback is HTTPS or same-origin relative; no-referrer does not conceal the viewer's IP from an external legacy image host.

## Start gates and evidence

- Exclusive clean Supabase/worker/frontend rig; record final SHA, migration ledger/hash, bucket/policy/function definitions, build/deploy identity, environment-honesty readback and public origin.
- Rehearse migration 0481 with real Auth AAL1/AAL2 users and Storage, not only the minimal native PostgreSQL fixture. Verify schema cache reload and generated catalog types.
- Use synthetic images only. Capacity: at least1,204 successful uploads (four per cycle times301), plus setup, replacement/failure, signing, read and cleanup margin. Preflight storage bytes, object count, Storage request quotas/rate limits and worker/client memory against that throughput, not merely four instantaneous objects. No real emails, payments, providers or production writes.
- Before starting the clock, exercise actual browser uploads through the decoder using a safe bounded synthetic corpus: truncated formats, MIME/header mismatch, polyglot input and compressed images with oversized dimensions. Inspect resulting PNG dimensions and byte size. The post-decode dimension check does not prove bounded decoder allocation or immunity to decompression bombs; do not use uncontrolled bomb payloads or claim mocked browser tests establish that guarantee.
- Capture explicit hosted probes for anonymous current-object-only signing, toggle-off fresh-sign denial, deleted/inactive subject denial, cross-user/org AAL1/AAL2 access and previously issued URL expiry after more than30seconds. Include current pointers, total objects, failed-cleanup/orphan keys, Storage errors and429 counters in per-cycle and closing artifacts. Require zero candidate-created orphans after settled failure cleanup, with only explicitly bounded in-flight objects permitted during a cycle.
- Local evidence commands: `bash scripts/uat14/native-pg-profile-media.sh`; `npx vitest run src/lib/profileMedia.test.ts src/pages/PublicProfilePage.test.tsx src/hooks/usePublicSearch.test.ts src/hooks/useProfile.test.ts src/hooks/useOrganization.test.ts src/lib/validators.test.ts src/components/dashboard/ProfileCard.test.tsx`; `npx tsc -p tsconfig.build.json --noEmit`; `npx playwright test -c e2e/uat14-profiles.config.ts`. Browser fixtures use production pages with mocked RPC/signing boundaries and do not prove hosted Storage/Auth.

## Observation window

Run at least 25 hours and 301 complete five-minute cycles. The closing cycle starts only after both monotonic and wall-clock floors. Every cycle uploads/replaces personal photo/banner and org logo/banner, toggles personal discovery off/on, probes stale signed URL expiry, scans QR destinations, exercises public member/org discovery at 1280px and 375px, and checks cross-user/cross-org/AAL1 denials plus object/pointer/orphan counts. Any identity drift, privacy disclosure, malformed media acceptance, stale-scope UI result, unexpected object deletion, failed assertion or skipped cycle invalidates the window.

## Rollback

Pause candidate media writes and settle in-flight uploads. Roll back UI/RPC callers first while retaining private bucket policies and additive columns. Do not make the bucket public and do not drop objects/columns as routine rollback. Reapply the candidate only after owner/private/public-toggle, exact-org admin, cross-tenant denial and current-pointer tests pass. A corrected runtime starts a fresh observation window absent explicit exact-head authority.

## Premortem / abort criteria

- Public bucket or leaked internal UUID defeats the privacy model: abort on any public bucket read, private/deleted profile signature, non-current-object anonymous signature, or UUID in public media paths.
- Client MIME lies or unsafe dimensions survive: abort on SVG, decode failure, over-4096 dimension, over-16M-pixel or post-sanitize over-2MB acceptance. Browser decoder resource safety remains a separate observed limit, not a guarantee from a check after decoding.
- Upload ordering loses the last good image: abort if an old object is removed before pointer commit, a failed commit retains its new object, or cleanup touches a different owner/kind.
- Scope changes surface stale success: abort if completion from an old user/org changes or toasts in the new scope.
- Toggle appears private while a fresh URL remains mintable: abort immediately; the documented 30-second lifetime applies only to already-issued signatures.
- QR points at preview/localhost or wrong identity: abort unless decoded QR equals the canonical public route for that DTO.
- Organization visibility assumption changes: this candidate follows the existing always-public organization registry. If product adds an org visibility toggle, release blocks until storage signing and discovery use the same authority.
