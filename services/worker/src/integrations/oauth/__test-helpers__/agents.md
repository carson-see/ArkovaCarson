# agents.md — services/worker/src/integrations/oauth/__test-helpers__/

_Last updated: 2026-09-21 (created — SCRUM-2903/3661/5094/2330 fields-mask incident)_

## What This Folder Contains

Shared test helpers for Google Drive API URL-construction tests in
`../drive.test.ts` (and any future connector test that builds a Google
`fields` partial-response mask).

| File | Purpose |
|------|---------|
| `fields-mask.ts` | `assertValidFieldsMask(mask)` — structural validator for a Drive API `fields` mask: balanced parentheses, no whitespace, no stray/trailing/empty commas, no two identifiers adjacent without a separator. |

## Do / Don't Rules

- **DO** call `assertValidFieldsMask()` on any newly-constructed `fields` mask AS WELL AS asserting the exact expected string — the validator alone is defense-in-depth against a DIFFERENT malformation class (unbalanced parens, a whitespace-joined mask) and CANNOT alone catch the defect this folder exists to guard against: a `.join('')` with no separator at all fuses two field names into one syntactically-valid-looking identifier (`newStartPageToken` + `nextPageToken` → `newStartPageTokennextPageToken`), indistinguishable from one long legitimate field name to a generic tokenizer. Read the doc comment at the top of `fields-mask.ts` before assuming this validator is sufficient on its own.
- **DO NOT** widen this validator to hardcode Google's actual field vocabulary (e.g. a list of valid Drive field names) — Drive's schema is Google's to change, not ours to freeze into a test helper.
- **DO NOT** duplicate this validator inline in a test file — import it.
