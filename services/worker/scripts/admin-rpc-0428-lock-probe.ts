/** Persistent PostgreSQL sessions for 0428's controlled lock experiment.
 * Only synthetic fixture rows are touched, and every session is rolled back.
 * psql uses PG* environment variables; credentials never appear in argv/logs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Resolve `psql` to a FIXED absolute path instead of letting the OS search
// `$PATH` (Sonar typescript:S4036 — a writable/attacker-controlled PATH entry
// could shadow the real binary and see the PG* credentials this probe passes
// through the environment). `/usr/bin/psql` is where the Debian/Ubuntu
// `postgresql-client` package installs it, which is what GitHub-hosted runners
// get; `PSQL_BIN` overrides for local dev and self-hosted rigs (e.g.
// Homebrew's `/opt/homebrew/opt/libpq/bin/psql`). Mirrors the GH_BIN / GIT_BIN
// convention in scripts/ci/lib/ciContext.ts.
const PSQL_BIN = process.env.PSQL_BIN ?? '/usr/bin/psql';

const PROD_REF = 'vzwyaatejekddvltxyye';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const BARRIER_MODES = new Set(['ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock']);
type ConnectionEnv = Record<string, string | undefined>;

export function validateProbeTarget(ref: string, env: ConnectionEnv): void {
  if (env.PGHOSTADDR || env.PGSERVICE || env.PGSERVICEFILE || (env.PGDATABASE && !/^[a-zA-Z0-9_]+$/.test(env.PGDATABASE))) throw new Error('Connection indirection is forbidden for an isolated lock probe');
  const host = env.PGHOST ?? '';
  if (ref === 'local-0428' && host === '127.0.0.1' && env.PGPORT === '55428') return;
  if (!/^[a-z]{20}$/.test(ref) || ref === PROD_REF || env.PGPORT !== '5432') {
    throw new Error('Lock probe requires a named isolated project and a session connection on port 5432');
  }
  const direct = host === `db.${ref}.supabase.co`;
  const pooled = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && env.PGUSER === `postgres.${ref}`;
  if (!direct && !pooled) throw new Error('Database connection does not identify the requested isolated project');
}

export function validateFixtureIds(ids: string[]): void {
  if (ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => !UUID.test(id))) {
    throw new Error('Holder, RPC and innocent writer need three distinct UUID fixture rows');
  }
}

class PsqlSession {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private errors = '';
  private pending: { token: string; resolve: (lines: string[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private stopped = false;
  constructor(env: ConnectionEnv, name: string) {
    this.child = spawn(PSQL_BIN, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse'], {
      env: { ...process.env, PGHOSTADDR: undefined, PGSERVICE: undefined, PGSERVICEFILE: undefined, PGDATABASE: 'postgres', ...env, PGAPPNAME: name, PGCONNECT_TIMEOUT: '10' }, stdio: 'pipe',
    });
    this.child.stdout.on('data', data => {
      this.buffer += String(data);
      if (this.pending && this.buffer.includes(`${this.pending.token}\n`)) {
        const p = this.pending; this.pending = null; clearTimeout(p.timer);
        const before = this.buffer.split(`${p.token}\n`, 1)[0]; this.buffer = '';
        p.resolve(before.split('\n').map(x => x.trim()).filter(Boolean));
      }
    });
    this.child.stderr.on('data', data => { this.errors = (this.errors + String(data)).slice(-1500); });
    this.child.stdin.on('error', () => this.fail(new Error('psql input channel closed')));
    this.child.on('error', () => this.fail(new Error('Could not start psql session')));
    this.child.on('close', code => {
      this.stopped = true;
      this.fail(new Error(`psql session ended (${code}): ${this.errors.slice(-500)}`));
    });
  }
  private fail(error: Error): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  query(sql: string): Promise<string[]> {
    if (this.stopped || this.pending) return Promise.reject(new Error('psql session is closed or busy'));
    const token = `probe_${randomUUID().replaceAll('-', '')}`;
    this.buffer = ''; this.errors = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('psql query exceeded 15-second deadline')); this.child.kill('SIGTERM'); }, 15_000);
      this.pending = { token, resolve, reject, timer };
      this.child.stdin.write(`${sql}\n\\echo ${token}\n`);
    });
  }
  close(): void {
    this.fail(new Error('psql session closed during cleanup'));
    this.child.kill('SIGTERM');
  }
}

type Lock = { pid: number; mode: string; granted: boolean; blockers: number[]; lock_wait_ms: number | null };
export type LockProbeResult = {
  rpc: string; barrierObserved: boolean; innocentBlockedByRpc: boolean;
  innocentServerMs: number; innocentRows: number; rpcCompleted: boolean;
  holderConfirmed: boolean; rpcLockConfirmed: boolean;
  pids?: { holder: number; rpc: number; innocent: number };
  observations?: Lock[][];
};

export function assertLockProbeHealthy(result: LockProbeResult): void {
  if (result.barrierObserved || result.innocentBlockedByRpc) throw new Error(`C11 table-write barrier: ${JSON.stringify(result)}`);
  if (!result.holderConfirmed || !result.rpcLockConfirmed || !result.rpcCompleted || result.innocentRows !== 1) {
    throw new Error(`C11 incomplete lock experiment: ${JSON.stringify(result)}`);
  }
  if (!Number.isFinite(result.innocentServerMs) || result.innocentServerMs < 0 || result.innocentServerMs > 3000) {
    throw new Error(`C11 innocent UPDATE exceeded 3000ms inside PostgreSQL: ${JSON.stringify(result)}`);
  }
}

function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: Error } = { done: false };
  const settled = promise.then(value => { state.value = value; state.done = true; }, error => { state.error = error; state.done = true; });
  return { state, settled };
}

const begin = `BEGIN; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='20s';
SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims='{"role":"service_role"}'; SELECT pg_backend_pid();`;

/** Observe a held conflicting writer, all three admin RPCs and a THIRD-row write.
 * Completion/pg_locks are barriers; the 50ms polling delay is not a readiness assumption.
 * The RPC's transaction remains open after its statement so its acquired locks
 * cannot vanish before observation. No Management API HTTP latency is measured.
 */
export async function runLockExperiment(
  ref: string, env: ConnectionEnv, holderId: string, rpcId: string, innocentId: string,
): Promise<LockProbeResult[]> {
  validateProbeTarget(ref, env); validateFixtureIds([holderId, rpcId, innocentId]);
  const results: LockProbeResult[] = [];
  const operations = [
    ['admin_change_user_role', `admin_change_user_role('${rpcId}','ORG_MEMBER')`],
    ['admin_set_platform_admin', `admin_set_platform_admin('${rpcId}',true)`],
    ['admin_set_user_org', `admin_set_user_org('${rpcId}',NULL)`],
  ];
  for (const [name, operation] of operations) {
    const sessions = ['holder', 'rpc', 'innocent', 'observer'].map(n => new PsqlSession(env, `soak0428_${n}`));
    const [holder, rpc, innocent, observer] = sessions;
    try {
      const pids = { holder: Number((await holder.query(begin)).at(-1)), rpc: Number((await rpc.query(begin)).at(-1)), innocent: Number((await innocent.query(begin)).at(-1)) };
      if (new Set(Object.values(pids)).size !== 3 || Object.values(pids).some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error('Independent PostgreSQL backend identities not established');
      await innocent.query(`CREATE FUNCTION pg_temp.arkova_0428_timed_write(target uuid) RETURNS jsonb LANGUAGE plpgsql AS $timed$ DECLARE started timestamptz := clock_timestamp(); changed integer; BEGIN UPDATE public.profiles SET updated_at=clock_timestamp() WHERE id=target; GET DIAGNOSTICS changed = ROW_COUNT; RETURN jsonb_build_object('server_ms',extract(epoch FROM (clock_timestamp()-started))*1000,'rows',changed); END; $timed$;`);
      const changed = await holder.query(`WITH changed AS (UPDATE public.profiles SET updated_at=clock_timestamp() WHERE id='${holderId}' RETURNING id) SELECT count(*) FROM changed;`);
      if (changed[0] !== '1') throw new Error('Holder fixture is absent; no conflicting writer was held');
      const observations: Lock[][] = [];
      const snapshot = async () => {
        const rows = await observer.query(`SELECT coalesce(jsonb_agg(jsonb_build_object('pid',pid,'mode',mode,'granted',granted,'blockers',pg_blocking_pids(pid),'lock_wait_ms',extract(epoch FROM (clock_timestamp()-waitstart))*1000)), '[]'::jsonb)::text FROM pg_locks WHERE relation='public.profiles'::regclass AND pid IN (${Object.values(pids).join(',')});`);
        const locks = JSON.parse(rows[0] ?? 'null') as Lock[];
        if (!Array.isArray(locks)) throw new Error('Missing lock observation');
        observations.push(locks); return locks;
      };
      const first = await snapshot();
      const holderConfirmed = first.some(l => l.pid === pids.holder && l.mode === 'RowExclusiveLock' && l.granted);
      if (!holderConfirmed) throw new Error('Holder returned without a live RowExclusiveLock');
      const call = track(rpc.query(`SELECT ${operation};`));
      const awaitObserved = async (predicate: (locks: Lock[]) => boolean) => {
        const deadline = Date.now() + 10_000;
        do {
          const locks = await snapshot();
          if (call.state.error) throw call.state.error;
          if (predicate(locks)) return locks;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error('Timed out establishing the controlled lock overlap');
      };
      const rpcLocks = await awaitObserved(locks => locks.some(l => l.pid === pids.rpc && BARRIER_MODES.has(l.mode)) || (call.state.done && locks.some(l => l.pid === pids.rpc && l.mode === 'RowExclusiveLock' && l.granted)));
      const rpcLockConfirmed = rpcLocks.some(l => l.pid === pids.rpc);
      const write = track(innocent.query(`SELECT pg_temp.arkova_0428_timed_write('${innocentId}');`));
      await awaitObserved(locks => {
        if (write.state.error) throw write.state.error;
        return write.state.done || locks.some(l => l.pid === pids.innocent && !l.granted && l.blockers.includes(pids.rpc));
      });
      const barrierObserved = observations.some(ls => ls.some(l => l.pid === pids.rpc && BARRIER_MODES.has(l.mode)));
      const innocentBlockedByRpc = observations.some(ls => ls.some(l => l.pid === pids.innocent && !l.granted && l.blockers.includes(pids.rpc)));
      // Release in dependency order, and check BOTH formerly-discarded async results.
      await holder.query('ROLLBACK;');
      await call.settled; if (call.state.error) throw call.state.error;
      await rpc.query('ROLLBACK;');
      await write.settled; if (write.state.error) throw write.state.error;
      const measured = JSON.parse(write.state.value?.[0] ?? 'null') as { server_ms: number; rows: number } | null;
      if (!measured) throw new Error('Innocent UPDATE did not return database timing');
      await innocent.query('ROLLBACK;');
      const result: LockProbeResult = { rpc: name, barrierObserved, innocentBlockedByRpc, innocentServerMs: Number(measured.server_ms), innocentRows: Number(measured.rows), rpcCompleted: call.state.done && !call.state.error, holderConfirmed, rpcLockConfirmed, pids, observations };
      assertLockProbeHealthy(result); results.push(result);
    } finally { sessions.forEach(s => s.close()); }
  }
  return results;
}

/** Hold the local exemption open until the other backend's rejected write has
 * actually completed. No sleep or connection-pool reuse assumption establishes overlap.
 */
export async function runFlagIsolation(ref: string, env: ConnectionEnv, individualId: string): Promise<void> {
  validateProbeTarget(ref, env);
  if (!UUID.test(individualId)) throw new Error('Invalid individual fixture UUID');
  const holder = new PsqlSession(env, 'soak0428_flag_holder');
  const intruder = new PsqlSession(env, 'soak0428_flag_intruder');
  try {
    const a = Number((await holder.query(begin)).at(-1)); const b = Number((await intruder.query(begin)).at(-1));
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) throw new Error('Flag probe did not establish two backends');
    await holder.query("SELECT set_config('arkova.allow_role_change','on',true);");
    let rejected = false;
    try { await intruder.query(`UPDATE public.profiles SET role='ORG_ADMIN' WHERE id='${individualId}';`); }
    catch (e) { if (!(e instanceof Error) || !e.message.includes('Role cannot be changed once set')) throw e; rejected = true; }
    if (!rejected) throw new Error('C10 concurrent direct role change succeeded');
    if ((await holder.query("SELECT current_setting('arkova.allow_role_change');"))[0] !== 'on') throw new Error('Flag holder was not still active during intruder write');
    await holder.query('ROLLBACK;');
  } finally { holder.close(); intruder.close(); }
}
