/**
 * Route reachability guard — "built but unreachable" detector.
 *
 * THE BUG THIS EXISTS FOR: `src/pages/PricingPage.tsx` was a complete,
 * tested, 268-line checkout page — the ONLY surface in the app that calls
 * `startCheckout` → worker `POST /api/checkout/session` → Stripe. It had no
 * `ROUTES` key, no `<Route>` in `App.tsx`, and zero importers. Every "Upgrade"
 * CTA in the product pointed at `ROUTES.BILLING` instead, which is the page the
 * user was already on. A customer who hit their plan limit had no reachable way
 * to pay us, and every unit test still passed because each one rendered its
 * component directly and never asked whether a router could reach it.
 *
 * A component test cannot catch this class of defect by construction: it mounts
 * the component itself, so "is this reachable from the app?" is never asked.
 * That question is structural, so this guard is structural — it reads
 * `App.tsx` and `routes.ts` as text and asserts two invariants:
 *
 *   1. every `ROUTES` constant is referenced in `App.tsx` (no orphan route
 *      constant — a named destination nothing renders);
 *   2. every page module in `src/pages/` is imported by `App.tsx` (no orphan
 *      page — a built screen with no way in).
 *
 * Both invariants held for 78 route keys and 75 of 76 pages when this was
 * written; PricingPage was the single violation. Keeping them at zero means the
 * next unrouted page fails CI instead of silently costing revenue.
 *
 * If a page is deliberately not routed (rendered only as a child of another
 * page, or staged behind an unreleased flag), add it to
 * `INTENTIONALLY_UNROUTED_PAGES` with a reason. That makes the exception a
 * deliberate, reviewed edit rather than silent drift.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../..');
const APP_SOURCE = fs.readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');
const ROUTES_SOURCE = fs.readFileSync(path.join(SRC_DIR, 'lib/routes.ts'), 'utf8');

/**
 * Page modules that are intentionally not mounted on a route.
 * Each entry MUST carry a reason. Empty is the healthy state.
 */
const INTENTIONALLY_UNROUTED_PAGES: Record<string, string> = {};

/** Route constants intentionally defined but not rendered by App.tsx. */
const INTENTIONALLY_UNROUTED_CONSTANTS: Record<string, string> = {};

/** `KEY: '/path'` entries from the top-level ROUTES object literal. */
function routeConstantNames(): string[] {
  return [...ROUTES_SOURCE.matchAll(/^ {2}([A-Z][A-Z_0-9]*):\s*'/gm)].map((m) => m[1]);
}

/** Page component modules (excluding test files). */
function pageModuleNames(): string[] {
  return fs
    .readdirSync(path.join(SRC_DIR, 'pages'))
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => f.replace(/\.tsx$/, ''));
}

describe('route reachability', () => {
  it('parses the ROUTES object (guard self-check)', () => {
    // If the ROUTES literal is ever reformatted, the regex above could silently
    // match nothing and make the real assertions vacuously pass.
    expect(routeConstantNames().length).toBeGreaterThan(50);
    expect(routeConstantNames()).toContain('BILLING');
  });

  it('finds page modules (guard self-check)', () => {
    expect(pageModuleNames().length).toBeGreaterThan(50);
    expect(pageModuleNames()).toContain('BillingPage');
  });

  it('renders every ROUTES constant somewhere in App.tsx', () => {
    const orphans = routeConstantNames().filter(
      (name) =>
        !INTENTIONALLY_UNROUTED_CONSTANTS[name] &&
        !APP_SOURCE.includes(`ROUTES.${name}`),
    );

    expect(
      orphans,
      `Route constants defined in routes.ts but never rendered in App.tsx: ${orphans.join(', ')}. ` +
        'A named route nothing mounts is a dead destination — wire it in App.tsx ' +
        'or document it in INTENTIONALLY_UNROUTED_CONSTANTS.',
    ).toEqual([]);
  });

  it('imports every page module in App.tsx (no built-but-unreachable page)', () => {
    const orphans = pageModuleNames().filter(
      (name) =>
        !INTENTIONALLY_UNROUTED_PAGES[name] && !APP_SOURCE.includes(`pages/${name}`),
    );

    expect(
      orphans,
      `Page components with no route in App.tsx: ${orphans.join(', ')}. ` +
        'These are built screens the user cannot reach (the PricingPage/checkout ' +
        'class of defect) — route them, or document them in INTENTIONALLY_UNROUTED_PAGES.',
    ).toEqual([]);
  });

  it('routes the pricing page that owns the Stripe checkout call', () => {
    // Explicit regression pin for the launch blocker: the checkout surface
    // specifically must be reachable, not merely "most pages are routed".
    // Boolean form, not toContain: a failed toContain against a whole source
    // file dumps App.tsx into the diff and buries the actual failure.
    expect(APP_SOURCE.includes('pages/PricingPage')).toBe(true);
    expect(APP_SOURCE.includes('ROUTES.PRICING')).toBe(true);
  });
});
