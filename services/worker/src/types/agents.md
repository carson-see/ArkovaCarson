# services/worker/src/types/

Shared TypeScript type definitions for the worker service.

## 2026-08-10 — organization_field_policies (manual patch, not a live regen)

Migration `0405` (file-only, unapplied) adds `public.organization_field_policies`; hand-patched into
`database.types.ts` here and in `src/types/` so `db.from('organization_field_policies')` in
`utils/orgFieldPolicy.ts` type-checks against real column names rather than an `as any` escape.
Same manual-patch caveat as the R19 note below — regenerate with `npm run gen:types` once `0405`
reaches a project this can generate against.

## 2026-07-28 R19 — anchors.fingerprint_source (manual patch, not a live regen)

Same manual patch as `src/types/agents.md` — migration `0376` (unmerged, file-only) adds `anchors.fingerprint_source`. Regenerate for real once `0376` lands on a reachable project.
## 2026-07-28 — Hand-added `admin_adjust_org_credit` Functions entry (L2-A5, pre-soak)

Migration `0375_admin_org_credit_adjust.sql` (file-only, pre-soak — see `supabase/migrations/agents.md`) is not yet applied to the local dev DB's committed ledger, so a full `npm run gen:types` resync wasn't run for this change. Instead, the `admin_adjust_org_credit` entry was hand-added to the `Functions` block (alphabetically, after `activate_user`) in both this file and `src/types/database.types.ts`, matching the exact shape (`Args`/`Returns`) the generator would emit — same pattern as the existing `admin_set_org_anchor_quota` entry. **Follow-up:** once 0375 lands on the local dev DB's migration ledger, run the canonical `npm run gen:types` (`--local`, per the Rules below) to confirm the hand-added entry matches byte-for-byte and pick up anything else pending.

## 2026-06-16 — Resynced to migration head 0339 (108 → 114 tables)

`database.types.ts` had drifted since migration 0326 (108 tables). Regenerated from a
clean `npx supabase db reset --local` (ledger head **0339**) with the same generator the
frontend uses — output is **byte-identical** to `src/types/database.types.ts` (PR #1199's
resync). Purely additive (**+364 / −6**): adds `external_document_versions`,
`version_reviews`, `org_credit_deductions`, plus other 0322–0339 tables/columns/RPCs; the
6 "deletions" are an `org_integrations.Relationships` reorder (net **+1** FK). This made
the redundant `untypedDb` / `(db as any)` escape hatches in `api/version-resolution.ts`
and `jobs/rules-engine-versions.ts` removable, so those paths now get real typing.

## 2026-07-15 — Regenerated through local migration 0358

After a clean local `supabase db reset --local`, the canonical generator added the service-role `anchor_txid_journal` table and `resolve_anchor_txid_journal` RPC. Worker and frontend generated files are byte-identical; no linked/staging/prod generation was used.

## Files

- **database.types.ts** — Auto-generated Supabase types (`npx supabase gen types`). Never edit by hand; regenerate after any migration.
- **google-cloud-kms.d.ts** — Ambient module declaration for `@google-cloud/kms`. Lets TypeScript compile without the real SDK installed; the SDK is only required at runtime when `KMS_PROVIDER=gcp` on mainnet.

## Rules

- `database.types.ts` is generated. Regenerate via the canonical root `npm run gen:types` (`supabase gen types typescript --local`) after `npx supabase db reset --local`, redirecting to `services/worker/src/types/database.types.ts`, then commit the diff. Use **`--local`** (deterministic from the committed migration ledger), NOT `--linked` — the worker file must stay byte-identical to the frontend `src/types/database.types.ts`, which is generated `--local`. Drift between the two is what forced the 0326→0339 catch-up.
- If you need to narrow or override generated types (e.g. tightening a `string` column to a union), create a separate override file in this directory rather than editing `database.types.ts`.
- Ambient declarations (`.d.ts`) are for optional dependencies only — don't use them to avoid installing required packages.

## 2026-07-15 x402 request context

- `Request.x402PayerContext` is a discriminated union: an explicit API-key or
  payments-disabled bypass, or a verified opaque `payerKey`. Never add a raw
  wallet address to this request type.
