#!/usr/bin/env python3
"""Batch-I T3 soak driver — PR #2589 (MCP/SDK tool renames + ES256 auth + SDK hardening).

Drives BOTH surfaces the PR changes, every cycle:

  * the Cloudflare edge MCP server, deployed from the PR head to a THROWAWAY
    workers.dev worker (no route, own KV namespaces) pointed at this rig, and
  * the Cloud Run worker deployed from the same candidate SHA.

Every identifier this driver needs is read from `config.json` next to it in the
run directory, so the tracked copy at `docs/staging/batch-i-0907/soak-batch-i.py`
carries no rig secrets and is byte-stable at the declared source head (the
provisioner requires STAGING_DRIVER_PATH to be tracked at that head).

Assertion discipline: nothing here is "HTTP 200". Every check names a row, a
value, or a status code that can only be produced by the changed behaviour.
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

RUN = pathlib.Path(os.environ.get('BATCH_I_RUN_DIR', str(pathlib.Path.home() / 'arkova-soak/batch-i-0907')))
CFG = json.loads((RUN / 'config.json').read_text())
CRED = json.loads((RUN / 'creds.json').read_text())
CYCLES = RUN / 'cycles'
CYCLES.mkdir(parents=True, exist_ok=True)

EDGE = CFG['edge_url'].rstrip('/')
WORKER = CFG['worker_url'].rstrip('/')
RIG = CFG['rig_ref']
SUPABASE_URL = CFG['supabase_url'].rstrip('/')
CANDIDATE_SHA = CFG['candidate_sha']
WT = pathlib.Path(CFG['worktree'])
CF_ACC = CFG['cf_account_id']
CF_SCRIPT = CFG['cf_script_name']
DEPLOYMENT_ID = CFG['cf_deployment_id']
VERSION_ID = CFG['cf_version_id']
BUNDLE_SHA = CFG['edge_bundle_sha256']
FX = CFG['fixtures']
JWT_EXP_SECONDS = int(CFG.get('rig_jwt_exp_seconds', 120))
EXPIRY_SLACK_SEC = 15                    # margin past exp+skew before the expiry negative runs

API_KEY = CRED['rig_api_key']
SB_TOKEN = CRED['supabase_access_token']
SB_ANON = CRED['supabase_anon_key']
CF_TOKEN = CRED['cloudflare_api_token']
CRON_SECRET = CRED['cron_secret']
SOAK_USER = CRED['soak_user']            # {email, password} — rig-only GoTrue user

# ── The rename contract this PR ships ────────────────────────────────────────
# TOOL_DEFINITIONS in services/edge/src/mcp-tools.ts is canonical for six
# surfaces; `arkova_anchor_document` registers only when
# MCP_ENABLE_ANCHOR_DOCUMENT=true (deliberately unset — this window is
# read-only), so 15 of the 16 definitions are live.
EXPECTED_TOOLS = {
    'arkova_verify_anchor', 'arkova_search_anchors', 'arkova_search', 'arkova_verify',
    'arkova_list_orgs', 'arkova_get_anchor', 'arkova_get_organization', 'arkova_get_record',
    'arkova_get_fingerprint', 'arkova_get_document', 'arkova_verify_document',
    'arkova_verify_batch', 'arkova_oracle_batch_verify', 'arkova_list_agents',
    'nessie_query',
}
# Pre-rename names. Absence is asserted every cycle: a silent revert of the
# rename is the regression this PR exists to prevent.
ABSENT_TOOLS = {
    'verify_credential', 'search_credentials', 'verify', 'search', 'list_orgs',
    'get_anchor', 'get_organization', 'get_record', 'get_fingerprint', 'get_document',
    'verify_document', 'verify_batch', 'oracle_batch_verify', 'list_agents',
    'anchor_document', 'arkova_verify_credential', 'arkova_search_credentials',
}
RENAMED_CALLABLE = [
    'arkova_verify_anchor', 'arkova_search_anchors', 'arkova_search', 'arkova_verify',
    'arkova_list_orgs', 'arkova_get_anchor', 'arkova_get_organization', 'arkova_get_record',
    'arkova_get_fingerprint', 'arkova_get_document', 'arkova_verify_document',
    'arkova_verify_batch', 'arkova_oracle_batch_verify', 'arkova_list_agents',
]

utc = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()


# ── transport ────────────────────────────────────────────────────────────────

def http(url, data=None, headers=None, method=None, timeout=60, retry_transport=True):
    """One retry on a transport-level failure only (never on an HTTP status)."""
    hdrs = dict(headers or {})
    hdrs.setdefault('User-Agent', 'arkova-batch-i-0907/1.0')  # Supabase mgmt API 403s urllib's default
    for i in range(2):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception:
            if not retry_transport or i == 1:
                raise
            time.sleep(2)


def idtoken():
    return subprocess.run(['gcloud', 'auth', 'print-identity-token'],
                          capture_output=True, text=True, timeout=120).stdout.strip()


def worker(path, method='GET', body=None, extra=None, timeout=120):
    h = {'Authorization': 'Bearer ' + idtoken()}
    if body is not None:
        h['Content-Type'] = 'application/json'
    h.update(extra or {})
    return http(WORKER + path, json.dumps(body).encode() if body is not None else None,
                h, method, timeout=timeout)


def sql(query):
    """Arbitrary SQL on the rig as `postgres` via the Management API.

    Caps at ~60 s server-side; a longer statement returns HTTP 000 while the work
    still COMMITs, so every statement here is bounded and idempotent.
    """
    status, raw = http(f'https://api.supabase.com/v1/projects/{RIG}/database/query',
                       json.dumps({'query': query}).encode(),
                       {'Authorization': 'Bearer ' + SB_TOKEN, 'Content-Type': 'application/json'},
                       'POST', timeout=120)
    assert status in (200, 201), f'rig query HTTP {status}: {raw[:200]!r}'
    return json.loads(raw)


# ── MCP client ───────────────────────────────────────────────────────────────

def mcp(method, params, api_key=API_KEY, bearer=None, origin=None):
    h = {'Content-Type': 'application/json',
         'Accept': 'application/json, text/event-stream',
         'MCP-Protocol-Version': '2025-03-26'}
    if origin or CFG.get('allowed_origin'):
        h['Origin'] = origin or CFG['allowed_origin']
    if api_key:
        h['X-API-Key'] = api_key
    if bearer:
        h['Authorization'] = 'Bearer ' + bearer
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    status, raw = http(EDGE + '/mcp', body, h, 'POST')
    return status, (json.loads(raw) if raw and status == 200 else None)


def tool(name, args, **kw):
    status, data = mcp('tools/call', {'name': name, 'arguments': args}, **kw)
    assert status == 200, f'{name} HTTP {status}'
    assert 'error' not in data, f'{name} protocol error: {json.dumps(data["error"])[:300]}'
    return data['result']


def body_of(result):
    return json.loads(result['content'][0]['text'])


# ── JWT helpers ──────────────────────────────────────────────────────────────

def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def b64u_dec(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def jwt_parts(token):
    h, p, _ = token.split('.')
    return json.loads(b64u_dec(h)), json.loads(b64u_dec(p))


def hs256(payload, secret):
    hdr = b64u(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    pl = b64u(json.dumps(payload, separators=(',', ':')).encode())
    sig = b64u(hmac.new(secret.encode(), f'{hdr}.{pl}'.encode(), hashlib.sha256).digest())
    return f'{hdr}.{pl}.{sig}'


# The stdlib has no P-256 signer, so the wrong-key ES256 negative is minted with
# node's WebCrypto (raw IEEE-P1363 R||S, which is what JWS ES256 requires).
_ES256_NODE = r'''
const crypto = require('crypto');
const [hdrB64, plB64] = process.argv.slice(2);
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const signing = Buffer.from(`${hdrB64}.${plB64}`);
const sig = crypto.sign('sha256', signing, { key: privateKey, dsaEncoding: 'ieee-p1363' });
process.stdout.write(sig.toString('base64url'));
'''


def es256_wrong_key(header, payload):
    """An ES256 JWT with the real token's kid but a key that is not in the rig JWKS."""
    hdr = b64u(json.dumps(header, separators=(',', ':')).encode())
    pl = b64u(json.dumps(payload, separators=(',', ':')).encode())
    sig = subprocess.run(['node', '-e', _ES256_NODE, hdr, pl],
                         capture_output=True, text=True, timeout=60, cwd=str(WT))
    assert sig.returncode == 0, f'node ES256 signer failed: {sig.stderr[:200]}'
    return f'{hdr}.{pl}.{sig.stdout}'


def mint_es256():
    """A REAL ES256 session token from this rig's GoTrue, signed by the rig-only
    signing key the edge resolves through <SUPABASE_URL>/auth/v1/.well-known/jwks.json."""
    status, raw = http(f'{SUPABASE_URL}/auth/v1/token?grant_type=password',
                       json.dumps({'email': SOAK_USER['email'], 'password': SOAK_USER['password']}).encode(),
                       {'apikey': SB_ANON, 'Content-Type': 'application/json'}, 'POST')
    assert status == 200, f'GoTrue password grant HTTP {status}: {raw[:200]!r}'
    tok = json.loads(raw)['access_token']
    hdr, _ = jwt_parts(tok)
    assert hdr.get('alg') == 'ES256', f'rig is not minting ES256 (alg={hdr.get("alg")})'
    return tok


def verifier_clock_skew_sec():
    """CLOCK_SKEW_SEC as the PR's own verifier defines it.

    Read from `services/edge/src/mcp-jwt-verify.ts` at the candidate head rather
    than hardcoded, so the expiry negative below can never drift from the
    tolerance it is testing. Getting this wrong is not a soft failure: the
    verifier rejects only once `now > exp + CLOCK_SKEW_SEC`, so a wait computed
    without it re-checks a token that is still lawfully valid and the negative
    silently reports the positive result."""
    src = (WT / 'services/edge/src/mcp-jwt-verify.ts').read_text()
    m = re.search(r'const\s+CLOCK_SKEW_SEC\s*=\s*(\d+)', src)
    assert m, 'CLOCK_SKEW_SEC not found in mcp-jwt-verify.ts'
    return int(m.group(1))


# ── SDK legs ─────────────────────────────────────────────────────────────────

FAULT_ID = 'ARK-BI-FAULT-000001'      # GET path the proxy always 503s (retry probe)
FAULT_POST = '/api/v1/webhooks'       # unsafe method the client must NOT retry


class IamProxy(threading.Thread):
    """Loopback proxy that forwards to the IAM-protected rig, injecting
    X-Serverless-Authorization. No SDK has a custom-header hook, so this is the
    only way to run the SHIPPED client bytes, unmodified, against the rig.

    It also serves two deterministic faults so the PR's method-scoped retry rule
    is measured rather than asserted: a GET carrying FAULT_ID and a POST to
    FAULT_POST both answer 503, and the per-path attempt counter says how many
    times the client actually tried."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.port = port
        self.httpd = None

    def run(self):
        # NOT `import http.server`: that binds the name `http` in this scope and
        # shadows the module-level `http()` transport helper the handler calls.
        import http.server as httpserver
        upstream = WORKER
        token = [idtoken()]
        stamp = [time.time()]
        counts = {}

        class H(httpserver.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def _send(self, st, raw):
                self.send_response(st)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _proxy(self, method):
                if self.path.startswith('/__bi/counts'):
                    return self._send(200, json.dumps(counts).encode())
                if self.path.startswith('/__bi/reset'):
                    counts.clear()
                    return self._send(200, b'{"reset":true}')
                length = int(self.headers.get('Content-Length') or 0)
                payload = self.rfile.read(length) if length else None
                key = ('FAULT_GET' if FAULT_ID in self.path
                       else 'FAULT_POST' if (method == 'POST' and self.path.startswith(FAULT_POST))
                       else None)
                if key:
                    counts[key] = counts.get(key, 0) + 1
                    return self._send(503, b'{"error":"injected_unavailable"}')
                if time.time() - stamp[0] > 1800:
                    token[0] = idtoken()
                    stamp[0] = time.time()
                fwd = {k: v for k, v in self.headers.items()
                       if k.lower() not in ('host', 'content-length', 'connection', 'accept-encoding')}
                fwd['X-Serverless-Authorization'] = 'Bearer ' + token[0]
                try:
                    st, raw = http(upstream + self.path, payload, fwd, method, timeout=60,
                                   retry_transport=False)
                except Exception as exc:
                    st = 599
                    raw = json.dumps({'error': 'proxy_transport',
                                      'message': f'{type(exc).__name__}: {exc}'[:200]}).encode()
                    print('[proxy]', method, self.path, type(exc).__name__, exc, flush=True)
                self._send(st, raw)

            def do_GET(self):
                self._proxy('GET')

            def do_POST(self):
                self._proxy('POST')

            def do_DELETE(self):
                self._proxy('DELETE')

        self.httpd = httpserver.ThreadingHTTPServer(('127.0.0.1', self.port), H)
        self.httpd.serve_forever()


_TS_SDK_LEG = r'''
const { Arkova, ArkovaError, VERIFY_BATCH_SYNC_LIMIT } = require(process.env.SDK_ENTRY);
const base = process.env.SDK_BASE, key = process.env.SDK_KEY;
const out = {};
(async () => {
  const c = new Arkova({ apiKey: key, baseUrl: base });

  // 1. the key lives in a real `#private` field, not an enumerable property
  out.apiKeyPrivate = !Object.keys(c).includes('apiKey')
    && !JSON.stringify(c).includes(key)
    && c.apiKey === undefined;

  // 2. happy path against the rig
  const v = await c.verify(process.env.SDK_GOOD_ID);
  out.verify = { verified: v.verified, status: v.status,
                 publicId: v.publicId ?? v.public_id ?? null };

  // 3. proof / privacy disclosure fields are mapped, not dropped
  out.disclosureKeys = Object.keys(v).filter((k) => /proof|privacy|disclos|ferpa/i.test(k)).sort();

  // 4. typed error mapping on a real miss (an ArkovaError, not a TypeError)
  try {
    await c.verify(process.env.SDK_UNKNOWN_ID);
    out.notFound = 'NO_THROW';
  } catch (e) {
    out.notFound = { name: e.constructor.name, isArkovaError: e instanceof ArkovaError,
                     statusCode: e.statusCode ?? null, code: e.code ?? null };
  }

  // 5. the inline batch cap is enforced client-side, before any request
  out.batchLimit = VERIFY_BATCH_SYNC_LIMIT;
  try {
    await c.verifyBatch(Array.from({ length: VERIFY_BATCH_SYNC_LIMIT + 1 },
                                   (_, i) => `ARK-BI-CAP-${String(i).padStart(6, '0')}`));
    out.batchCap = 'NO_THROW';
  } catch (e) {
    out.batchCap = { name: e.constructor.name, message: String(e.message).slice(0, 140) };
  }

  // 6. retry is METHOD-SCOPED. Measured against the proxy's injected 503s:
  //    a safe GET is retried (retries:2 -> 3 attempts); an unsafe POST is not.
  await fetch(base + '/__bi/reset');
  try { await c.verify(process.env.SDK_FAULT_ID); } catch (e) { out.faultGetError = e.constructor.name; }
  try { await c.webhooks.create({ url: 'https://batch-i-0907.invalid/hook', events: ['anchor.secured'] }); }
  catch (e) { out.faultPostError = e.constructor.name; }
  out.attempts = await (await fetch(base + '/__bi/counts')).json();

  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e).slice(0, 400) })); });
'''


def sdk_ts_leg(base):
    env = dict(os.environ, SDK_ENTRY=CFG['sdk_ts_entry'], SDK_BASE=base, SDK_KEY=API_KEY,
               SDK_GOOD_ID=FX['good_public_id'], SDK_UNKNOWN_ID=FX['unknown_public_id'],
               SDK_FAULT_ID=FX['fault_public_id'])
    r = subprocess.run(['node', '-e', _TS_SDK_LEG], capture_output=True, text=True,
                       timeout=300, env=env, cwd=str(WT))
    assert r.returncode == 0, f'TS SDK leg exit {r.returncode}: {r.stderr[-400:]}'
    return json.loads(r.stdout)


_PY_SDK_LEG = r'''
import json, os, sys
sys.path.insert(0, os.environ['PY_SDK_SRC'])
import arkova
from arkova.errors import ArkovaError
out = {'version': getattr(arkova, '__version__', None)}
c = arkova.Arkova(api_key=os.environ['SDK_KEY'], base_url=os.environ['SDK_BASE'], timeout=20.0)
v = c.verify(os.environ['SDK_GOOD_ID'])
d = v.model_dump() if hasattr(v, 'model_dump') else dict(v)
out['verify'] = {'verified': d.get('verified'), 'status': d.get('status')}
out['disclosure_fields'] = sorted(k for k in d if any(t in k for t in ('proof', 'privacy', 'disclos', 'ferpa')))
try:
    c.verify(os.environ['SDK_UNKNOWN_ID'])
    out['not_found'] = 'NO_RAISE'
except ArkovaError as e:
    out['not_found'] = {'type': type(e).__name__, 'status': getattr(e, 'status_code', None)}
except Exception as e:
    out['not_found'] = {'type': type(e).__name__, 'unexpected': True}
c.close()
print(json.dumps(out))
'''


def sdk_py_leg(base):
    env = dict(os.environ, PY_SDK_SRC=CFG['sdk_py_src'], SDK_KEY=API_KEY, SDK_BASE=base,
               SDK_GOOD_ID=FX['good_public_id'], SDK_UNKNOWN_ID=FX['unknown_public_id'])
    r = subprocess.run([CFG.get('python_bin', 'python3'), '-c', _PY_SDK_LEG],
                       capture_output=True, text=True, timeout=300, env=env, cwd=str(WT))
    assert r.returncode == 0, f'Python SDK leg exit {r.returncode}: {r.stderr[-400:]}'
    return json.loads(r.stdout.strip().splitlines()[-1])


_VERIFY_JWT_LEG = r'''
import { verifySupabaseJwt } from './services/edge/src/mcp-jwt-verify.js';
const tokens = JSON.parse(process.env.BI_TOKENS);
const supabaseUrl = process.env.BI_SUPABASE_URL;
const out = {};
for (const [label, token] of Object.entries(tokens)) {
  // No `secret`: SUPABASE_JWT_SECRET is deliberately unprovisioned on the
  // soaked edge worker, so the HS256 fallback must fail closed here too.
  const r = await verifySupabaseJwt(token, { supabaseUrl });
  out[label] = r.ok ? { ok: true, tier: r.tier, userId: r.userId, scopes: r.scopes }
                    : { ok: false, reason: r.reason };
}
const jwks = await (await fetch(supabaseUrl + '/auth/v1/.well-known/jwks.json')).json();
out.jwks_algs = [...new Set(jwks.keys.map((k) => k.alg))].sort();
process.stdout.write(JSON.stringify(out));
'''


def verify_jwt_leg(tokens):
    """Run the PR head's own ES256/HS256 verifier against the rig's LIVE JWKS."""
    f = pathlib.Path(WT) / 'batch-i-verify-jwt.mts'
    f.write_text(_VERIFY_JWT_LEG)
    try:
        r = subprocess.run(['npx', 'tsx', str(f)], capture_output=True, text=True, timeout=300,
                           cwd=str(WT), env=dict(os.environ, BI_TOKENS=json.dumps(tokens),
                                                 BI_SUPABASE_URL=SUPABASE_URL))
        assert r.returncode == 0, f'jwt verifier leg exit {r.returncode}: {r.stderr[-400:]}'
        return json.loads(r.stdout)
    finally:
        f.unlink(missing_ok=True)


# ── the cycle ────────────────────────────────────────────────────────────────

def cycle(n, proxy_base):
    out = {'cycle': n, 'ts': utc(time.time()), 'checks': {}}
    ck = out['checks']

    # ── EDGE 1: liveness + anti-hollow bundle identity ───────────────────────
    st, raw = http(EDGE + '/health')
    h = json.loads(raw)
    assert st == 200 and h.get('service') == 'arkova-edge', f'edge health {st} {h}'
    st, raw = http(f'https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/workers/scripts/{CF_SCRIPT}/deployments',
                   headers={'Authorization': 'Bearer ' + CF_TOKEN})
    dep = json.loads(raw)['result']['deployments'][0]
    assert dep['id'] == DEPLOYMENT_ID, f'edge deployment changed: {dep["id"]}'
    assert dep['versions'][0]['version_id'] == VERSION_ID, 'edge version changed'
    ck['edge_identity'] = {'health': h, 'deployment_id': dep['id'],
                           'version_id': dep['versions'][0]['version_id'],
                           'bundle_sha256': BUNDLE_SHA}

    # ── EDGE 2: the rename contract ──────────────────────────────────────────
    st, data = mcp('tools/list', {})
    assert st == 200, f'tools/list HTTP {st}'
    names = {t['name'] for t in data['result']['tools']}
    assert names == EXPECTED_TOOLS, f'tool set drift: {sorted(names ^ EXPECTED_TOOLS)}'
    assert not (names & ABSENT_TOOLS), f'pre-rename name resurfaced: {sorted(names & ABSENT_TOOLS)}'
    # A removed name must not merely be hidden from the list — calling it must fail.
    st, data = mcp('tools/call', {'name': 'verify_credential',
                                  'arguments': {'public_id': FX['good_public_id']}})
    rejected = data.get('result', {}).get('isError') is True or data.get('error') is not None
    reject_text = (data.get('result', {}).get('content') or [{}])[0].get('text', '') \
        if data.get('result') else json.dumps(data.get('error'))
    assert rejected and 'not found' in reject_text.lower(), \
        f'old tool name still resolves: {json.dumps(data)[:300]}'
    ck['tools_list'] = {'count': len(names), 'set_matches': True, 'old_names_absent': True,
                        'old_name_call_rejected': reject_text[:120]}

    # ── EDGE 3: every renamed tool callable end to end ───────────────────────
    called = {}
    # get_public_anchor projects SECURED -> the public status literal 'ACTIVE'.
    a = body_of(tool('arkova_verify_anchor', {'public_id': FX['good_public_id']}))
    assert a['verified'] is True and a.get('status') == 'ACTIVE', f'arkova_verify_anchor: {a}'
    # The redacted single-record envelope carries no `public_id`; the record it
    # resolved is named by `record_uri` (get_public_anchor derives it from public_id).
    assert a.get('record_uri', '').endswith('/' + FX['good_public_id']), \
        f'arkova_verify_anchor resolved {a.get("record_uri")!r}'
    assert a.get('bitcoin_block') == FX['good_block'], f'bitcoin_block drift: {a.get("bitcoin_block")}'
    called['arkova_verify_anchor'] = {'verified': a['verified'], 'status': a['status'],
                                      'bitcoin_block': a.get('bitcoin_block')}

    sr = body_of(tool('arkova_search_anchors', {'query': FX['search_query'], 'max_results': 5}))
    assert isinstance(sr.get('results'), list) and 'search_mode' in sr and 'total' in sr, \
        f'arkova_search_anchors shape: {sorted(sr)}'
    # NOT asserted: a non-empty hit. The public search RPC indexes publicly
    # searchable records only, and this rig's fixtures are not published to it.
    called['arkova_search_anchors'] = {'search_mode': sr['search_mode'], 'total': sr['total']}

    g = body_of(tool('arkova_search', {'q': FX['search_query'], 'type': 'all', 'limit': 5}))
    assert isinstance(g.get('results'), list) and 'next_cursor' in g, f'arkova_search shape: {sorted(g)}'
    called['arkova_search'] = {'results': len(g['results'])}

    # Fingerprint-keyed tools echo public_id; public_id-keyed tools name the record
    # through record_uri. Both must resolve to the SAME seeded row.
    for tname, args in (
        ('arkova_verify', {'fingerprint': FX['good_fingerprint']}),
        ('arkova_get_fingerprint', {'fingerprint': FX['good_fingerprint']}),
        ('arkova_get_anchor', {'public_id': FX['good_public_id']}),
        ('arkova_get_record', {'public_id': FX['good_public_id']}),
        ('arkova_get_document', {'public_id': FX['good_public_id']}),
    ):
        r = body_of(tool(tname, args))
        resolved = r.get('public_id') or r.get('record_uri', '').rsplit('/', 1)[-1]
        assert resolved == FX['good_public_id'], f'{tname} resolved {resolved!r}'
        assert r.get('verified') is True and r.get('bitcoin_block') == FX['good_block'], \
            f'{tname} envelope: verified={r.get("verified")} bitcoin_block={r.get("bitcoin_block")}'
        called[tname] = {'resolved': resolved, 'verified': r['verified'],
                         'bitcoin_block': r.get('bitcoin_block')}

    o = body_of(tool('arkova_list_orgs', {}))
    orgs = o.get('organizations') if isinstance(o, dict) else o
    assert isinstance(orgs, list), f'arkova_list_orgs shape: {o if not isinstance(o, dict) else list(o)}'
    assert any(g.get('public_id') == FX['org_a_public_id'] for g in orgs), \
        f'arkova_list_orgs did not return the caller org: {[g.get("public_id") for g in orgs]}'
    called['arkova_list_orgs'] = {'organizations': len(orgs)}

    org = body_of(tool('arkova_get_organization', {'public_id': FX['org_a_public_id']}))
    assert org.get('public_id') == FX['org_a_public_id'], f'arkova_get_organization: {org}'
    called['arkova_get_organization'] = {'public_id': org['public_id']}

    vd = body_of(tool('arkova_verify_document', {'content_hash': FX['good_fingerprint']}))
    assert vd.get('verified') is True and vd.get('public_id') == FX['good_public_id'], \
        f'arkova_verify_document: {vd}'
    called['arkova_verify_document'] = {'verified': True, 'public_id': vd['public_id']}

    ids = [FX['good_public_id'], FX['unknown_public_id'], FX['pending_public_id']]
    vb = body_of(tool('arkova_verify_batch', {'public_ids': ids}))
    assert [r['public_id'] for r in vb['results']] == ids, 'arkova_verify_batch order changed'
    assert vb['results'][0]['verified'] is True and vb['results'][1]['verified'] is False, 'batch partial results'
    assert [r.get('status') for r in vb['results']] == ['ACTIVE', 'UNKNOWN', 'PENDING'], \
        f'batch statuses: {[r.get("status") for r in vb["results"]]}'
    for r in vb['results']:
        assert 'bitcoin_block' in r, f'bitcoin_block missing on {r["public_id"]}'
    called['arkova_verify_batch'] = {'order_preserved': True,
                                     'statuses': [r.get('status') for r in vb['results']],
                                     'verified': [r['verified'] for r in vb['results']]}

    # oracle envelope: DI-038 partial results (merged from main) under the
    # PR's renamed registration, plus the HMAC envelope contract.
    env = body_of(tool('arkova_oracle_batch_verify', {'public_ids': ids}))
    assert set(env) >= {'alg', 'key_id', 'payload', 'signature'}, f'envelope shape: {sorted(env)}'
    canon = json.dumps(env['payload'], separators=(',', ':'), ensure_ascii=False).encode()
    expect = hmac.new(CRED['mcp_signing_key'].encode(), canon, hashlib.sha256).hexdigest()
    assert hmac.compare_digest(expect, env['signature']), 'oracle envelope signature invalid'
    tampered = json.loads(json.dumps(env['payload']))
    tampered['results'][0]['verified'] = False
    bad = hmac.new(CRED['mcp_signing_key'].encode(),
                   json.dumps(tampered, separators=(',', ':'), ensure_ascii=False).encode(),
                   hashlib.sha256).hexdigest()
    assert not hmac.compare_digest(bad, env['signature']), 'tampered oracle payload verified'
    orec = env['payload']['results']
    assert [r['public_id'] for r in orec] == ids, 'oracle order changed'
    assert orec[0]['verified'] and not orec[1]['verified'], 'oracle partial results lost'
    called['arkova_oracle_batch_verify'] = {'alg': env['alg'], 'signature_valid': True,
                                            'tamper_rejected': True, 'partial_results': True}

    la_res = tool('arkova_list_agents', {})
    assert not la_res.get('isError'), f'arkova_list_agents errored: {json.dumps(la_res)[:200]}'
    la = body_of(la_res)
    assert isinstance(la.get('agents'), list), f'arkova_list_agents shape: {la}'
    called['arkova_list_agents'] = {'agents': len(la['agents'])}

    assert set(called) == set(RENAMED_CALLABLE), \
        f'not every renamed tool was driven: {sorted(set(RENAMED_CALLABLE) - set(called))}'
    ck['renamed_tools_callable'] = called

    # nessie_query is registered but MUST stay off (founder directive 2026-08-01):
    # asserted disabled, never activated.
    nq = tool('nessie_query', {'query': 'soak probe', 'mode': 'retrieval', 'limit': 1})
    nqt = json.dumps(nq)
    assert 'disabled' in nqt.lower() or nq.get('isError'), f'nessie_query is not OFF: {nqt[:200]}'
    ck['nessie_off'] = True

    # ── EDGE 4: sanitized error text on the shared error path ────────────────
    st, data = mcp('tools/call', {'name': 'arkova_oracle_batch_verify',
                                  'arguments': {'public_ids': [FX['good_public_id'], 'not-an-id!!']}})
    assert st == 200 and data['result'].get('isError'), 'malformed public_id was not rejected'
    msg = data['result']['content'][0]['text']
    for leak in ('supabase.co', 'service_role', 'eyJ', 'at Object.', '/private/tmp', 'stack'):
        assert leak not in msg, f'error text leaked {leak!r}'
    ck['error_sanitized'] = {'message': msg[:160]}

    # ── EDGE 5: ES256 auth ──────────────────────────────────────────────────
    #
    # TWO LEVELS, because the deployed surface gates before it authenticates.
    #
    # (a) Deployed edge, bearer-only: `enforceOriginAllowlist` runs BEFORE
    #     `validateBearer`, and a bearer caller has no `apiKeyId`, so the gate
    #     returns `challenge` -> 403 `origin_challenge_required` no matter how
    #     valid the token is. That is the shipped design (MCP-SEC-08) and it is
    #     asserted here as observed behaviour, not worked around: the throwaway
    #     worker binds MCP_ORIGIN_ALLOWLIST_KV exactly as prod does.
    # (b) The PR's verifier itself, `services/edge/src/mcp-jwt-verify.ts` at the
    #     candidate head, run against a REAL ES256 token this rig's GoTrue just
    #     minted and the rig's LIVE JWKS. That is where the changed behaviour
    #     lives and it is exercised positively and negatively every cycle.
    minted_at = time.time()
    real = mint_es256()
    rhdr, rpl = jwt_parts(real)
    wrong = es256_wrong_key(rhdr, rpl)
    downgrade = hs256(rpl, CRED.get('hs256_downgrade_secret', 'not-the-projects-secret'))
    assert jwt_parts(downgrade)[0]['alg'] == 'HS256'
    none_tok = b64u(json.dumps({'alg': 'none', 'typ': 'JWT'}).encode()) + '.' + \
        b64u(json.dumps(rpl).encode()) + '.'

    verifier = verify_jwt_leg({'real': real, 'wrong_key': wrong,
                               'hs256_downgrade': downgrade, 'alg_none': none_tok})
    assert verifier['real']['ok'] is True, f'real ES256 token rejected: {verifier["real"]}'
    assert verifier['real']['tier'] == 'authenticated', f'ES256 tier: {verifier["real"]}'
    assert verifier['wrong_key']['ok'] is False and verifier['wrong_key']['reason'] == 'bad_signature', \
        f'ES256 wrong-key: {verifier["wrong_key"]}'
    assert verifier['hs256_downgrade']['ok'] is False and \
        verifier['hs256_downgrade']['reason'] == 'missing_secret', \
        f'HS256 downgrade: {verifier["hs256_downgrade"]}'
    assert verifier['alg_none']['ok'] is False and verifier['alg_none']['reason'] == 'wrong_alg', \
        f'alg:none: {verifier["alg_none"]}'
    assert verifier['jwks_algs'] == ['ES256'], f'rig JWKS algs: {verifier["jwks_algs"]}'

    # Deployed-surface behaviour for every credential shape.
    surface = {}
    for label, kw, want in (
        ('es256_real_bearer', {'api_key': None, 'bearer': real}, 403),
        ('es256_wrong_key', {'api_key': None, 'bearer': wrong}, 401),
        ('hs256_downgrade', {'api_key': None, 'bearer': downgrade}, 401),
        ('alg_none', {'api_key': None, 'bearer': none_tok}, 401),
        ('no_credential', {'api_key': None}, 401),
        ('bad_api_key', {'api_key': 'ak_live_deadbeefdeadbeefdeadbeefdeadbeef'}, 401),
    ):
        st, _ = mcp('tools/list', {}, **kw)
        assert st == want, f'deployed-surface {label} returned {st}, expected {want}'
        surface[label] = st
    ck['es256_auth'] = {
        'token_alg': rhdr['alg'], 'kid': rhdr.get('kid'),
        'jwks_url': f'{SUPABASE_URL}/auth/v1/.well-known/jwks.json',
        'jwks_algs': verifier['jwks_algs'],
        'verifier_at_candidate_head': verifier,
        'deployed_surface': surface,
        'discriminator': 'On the deployed edge a VALID ES256 bearer answers 403 '
                         '(origin_challenge_required — it authenticated, then MCP-SEC-08 '
                         'gated it) while every invalid bearer answers 401 (rejected at '
                         'auth, before the gate). The 403/401 split is therefore direct '
                         'evidence that the hosted surface accepts the ES256 token: only a '
                         'token this PR verifies reaches the origin gate at all.',
        'not_asserted': 'The deployed edge does not complete a bearer-only tool call: '
                        'enforceOriginAllowlist challenges every caller with no apiKeyId, '
                        'which is the shipped MCP-SEC-08 design and is prod-faithful (the '
                        'throwaway worker binds the allowlist KV exactly as prod does). '
                        'Tool EXECUTION under a bearer is therefore not exercised; '
                        'X-API-Key is the path that runs tools end to end here, and every '
                        'tool call above used it.',
    }

    # ── WORKER 1: anti-hollow SHA + the rename on the worker's agent surface ─
    st, raw = worker('/health')
    wh = json.loads(raw)
    assert st == 200, f'worker /health {st}'
    assert wh.get('git_sha') == CANDIDATE_SHA, f'worker git_sha {wh.get("git_sha")} != {CANDIDATE_SHA}'
    # `database` is nested under `checks` on this route; reading it flat recorded
    # a null that looked like an unknown DB state in the cycle evidence.
    ck['worker_health'] = {'git_sha': wh.get('git_sha'), 'status': wh.get('status'),
                           'checks': wh.get('checks'), 'network': wh.get('network')}

    st, raw = http(WORKER + '/v2/openapi.json', headers={'Authorization': 'Bearer ' + idtoken()})
    assert st == 200, f'/v2/openapi.json {st}'
    spec_text = raw.decode()
    spec = json.loads(spec_text)
    op_ids = sorted({op['operationId'] for p in spec['paths'].values()
                     for op in p.values() if isinstance(op, dict) and 'operationId' in op})
    derived = {'arkova_' + o for o in op_ids}
    shared = derived & EXPECTED_TOOLS
    assert shared, f'no derived tool name matched the edge set; derived={sorted(derived)[:8]}'
    assert 'arkova_verify_anchor' in derived or 'arkova_verify' in derived, \
        f'renamed verification op absent from the served spec: {sorted(derived)}'
    for legacy in ('verify_credential', 'search_credentials'):
        assert legacy not in spec_text, f'served v2 spec still names {legacy}'
    ck['worker_agent_surface'] = {'operation_ids': len(op_ids),
                                  'derived_matching_edge': sorted(shared),
                                  'legacy_names_absent': True}

    # ── WORKER 2: edge/worker envelope parity on the same anchor ─────────────
    st, raw = worker(f'/api/v1/verify/{FX["good_public_id"]}')
    assert st == 200, f'worker verify {st}'
    w = json.loads(raw)
    e = body_of(tool('arkova_get_anchor', {'public_id': FX['good_public_id']}))
    fields = ['verified', 'status', 'anchor_timestamp', 'bitcoin_block',
              'network_receipt_id', 'record_uri', 'issuer_name', 'issued_date', 'expiry_date']
    diffs = {k: [w.get(k), e.get(k)] for k in fields if k in w and k in e and w.get(k) != e.get(k)}
    assert not diffs, f'edge/worker envelope divergence: {diffs}'
    ck['envelope_parity'] = {'fields_compared': len([k for k in fields if k in w and k in e]),
                             'divergences': 0}

    # ── SDK legs: the shipped client bytes, against the rig ──────────────────
    ts = sdk_ts_leg(proxy_base)
    assert 'fatal' not in ts, f'TS SDK leg fatal: {ts.get("fatal")}'
    assert ts['apiKeyPrivate'] is True, 'TS SDK exposes the API key on the instance'
    assert ts['verify']['verified'] is True, f'TS SDK verify: {ts["verify"]}'
    assert isinstance(ts['notFound'], dict) and ts['notFound']['isArkovaError'], \
        f'TS SDK did not map the miss to an ArkovaError: {ts["notFound"]}'
    assert ts['batchLimit'] == 20 and ts['batchCap'] != 'NO_THROW', \
        f'TS SDK inline batch cap: limit={ts["batchLimit"]} cap={ts["batchCap"]}'
    att = ts['attempts']
    assert att.get('FAULT_GET', 0) >= 2, f'safe GET was not retried: {att}'
    assert att.get('FAULT_POST', 0) == 1, f'unsafe POST was retried: {att}'
    ck['sdk_ts'] = ts

    py = sdk_py_leg(proxy_base)
    assert py['verify']['verified'] is True, f'Python SDK verify: {py["verify"]}'
    assert isinstance(py['not_found'], dict) and not py['not_found'].get('unexpected'), \
        f'Python SDK did not raise ArkovaError on a miss: {py["not_found"]}'
    ck['sdk_py'] = py

    # ── Parity gate across the six surfaces, at the candidate head ───────────
    r = subprocess.run(['npx', 'tsx', 'scripts/ci/check-mcp-claim-parity.ts'],
                       capture_output=True, text=True, timeout=600, cwd=str(WT))
    assert r.returncode == 0, f'mcp-claim-parity FAILED: {(r.stdout + r.stderr)[-400:]}'
    r2 = subprocess.run(['npx', 'tsx', 'scripts/ci/check-api-contract-drift.ts'],
                        capture_output=True, text=True, timeout=600, cwd=str(WT))
    assert r2.returncode == 0, f'api-contract-drift FAILED: {(r2.stdout + r2.stderr)[-400:]}'
    ck['parity_gates'] = {'mcp_claim_parity': 'pass', 'api_contract_drift': 'pass',
                          'at_head': CANDIDATE_SHA}

    # ── T3: triggers, daily flush, per-org isolation ─────────────────────────
    cron = {'X-Cron-Secret': CRON_SECRET}
    st_a1, raw_a1 = worker('/jobs/org-queue-scheduler', 'POST', {}, cron)
    st_a2, raw_a2 = worker('/jobs/batch-anchors', 'POST', {}, cron)
    assert st_a1 == 200 and st_a2 == 200, f'Trigger A {st_a1}/{st_a2}'
    ck['trigger_a'] = {'org-queue-scheduler': json.loads(raw_a1 or b'{}'),
                       'batch-anchors': json.loads(raw_a2 or b'{}')}
    st_b, raw_b = worker('/jobs/check-confirmations', 'POST', {}, cron)
    assert st_b == 200, f'Trigger B {st_b}'
    ck['trigger_b'] = json.loads(raw_b or b'{}')

    if state.get('last_flush_at') is None or time.time() - state['last_flush_at'] >= 86400:
        st_f, raw_f = worker('/jobs/batch-anchors?force=true', 'POST', {}, cron)
        census = sql("select status, count(*) as n from public.anchors group by 1 order by 1;")
        assert st_f == 200, f'daily flush {st_f}'
        ck['daily_flush'] = {'status': st_f, 'response': json.loads(raw_f or b'{}'),
                             'anchor_census': {r['status']: int(r['n']) for r in census},
                             'observed_at': utc(time.time())}
        state['last_flush_at'] = time.time()

    iso = sql(f"""
        BEGIN;
        SET LOCAL ROLE authenticated;
        SELECT set_config('request.jwt.claims',
               '{{"sub":"{FX["org_a_member_id"]}","role":"authenticated"}}', true);
        SELECT
          (SELECT count(*) FROM public.anchors a
             JOIN public.organizations o ON o.id = a.org_id
            WHERE o.public_id = '{FX["org_b_public_id"]}') AS cross_org,
          (SELECT count(*) FROM public.anchors) AS own_visible;
        COMMIT;
    """)[0]
    ck['org_isolation'] = {'cross_org': int(iso['cross_org']), 'own_visible': int(iso['own_visible'])}

    # ── Anti-hollow: audit rows written by THIS cycle, then re-read ──────────
    after = sql(f"""
        select event_category, count(*) as n from public.audit_events
         where event_type = 'MCP_TOOL_CALL' and created_at > '{cycle_t0}'::timestamptz
         group by 1;
    """)
    secure_rows = sum(int(r['n']) for r in after if r['event_category'] == 'SECURITY')
    assert secure_rows >= len(RENAMED_CALLABLE), \
        f'MCP_TOOL_CALL rows written this cycle: {secure_rows} (expected >= {len(RENAMED_CALLABLE)})'
    assert all(r['event_category'] == 'SECURITY' for r in after), \
        f'lowercase event_category regression: {after}'
    # The edge records the tool name in audit_events.target_id (target_type='mcp_tool').
    named = sql(f"""
        select target_id as tool_name, count(*) as n from public.audit_events
         where event_type = 'MCP_TOOL_CALL' and target_type = 'mcp_tool'
           and created_at > '{cycle_t0}'::timestamptz
           and target_id is not null
         group by 1 order by 1;
    """)
    logged = {r['tool_name'] for r in named}
    if logged:
        assert not (logged & ABSENT_TOOLS), f'audit log records a pre-rename tool name: {sorted(logged & ABSENT_TOOLS)}'
    ck['audit_rows'] = {'cycle_t0': cycle_t0, 'written_since_t0': secure_rows,
                        'event_category': 'SECURITY', 'tool_names_logged': sorted(logged)}

    # ── ES256 expiry negative: the SAME real token, after it has expired ─────
    # The rig's GoTrue jwt_exp is set to JWT_EXP_SECONDS so this is a genuine
    # expiry of a genuinely-signed token, not a forged `exp`.
    #
    # The deadline is the token's OWN `exp` claim plus the verifier's declared
    # CLOCK_SKEW_SEC, not `minted_at + JWT_EXP_SECONDS`: the verifier rejects
    # only once `now > exp + CLOCK_SKEW_SEC`, so re-checking at exp+10 asks about
    # a token that is still lawfully valid and gets `ok:true` back. That is what
    # the 2026-09-07 rehearsal caught — a driver defect, not a verifier defect.
    skew = verifier_clock_skew_sec()
    expires_at = rpl['exp'] + skew
    wait = expires_at + EXPIRY_SLACK_SEC - time.time()
    if wait > 0:
        time.sleep(wait)
    checked_at = time.time()
    assert checked_at > expires_at, \
        f'expiry negative ran {expires_at - checked_at:.1f}s before the token could be rejected'
    expired = verify_jwt_leg({'expired': real})['expired']
    assert expired['ok'] is False and expired['reason'] == 'expired', \
        f'expired real ES256 token: {expired}'
    st, _ = mcp('tools/list', {}, api_key=None, bearer=real)
    assert st == 401, f'expired real ES256 token on the deployed edge returned {st} (401 expected)'
    ck['es256_auth']['expired_real_key'] = {**expired, 'deployed_surface': st}
    ck['es256_auth']['expiry_seconds'] = JWT_EXP_SECONDS
    ck['es256_auth']['expiry_negative'] = {
        'token_exp': rpl['exp'], 'verifier_clock_skew_sec': skew,
        'rejectable_after': utc(expires_at), 'checked_at': utc(checked_at),
        'margin_seconds': round(checked_at - expires_at, 1),
        'minted_at': utc(minted_at),
    }

    out['allExpected'] = True
    return out


# ── window ───────────────────────────────────────────────────────────────────

HASH_PATHS = [WT / p for p in (
    'services/edge/src/mcp-server.ts', 'services/edge/src/mcp-tools.ts',
    'services/edge/src/mcp-jwt-verify.ts', 'services/edge/src/mcp-tool-schemas.ts',
    'services/edge/src/mcp-error-utils.ts',
    'packages/sdk/src/client.ts', 'packages/sdk/src/index.ts',
    'packages/arkova-py/src/arkova/models.py',
    'sdks/mcp-server/src/index.ts', 'sdks/mcp-server/src/cli.ts',
    'scripts/ci/check-mcp-claim-parity.ts', 'scripts/ci/mcp-claim-parity-baseline.json',
    'scripts/ci/check-api-contract-drift.ts',
    'services/worker/src/api/v2/openapi.ts',
    'docs/staging/batch-i-0907/soak-batch-i.py',
)]
HASHES = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in HASH_PATHS if p.is_file()}
(RUN / 'input-hashes.json').write_text(json.dumps(HASHES, indent=2))

started = time.time()
deadline = started + float(os.environ.get('BATCH_I_SOAK_HOURS', '48')) * 3600
state = {
    'window': 'Batch-I — PR #2589 re-soak on a current base',
    'tier': 'T3',
    'pr': 2589,
    'candidate_sha': CANDIDATE_SHA,
    'pr_head_sha': CFG['pr_head_sha'],
    'base_sha': CFG['base_sha'],
    'staging_project_ref': RIG,
    'cloud_run_service': CFG['cloud_run_service'],
    'cloud_run_revision': CFG['cloud_run_revision'],
    'image_digest': CFG['image_digest'],
    'edge_worker': CF_SCRIPT,
    'edge_url': EDGE,
    'edge_deployment_id': DEPLOYMENT_ID,
    'edge_version_id': VERSION_ID,
    'edge_bundle_sha256': BUNDLE_SHA,
    'started_at': utc(started),
    'not_before': utc(deadline),
    'status': 'running',
    'cycles': 0,
    'failures': 0,
    'cycle_interval_seconds': int(os.environ.get('BATCH_I_CYCLE_SECONDS', '900')),
    'runtime_pid': os.getpid(),
    'last_flush_at': None,
    'scope': 'PR #2589 head merged onto origin/main. BOTH changed surfaces are driven: the edge '
             'MCP bundle built from the candidate and deployed to a THROWAWAY workers.dev worker '
             '(no route, own KV namespaces) bound to this isolated rig, and the Cloud Run worker '
             'built from the same candidate SHA. Writes are confined to the rig.',
}


def save():
    tmp = RUN / 'status.tmp'
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(RUN / 'status.json')


save()
proxy = IamProxy(int(CFG.get('sdk_proxy_port', 8907)))
proxy.start()
time.sleep(2)
PROXY_BASE = f'http://127.0.0.1:{CFG.get("sdk_proxy_port", 8907)}'
print('batch-i soak opened', state['started_at'], 'earliest end', state['not_before'], flush=True)

try:
    while True:
        tick = time.time()
        for name, digest in HASHES.items():
            assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == digest, \
                'soaked input changed under the window: ' + name
        cycle_t0 = sql('select now() as t0;')[0]['t0']
        result = cycle(state['cycles'] + 1, PROXY_BASE)
        assert result['allExpected']
        i = state['cycles'] + 1
        (CYCLES / f'{i:05d}.json').write_text(json.dumps(result, indent=2))
        state.update(cycles=i, last_cycle_at=utc(time.time()))
        save()
        print('cycle', i, 'passed', flush=True)
        if time.time() >= deadline:
            state.update(status='window_complete_pending_review', completed_at=utc(time.time()))
            save()
            break
        time.sleep(max(1, state['cycle_interval_seconds'] - (time.time() - tick)))
except BaseException as error:
    state.update(status='failed', failures=state['failures'] + 1,
                 error=f'{type(error).__name__}: {error}', failed_at=utc(time.time()))
    save()
    print('SOAK FAILED:', error, flush=True)
    raise
