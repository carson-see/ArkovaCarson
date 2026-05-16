# services/worker/scripts/ci

CI helper scripts called by GitHub Actions or Atlassian Automation rules.

## Files

- `check-confluence-dod.ts` — SCRUM-1251 (R0-5). Validates that a Confluence page's "Definition of Done" section has all checkboxes ticked. Returns `{ ok: true }` or `{ ok: false, untickedLines }`. Pages without a DoD section pass by default.
- `check-confluence-dod.test.ts` — Unit tests for the DoD checker.

## Constraints

- Requires `CONFLUENCE_USER` and `CONFLUENCE_API_TOKEN` env vars at runtime.
- Used by Atlassian Automation rule R4 to block Done transitions with unticked DoD items.
