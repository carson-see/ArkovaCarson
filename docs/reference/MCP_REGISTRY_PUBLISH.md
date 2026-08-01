# MCP Registry Publish — Runbook

Operational notes for publishing/republishing the Arkova MCP server
(`edge.arkova.ai`, Cloudflare Worker) to the **official MCP Registry**
(`registry.modelcontextprotocol.io`, source at
[`github.com/modelcontextprotocol/registry`](https://github.com/modelcontextprotocol/registry)).
This is a discovery/metadata listing, separate from the server itself — it
tells MCP clients and registry aggregators that Arkova's MCP server exists and
how to connect to it. It is unrelated to Confluence/Jira process; this is an
internal engineering note (CLAUDE.md §0 rule 4 — `docs/` files are historical
context / internal notes, not "documentation" in the Confluence sense).

## Current state (verified 2026-08-01)

- Server name: **`io.github.carson-see/arkova-verification`**
- Registry: [`registry.modelcontextprotocol.io`](https://registry.modelcontextprotocol.io)
- Current live version: **1.0.1** — `status: active`, `isLatest: true`
- Verify live listing any time:
  ```bash
  curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.carson-see%2Farkova-verification" | python3 -m json.tool
  ```
- Source of truth for the payload: [`services/edge/server.json`](../../services/edge/server.json)

### What was broken (2026-03-25 → 2026-08-01)

The server was published as version `1.0.0` back on 2026-03-25, but
`services/edge/server.json` at the time used a non-standard `remoteEndpoints`
key (plus `tools`/`resources`/`prompts`/`authentication` fields) that don't
exist in the registry's schema
(`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`,
`#/definitions/ServerDetail` — the only top-level fields it accepts are
`$schema`, `_meta`, `description`, `icons`, `name`, `packages`, `remotes`,
`repository`, `title`, `version`, `websiteUrl`). The registry backend
silently dropped every field it didn't recognize, so the published record
kept only `name`/`description`/`version`/`repository` — **no `remotes` and no
`packages`**, i.e. no connection information at all. Any agent or client that
found Arkova via the registry had nothing to connect to.

Fixed in version `1.0.1` (server.json now uses the correct `remotes[]`
array). The broken `1.0.0` was marked `deprecated` (not deleted) so version
history stays intact — see `mcp-publisher status` below.

**Important**: the registry's `server.json` schema has **no field for a tool
list**. It only describes how to find and connect to the server, not what
tools it exposes once connected. Tool-level discovery is a *separate*
artifact — the agent-facing discovery card at
[`arkova.ai/.well-known/mcp/server-card.json`](https://arkova.ai/.well-known/mcp/server-card.json)
(source: `public/.well-known/mcp/server-card.json`) — or the live `tools/list`
MCP call itself. Keep both in sync with the real tool surface
(`TOOL_DEFINITIONS` in `services/edge/src/mcp-tools.ts`) independently; a fix
to one does not fix the other. (`server-card.json` had its own 16-tool parity
fix in PR #1726 — see `services/edge/agents.md` for that history.)

## How to republish (e.g. after a tool-surface or endpoint change)

Prerequisite: `mcp-publisher` CLI. Install via Homebrew:
```bash
brew install mcp-publisher
```
(A prebuilt-binary install is also documented on the
[quickstart page](https://modelcontextprotocol.io/registry/quickstart) if
Homebrew isn't available.)

1. **Edit `services/edge/server.json`.** Bump `version` (registry rejects
   duplicate-version publishes — `cannot publish duplicate version`). Follow
   semver; non-ranges only (`1.0.2`, not `^1.0.2`).
2. **Validate before publishing:**
   ```bash
   cd services/edge
   mcp-publisher validate ./server.json
   ```
3. **Authenticate.** The registry ties the `io.github.carson-see/*` namespace
   to GitHub OAuth for the `carson-see` account. Two ways to log in:
   - **Interactive (human, e.g. Carson locally):**
     ```bash
     mcp-publisher login github
     ```
     Opens a device-flow browser prompt.
   - **Non-interactive (agent/CI), using the PAT in Secret Manager:**
     ```bash
     GH_PUBLISH_TOKEN="$(gcloud secrets versions access latest --secret=Github_Token --project=arkova1)"
     mcp-publisher login github -token "$GH_PUBLISH_TOKEN"
     unset GH_PUBLISH_TOKEN
     ```
     Never print `$GH_PUBLISH_TOKEN`. The `Github_Token` secret is a
     fine-grained PAT scoped to the `carson-see` personal account (expires
     2026-08-25 as of this writing — check expiry before relying on it; a
     fine-grained PAT has no org visibility unless explicitly granted
     Organization Members → Read-only, which is irrelevant here since we
     publish to the *personal* `io.github.carson-see/*` namespace, not an org
     namespace).
   - `mcp-publisher login` writes credential/token artifacts into **both**
     `~/.config/mcp-publisher/token.json` **and** legacy files
     (`.mcpregistry_github_token`, `.mcpregistry_registry_token`) in the
     **current working directory**. The repo's `.gitignore` now covers these
     (added 2026-08-01) — but always run `mcp-publisher logout` when done and
     confirm no `.mcpregistry_*` files are left in the repo tree before
     committing anything.
4. **Publish:**
   ```bash
   mcp-publisher publish ./server.json
   ```
5. **Verify live:**
   ```bash
   curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.carson-see%2Farkova-verification" | python3 -m json.tool
   ```
   Confirm the new version shows `isLatest: true` and the fields you changed
   are actually present (the registry accepts extra unrecognized fields
   silently — always verify the *response*, not just a `publish` exit code,
   because a schema mistake will publish "successfully" with the bad field
   quietly dropped, exactly like the original `remoteEndpoints` bug above).
6. **Log out** (`mcp-publisher logout`) and delete any stray
   `.mcpregistry_*` files in the working tree.

### Deprecating / deleting an old version

```bash
# Deprecate (stays visible with a warning; use for "superseded" versions)
mcp-publisher status --status deprecated --message "<why + what to use instead>" \
  io.github.carson-see/arkova-verification <version>

# Delete (hides from default listings; use for genuinely broken/security-issue versions)
mcp-publisher status --status deleted --message "<why>" \
  io.github.carson-see/arkova-verification <version>
```
Requires being logged in with publish/edit permission for the namespace
(same login step as above).

## Optional future upgrade: custom-domain namespace

The server currently publishes under the **GitHub personal namespace**
(`io.github.carson-see/*`), which required no DNS changes — ownership is
proven by GitHub OAuth against the `carson-see` account that owns the
`ArkovaCarson` repo. This is live today and needs no further action.

If Arkova later wants a **branded namespace** instead (e.g. `ai.arkova/*`,
the reverse-DNS form of `arkova.ai`), that requires **domain-based
authentication** — a DNS TXT record at the **apex** of `arkova.ai` (not a
subdomain/selector). Cloudflare DNS for `arkova.ai` is founder-managed
(CLAUDE.md §1.11), so this step is **Carson-only**; nothing below has been
executed and no DNS was touched.

Staged commands (run locally, then hand the printed TXT record to Carson —
do **not** run `mcp-publisher login dns` with a real private key from an
agent session, since the key must be kept by whoever controls the DNS):

```bash
MY_DOMAIN="arkova.ai"

# Ed25519 keypair (macOS: brew install openssl@3 first — system LibreSSL
# does not implement Ed25519 in genpkey)
openssl genpkey -algorithm Ed25519 -out key.pem

# Print the exact TXT record to hand to Carson for Cloudflare DNS:
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "${MY_DOMAIN}. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

After Carson adds that TXT record at the apex of `arkova.ai` in Cloudflare
and it propagates:

```bash
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain "${MY_DOMAIN}" --private-key "${PRIVATE_KEY}"
```

This grants the `ai.arkova/*` namespace. `server.json`'s `name` would then
need to change from `io.github.carson-see/arkova-verification` to something
like `ai.arkova/verification`, republished as a new entry (the old
`io.github.carson-see/*` entry can stay published in parallel — the registry
allows multiple names for conceptually the same server; there is no
"rename," only publish-new + deprecate-old).

**Not currently necessary** — the existing `io.github.carson-see/*` listing
is live, correct, and fully functional. This section exists only so the
migration path is pre-staged if Arkova wants the more branded name later.

## Related

- `services/edge/server.json` — the payload
- `services/edge/agents.md` — change history for this folder, including the
  2026-08-01 fix
- `public/.well-known/mcp/server-card.json` — the separate agent-facing
  discovery card (full tool list + schemas); NOT read by the MCP registry
- [MCP Registry docs](https://modelcontextprotocol.io/registry/about) (the
  registry is documented as being in **preview** — expect breaking changes)
