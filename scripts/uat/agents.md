# scripts/uat/agents.md

UAT (User Acceptance Testing) screenshot capture scripts. Automate visual verification at specified viewports.

## Files
- **`capture-scrum-952-public-verify.ts`** — captures desktop (1280px) and mobile (375px) screenshots of the public verification page across all anchor states (PENDING, SUBMITTED, SECURED, EXPIRED, REVOKED). Outputs to `docs/uat/`.

## Conventions
- Uses Playwright (chromium) for headless rendering.
- Creates test anchors via Supabase service client; cleans up after capture.
- Screenshots are PDF artifacts stored in `docs/uat/`.
- Defaults to `http://localhost:5173`; override with `UAT_BASE_URL` env var.
