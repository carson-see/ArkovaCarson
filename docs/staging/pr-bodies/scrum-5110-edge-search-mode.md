# PR body — fix(edge): arkova_search_anchors honours the worker's search_mode [SCRUM-5110] [T2]

Branch: `fix/scrum-5110-edge-search-mode-propagation` · fix commit `94e1e06c642b770933371f3fece632d00bde4193` · base `origin/main` `8115bfdc6`.
Held under the 16-PR ceiling; the PR-owning session opens the PR from this body and appends the `## Staging Soak Evidence` block at seal (T2 fields per `docs/staging/PR_TEMPLATE.md`; no placeholders).

---

## Summary

SCRUM-3906 (worker branch `fix/verify-search-lexical-fallback`, `5ee7a01fc`) makes `GET /api/v1/verify/search` answer **HTTP 200 with a lexical fallback** when `ENABLE_SEMANTIC_SEARCH` is off or the embedding / `search_public_credential_embeddings` RPC fails, and stamps `search_mode: 'semantic_vector' | 'lexical_substring'` on every body.

`searchCredentialsWorkerSemantic()` in `services/edge/src/mcp-tools.ts` (hosted MCP tool `arkova_search_anchors` at `edge.arkova.ai`) treated every 2xx with a `results` array as semantic and labelled its own output `semantic_vector` without reading the worker's field. After SCRUM-3906 lands, every flag-off or degraded search would be presented to the calling agent as vector-similarity ranking when it was a substring match.

**Fix:** a worker 200 is relabelled `semantic_vector` **only** when the body's own `search_mode` is exactly `'semantic_vector'`. `lexical_substring`, an absent field (pre-SCRUM-3906 worker) or an unknown value return `null` from the proxy — the same path as the old 503 — so `handleSearchCredentials` runs its own labelled lexical fallback. One lexical output shape is kept (the edge RPC path fills `title`; the worker's lexical rows omit it); cost is one extra RPC on the fallback path, identical to today's 503 path. The worker-supplied `search_mode` is reduced to a `[\w-]{0,40}` token before it is logged; the caller API key is never logged.

## Changes

- `services/edge/src/mcp-tools.ts` — `WorkerVerifySearchBody` (`search_mode?: string`); per-hit fields the worker's lexical shape omits made optional; attribution check before relabelling; doc comments on the proxy and `handleSearchCredentials`.
- `services/edge/src/mcp-tools.test.ts` — (a)/(b)/(f) mocks carry the worker's attribution; new (i) 200+`lexical_substring` not relabelled and edge lexical runs, (j) absent `search_mode` not assumed semantic, (k) unknown value not relabelled, (l) no caller key in logs. (i)(j)(k) were red before the fix.
- `services/edge/agents.md` — rule recorded.
- `docs/staging/pr-bodies/scrum-5110-edge-search-mode.md`, `HANDOFF.md` — this handoff.

## Verification (local, head `94e1e06c6`)

- Edge suite 128/128; `mcp-tools.test.ts` 63/63 (59 → 63).
- `tsc --noEmit` clean in `services/edge`.
- `npx tsx scripts/ci/check-mcp-claim-parity.ts` — OK, 16 tools × 6 surfaces.
- Root `tests/infra/mcp-manifest-parity.test.ts` + `mcp-server.test.ts` 103/103; `lint:copy` clean.
- `requiredTierFor()` on the changed files → **T2** (`services/edge/src/mcp-tools.ts — edge worker`).

## Soak / deploy notes for the owning session

- **Tier T2.** The gate has no edge-only evidence mode (SCRUM-3427 open), so evidence comes from a rig with the edge deployed via `wrangler.soak.toml` (`--name arkova-edge-<rig>`, never the routed `wrangler.toml`) pointed at a rig worker that carries SCRUM-3906. Targeted probe: flag off → tool output `search_mode: lexical_substring` with no `similarity`; flag on with seeded embeddings → `semantic_vector` with `similarity`; worker 503 → `lexical_substring` (regression of the old path).
- **Land with or immediately after SCRUM-3906.** Prod `arkova-edge` has no deploy pipeline (SCRUM-3907 / SCRUM-3797); until this is deployed with `wrangler`, the currently deployed edge mislabels once the worker change is live.
- Rollback: redeploy the previous `arkova-edge` version with `wrangler`; no data, schema or worker state to unwind.

## Links

- Jira: https://arkova.atlassian.net/browse/SCRUM-5110 (epic SCRUM-3894)
- Confluence: https://arkova.atlassian.net/wiki/spaces/A/pages/147324931
- Worker change: https://arkova.atlassian.net/wiki/spaces/A/pages/146440317 (SCRUM-3906)
- Bug Tracker — Master Log v90, section "Edge relabel hazard after SCRUM-3906 — SCRUM-5110 — 2026-09-13"

🤖 Generated with [Claude Code](https://claude.com/claude-code)
