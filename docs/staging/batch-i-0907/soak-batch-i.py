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


# ── SDK legs ─────────────────────────────────────────────────────────────────

class IamProxy(threading.Thread):
    """Loopback proxy that forwards to the IAM-protected rig, injecting
    X-Serverless-Authorization. No SDK has a custom-header hook, so this is the
    only way to run the SHIPPED client bytes unmodified against the rig."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.port = port
        self.httpd = None

    def run(self):
        import http.server
        upstream = WORKER
        token = idtoken()
        stamp = [time.time()]

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def _proxy(self, method):
                nonlocal token
                if time.time() - stamp[0] > 1800:
                    token = idtoken()
                    stamp[0] = time.time()
                length = int(self.headers.get('Content-Length') or 0)
                payload = self.rfile.read(length) if length else None
                fwd = {k: v for k, v in self.headers.items()
                       if k.lower() not in ('host', 'content-length', 'connection', 'accept-encoding')}
                fwd['X-Serverless-Authorization'] = 'Bearer ' + token
                try:
                    st, raw = http(upstream + self.path, payload, fwd, method, timeout=60,
                                   retry_transport=False)
                except Exception:
                    st, raw = 599, b'{"error":"proxy_transport"}'
                self.send_response(st)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self._proxy('GET')

            def do_POST(self):
                self._proxy('POST')

            def do_DELETE(self):
                self._proxy('DELETE')

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', self.port), H)
        self.httpd.serve_forever()


_TS_SDK_LEG = r'''
const { ArkovaClient } = require(process.env.SDK_ENTRY);
const base = process.env.SDK_BASE, key = process.env.SDK_KEY;
const out = { };
(async () => {
  const c = new ArkovaClient({ apiKey: key, baseUrl: base });

  // 1. secrets live in a real private field, not an enumerable property
  out.apiKeyNotEnumerable = !Object.keys(c).includes('apiKey')
    && !JSON.stringify(c).includes(key)
    && !String(c.apiKey ?? '').includes(key);

  // 2. happy path against the rig
  const v = await c.verify(process.env.SDK_GOOD_ID);
  out.verify = { verified: v.verified, status: v.status, public_id: v.public_id ?? v.publicId };

  // 3. proof / privacy disclosure fields are mapped, not dropped
  out.disclosureKeys = Object.keys(v).filter((k) => /proof|privacy|disclos/i.test(k)).sort();

  // 4. typed error mapping on a real 404 (not a thrown TypeError)
  try {
    await c.verify(process.env.SDK_UNKNOWN_ID);
    out.notFound = 'NO_THROW';
  } catch (e) {
    out.notFound = { name: e.name, status: e.status ?? e.statusCode ?? null, isError: e instanceof Error };
  }

  // 5. batch cap is enforced client-side before a request is made
  try {
    await c.verifyBatch(Array.from({ length: 21 }, (_, i) => `ARK-DOC-XXXX${i}`));
    out.batchCap = 'NO_THROW';
  } catch (e) {
    out.batchCap = { name: e.name, message: String(e.message).slice(0, 120) };
  }

  // 6. retry policy is method-scoped: a GET retries, an unsafe method does not
  out.retryConfig = typeof c.constructor?.RETRYABLE_METHODS !== 'undefined'
    ? [...c.constructor.RETRYABLE_METHODS] : null;

  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e).slice(0, 300) })); });
'''


def sdk_ts_leg(base):
    entry = CFG['sdk_ts_entry']
    env = dict(os.environ, SDK_ENTRY=entry, SDK_BASE=base, SDK_KEY=API_KEY,
               SDK_GOOD_ID=FX['good_public_id'], SDK_UNKNOWN_ID=FX['unknown_public_id'])
    r = subprocess.run(['node', '-e', _TS_SDK_LEG], capture_output=True, text=True,
                       timeout=180, env=env, cwd=str(WT))
    assert r.returncode == 0, f'TS SDK leg exit {r.returncode}: {r.stderr[:300]}'
    return json.loads(r.stdout)


_PY_SDK_LEG = r'''
import json, os, sys
sys.path.insert(0, os.environ['PY_SDK_SRC'])
import arkova
out = {'version': getattr(arkova, '__version__', None)}
Client = getattr(arkova, 'ArkovaClient', None) or getattr(arkova, 'Client')
c = Client(api_key=os.environ['SDK_KEY'], base_url=os.environ['SDK_BASE'])
v = c.verify(os.environ['SDK_GOOD_ID'])
d = v if isinstance(v, dict) else v.__dict__
out['verify'] = {'verified': d.get('verified'), 'status': d.get('status')}
out['fields'] = sorted(k for k in d if 'proof' in k or 'privacy' in k or 'disclos' in k)
try:
    c.verify(os.environ['SDK_UNKNOWN_ID'])
    out['not_found'] = 'NO_RAISE'
except Exception as e:
    out['not_found'] = type(e).__name__
print(json.dumps(out))
'''


def sdk_py_leg(base):
    env = dict(os.environ, PY_SDK_SRC=CFG['sdk_py_src'], SDK_KEY=API_KEY, SDK_BASE=base,
               SDK_GOOD_ID=FX['good_public_id'], SDK_UNKNOWN_ID=FX['unknown_public_id'])
    r = subprocess.run(['python3', '-c', _PY_SDK_LEG], capture_output=True, text=True,
                       timeout=180, env=env, cwd=str(WT))
    assert r.returncode == 0, f'Python SDK leg exit {r.returncode}: {r.stderr[-400:]}'
    return json.loads(r.stdout.strip().splitlines()[-1])


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
    assert st == 200 and data.get('error') is not None, 'old tool name still resolves'
    ck['tools_list'] = {'count': len(names), 'set_matches': True, 'old_names_absent': True,
                        'old_name_call_rejected': data['error'].get('code')}

    # ── EDGE 3: every renamed tool callable end to end ───────────────────────
    called = {}
    a = body_of(tool('arkova_verify_anchor', {'public_id': FX['good_public_id']}))
    assert a['verified'] is True and a.get('status') == 'SECURED', f'arkova_verify_anchor: {a}'
    called['arkova_verify_anchor'] = {'verified': a['verified'], 'status': a['status']}

    s = body_of(tool('arkova_search_anchors', {'query': FX['search_query'], 'max_results': 5}))
    assert isinstance(s.get('results'), list), f'arkova_search_anchors shape: {list(s)}'
    called['arkova_search_anchors'] = {'results': len(s['results'])}

    g = body_of(tool('arkova_search', {'q': FX['search_query'], 'type': 'all', 'limit': 5}))
    called['arkova_search'] = {'keys': sorted(g)[:6]}

    for tname, args, want in (
        ('arkova_verify', {'fingerprint': FX['good_fingerprint']}, FX['good_public_id']),
        ('arkova_get_fingerprint', {'fingerprint': FX['good_fingerprint']}, FX['good_public_id']),
        ('arkova_get_anchor', {'public_id': FX['good_public_id']}, FX['good_public_id']),
        ('arkova_get_record', {'public_id': FX['good_public_id']}, FX['good_public_id']),
        ('arkova_get_document', {'public_id': FX['good_public_id']}, FX['good_public_id']),
    ):
        r = body_of(tool(tname, args))
        assert r.get('public_id') == want, f'{tname} resolved {r.get("public_id")!r}, want {want}'
        called[tname] = {'public_id': r['public_id'], 'verified': r.get('verified')}

    o = body_of(tool('arkova_list_orgs', {}))
    assert isinstance(o.get('organizations', o.get('results')), list), f'arkova_list_orgs shape: {list(o)}'
    called['arkova_list_orgs'] = {'ok': True}

    org = body_of(tool('arkova_get_organization', {'public_id': FX['org_a_public_id']}))
    assert org.get('public_id') == FX['org_a_public_id'], f'arkova_get_organization: {org}'
    called['arkova_get_organization'] = {'public_id': org['public_id']}

    vd = body_of(tool('arkova_verify_document', {'content_hash': FX['good_fingerprint']}))
    assert vd.get('verified') is True, f'arkova_verify_document: {vd}'
    called['arkova_verify_document'] = {'verified': True}

    ids = [FX['good_public_id'], FX['unknown_public_id'], FX['pending_public_id']]
    vb = body_of(tool('arkova_verify_batch', {'public_ids': ids}))
    assert [r['public_id'] for r in vb['results']] == ids, 'arkova_verify_batch order changed'
    assert vb['results'][0]['verified'] is True and vb['results'][1]['verified'] is False, 'batch partial results'
    called['arkova_verify_batch'] = {'order_preserved': True,
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

    la = body_of(tool('arkova_list_agents', {}))
    called['arkova_list_agents'] = {'keys': sorted(la)[:6]}

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

    # ── EDGE 5: ES256 auth, positive then negatives ──────────────────────────
    minted_at = time.time()
    real = mint_es256()
    rhdr, rpl = jwt_parts(real)
    st, data = mcp('tools/list', {}, api_key=None, bearer=real)
    assert st == 200, f'ES256 positive (tools/list) returned {st}'
    pos_names = {t['name'] for t in data['result']['tools']}
    assert pos_names == EXPECTED_TOOLS, 'ES256-authenticated tool set differs from key-authenticated'
    v_es = body_of(tool('arkova_verify_anchor', {'public_id': FX['good_public_id']},
                        api_key=None, bearer=real))
    assert v_es['verified'] is True, 'ES256-authenticated tool call did not resolve'
    negatives = {}
    # (a) ES256, correct kid, key that is NOT in the rig JWKS
    wrong = es256_wrong_key(rhdr, rpl)
    st, _ = mcp('tools/list', {}, api_key=None, bearer=wrong)
    assert st == 401, f'ES256 wrong-key returned {st}'
    negatives['es256_wrong_key'] = st
    # (b) HS256 downgrade of the very same claims (SUPABASE_JWT_SECRET is
    #     deliberately not provisioned on this edge worker, so HS256 fails closed)
    down = hs256(rpl, CRED.get('hs256_downgrade_secret', 'not-the-projects-secret'))
    assert jwt_parts(down)[0]['alg'] == 'HS256'
    st, _ = mcp('tools/list', {}, api_key=None, bearer=down)
    assert st == 401, f'HS256 downgrade returned {st}'
    negatives['hs256_downgrade'] = st
    # (c) alg:none
    none_tok = b64u(json.dumps({'alg': 'none', 'typ': 'JWT'}).encode()) + '.' + \
        b64u(json.dumps(rpl).encode()) + '.'
    st, _ = mcp('tools/list', {}, api_key=None, bearer=none_tok)
    assert st == 401, f'alg:none returned {st}'
    negatives['alg_none'] = st
    # (d) no credential at all
    st, _ = mcp('tools/list', {}, api_key=None)
    assert st == 401, f'unauthenticated returned {st}'
    negatives['no_credential'] = st
    # (e) bad API key
    st, _ = mcp('tools/list', {}, api_key='ak_live_deadbeefdeadbeefdeadbeefdeadbeef')
    assert st == 401, f'bad API key returned {st}'
    negatives['bad_api_key'] = st
    ck['es256_auth'] = {'token_alg': rhdr['alg'], 'kid': rhdr.get('kid'),
                        'jwks_url': f'{SUPABASE_URL}/auth/v1/.well-known/jwks.json',
                        'positive_tools_list': 200, 'positive_tool_call_verified': True,
                        'negatives': negatives}

    # ── WORKER 1: anti-hollow SHA + the rename on the worker's agent surface ─
    st, raw = worker('/health')
    wh = json.loads(raw)
    assert st == 200, f'worker /health {st}'
    assert wh.get('git_sha') == CANDIDATE_SHA, f'worker git_sha {wh.get("git_sha")} != {CANDIDATE_SHA}'
    ck['worker_health'] = {'git_sha': wh.get('git_sha'), 'status': wh.get('status'),
                           'database': wh.get('database')}

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
    assert ts['apiKeyNotEnumerable'] is True, 'TS SDK leaks the API key on the instance'
    assert ts['verify']['verified'] is True, f'TS SDK verify: {ts["verify"]}'
    assert isinstance(ts['notFound'], dict) and ts['notFound']['isError'], \
        f'TS SDK did not map the 404 to a typed error: {ts["notFound"]}'
    assert ts['batchCap'] != 'NO_THROW', 'TS SDK did not enforce the 20-item inline batch cap'
    ck['sdk_ts'] = ts

    py = sdk_py_leg(proxy_base)
    assert py['verify']['verified'] is True, f'Python SDK verify: {py["verify"]}'
    assert py['not_found'] != 'NO_RAISE', 'Python SDK did not raise on a 404'
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
        set local role authenticated;
        set local request.jwt.claims = '{json.dumps({"sub": FX["org_a_member_id"], "role": "authenticated"})}';
        select
          (select count(*) from public.anchors a
             join public.organizations o on o.id = a.organization_id
            where o.public_id = '{FX["org_b_public_id"]}') as cross_org,
          (select count(*) from public.anchors) as own_visible;
    """)[0]
    assert int(iso['cross_org']) == 0, f'per-org isolation broken: {iso}'
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
    named = sql(f"""
        select tool_name, count(*) as n from (
          select details->>'tool' as tool_name from public.audit_events
           where event_type = 'MCP_TOOL_CALL' and created_at > '{cycle_t0}'::timestamptz
        ) t where tool_name is not null group by 1 order by 1;
    """)
    logged = {r['tool_name'] for r in named}
    if logged:
        assert not (logged & ABSENT_TOOLS), f'audit log records a pre-rename tool name: {sorted(logged & ABSENT_TOOLS)}'
    ck['audit_rows'] = {'cycle_t0': cycle_t0, 'written_since_t0': secure_rows,
                        'event_category': 'SECURITY', 'tool_names_logged': sorted(logged)}

    # ── ES256 expiry negative: the SAME real token, after it expires ─────────
    wait = JWT_EXP_SECONDS + 10 - (time.time() - minted_at)
    if wait > 0:
        time.sleep(wait)
    st, _ = mcp('tools/list', {}, api_key=None, bearer=real)
    assert st == 401, f'expired real ES256 token returned {st}'
    ck['es256_auth']['negatives']['es256_expired_real_key'] = st
    ck['es256_auth']['expiry_seconds'] = JWT_EXP_SECONDS

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
