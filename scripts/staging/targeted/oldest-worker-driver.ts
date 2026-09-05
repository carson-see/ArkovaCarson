/** Exact changed-path probe for PRs 2436/2437/2438. Fixture setup and flag
 * changes happen in the exclusive rig supervisor before this single cycle.
 * USE_MOCKS remains true: real HTTP/DB authorization and live flags are tested;
 * no claim is made of real Bitcoin settlement. All assertions fail closed.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isDirectRun } from './public-projection-driver.js';
import { iamOnlyHeaders, requireEnv, writeEvidenceFile } from './runtime.js';

type ObjectBody = Record<string, unknown>;
function object(value: unknown): ObjectBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected response object');
  return value as ObjectBody;
}
export function assertQueueScope(body: unknown, own: string[], foreign: string[]): void {
  const items = object(body).items;
  if (!Array.isArray(items) || own.length === 0) throw new Error('Missing positive queue fixture');
  const ids = items.map((item: unknown) => object(item).public_id);
  if (!own.every((id) => ids.includes(id))) throw new Error('Expected own-org queue record absent');
  if (foreign.some((id) => ids.includes(id))) throw new Error('Cross-org queue record disclosed');
}
export function assertFlagResults(mode: 'on' | 'off', batch: unknown, expiry: unknown): void {
  const b = object(batch); const e = object(expiry);
  if (mode === 'off') {
    if (b.processed !== 0 || e.skipped !== true || e.reason !== 'ENABLE_EXPIRY_ALERTS flag is disabled') {
      throw new Error('Disabled gate returned unexpected behavior');
    }
  } else if (typeof b.processed !== 'number' || b.processed < 1 || e.skipped === true) {
    throw new Error('Enabled gate did not execute positive workload');
  }
}
export function assertProviderLog(logs: unknown[], marker: string): void {
  if (!marker) throw new Error('Missing synthetic credential marker');
  const text = JSON.stringify(logs);
  if (text.includes(marker) || /"rpcUrl"\s*:/.test(text)) throw new Error('Credential-bearing log content emitted');
  if (!logs.some((entry) => {
    const payload = object(entry).jsonPayload;
    return payload && object(payload).provider === 'getblock' && object(payload).rpcOrigin === 'https://rpc-soak.invalid';
  })) throw new Error('No positive GetBlock factory origin log');
}
async function main(): Promise<void> {
  const {values} = parseArgs({ options: { 'mode': {type:'string'}, 'evidence-out': {type:'string'}, 'provider-log': {type:'string'} } });
  const mode = values.mode;
  if (mode !== 'on' && mode !== 'off') throw new Error('Specify --mode on or off');
  const env = (name: string) => requireEnv(name, 'oldest-worker-driver');
  const base = env('STAGING_API_BASE').replace(/\/$/,'');
  const sb = env('STAGING_SUPABASE_URL').replace(/\/$/,'');
  const ref = env('STAGING_SUPABASE_PROJECT_REF');
  if (['vzwyaatejekddvltxyye','ujtlwnoqfhtitcmsnrpq'].includes(ref) || sb !== `https://${ref}.supabase.co` || !new URL(base).hostname.startsWith('arkova-worker-oldest-worker-')) throw new Error('Not the exclusive oldest-worker rig');
  const key = env('STAGING_SUPABASE_SERVICE_ROLE_KEY');
  const cron = env('STAGING_CRON_SECRET');
  const org = env('STAGING_BATCH_ORG_ID');
  const own = env('STAGING_QUEUE_A_IDS').split(','); const foreign = env('STAGING_QUEUE_B_IDS').split(',');
  const outcomes: ObjectBody[] = [];
  async function call(label: string, path: string, status: number, token?: string, post=false): Promise<unknown> {
    const response = await fetch(base+path,{ method:post?'POST':'GET', headers:iamOnlyHeaders({...token?{Authorization:`Bearer ${token}`}:{},...post?{'X-Cron-Secret':cron}:{} }),signal:AbortSignal.timeout(30000) });
    const body:unknown = await response.json();
    outcomes.push({label,status:response.status,body});
    if (response.status !== status) throw new Error(`${label} returned HTTP ${response.status}, expected ${status}`);
    return body;
  }
  let failure: string | undefined;
  try {
    const pending = await fetch(`${sb}/rest/v1/anchors?select=id&org_id=eq.${org}&status=eq.PENDING`,{headers:{apikey:key,Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
    if (!pending.ok) throw new Error('Pending fixture lookup failed');
    const rows:unknown = await pending.json();
    if (!Array.isArray(rows) || rows.length < 1) throw new Error('Missing positive pending batch fixture');
    const a = await call('org-a-admin','/api/queue/pending',200,env('STAGING_ADMIN_A_JWT'));
    assertQueueScope(a,own,foreign);
    const b = await call('org-b-admin','/api/queue/pending',200,env('STAGING_ADMIN_B_JWT'));
    assertQueueScope(b,foreign,own);
    await call('member-denied','/api/queue/pending',403,env('STAGING_MEMBER_JWT'));
    await call('anonymous-denied','/api/queue/pending',401);
    await call('treasury-factory','/api/treasury/status',200,env('STAGING_PLATFORM_ADMIN_JWT'));
    const batch = await call('live-batch-gate',`/jobs/batch-anchors?force=true&org_id=${org}`,200,undefined,true);
    const expiry = await call('live-expiry-gate','/jobs/check-credential-expiry',200,undefined,true);
    assertFlagResults(mode,batch,expiry);
    if (values['provider-log']) assertProviderLog(JSON.parse(readFileSync(values['provider-log'],'utf8')) as unknown[],env('STAGING_SYNTHETIC_RPC_MARKER'));
  } catch (error) { failure = error instanceof Error ? error.message : 'Unknown probe failure'; }
  writeEvidenceFile(values['evidence-out'],{driver:'oldest-worker',prs:[2436,2437,2438],mode,project_ref:ref,timestamp:new Date().toISOString(),allExpected:!failure,outcomes,...failure?{failure}:{}});
  if (failure) throw new Error(failure);
}
if (isDirectRun(import.meta.url,process.argv[1])) main().catch((error:unknown)=>{console.error(error instanceof Error ? error.message : 'Probe failed');process.exitCode=1;});
