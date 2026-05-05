# Vercel Preview Environment — wiring previews to the staging rig

> **Scope:** Vercel "Preview" environment scope only. **Production** scope must continue to point at prod Supabase + prod Cloud Run worker. Apply each variable to **Preview** only.

## Why

Per CLAUDE.md §1.11 / SCRUM-1755 the staging rig (`arkova-staging`, project ref `ujtlwnoqfhtitcmsnrpq`, Cloud Run `arkova-worker-staging`) is the substrate for soak + reviewer-facing UI experiments. Today Vercel previews boot pointing at production data, which makes any UI-touching PR risky to demo. The fix is to scope Vercel env vars so previews speak to the staging rig and prod is untouched.

CLAUDE.md §1.6 ("documents never leave the user's device") is preserved either way — env-var pointing only changes which Supabase + worker the previews talk to. No code change to client-side fingerprinting / extraction.

## Operator steps (Vercel dashboard, ~3 minutes)

1. Open <https://vercel.com> → select the Arkova project → **Settings → Environment Variables**.
2. For each row in the table below, click **Add New**, paste the **Key** + **Value**, and select **only the "Preview" environment** (uncheck Production + Development).
3. Save. Then trigger a redeploy of any open Preview to pick up the new vars.

## Variables

| Key | Value | Source |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://ujtlwnoqfhtitcmsnrpq.supabase.co` | hardcoded — staging project ref |
| `VITE_SUPABASE_ANON_KEY` | _fetch via_ Supabase MCP `get_publishable_keys` for project_ref `ujtlwnoqfhtitcmsnrpq`, OR `gcloud secrets versions access latest --secret=supabase-anon-key-staging --project=arkova1` | the staging project's own anon key |
| `VITE_WORKER_URL` | `https://arkova-worker-staging-kvojbeutfa-uc.a.run.app` | hardcoded — staging Cloud Run service URL |
| `VITE_API_URL` _(if used)_ | same as `VITE_WORKER_URL` | match the worker URL |

The CSP `connect-src` in `vercel.json` already allowlists the staging worker domain (`arkova-worker-staging-kvojbeutfa-uc.a.run.app`), so the browser will not block requests once the env vars flip.

## Verifying after deploy

1. Open the Vercel-generated preview URL.
2. DevTools → Network. Sign in.
3. The first Supabase request should hit `https://ujtlwnoqfhtitcmsnrpq.supabase.co/...`. If you see `vzwyaatejekddvltxyye` (prod ref) or `https://app.arkova.ai/...` proxied to prod worker, the env vars did not save with Preview scope — recheck step 2 above.
4. The first authenticated worker request should hit `https://arkova-worker-staging-kvojbeutfa-uc.a.run.app/...`. Cold-start expected (preview-mode worker is `--min-instances=0`).
5. Run the staging seed if the rig DB looks empty: `npx tsx scripts/staging/seed.ts --smoke` from a terminal with `STAGING_SUPABASE_*` env vars set. Reviewers will then see prod-shape synthetic data.

## Rollback

Delete the four Preview-scope env vars in step 2. Preview deploys will fall back to whatever the `Development` (or per-PR overrides) defines — typically prod, matching pre-1755 behavior.

## Out of scope for this PR

* `vercel.json` per-environment `rewrites` (Vercel doesn't expose `VERCEL_ENV` to the static rewrites engine; the frontend already uses `VITE_WORKER_URL`/`workerFetch` so the rewrite is fallback-only).
* Vercel preview-deploy gating per-branch (the `git.deploymentEnabled` map is the correct knob; this PR adds the SCRUM-1755 branch).
