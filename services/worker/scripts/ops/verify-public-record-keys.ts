/**
 * NPH-16 — Verify OpenStates / SAM.gov / CourtListener API keys BEFORE
 * deploying them to Cloud Run.
 *
 * Each check makes a single cheap GET request. No writes, no DB, no
 * background processing. Prints a one-line result per provider and
 * exits non-zero if ANY provider fails so CI / humans can gate a deploy.
 *
 * Usage:
 *   OPENSTATES_API_KEY=... \
 *   SAM_GOV_API_KEY=... \
 *   COURTLISTENER_API_TOKEN=... \
 *     npx tsx scripts/ops/verify-public-record-keys.ts
 *
 * Jira: SCRUM-728 (NPH-16)
 */

interface CheckResult {
  provider: string;
  ok: boolean;
  status: number;
  message: string;
}

async function verifyOpenStates(apiKey: string | undefined): Promise<CheckResult> {
  if (!apiKey) return { provider: 'openstates', ok: false, status: 0, message: 'OPENSTATES_API_KEY not set' };
  try {
    const res = await fetch('https://v3.openstates.org/jurisdictions?classification=state&per_page=1', {
      headers: { 'X-API-KEY': apiKey },
    });
    if (!res.ok) {
      return { provider: 'openstates', ok: false, status: res.status, message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { results?: unknown[] };
    const count = body.results?.length ?? 0;
    return { provider: 'openstates', ok: true, status: 200, message: `fetched ${count} results` };
  } catch (err) {
    return { provider: 'openstates', ok: false, status: 0, message: (err as Error).message };
  }
}

async function verifySamGov(apiKey: string | undefined): Promise<CheckResult> {
  if (!apiKey) return { provider: 'sam.gov', ok: false, status: 0, message: 'SAM_GOV_API_KEY not set' };
  try {
    // Entity Management Public v4 — one result, cheapest query.
    const url = new URL('https://api.sam.gov/entity-information/v4/entities');
    url.searchParams.set('samRegistered', 'Yes');
    url.searchParams.set('registrationStatus', 'A');
    url.searchParams.set('includeSections', 'entityRegistration');
    url.searchParams.set('size', '1');
    url.searchParams.set('api_key', apiKey);
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return { provider: 'sam.gov', ok: false, status: res.status, message: `HTTP ${res.status}` };
    }
    return { provider: 'sam.gov', ok: true, status: 200, message: 'accepted' };
  } catch (err) {
    return { provider: 'sam.gov', ok: false, status: 0, message: (err as Error).message };
  }
}

async function verifyCourtListener(token: string | undefined): Promise<CheckResult> {
  if (!token) return { provider: 'courtlistener', ok: false, status: 0, message: 'COURTLISTENER_API_TOKEN not set' };
  try {
    const res = await fetch('https://www.courtlistener.com/api/rest/v4/opinions/?page_size=1', {
      headers: { Authorization: `Token ${token}` },
    });
    if (!res.ok) {
      return { provider: 'courtlistener', ok: false, status: res.status, message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { count?: number; results?: unknown[] };
    const n = body.results?.length ?? 0;
    return { provider: 'courtlistener', ok: true, status: 200, message: `fetched ${n} opinions (total ${body.count ?? 'unknown'})` };
  } catch (err) {
    return { provider: 'courtlistener', ok: false, status: 0, message: (err as Error).message };
  }
}

async function main(): Promise<number> {
  const results = await Promise.all([
    verifyOpenStates(process.env.OPENSTATES_API_KEY),
    verifySamGov(process.env.SAM_GOV_API_KEY),
    verifyCourtListener(process.env.COURTLISTENER_API_TOKEN),
  ]);

  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    const statusFragment = r.status ? `(HTTP ${r.status})` : '';
    console.log(`[${r.provider}] ${icon} ${r.ok ? 'key accepted' : 'check failed'} ${statusFragment} — ${r.message}`);
  }

  const allOk = results.every((r) => r.ok);
  if (!allOk) {
    console.error('\nOne or more keys failed verification. Do NOT deploy. See docs/runbooks/nph-16-deploy-api-keys.md §3.');
    return 1;
  }
  console.log('\nAll three keys verified. Safe to deploy per docs/runbooks/nph-16-deploy-api-keys.md §4.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('verify-public-record-keys: unexpected error', err);
    process.exit(2);
  },
);
