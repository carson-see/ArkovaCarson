# services/worker/src/types/

Shared TypeScript type definitions for the worker service.

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
