# services/worker/src/types/

Shared TypeScript type definitions for the worker service.

## Files

- **database.types.ts** — Auto-generated Supabase types (`npx supabase gen types`). Never edit by hand; regenerate after any migration.
- **google-cloud-kms.d.ts** — Ambient module declaration for `@google-cloud/kms`. Lets TypeScript compile without the real SDK installed; the SDK is only required at runtime when `KMS_PROVIDER=gcp` on mainnet.

## Rules

- `database.types.ts` is generated. Run `npx supabase gen types typescript --linked > services/worker/src/types/database.types.ts` after every migration, then commit the diff.
- If you need to narrow or override generated types (e.g. tightening a `string` column to a union), create a separate override file in this directory rather than editing `database.types.ts`.
- Ambient declarations (`.d.ts`) are for optional dependencies only — don't use them to avoid installing required packages.
