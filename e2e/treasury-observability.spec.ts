/**
 * SCRUM-2901 (PI-0.5) — Treasury observability E2E: all three data legs mocked
 * at the network boundary + degrade-to-null.
 *
 * Companion to `e2e/treasury-errors.spec.ts` (SCRUM-1260), which pins the
 * worker-DOWN failure/stale paths. This file pins the complementary axis —
 * worker UP — and the graceful-degradation contract that the #1600 treasury
 * balance-source fix depends on:
 *
 *   Leg 1  worker  GET /api/treasury/status  → authoritative fee-account
 *          balance + anchor stats + coarse fee rate.
 *   Leg 2  worker  GET /api/treasury/health  → treasury-cache freshness.
 *   Leg 3  public  mempool.space /address/<addr>/txs, /v1/prices,
 *          /v1/fees/recommended → display-only receipts + USD price
 *          enrichment + granular fee rates.
 *
 * Every leg is stubbed with Playwright `route()` — NO live mempool.space or
 * live worker call runs in CI (a live third-party dependency in the e2e job
 * is exactly the flake/sovereignty risk SCRUM-1260 called out). The address
 * `/utxo` balance-equivalent endpoint is asserted to be NEVER called, so the
 * browser can never silently fall back to direct mempool balance polling.
 *
 * Degrade-to-null (the core SCRUM-2901 assertion): when the authoritative
 * worker leg succeeds but a mempool enrichment leg fails, the page keeps the
 * worker-sourced BTC balance visible and simply omits the USD line
 * (`TreasuryBalance.totalUsd === null`) — it never shows a balance-error
 * banner for a display-only enrichment failure.
 *
 * @see src/hooks/useTreasuryBalance.ts   (fetchAll — the three-leg fan-out)
 * @see src/components/admin/treasury/BalanceCard.tsx  (totalUsd !== null gate)
 * @see e2e/treasury-errors.spec.ts        (worker-DOWN sibling coverage)
 */

import type { Page } from '@playwright/test';
import { test as authTest, expect } from './fixtures';

// Leg 3 (receipts / price / granular fees) is fetched by useTreasuryBalance
// DIRECTLY from mempool.space in the browser. Both the dev (index.html) and
// prod (vercel.json) CSP `connect-src` omit mempool.space, and CSP is enforced
// *before* a request is dispatched — so Playwright `page.route()` can never
// intercept those calls: the leg-3 stubs below would be dead and the page would
// silently degrade to worker-only (no USD, no granular fees, no receipts). The
// treasury CSP is owned by the #1600 balance-source/CSP change, not this
// test-only PR, so we isolate the hook's three-leg contract from the CSP config
// by running the treasury page in a `bypassCSP` context. This lets the
// network-boundary stubs actually fulfill, and it strengthens the sovereignty
// assertion: a stray mempool `/utxo` balance-poll now registers on the counter
// instead of being silently swallowed by CSP.
const test = authTest.extend<{ orgBAdminPage: Page }>({
  orgBAdminPage: async ({ browser }, use) => {
    // '.auth/orgBAdmin.json' (sarah) mirrors ORG_B_ADMIN_STATE in e2e/fixtures/auth.ts.
    const context = await browser.newContext({
      storageState: '.auth/orgBAdmin.json',
      bypassCSP: true,
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

const TREASURY_ADDRESS = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';

// Path-anchored so they match regardless of the worker host (Cloud Run URL in
// CI vs. VITE_WORKER_URL locally). Kept disjoint per leg so a single leg can
// be failed without disturbing the others.
const WORKER_STATUS = /\/api\/treasury\/status(?:[?#].*)?$/;
const WORKER_HEALTH = /\/api\/treasury\/health(?:[?#].*)?$/;
const WORKER_X402 = /\/api\/treasury\/x402-stats(?:[?#].*)?$/;

const MEMPOOL_TXS = /mempool\.space\/api\/address\/[^/]+\/txs(?:[?#].*)?$/;
const MEMPOOL_UTXO = /mempool\.space\/api\/address\/[^/]+\/utxo(?:[?#].*)?$/;
const MEMPOOL_PRICES = /mempool\.space\/api\/v1\/prices(?:[?#].*)?$/;
const MEMPOOL_FEES = /mempool\.space\/api\/v1\/fees\/recommended(?:[?#].*)?$/;

// Balance split so every on-screen BTC string is UNIQUE (BalanceCard renders
// total, confirmed, and unconfirmed — identical values would collide under
// Playwright strict-mode locators):
//   total       → formatBtc(250_000_000) = "2.50000000"  (the headline value)
//   confirmed   → formatBtc(200_000_000) = "2.00000000"
//   unconfirmed → formatBtc( 50_000_000) = "0.50000000"  (rendered "+0.50000000")
//   USD (total) → 2.5 BTC * $40,000       = "$100,000.00"
//   price       → formatUsd(40_000)       = "$40,000.00"
const BALANCE_SATS = 250_000_000;
const CONFIRMED_SATS = 200_000_000;
const UNCONFIRMED_SATS = 50_000_000;
const BTC_TEXT = '2.50000000';
const USD_TEXT = '$100,000.00';
const PRICE_UNIT_TEXT = '$40,000.00';

// 64-hex receipt txid → ReceiptTable truncates to first8…last8.
const RECEIPT_TXID = `${'deadbeef'.repeat(7)}cafebabe`;
const RECEIPT_TRUNCATED = 'deadbeef...cafebabe';

function workerStatusBody() {
  return JSON.stringify({
    wallet: {
      balanceSats: BALANCE_SATS,
      confirmedBalanceSats: CONFIRMED_SATS,
      unconfirmedBalanceSats: UNCONFIRMED_SATS,
      utxoCount: 3,
    },
    fees: { currentRateSatPerVbyte: 7 },
    recentAnchors: {
      totalSecured: 2_972_264,
      totalPending: 0,
      lastSecuredAt: '2026-07-21T00:00:00.000Z',
      last24hCount: 12,
      distinctTxIds: 1,
      avgAnchorsPerTx: 1,
    },
  });
}

function workerHealthBody() {
  // "now" → isFreshnessStale() returns false → no Stale badge.
  return JSON.stringify({ last_updated_at: new Date().toISOString() });
}

function mempoolTxsBody() {
  return JSON.stringify([
    {
      txid: RECEIPT_TXID,
      fee: 1234,
      size: 250,
      weight: 1000,
      status: { confirmed: true, block_height: 900_000, block_time: 1_770_000_000 },
      vout: [{ scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_asm: '', value: 5000 }],
    },
  ]);
}

const mempoolPricesBody = () => JSON.stringify({ USD: 40_000 });
const mempoolFeesBody = () =>
  JSON.stringify({ fastestFee: 9, halfHourFee: 6, hourFee: 4, economyFee: 2, minimumFee: 1 });

/** Stub the two worker legs (status + health) with success + the x402 panel
 *  so the page renders cleanly. Returns a counter of mempool /utxo hits that
 *  each test asserts stays at 0 (no direct-balance-polling fallback). */
async function stubWorkerLegs(page: Page): Promise<{ utxoHits: () => number }> {
  await page.route(WORKER_STATUS, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: workerStatusBody() }),
  );
  await page.route(WORKER_HEALTH, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: workerHealthBody() }),
  );
  // Body MUST match the shape X402PaymentStats consumes ({ total, revenue,
  // recent }). A mismatched payload (e.g. { totalUsdc, count }) leaves
  // `stats.total` undefined, which slips past the `stats.total === 0`
  // empty-state guard and reaches `stats.revenue.toFixed(4)` on undefined —
  // that throw is swallowed by the Treasury <RouteErrorBoundary>, blanking the
  // entire page (balance included). `total: 0` renders the safe empty state.
  await page.route(WORKER_X402, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total: 0, revenue: 0, recent: [] }),
    }),
  );

  let utxoHits = 0;
  await page.route(MEMPOOL_UTXO, (route) => {
    utxoHits++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return { utxoHits: () => utxoHits };
}

test.describe('SCRUM-2901 — Treasury observability (three legs mocked at the network boundary)', () => {
  // No DB setup: the browser hook never reads treasury_cache (SCRUM-1260 —
  // worker/cache is worker-owned), and all three legs are stubbed at the
  // network boundary below, so this suite needs no seeded state and no
  // service client. Cache freshness is driven solely by the mocked
  // /api/treasury/health payload.

  test('all three legs healthy → worker balance + USD enrichment + receipts + fees render, cache fresh', async ({
    orgBAdminPage,
  }) => {
    const { utxoHits } = await stubWorkerLegs(orgBAdminPage);
    await orgBAdminPage.route(MEMPOOL_TXS, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mempoolTxsBody() }),
    );
    await orgBAdminPage.route(MEMPOOL_PRICES, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mempoolPricesBody() }),
    );
    await orgBAdminPage.route(MEMPOOL_FEES, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mempoolFeesBody() }),
    );

    await orgBAdminPage.goto('/admin/treasury');

    // Leg 1 — authoritative balance.
    await expect(orgBAdminPage.getByText(BTC_TEXT)).toBeVisible({ timeout: 12_000 });
    // Leg 3 — price enrichment produced a non-null totalUsd + per-unit price.
    await expect(orgBAdminPage.getByText(USD_TEXT)).toBeVisible();
    await expect(orgBAdminPage.getByText(`@ ${PRICE_UNIT_TEXT}/unit`)).toBeVisible();
    // Leg 3 — receipts + granular fees.
    await expect(orgBAdminPage.getByText(RECEIPT_TRUNCATED)).toBeVisible();
    await expect(orgBAdminPage.getByText('9 sat/vB').first()).toBeVisible();
    // Leg 2 — fresh cache: no error banners, no Stale badge.
    await expect(orgBAdminPage.getByTestId('treasury-balance-error')).toHaveCount(0);
    await expect(orgBAdminPage.getByTestId('treasury-cache-error')).toHaveCount(0);
    await expect(
      orgBAdminPage.getByTestId('treasury-cache-freshness').getByText('Stale'),
    ).toHaveCount(0);
    // Sovereignty: no direct mempool balance (/utxo) polling ever fired.
    expect(utxoHits()).toBe(0);
  });

  test('degrade-to-null: worker up but mempool /v1/prices fails → BTC balance stays, USD omitted, no error banner', async ({
    orgBAdminPage,
  }) => {
    const { utxoHits } = await stubWorkerLegs(orgBAdminPage);
    await orgBAdminPage.route(MEMPOOL_TXS, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mempoolTxsBody() }),
    );
    // Price enrichment leg fails.
    await orgBAdminPage.route(MEMPOOL_PRICES, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"prices down"}' }),
    );
    await orgBAdminPage.route(MEMPOOL_FEES, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mempoolFeesBody() }),
    );

    await orgBAdminPage.goto('/admin/treasury');

    // Authoritative worker balance still renders.
    await expect(orgBAdminPage.getByText(BTC_TEXT)).toBeVisible({ timeout: 12_000 });
    // totalUsd stayed null → the USD line (and per-unit price) is absent.
    await expect(orgBAdminPage.getByText(USD_TEXT)).toHaveCount(0);
    await expect(orgBAdminPage.getByText(`@ ${PRICE_UNIT_TEXT}/unit`)).toHaveCount(0);
    // A display-only enrichment failure must NOT raise a balance-error banner.
    await expect(orgBAdminPage.getByTestId('treasury-balance-error')).toHaveCount(0);
    expect(utxoHits()).toBe(0);
  });

  test('degrade-to-null: worker up but the ENTIRE mempool leg fails → balance stays, no USD, no error, no balance fallback', async ({
    orgBAdminPage,
  }) => {
    const { utxoHits } = await stubWorkerLegs(orgBAdminPage);
    // Every mempool enrichment endpoint is unavailable.
    for (const pattern of [MEMPOOL_TXS, MEMPOOL_PRICES, MEMPOOL_FEES]) {
      await orgBAdminPage.route(pattern, (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
      );
    }

    await orgBAdminPage.goto('/admin/treasury');

    await expect(orgBAdminPage.getByText(BTC_TEXT)).toBeVisible({ timeout: 12_000 });
    await expect(orgBAdminPage.getByText(USD_TEXT)).toHaveCount(0);
    await expect(orgBAdminPage.getByTestId('treasury-balance-error')).toHaveCount(0);
    // The whole point of SCRUM-1260 Forensic 1: worker-authoritative balance
    // must never be replaced by a direct mempool /utxo balance read.
    expect(utxoHits()).toBe(0);
  });
});
