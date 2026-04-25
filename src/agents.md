# agents.md — src/
_Last updated: 2026-04-24_

## What This Folder Contains

React 18 frontend application — TypeScript + Tailwind CSS + shadcn/ui + Vite bundler.

## Architecture

- **23 feature domain folders** in `src/components/` (e.g., anchors, billing, admin, auth)
- **Route-level code splitting** via `React.lazy` — 60+ pages
- **State management:** Supabase-centric (no Redux/Zustand). Custom hooks (`useAnchors`, `useBilling`, etc.) query Supabase directly.
- **Auth:** `useAuth()` + `useProfile()` React Context providers
- **UI copy:** Centralized in `src/lib/copy.ts` — CI enforced via `npm run lint:copy`
- **Rule wizard validation:** `src/lib/ruleSchemas.ts` mirrors only required client-side checks; worker Zod schemas stay authoritative.
- **Design system:** "Precision Engine" — see `docs/reference/BRAND.md`
- **Routing:** react-router-dom v6, named routes in `src/lib/routes.ts`

## Constitution Rules (Immutable)

- **1.6 — Documents NEVER leave the browser.** `generateFingerprint`, `piiStripper`, OCR all run client-side only. Never import these in `services/worker/`.
- **1.3 — No crypto jargon** in user-facing strings. Banned: Wallet, Gas, Hash, Block, Transaction, Crypto, Blockchain, Bitcoin, Testnet, Mainnet, UTXO, Broadcast. See `src/lib/copy.ts`.

## Do / Don't Rules

- **DO** put all UI strings in `src/lib/copy.ts`
- **DO** use Zod validators from `src/lib/validators.ts` before any DB write
- **DO** query Supabase via custom hooks — never `useState` arrays for DB data
- **DO** use `React.lazy` for new route-level pages
- **DON'T** add Redux, Zustand, or other global state libraries
- **DON'T** use `supabase.auth.admin` or service role key in browser code
- **DON'T** import `generateFingerprint` outside `src/` (client-side only)
- **DON'T** set `anchor.status = 'SECURED'` from client code — worker-only
- **DON'T** expose `user_id`, `org_id`, or `anchors.id` publicly — use `public_id`

## Testing

- Vitest for unit/integration tests
- Playwright for E2E (`e2e/` directory)
- Coverage: `@vitest/coverage-v8`, 80% thresholds on critical paths
- RLS test helpers: `src/tests/rls/helpers.ts` (`withUser()` / `withAuth()`)

## Dependencies

- `react`, `react-dom` — UI framework
- `@supabase/supabase-js` — database + auth
- `react-router-dom` — routing
- `tailwindcss` + `shadcn/ui` + `lucide-react` — styling + components + icons
- `zod` — validation
- `pdf.js` + `tesseract.js` — client-side OCR
- `vite` — bundler
