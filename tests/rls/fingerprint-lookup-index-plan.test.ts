/**
 * LIVE proof that `get_public_anchor_by_fingerprint` can still reach
 * `idx_anchors_fingerprint_lookup` by INDEX COND (migration 0441).
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * Found in production 2026-09-08 during the SCRUM-3797 edge catch-up deploy:
 * the MCP tools `verify` (by fingerprint) and `get_fingerprint` on
 * https://edge.arkova.ai returned `isError: "Document verification timed out"`.
 *
 * `anchors.fingerprint` is `character(64)` (bpchar); the RPC parameter is
 * `text`. There is no `bpchar = text` operator, so `a.fingerprint =
 * lower(p_fingerprint)` made Postgres cast the COLUMN — `Filter:
 * ((fingerprint)::text = …)` — and a btree on the bare bpchar column cannot
 * drive an expression it was not built on. The fingerprint predicate was
 * demoted from an Index Cond to a Filter, the planner fell back to
 * `idx_anchors_status_secured_submitted` over the ~3.5M-row SECURED partition
 * at cost 2,302,395, and the statement blew `statement_timeout`. 0441 casts the
 * PARAMETER instead (`lower(p_fingerprint)::bpchar`); prod EXPLAIN with the cast
 * is an `Index Scan using idx_anchors_fingerprint_lookup` at 3.020 ms.
 *
 * ── WHY THIS TEST IS SHAPED THE WAY IT IS ───────────────────────────────────
 *
 * A TIMING assertion cannot catch this and must not be written. The 12h
 * retro-soak that preceded the outage ran against a 10-row rig fixture, where a
 * sequential scan is instant — the defect is invisible below roughly a million
 * rows, and no CI fixture will ever be that big. Seeding to prod scale to make
 * a stopwatch meaningful would trade a fast, exact test for a slow, flaky one.
 *
 * So this pins the PLAN, which is tested against a selective owned fixture:
 *
 *   1. `SET enable_seqscan = off` removes the only variable that actually
 *      permits a sequential scan. Index selection still depends on cost, so
 *      the suite seeds 2,048 owned SECURED rows to make the fingerprint
 *      selective compared with the status index. The assertion is structural.
 *   2. The assertion is on `Index Cond`, not on the index NAME appearing
 *      somewhere in the plan. With seqscan disabled the planner will happily
 *      choose a FULL scan of `idx_anchors_fingerprint_lookup` and apply
 *      `(fingerprint)::text = …` as a Filter — a plan that contains the index
 *      name while doing exactly the pathological thing. Asserting the name alone
 *      would pass on the broken function.
 *   3. The query is extracted from the LIVE function body in `pg_proc`, not
 *      copied into this file. A test that re-typed the predicate would keep
 *      passing after someone reverted the function; this one degrades with it.
 *      That is the point of `tests/rls/agents.md`'s rule — a mock may stand in
 *      for a collaborator, never for the invariant under test.
 *   4. A NEGATIVE CONTROL runs the pre-0441 form of that same extracted query
 *      and asserts it does NOT reach the index. Without it, "the plan is an
 *      index scan" could be an artifact of a small fixture rather than proof
 *      this test would have failed before the fix.
 *   5. A POSITIVE CONTROL calls the function for real. "No `(fingerprint)::text`
 *      in the plan" passes just as well against a function that is broken,
 *      renamed, or returns nothing — which looks like a fix and is an outage.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const INDEX = 'idx_anchors_fingerprint_lookup';

// Same loopback-fixture guard as oauth-email-confirmation.test.ts: this suite
// runs EXPLAIN and seeds rows, so it must never be pointed at a shared rig or
// at production by a stray environment variable.
const dbUrl = process.env.RLS_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const fixtureUrl = new URL(dbUrl);
if (!['postgres:', 'postgresql:'].includes(fixtureUrl.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname)
  || !['54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixtureUrl.port)) {
  throw new Error('fingerprint index-plan regression requires an owned loopback PostgreSQL fixture or repository CI port block');
}

function sql(body: string): string {
  try {
    return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-v', 'SHOW_ALL_RESULTS=off', '-At'], {
      input: body, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    const primaryError = stderr?.match(/^ERROR:[ \t]+([^\r\n]+)/m)?.[1];
    throw new Error(primaryError || stderr?.split(/\r?\n/, 1)[0]?.trim() || 'Local PostgreSQL fixture command failed');
  }
}

function quote(literal: string): string {
  return `'${literal.replace(/'/g, "''")}'`;
}

/** The live body of the deployed function — the authority this suite reads. */
function liveBody(): string {
  // Match the single-`text`-argument overload by TYPE, not by
  // pg_get_function_identity_arguments — that renders as `p_fingerprint text`
  // (name included), so an equality test against 'text' silently matches
  // nothing and every assertion below would fail for the wrong reason.
  const body = sql(
    "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
    + "WHERE n.nspname='public' AND p.proname='get_public_anchor_by_fingerprint' "
    + "AND p.pronargs = 1 AND p.proargtypes[0] = 'text'::regtype",
  ).trim();
  if (!body) throw new Error('public.get_public_anchor_by_fingerprint(text) is not installed in this fixture');
  return body;
}

/**
 * Lift the lookup SELECT out of the live plpgsql body and make it runnable
 * standalone: drop the `INTO` target and bind the parameter to a literal.
 * Extraction is deliberately strict — a body this cannot parse fails the suite
 * loudly rather than silently EXPLAINing a query nobody ships.
 */
function lookupQuery(fingerprint: string): string {
  const block = liveBody().match(/SELECT\s+a\.public_id[\s\S]*?LIMIT\s+1/i)?.[0];
  if (!block) throw new Error('could not locate the fingerprint lookup SELECT in the live function body');
  const runnable = block.replace(/\bINTO\s+v_public_id\b/i, '');
  if (!/\bp_fingerprint\b/.test(runnable)) {
    throw new Error('the extracted lookup SELECT does not reference p_fingerprint — extraction is wrong, not the function');
  }
  return `${runnable.replace(/\bp_fingerprint\b/g, quote(fingerprint))};`;
}

type PlanNode = { 'Node Type'?: string; 'Index Name'?: string; 'Index Cond'?: string; Filter?: string; Plans?: PlanNode[] };

function explain(query: string): PlanNode[] {
  // Disable sequential scans, but retain real competition among indexes.
  // The owned SECURED background cohort makes the fingerprint selective;
  // enable_seqscan=off alone does not force a particular index.
  const raw = sql(`BEGIN; SET LOCAL enable_seqscan = off; EXPLAIN (FORMAT JSON, COSTS OFF) ${query} ROLLBACK;`);
  const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
  const nodes: PlanNode[] = [];
  const walk = (node?: PlanNode) => {
    if (!node) return;
    nodes.push(node);
    node.Plans?.forEach(walk);
  };
  walk((JSON.parse(json) as { Plan: PlanNode }[])[0]?.Plan);
  if (nodes.length === 0) throw new Error('EXPLAIN returned no plan nodes');
  return nodes;
}

/** An index SCAN NAMED the index is not enough — it must carry an Index Cond. */
function indexCondFor(nodes: PlanNode[], index: string): string | undefined {
  return nodes.find((n) => n['Index Name'] === index && n['Index Cond'])?.['Index Cond'];
}

const RUN = randomUUID();
const USER_ID = randomUUID();
const ORG_ID = randomUUID();
const securedFingerprint = randomBytes(32).toString('hex');
const pendingFingerprint = randomBytes(32).toString('hex');
const unknownFingerprint = randomBytes(32).toString('hex');

function seed(fingerprint: string, status: 'SECURED' | 'PENDING'): void {
  const secured = status === 'SECURED';
  sql(
    `INSERT INTO public.anchors (user_id, fingerprint, filename, file_size, status, credential_type, metadata, chain_tx_id, chain_timestamp) `
    + `VALUES (${quote(USER_ID)}::uuid, ${quote(fingerprint)}, ${quote(`fp-plan-${RUN}-${status}.pdf`)}, 1024, ${quote(status)}::public.anchor_status, `
    + `'OTHER'::public.credential_type, '{}'::jsonb, ${secured ? quote(`tx-${RUN}`) : 'NULL'}, ${secured ? 'now()' : 'NULL'});`,
  );
}

describe('0441 — fingerprint lookup keeps idx_anchors_fingerprint_lookup usable', () => {
  beforeAll(() => {
    // Prove the fixture is real before any assertion can pass vacuously against
    // a refused connection or a table that is not there.
    expect(sql("SELECT to_regclass('public.anchors') IS NOT NULL").trim()).toContain('t');
    expect(sql(
      "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
      + "WHERE attrelid='public.anchors'::regclass AND attname='fingerprint'",
    )).toContain('character(64)');
    expect(sql(`SELECT count(*) FROM pg_class WHERE relname=${quote(INDEX)}`).trim()).toContain('1');

    sql(`BEGIN;
      INSERT INTO public.organizations (id, legal_name, display_name) VALUES (${quote(ORG_ID)}::uuid, ${quote(`fp-plan-${RUN}`)}, ${quote(`fp-plan-${RUN}`)});
      INSERT INTO auth.users (id, email) VALUES (${quote(USER_ID)}::uuid, ${quote(`fp-plan-${RUN}@arkova.local`)});
      INSERT INTO public.profiles (id, email, org_id, role) VALUES (${quote(USER_ID)}::uuid, ${quote(`fp-plan-${RUN}@arkova.local`)}, ${quote(ORG_ID)}::uuid, 'ORG_ADMIN');
      COMMIT;`);
    seed(securedFingerprint, 'SECURED');
    seed(pendingFingerprint, 'PENDING');
    // With only one SECURED row the status index is legitimately as selective
    // as the fingerprint index. A modest owned cohort makes the comparison
    // meaningful without a timing assertion or a production-sized fixture.
    sql(`INSERT INTO public.anchors (user_id, fingerprint, filename, file_size, status, credential_type, metadata, chain_tx_id, chain_timestamp)
      SELECT ${quote(USER_ID)}::uuid, md5(${quote(RUN)} || i::text) || md5(i::text || ${quote(RUN)}),
        'fp-plan-background-' || i || '.pdf', 1024, 'SECURED', 'OTHER', '{}'::jsonb, ${quote(`tx-${RUN}`)}, now()
      FROM generate_series(1, 2048) AS i;`);
    // The planner needs statistics that exist; without ANALYZE a brand-new row
    // set can leave the relation at its default estimate.
    sql('ANALYZE public.anchors;');
  });

  afterAll(() => {
    // This suite owns every identity it creates, including partial setup failures.
    sql(`BEGIN; SET LOCAL request.jwt.claims = '{"role":"service_role"}';
      DELETE FROM public.anchors WHERE user_id = ${quote(USER_ID)}::uuid;
      DELETE FROM public.profiles WHERE id = ${quote(USER_ID)}::uuid;
      DELETE FROM auth.users WHERE id = ${quote(USER_ID)}::uuid;
      DELETE FROM public.organizations WHERE id = ${quote(ORG_ID)}::uuid;
      COMMIT;`);
  });

  it('the live function body casts the PARAMETER, not the column', () => {
    const body = liveBody();
    expect(body).toMatch(/a\.fingerprint\s*=\s*lower\(p_fingerprint\)::bpchar/i);
    // The inverse is the defect: casting the indexed side makes the index dead.
    expect(body).not.toMatch(/lower\(\s*a\.fingerprint\s*\)/i);
    expect(body).not.toMatch(/a\.fingerprint\s*::\s*(text|varchar|character varying)/i);
  });

  it('the live lookup predicate reaches the index by Index Cond', () => {
    const nodes = explain(lookupQuery(securedFingerprint));
    const cond = indexCondFor(nodes, INDEX);
    expect(cond, `no Index Cond on ${INDEX}; plan was ${JSON.stringify(nodes)}`).toBeDefined();
    expect(cond).toContain('fingerprint');
  });

  it('no plan node casts the indexed column to text', () => {
    // The exact signature of the production defect: `Filter: ((fingerprint)::text = …)`.
    const filters = explain(lookupQuery(securedFingerprint))
      .flatMap((n) => [n.Filter, n['Index Cond']])
      .filter((f): f is string => Boolean(f));
    expect(filters.some((f) => /\(fingerprint\)::text/i.test(f))).toBe(false);
  });

  it('NEGATIVE CONTROL — the pre-0441 uncast predicate does NOT reach the index', () => {
    // Derived from the same live query so this control cannot drift away from
    // what the function actually runs. If this ever passes the index by Index
    // Cond, the fixture has stopped being able to tell the two apart and the
    // assertion above has quietly lost its teeth.
    const uncast = lookupQuery(securedFingerprint).replace(/::bpchar/gi, '');
    expect(uncast).toMatch(/a\.fingerprint\s*=\s*lower\(/i);
    const nodes = explain(uncast);
    expect(indexCondFor(nodes, INDEX)).toBeUndefined();
  });

  it('POSITIVE CONTROL — the function still resolves a SECURED anchor', () => {
    const result = sql(`SELECT public.get_public_anchor_by_fingerprint(${quote(securedFingerprint)});`);
    expect(result).not.toContain('Record not found');
    expect(result).toContain('public_id');
  });

  it('POSITIVE CONTROL — 0386 SECURED-only invariant survives the cast', () => {
    // An in-flight row and an unknown fingerprint must stay indistinguishable.
    const inFlight = sql(`SELECT public.get_public_anchor_by_fingerprint(${quote(pendingFingerprint)});`).trim();
    const unknown = sql(`SELECT public.get_public_anchor_by_fingerprint(${quote(unknownFingerprint)});`).trim();
    expect(inFlight).toContain('Record not found');
    expect(inFlight).toBe(unknown);
  });

  it('an overlong input is not truncated into an existing fingerprint', () => {
    const result = sql(`SELECT public.get_public_anchor_by_fingerprint(${quote(securedFingerprint + '0')});`).trim();
    expect(result).toContain('Record not found');
    expect(result).toBe(sql(`SELECT public.get_public_anchor_by_fingerprint(${quote(unknownFingerprint)});`).trim());
  });

  it('POSITIVE CONTROL — uppercase input still resolves through the cast', () => {
    // lower() runs before the cast; a caller sending upper-case hex must still
    // match a stored lowercase fingerprint.
    const result = sql(`SELECT public.get_public_anchor_by_fingerprint(${quote(securedFingerprint.toUpperCase())});`);
    expect(result).not.toContain('Record not found');
  });
});
