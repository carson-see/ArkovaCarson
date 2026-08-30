/**
 * public-projection-driver.ts — targeted soak driver for the
 * `mig-public-projection` batch (PR #2314 / migration 0415, and
 * PR #2440 / migration 0421).
 *
 * WHAT THIS EXERCISES (the batch's OWN changed behavior, not generic health):
 *
 *  * #2314 / 0415 — FERPA §99.37 directory-information suppression. The
 *    `directory_info_opt_out` column has existed since 0197 and NO public
 *    projection read it. This driver calls the two ANONYMOUS surfaces for
 *    real — `public.get_public_anchor` over PostgREST and
 *    `GET /api/v1/verify/:publicId` on the worker — and asserts that an
 *    opted-out subject's directory fields (issued/expiry dates, issuer
 *    identity, filename) are WITHHELD, while a non-opted-out subject's are
 *    returned. The negative case is proven CROSS-ORG: org B's opted-out
 *    record must suppress too, and org B's published record must carry org
 *    B's issuer identity, never org A's.
 *
 *  * #2440 / 0421 — canonical `anchors.sub_type` projection. Asserts the
 *    RPC emits the column value (not the metadata duplicate, not a fallback)
 *    for every seeded sub_type, and emits an explicit `null` — key PRESENT —
 *    when the column is null, which is what makes the renderer fall back to
 *    the parent type label instead of the meaningless "Other".
 *
 * PROJECTION-HEAD MODES. 0415 and 0421 BOTH `CREATE OR REPLACE
 * public.get_public_anchor`, and neither body contains the other's change, so
 * the LAST one applied wins outright. `--projection-head` tells the driver
 * which body is live so its assertions describe reality rather than hope:
 *
 *   --projection-head=0415  FERPA suppression enforced; sub_type absent.
 *   --projection-head=0421  sub_type projected; FERPA suppression CLOBBERED
 *                           on get_public_anchor (the worker REST surface
 *                           still suppresses — that half is TS, not SQL).
 *
 * Usage:
 *   STAGING_API_BASE=... STAGING_SUPABASE_URL=... STAGING_SUPABASE_SERVICE_ROLE_KEY=... \
 *   STAGING_SUPABASE_ANON_KEY=... \
 *     npx tsx scripts/staging/targeted/public-projection-driver.ts \
 *       --duration 60 --projection-head 0421 --evidence-out docs/staging/.../x.json
 */
import { parseArgs } from 'node:util';
import {
  newDriverStats,
  recordOutcome,
  summarizeEvidence,
  bodySnippet,
  type DriverStats,
  type JsonBody,
} from './driver-core.js';
import { iamOnlyHeaders, requireEnv, writeEvidenceFile } from './runtime.js';

// ─── Fixture identity ───────────────────────────────────────────────────────
// Stable synthetic UUIDs so re-running the driver is idempotent and every row
// is obviously a soak fixture. `MPP` = mig-public-projection.
const ORG_A = '99ff0000-0000-4000-8000-0000000000a1';
const ORG_B = '99ff0000-0000-4000-8000-0000000000b1';
const USER_A = '99ff0000-0000-4000-8000-0000000000a2';
const USER_B = '99ff0000-0000-4000-8000-0000000000b2';

interface AnchorSpec {
  id: string;
  publicId: string;
  org: string;
  user: string;
  credentialType: string | null;
  subType: string | null;
  optOut: boolean;
  /** Does the FERPA predicate suppress this row? (the expected answer) */
  suppressed: boolean;
}

const ANCHORS: AnchorSpec[] = [
  // ── org A ────────────────────────────────────────────────────────────────
  { id: '99ff0001-0000-4000-8000-000000000001', publicId: 'ARK-MPP-A-OPTDEG', org: ORG_A, user: USER_A,
    credentialType: 'DEGREE', subType: 'official_undergraduate', optOut: true,  suppressed: true },
  // The prod-shaped case: opted out with a NULL type. 100% of the real rows
  // carrying the flag look like this, and the pre-0415 predicate published
  // every one of them.
  { id: '99ff0001-0000-4000-8000-000000000002', publicId: 'ARK-MPP-A-OPTNULL', org: ORG_A, user: USER_A,
    credentialType: null, subType: null, optOut: true, suppressed: true },
  { id: '99ff0001-0000-4000-8000-000000000003', publicId: 'ARK-MPP-A-NOOPTDEG', org: ORG_A, user: USER_A,
    credentialType: 'DEGREE', subType: 'official_graduate', optOut: false, suppressed: false },
  // Boundary: §99.37 is an education-records right. A PRESENT non-education
  // type still publishes even with the flag set.
  { id: '99ff0001-0000-4000-8000-000000000004', publicId: 'ARK-MPP-A-OPTLIC', org: ORG_A, user: USER_A,
    credentialType: 'LICENSE', subType: 'state_license', optOut: true, suppressed: false },
  // ── sub_type projection cases (#2440) ────────────────────────────────────
  { id: '99ff0001-0000-4000-8000-000000000005', publicId: 'ARK-MPP-A-OTHPRO', org: ORG_A, user: USER_A,
    credentialType: 'OTHER', subType: 'Professional Certification', optOut: false, suppressed: false },
  { id: '99ff0001-0000-4000-8000-000000000006', publicId: 'ARK-MPP-A-OTHRN', org: ORG_A, user: USER_A,
    credentialType: 'OTHER', subType: 'nursing_rn', optOut: false, suppressed: false },
  { id: '99ff0001-0000-4000-8000-000000000007', publicId: 'ARK-MPP-A-OTHNULL', org: ORG_A, user: USER_A,
    credentialType: 'OTHER', subType: null, optOut: false, suppressed: false },
  // ── org B (cross-org / isolation) ────────────────────────────────────────
  { id: '99ff0002-0000-4000-8000-000000000001', publicId: 'ARK-MPP-B-OPTDEG', org: ORG_B, user: USER_B,
    credentialType: 'DEGREE', subType: 'official_undergraduate', optOut: true, suppressed: true },
  { id: '99ff0002-0000-4000-8000-000000000002', publicId: 'ARK-MPP-B-OTHCLE', org: ORG_B, user: USER_B,
    credentialType: 'OTHER', subType: 'cle_ethics', optOut: false, suppressed: false },
];

// ─── args ───────────────────────────────────────────────────────────────────
interface Args {
  durationMin: number;
  evidenceOut?: string;
  projectionHead: '0415' | '0421';
  seedOnly: boolean;
  passIntervalMs: number;
}

function parse(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: 'string' },
      'evidence-out': { type: 'string' },
      'projection-head': { type: 'string' },
      'seed-only': { type: 'boolean', default: false },
      'pass-interval-sec': { type: 'string' },
    },
    allowPositionals: true,
  });
  const head = values['projection-head'] ?? '0421';
  if (head !== '0415' && head !== '0421') {
    throw new Error(`--projection-head must be 0415 or 0421; got '${head}'`);
  }
  return {
    durationMin: values.duration ? Number(values.duration) : 15,
    evidenceOut: values['evidence-out'],
    projectionHead: head,
    seedOnly: values['seed-only'] === true,
    passIntervalMs: (values['pass-interval-sec'] ? Number(values['pass-interval-sec']) : 30) * 1000,
  };
}

// ─── fixture verification ───────────────────────────────────────────────────
// The fixtures themselves are seeded by scripts/staging/seed-mpp-projection-fixture.sql
// (auth.users -> organizations -> profiles -> anchors, and the anchor INSERT needs a
// transaction-local service_role claim, which PostgREST cannot express). This step
// only PROVES they are present before the window opens, so a driver can never
// report a green soak against an empty rig.
async function verifyFixtures(url: string, key: string, log: (m: string) => void): Promise<void> {
  const ids = ANCHORS.map((a) => a.publicId).join(',');
  const res = await fetch(
    `${url}/rest/v1/anchors?select=public_id,credential_type,sub_type,directory_info_opt_out&public_id=in.(${ids})`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`fixture check failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = (await res.json()) as Array<{ public_id: string }>;
  const found = new Set(rows.map((r) => r.public_id));
  const missing = ANCHORS.filter((a) => !found.has(a.publicId)).map((a) => a.publicId);
  if (missing.length) {
    throw new Error(
      `missing ${missing.length} fixture anchor(s): ${missing.join(', ')} — run ` +
        'psql -f scripts/staging/seed-mpp-projection-fixture.sql against the rig first.',
    );
  }
  log(`fixtures verified: ${rows.length}/${ANCHORS.length} projection anchors present`);
}

// ─── assertions ─────────────────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** FERPA: what the SQL projection must look like for a SUPPRESSED row. */
function assertSqlSuppressed(b: JsonBody): string | null {
  if (!isObj(b)) return 'not an object';
  if (b.issued_date !== null) return `issued_date leaked: ${JSON.stringify(b.issued_date)}`;
  if (b.expiry_date !== null) return `expiry_date leaked: ${JSON.stringify(b.expiry_date)}`;
  if (b.issuer_public_id !== null) return `issuer_public_id leaked: ${JSON.stringify(b.issuer_public_id)}`;
  if (b.issuer_name !== 'Unknown Issuer') return `issuer_name leaked: ${JSON.stringify(b.issuer_name)}`;
  if (typeof b.filename === 'string' && b.filename.includes('Jordan Rivera')) {
    return `filename leaked learner name: ${b.filename}`;
  }
  if (b.directory_info_suppressed !== true) return 'directory_info_suppressed marker absent';
  return null;
}

/** FERPA: what it must look like for a PUBLISHED row. */
function assertSqlPublished(b: JsonBody): string | null {
  if (!isObj(b)) return 'not an object';
  if (b.issued_date === null || b.issued_date === undefined) return 'issued_date withheld on a non-opted-out row';
  if (!b.issuer_public_id) return 'issuer_public_id withheld on a non-opted-out row';
  if ('directory_info_suppressed' in b) return 'suppression marker present on a published row';
  return null;
}

/** #2440: canonical sub_type projection. */
function assertSubType(b: JsonBody, expected: string | null): string | null {
  if (!isObj(b)) return 'not an object';
  if (!('sub_type' in b)) return 'sub_type key ABSENT (0421 not live / clobbered)';
  if (b.sub_type !== expected) return `sub_type=${JSON.stringify(b.sub_type)} expected ${JSON.stringify(expected)}`;
  return null;
}

/** Per-org isolation: the published record carries ITS OWN org's identity. */
function assertOrgIsolation(b: JsonBody, expectedIssuer: string): string | null {
  if (!isObj(b)) return 'not an object';
  if (b.issuer_name !== expectedIssuer) {
    return `cross-org issuer bleed: got ${JSON.stringify(b.issuer_name)} expected ${JSON.stringify(expectedIssuer)}`;
  }
  return null;
}

/** Worker REST surface: TS predicate (suppressesDirectoryInfo) — 0415's twin. */
function assertRestSuppressed(b: JsonBody): string | null {
  if (!isObj(b)) return 'not an object';
  const r = isObj(b.result) ? b.result : b;
  const cred = isObj(r.credential) ? r.credential : r;
  const leaked: string[] = [];
  for (const k of ['issued_date', 'issued_at', 'expiry_date', 'expires_at', 'recipient_name']) {
    if (cred[k] !== null && cred[k] !== undefined) leaked.push(`${k}=${JSON.stringify(cred[k])}`);
  }
  return leaked.length ? `directory fields present on REST: ${leaked.join(', ')}` : null;
}

// ─── one labeled, semantically-asserted call ────────────────────────────────
interface CallOpts {
  stats: DriverStats;
  label: string;
  url: string;
  endpoint: string;
  headers: Record<string, string>;
  body?: string;
  method?: string;
  okStatuses: readonly number[];
  assert?: (b: JsonBody) => string | null;
  captureFailures: string[];
}

async function call(o: CallOpts): Promise<void> {
  const start = Date.now();
  let status = 0;
  let parsed: JsonBody = null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(o.url, {
      method: o.method ?? 'POST',
      headers: o.headers,
      body: o.body,
      signal: ctrl.signal,
    });
    status = res.status;
    parsed = bodySnippet(await res.text());
  } catch {
    status = 0;
  } finally {
    clearTimeout(t);
  }

  let semanticFailure: string | null = null;
  const httpOk = status !== 0 && o.okStatuses.includes(status);
  if (httpOk && o.assert) semanticFailure = o.assert(parsed);
  const expected = httpOk && semanticFailure === null;
  if (!expected) {
    const why = !httpOk ? `http ${status}` : `assert: ${semanticFailure}`;
    const line = `${o.label} ${o.endpoint} -> ${why}`;
    if (o.captureFailures.length < 40) o.captureFailures.push(line);
  }
  recordOutcome(o.stats, {
    label: o.label,
    endpoint: o.endpoint,
    method: o.method ?? 'POST',
    status,
    latencyMs: Date.now() - start,
    expected,
    ...(expected ? {} : { capturedBody: parsed }),
  });
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const apiBase = requireEnv('STAGING_API_BASE', 'public-projection-driver').replace(/\/$/, '');
  const sbUrl = requireEnv('STAGING_SUPABASE_URL', 'public-projection-driver').replace(/\/$/, '');
  const svcKey = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY', 'public-projection-driver');
  const anonKey = requireEnv('STAGING_SUPABASE_ANON_KEY', 'public-projection-driver');
  const log = (m: string) => console.log(`[mpp] ${new Date().toISOString()} ${m}`);

  if (/vzwyaatejekddvltxyye/.test(sbUrl) || /arkova-worker-[0-9]+\.us-central1|arkova-worker-kvojbeutfa/.test(apiBase)) {
    throw new Error('refusing to run against production');
  }

  log(`api_base=${apiBase} rig=${sbUrl} projection_head=${args.projectionHead} duration=${args.durationMin}min`);
  await verifyFixtures(sbUrl, svcKey, log);
  if (args.seedOnly) {
    log('--seed-only: fixture verification done.');
    return;
  }

  const stats = newDriverStats();
  const captureFailures: string[] = [];
  const rpcUrl = `${sbUrl}/rest/v1/rpc/get_public_anchor`;
  const anonHeaders = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  };

  const endAt = Date.now() + args.durationMin * 60_000;
  let pass = 0;
  while (Date.now() < endAt) {
    for (const a of ANCHORS) {
      const body = JSON.stringify({ p_public_id: a.publicId });

      // ── SQL projection (anonymous PostgREST) ──
      // FERPA assertions apply only while 0415's body is the live one.
      const ferpaAssert =
        args.projectionHead === '0415'
          ? a.suppressed
            ? assertSqlSuppressed
            : assertSqlPublished
          : undefined;
      await call({
        stats,
        label: a.suppressed ? 'sql:ferpa_suppressed' : 'sql:ferpa_published',
        url: rpcUrl,
        endpoint: 'rpc/get_public_anchor',
        headers: anonHeaders,
        body,
        okStatuses: [200],
        assert: ferpaAssert,
        captureFailures,
      });

      // sub_type assertions apply only while 0421's body is the live one.
      if (args.projectionHead === '0421') {
        await call({
          stats,
          label: a.subType === null ? 'sql:subtype_null' : 'sql:subtype_projected',
          url: rpcUrl,
          endpoint: 'rpc/get_public_anchor',
          headers: anonHeaders,
          body,
          okStatuses: [200],
          assert: (b) => assertSubType(b, a.subType),
          captureFailures,
        });
      }

      // Per-org isolation: only meaningful on rows that publish issuer identity.
      if (!a.suppressed || args.projectionHead === '0421') {
        const expectedIssuer = a.org === ORG_A ? 'TSOAK-MPP Alpha University' : 'TSOAK-MPP Bravo College';
        await call({
          stats,
          label: 'sql:org_isolation',
          url: rpcUrl,
          endpoint: 'rpc/get_public_anchor',
          headers: anonHeaders,
          body,
          okStatuses: [200],
          assert: (b) => assertOrgIsolation(b, expectedIssuer),
          captureFailures,
        });
      }

      // ── worker REST surface (anonymous to the app, IAM to Cloud Run) ──
      await call({
        stats,
        label: a.suppressed ? 'rest:ferpa_suppressed' : 'rest:ferpa_published',
        url: `${apiBase}/api/v1/verify/${a.publicId}`,
        endpoint: '/api/v1/verify/:publicId',
        method: 'GET',
        headers: iamOnlyHeaders(),
        okStatuses: [200],
        assert: a.suppressed ? assertRestSuppressed : undefined,
        captureFailures,
      });
    }

    // Not-found control: the projection must not 500 on an unknown id.
    await call({
      stats,
      label: 'sql:not_found_control',
      url: rpcUrl,
      endpoint: 'rpc/get_public_anchor',
      headers: anonHeaders,
      body: JSON.stringify({ p_public_id: 'ARK-MPP-DOES-NOT-EXIST' }),
      okStatuses: [200],
      assert: (b) => (isObj(b) && b.error === 'Record not found' ? null : 'expected Record not found'),
      captureFailures,
    });

    pass++;
    if (pass % 20 === 0) {
      const tot = stats.outcomes.length;
      const bad = stats.outcomes.filter((o) => !o.expected).length;
      log(`pass ${pass}: ${tot} requests, ${bad} unexpected`);
    }
    const remaining = endAt - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(args.passIntervalMs, remaining)));
  }

  const evidence = summarizeEvidence(stats, {
    driver: `public-projection-driver@${args.projectionHead}`,
    apiBase,
    pr: '2314,2440',
  });
  const enriched = {
    ...evidence,
    projectionHead: args.projectionHead,
    rigSupabaseUrl: sbUrl,
    passes: pass,
    assertionFailures: captureFailures,
  };
  writeEvidenceFile(args.evidenceOut, enriched);
  log(`done: ${evidence.totalRequests} requests, allExpected=${evidence.allExpected}, passes=${pass}`);
  for (const [label, s] of Object.entries(evidence.byLabel)) {
    log(`  ${label}: ok=${s.expected} bad=${s.unexpected} p95=${s.p95Ms}ms`);
  }
}

main().catch((err) => {
  console.error(`[mpp] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
