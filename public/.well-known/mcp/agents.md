# agents.md — public/.well-known/mcp

_Last updated: 2026-08-18_

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
