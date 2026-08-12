# v1 UUID-leak deprecation runbook

**SCRUM-1271 (R2-8)** — `/api/v1/*` responses currently expose internal database UUIDs (`id`, `org_id`, `user_id`, `agent_id`, `key_id`, `endpoint_id`, `attestation_id`). CLAUDE.md §6 hard-bans this. CLAUDE.md §1.8 freezes v1 schema, so a clean removal requires a `v2+` namespace + 12-month deprecation.

This runbook is the cutover plan.

## Scope

Confirmed leak sites (snapshot 2026-04-27):

| File | Lines | Leaked field | Severity |
|---|---|---|---|
| `services/worker/src/api/v1/agents.ts` | 124, 156, 185, 240, 288, 358-365 | full DB row spread (`id`, `org_id`, `registered_by`, `agent_id`, `key_id`) | CRITICAL |
| `services/worker/src/api/v1/anchor-lifecycle.ts` | already fixed (uses `actor_public_id`) | — | resolved |
| `services/worker/src/api/v1/attestations.ts` | 228, 325-326 | `attestation_id`, evidence `id` | HIGH |
| `services/worker/src/api/v1/webhooks.ts` | 183, 283, 506, 561 | endpoint `id`, delivery `endpoint_id` | HIGH |
| `services/worker/src/api/v1/keys.ts` | 130, 143-146, 184, 258 | api_keys `id` | **NOT A LEAK — do not strip. See below.** |
| `services/worker/src/api/v1/jobs.ts` | 67 | `job_id` (frozen — defer) | MEDIUM |

The `scripts/ci/check-v1-uuid-leaks.ts` lint script flags these patterns at PR time (warn-only initially; will flip to fail once §1.8 cutover completes).

### `keys.ts` — carve-out (FD-P7 / BUG-2026-08-12)

**`api_keys.id` stays in the `/api/v1/keys` responses. Do not strip it again.**

SCRUM-1271-D removed it here in April 2026. Because PATCH/DELETE address a key
by `:keyId` (= `api_keys.id`), that removal left org admins able to *see* their
keys and unable to *name* the one they wanted revoked — `ApiKeySettings.tsx`
passes `apiKey.id`, which became `undefined` at runtime, so the Revoke button
issued `PATCH /api/v1/keys/undefined` and 404'd. SOC 2 CC6.8 (key lifecycle) had
no customer-operable path until FD-P7 restored the field. It reached production.

Why this row was never really in scope:

- §6 bans UUIDs on **public** surfaces. Every `/api/v1/keys` route sits behind a
  Supabase JWT + an `ORG_ADMIN` check + an org-scoped query; the only `id` a
  caller sees belongs to a key their own org owns.
- `org_id` and `key_hash` — the actual tenant identifier and the actual secret —
  are still stripped, and `keys-sanitizer.test.ts` pins that.
- Phase 3 below already specifies that v1 carries **both** `id` and `public_id`
  through the deprecation window. Stripping the identifier before shipping its
  replacement inverted the order and broke the feature.

**Precondition for ever removing it:** `api_keys.public_id` exists and is
backfilled (Phase 2), the routes resolve `:keyId` against it, and the frontend
has migrated. Until all three hold, removing `id` breaks revocation again.

## Cutover phases

### Phase 1 — annotate (this PR)

- [x] Lint script lands warn-only.
- [x] This runbook lands.
- [ ] Each leak site gets `// SCRUM-1271-EXEMPT: <reason>` so the lint signal-to-noise stays useful while v2 work is in flight.

### Phase 2 — v2 namespace (R3 / SCRUM-1284 follow-up)

- Add `public_id` column to: `agents`, `webhook_endpoints`, `attestation_evidence`, `attestations`, `api_keys` (where not already present).
- Backfill `public_id` for all existing rows (one migration per table).
- Ship `/api/v2/<resource>` routes that return only `public_id` + derived fields.
- Add `services/worker/src/api/v2/response-schemas.ts` with `.strict()` Zod schemas for each response body.

### Phase 3 — soft deprecation

- v1 routes start returning a `Sunset:` header (RFC 8594) with a date 12 months out.
- v1 routes continue to include both `id` AND `public_id` for the deprecation window — clients migrate at their own pace.
- Customer-facing changelog announces the cutover date.

### Phase 4 — hard cutover

- 12-month deprecation window expires.
- v1 routes drop UUID fields (or 410 Gone if the route itself is being removed).
- `scripts/ci/check-v1-uuid-leaks.ts` flips to `process.exit(findings.length > 0 ? 1 : 0)`.

## Privacy spot-fixes (do not wait for v2)

Per the SCRUM-1271 ticket: "For the most egregious leaks (`actor_id` = user UUID in `anchor-lifecycle.ts`), **remove immediately** — that's a privacy bug, not a contract change."

- ✅ `anchor-lifecycle.ts:48` — already exposes `actor_public_id`, not the raw user UUID. No action.
- ⏳ Identify any other field whose CURRENT value is a personally-identifying UUID exposed to anonymous callers — those qualify as privacy bugs and are removable without v2.

## Override mechanism

Any handler that LEGITIMATELY needs to expose an internal UUID (none today; some tests may) can suppress the lint with `// SCRUM-1271-EXEMPT: <reason>` on the same source line. The registry of exempt sites is reviewed monthly during R-cycle close-outs.

## References

- [SCRUM-1271](https://arkova.atlassian.net/browse/SCRUM-1271) — this story
- [SCRUM-1246](https://arkova.atlassian.net/browse/SCRUM-1246) — RECOVERY epic
- CLAUDE.md §6 (banned UUID exposure)
- CLAUDE.md §1.8 (frozen API + v2 deprecation policy)
- [v1 API contract — Confluence](https://arkova.atlassian.net/wiki/spaces/A) (Identity & Access page)
