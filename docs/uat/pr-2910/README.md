# UAT — PR #2910 Pipeline Controls (SCRUM-5043 / 5044 / 5045)

Head: d63b14c03ed49cd5c99f7dfd7b437784abdcf550. Captured 2026-09-13 at 1280px and 375px per CLAUDE.md §0 rule 6.

**How these were produced (read this before trusting them):** the real `src/pages/PipelineAdminPage.tsx` mounted in a throwaway Vite harness with the same module mocks the unit tests use (`useAuth`, `useProfile`, `workerFetch`, `supabase`). No Supabase stack was running and none was started. Freshness captions therefore show mocked rows (`842 rows / 30d`, `No records yet`), chosen so both caption states appear side by side. Disabled reasons, the Disabled badge, the "Runs in background" hint and the 375px wrapping are the real component output. The broken image on "Run Anchoring" / "Auditor Mode" is the harness failing to resolve the logo asset, not a change in this PR.

| File | Shows |
|---|---|
| `1280-expanded.png` | Federal & Compliance: freshness caption, "No records yet", "Runs in background", three disabled controls with visible reasons |
| `375-expanded.png` | Same six controls single-column at 375px; reasons wrap inside the card |
| `375-disabled-reasons.png` | Professional Licensing at 375px; the longest reason wraps to two lines with no overflow |
| `1280-runs-in-background.png` | Full grid; every disabled control shows its reason |
| `375-runs-in-background.png` | Full grid at 375px |
