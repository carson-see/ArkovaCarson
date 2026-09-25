# agents.md — public/.well-known/mcp

_Last updated: 2026-08-23_

## 2026-09-05 — the `arkova_` rename across the whole of `public/`, recorded here

`server-card.json` renamed all 16 tool entries to the registry's live names (v3.0 /
SCRUM-3894 / BUG-2026-09-02-001) — `nessie_query` keeps its own namespace and is the one
name that does not take the prefix. `tests/infra/mcp-manifest-parity.test.ts` and
`scripts/ci/check-mcp-claim-parity.ts` both check the card against
`services/edge/src/mcp-tools.ts`, so the card cannot lag the registry; neither of them
checks the rest of `public/`, which is why the rest of this entry exists.

**Why the other `public/` changes are logged in this file.** `public/` has no engineering
`agents.md`. Its only `agents.md`-shaped file is `public/AGENTS.md`, which is a PUBLISHED
agent-integration guide and one of the surfaces the claim-parity gate reads — a dated
engineering changelog does not belong in a document served to clients. So:

- `public/.well-known/agent-skills/*/SKILL.md` — three MCP call instructions named
  unregistered tools (`search`, `get_anchor`). Corrected, and `index.json`'s sha256
  digests recomputed: a spec-honouring client hashes the fetched skill and refuses a
  mismatch, so a stale digest takes the skill OFFLINE rather than serving old text.
  Pinned by `tests/infra/agent-skills-digests.test.ts` (hashes the files, not a snapshot
  of expected hex) and by claim-parity rule 5 (`skill-bare-tool-name`).
- `public/.well-known/oauth-protected-resource` — `authorization_servers` REMOVED (D3).
  The Supabase GoTrue issuer is not an RFC 9728 authorization server for
  `https://app.arkova.ai`: it issues no token for that resource, so advertising it sent
  MCP clients into an OAuth flow that cannot succeed. API access is bearer API keys, per
  `public/auth.md`. The key is absent, not empty — an empty array still advertises the
  field. `src/agentDiscovery.test.ts` asserts its ABSENCE.
- `public/AGENTS.md`, `public/llms.txt`, `public/llms-full.txt` — tool names re-synced;
  all three are claim-parity prose surfaces with a shrink-only coverage ratchet, so a
  tool may gain a mention here but not lose one.

## 2026-08-23 — `anchor_document` description re-synced to the BUG-028 canonical text

`services/edge/src/mcp-tools.ts` rewrote the `anchor_document` description
(BUG-028: the old text promised "an anchor receipt with a public identifier"
that the handler never returned — `public_records` has no `public_id` column;
the receipt is a submission receipt with `public_id: null` and the fingerprint
as the handle). The card's copy of the description is updated to start with
that canonical text, keeping the card-only "Conditionally available:
MCP_ENABLE_ANCHOR_DOCUMENT" suffix that the prefix rule in
`scripts/ci/check-mcp-claim-parity.ts` permits.

## What This Folder Contains

`server-card.json` — the public MCP discovery manifest served at
`app.arkova.ai/.well-known/mcp/server-card.json`. Machine-readable, not user
copy, so it is outside `src/lib/copy.ts` and the `lint:copy` / scaffolding
guards. Tool list and description text must stay in parity with
`services/edge/src/mcp-tools.ts` — enforced by `tests/infra/mcp-manifest-parity.test.ts`,
`tests/infra/mcp-claim-parity.test.ts`, and `scripts/ci/check-mcp-claim-parity.ts`
(none of which assert on the `vendor` field).

## 2026-08-18 — `vendor` corrected to the real entity (P1, item 9 of 9, counsel-ordered)

`serverInfo.vendor` read `"Arkova Technologies, Inc."` — a placeholder used
pending incorporation and never cleaned up (per a source comment counsel found
on the marketing site's privacy page, flagged to Rick Tapia). No such
corporation exists. This is a machine-readable legal-entity assertion served
to AI crawlers and MCP clients, not cosmetic copy.

Corrected to `"Bloc Doc Inc."`, the real entity (d/b/a Arkova). Per the
Sarah/Carson privacy-policy addendum (Google Doc
`1LVNus_xgbWu79DZGUDwh0MUJ8OQn6ISaJSPMQwxSDl8`, finding 3 / P1), the placeholder
name appears in **nine** locations across two repositories — the app repo
(here) has one occurrence, this file; the other eight are in the marketing
repository (opening paragraph, contact block, meta-author, Terms page contact
block, index.html JSON-LD `legalName`, `llms-full.txt`,
`.well-known/agent-skills/index.json`, `.well-known/mcp/server-card.json` in
*that* repo) and are out of scope here — they land as Tranche 1, this week,
per the addendum's own sequencing ("all nine together" is the instruction;
this app-repo occurrence ships now because it's a one-line JSON change already
touched by this PR, not because the marketing-repo work is done).

**Open item, not resolved by this change:** Rick Tapia is confirming the
exact DBA string against the filing. If the confirmed string differs from
"Bloc Doc Inc." (e.g. a different capitalization, punctuation, or a fuller
legal name), this value needs a follow-up correction — do not treat this
commit as the final word on the string's exact form, only on removing the
non-existent placeholder entity.

UAT-23 adds `arkova_import_rows` to the documented conditional write surface; keep the server card exactly aligned with `TOOL_DEFINITIONS` and the 15+3 count.

## 2026-09-21 — server-card description synced for arkova_import_rows (PR #3034)

`mcp-manifest-parity` asserts each manifest description equals its
`TOOL_DEFINITIONS` description exactly, so this file and
`services/edge/src/mcp-tools.ts` change together or CI goes red.

## 2026-09-21 — server-card carries the recipient disclosure (PR #3034)

The `arkova_import_rows` description gained the S6 recipient/third-party-email
disclosure and the S3 reason-code pointer. Copied byte-identically from
`services/edge/src/mcp-tools.ts` — `mcp-manifest-parity` asserts exact equality,
so the two files change together or CI goes red.
