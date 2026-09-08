#!/usr/bin/env python3
"""Edge catch-up retro-soak driver (T2, 12 h) — arkova-edge-retro-0907.

Exercises the origin/main services/edge bundle deployed to a THROWAWAY
workers.dev worker against the standing shared staging rig. Read-only:
the only rows it creates are the edge's own MCP_TOOL_CALL audit rows.
"""
import datetime, hashlib, hmac, json, os, pathlib, subprocess, time, urllib.error, urllib.request

D = pathlib.Path('/Volumes/Extreme/offload/arkova-edge-retro-0907')
C = D / os.environ.get('RETRO_CYCLE_DIR', 'cycles'); C.mkdir(exist_ok=True)
SRC = pathlib.Path('/private/tmp/claude-502/-Volumes-Extreme-Arkova--legacy-home-Arkova-2026-05-15-arkova-mvpcopy-main/679a22d9-08a2-4862-95a8-f4ddb8049518/scratchpad/wt-edge-retro/services/edge')

WORKER_URL = 'https://arkova-edge-retro-0907.carson-182.workers.dev'
ORIGIN = 'https://retro-soak.invalid'
SHA = '61f04403d7802bb5fb882f473dc21357b5e4cacd'
BUNDLE_SHA = 'b5a8942e0650b9ee3e40bc1e3e4a4b6175f8e4854a36b7140bad239998daf365'
DEPLOYMENT_ID = '69d42679-9379-4559-b914-555538697a73'
VERSION_ID = 'fb093cd8-304a-4bb1-90b2-cab730f0b110'
RIG = 'fizyjojbebyalirtjjht'
CF_ACC = '1823ad5cbd8a0dc10aeac93cda743bb5'
STAGING_WORKER = 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app'

API_KEY = (D / '.rig-api-key').read_text().strip()
SB_TOKEN = (D / '.sb-token').read_text().strip()
CF_TOKEN = (D / '.cf-token').read_text().strip()
CREDS = json.loads((D / '.driver-creds.json').read_text())
SIGNING_KEY = CREDS['signing_key']; JWT_SECRET = CREDS['jwt_secret']

# Fixture set on the rig (verified 2026-09-07 pre-window).
GOOD = 'ARK-BBSEC-000001'      # SECURED, chain_block_height 880001
GOOD_FP = '1' * 64
UNKNOWN = 'ARK-BBUNK-999999'   # schema-valid, no such row
PENDING = 'ARK-BBPEN-000001'   # PENDING -> bitcoin_block null
MALFORMED = 'not-an-id!!'      # schema-invalid -> -32602 at the Zod boundary

# tools/list contract on origin/main. anchor_document is registered only when
# MCP_ENABLE_ANCHOR_DOCUMENT=true (unset here), so 15 of the 16 definitions.
EXPECTED_TOOLS = {
    'verify_credential', 'search_credentials', 'search', 'verify', 'list_orgs',
    'get_anchor', 'get_organization', 'get_record', 'get_fingerprint',
    'get_document', 'nessie_query', 'verify_document', 'verify_batch',
    'oracle_batch_verify', 'list_agents',
}
# The *_anchor renames (PR #2589) are NOT on origin/main — assert their absence
# so a later rename cannot land unnoticed while this evidence is cited.
ABSENT_TOOLS = {'verify_anchor', 'search_anchors', 'anchor_status',
                'arkova_verify_anchor', 'arkova_search_anchors'}


def http(url, data=None, headers=None, method=None, timeout=60, retry_transport=True):
    """One retry on a transport-level failure only (never on an HTTP status)."""
    attempts = []
    hdrs = dict(headers or {})
    hdrs.setdefault('User-Agent', 'arkova-edge-retro-0907/1.0')
    for i in range(2):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read(), attempts
        except urllib.error.HTTPError as e:
            return e.code, e.read(), attempts
        except urllib.error.URLError as e:
            attempts.append({'attempt': i + 1, 'error': 'URLError:' + str(e.reason)[:80]})
            if not retry_transport or i == 1:
                raise
            time.sleep(2)
            continue
        except Exception as e:                       # transport drop (memory item 7)
            attempts.append({'attempt': i + 1, 'error': type(e).__name__})
            if not retry_transport or i == 1:
                raise
            time.sleep(2)


def mcp(method, params, api_key=API_KEY, origin=ORIGIN, bearer=None):
    h = {'Content-Type': 'application/json',
         'Accept': 'application/json, text/event-stream',
         'MCP-Protocol-Version': '2025-03-26'}
    if origin:
        h['Origin'] = origin
    if api_key:
        h['X-API-Key'] = api_key
    if bearer:
        h['Authorization'] = 'Bearer ' + bearer
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    status, raw, _ = http(WORKER_URL + '/mcp', body, h, 'POST')
    return status, (json.loads(raw) if raw and status == 200 else None)


def tool(name, args):
    status, data = mcp('tools/call', {'name': name, 'arguments': args})
    assert status == 200, f'{name} HTTP {status}'
    assert 'error' not in data, f'{name} protocol error: {json.dumps(data["error"])[:300]}'
    return data['result']


def body_of(result):
    return json.loads(result['content'][0]['text'])


def sql(query):
    body = json.dumps({'query': query}).encode()
    status, raw, _ = http(f'https://api.supabase.com/v1/projects/{RIG}/database/query', body,
                          {'Authorization': 'Bearer ' + SB_TOKEN, 'Content-Type': 'application/json'},
                          'POST', timeout=120)
    assert status in (200, 201), f'rig query HTTP {status}'
    return json.loads(raw)


def b64u(b):
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def hs256(payload, secret):
    hdr = b64u(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    pl = b64u(json.dumps(payload, separators=(',', ':')).encode())
    sig = b64u(hmac.new(secret.encode(), f'{hdr}.{pl}'.encode(), hashlib.sha256).digest())
    return f'{hdr}.{pl}.{sig}'


def cycle():
    out = {'ts': utc(time.time()), 'checks': {}}
    ck = out['checks']

    # 1. /health
    status, raw, _ = http(WORKER_URL + '/health')
    health = json.loads(raw)
    assert status == 200 and health.get('status') == 'ok' and health.get('service') == 'arkova-edge', 'health'
    ck['health'] = health
    # /health carries NO build/version field on origin/main -> the bundle
    # identity is re-asserted out-of-band from the Cloudflare API instead.

    # 2. Anti-hollow: the live deployment is still the exact bundle we soaked.
    st, raw, _ = http(f'https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/workers/scripts/arkova-edge-retro-0907/deployments',
                      headers={'Authorization': 'Bearer ' + CF_TOKEN})
    dep = json.loads(raw)['result']['deployments'][0]
    assert dep['id'] == DEPLOYMENT_ID, f'deployment changed: {dep["id"]}'
    assert dep['versions'][0]['version_id'] == VERSION_ID, 'version changed'
    ck['deployment_identity'] = {'deployment_id': dep['id'], 'version_id': dep['versions'][0]['version_id']}

    # 3. tools/list contract + rename-absence guard
    status, data = mcp('tools/list', {})
    assert status == 200, f'tools/list HTTP {status}'
    names = {t['name'] for t in data['result']['tools']}
    assert names == EXPECTED_TOOLS, f'tool set drift: {sorted(names ^ EXPECTED_TOOLS)}'
    assert not (names & ABSENT_TOOLS), 'unexpected *_anchor rename present'
    ck['tools_list'] = {'count': len(names), 'set_matches': True, 'renames_absent': True}

    # 4. Audit rows: count before, drive traffic, re-count (row written AND re-read)
    before = int(sql(f"select count(*) from audit_events where event_type='MCP_TOOL_CALL' "
                     f"and event_category='SECURITY' and created_at > now() - interval '30 minutes';")[0]['count'])
    # DB-side cycle-start timestamp: the audit assertion counts rows written AFTER this
    # instant, not inside a sliding 30-minute window (a sliding window at a 15-minute cadence
    # let cycle-1 rows fall out exactly as cycle-3 rows entered -> false '10 -> 10' failure).
    cycle_t0 = sql("select now() as t0;")[0]['t0']

    # 5. verify_batch — partial results survive a mixed batch (#2434)
    ids = [GOOD, UNKNOWN, PENDING]
    vb = body_of(tool('verify_batch', {'public_ids': ids}))
    assert [r['public_id'] for r in vb['results']] == ids, 'verify_batch order changed'
    assert vb['results'][0]['verified'] is True, 'good member lost'
    assert vb['results'][1]['verified'] is False and vb['results'][1]['status'] == 'UNKNOWN', 'unknown member wrong'
    assert vb['results'][2]['verified'] is False and vb['results'][2]['status'] == 'PENDING', 'pending member wrong'
    # 6. #1106 bitcoin_block: key ALWAYS present, never undefined; null when unconfirmed
    for r in vb['results']:
        assert 'bitcoin_block' in r, f'bitcoin_block missing on {r["public_id"]}'
    assert vb['results'][0]['bitcoin_block'] == 880001, 'bitcoin_block value drift'
    assert vb['results'][1]['bitcoin_block'] is None and vb['results'][2]['bitcoin_block'] is None, 'bitcoin_block should be null'
    ck['verify_batch'] = {'order_preserved': True, 'partial_results': True,
                          'bitcoin_block': [r['bitcoin_block'] for r in vb['results']]}

    # 7. oracle_batch_verify — same partial-results contract + signed envelope
    env = body_of(tool('oracle_batch_verify', {'public_ids': ids}))
    assert set(env) >= {'alg', 'key_id', 'payload', 'signature'}, 'envelope shape'
    canon = json.dumps(env['payload'], separators=(',', ':'), ensure_ascii=False).encode()
    expect = hmac.new(SIGNING_KEY.encode(), canon, hashlib.sha256).hexdigest()
    assert hmac.compare_digest(expect, env['signature']), 'envelope signature invalid'
    # negative: a tampered payload must not verify under the returned signature
    tampered = json.loads(json.dumps(env['payload']))
    tampered['results'][0]['verified'] = False
    bad = hmac.new(SIGNING_KEY.encode(),
                   json.dumps(tampered, separators=(',', ':'), ensure_ascii=False).encode(),
                   hashlib.sha256).hexdigest()
    assert not hmac.compare_digest(bad, env['signature']), 'tampered payload verified'
    orec = env['payload']['results']
    assert [r['public_id'] for r in orec] == ids, 'oracle order changed'
    assert orec[0]['verified'] and not orec[1]['verified'] and not orec[2]['verified'], 'oracle partial results'
    for r in orec:
        assert 'bitcoin_block' in r, 'oracle bitcoin_block missing'
    ck['oracle_batch_verify'] = {'alg': env['alg'], 'signature_valid': True,
                                 'tamper_rejected': True, 'partial_results': True}

    # 8. schema-invalid member: rejected at the Zod boundary with a sanitized message
    st, data = mcp('tools/call', {'name': 'oracle_batch_verify',
                                  'arguments': {'public_ids': [GOOD, MALFORMED, PENDING]}})
    assert st == 200 and data['result'].get('isError'), 'malformed id was not rejected'
    msg = data['result']['content'][0]['text']
    assert '-32602' in msg and 'ARK-<TYPE>' in msg, 'unexpected validation message'
    for leak in ('supabase.co', 'service_role', 'eyJ', 'at Object.', '/private/tmp', 'stack'):
        assert leak not in msg, f'error text leaked {leak!r}'
    ck['malformed_rejected'] = {'sanitized': True, 'message': msg[:160]}

    # 9. verify-by-fingerprint (get_public_anchor_by_fingerprint RPC path)
    for tname in ('verify', 'get_fingerprint'):
        fp = body_of(tool(tname, {'fingerprint': GOOD_FP}))
        assert fp['public_id'] == GOOD and fp['verified'] is True, f'{tname} fingerprint lookup'
        assert 'bitcoin_block' in fp and fp['bitcoin_block'] == 880001, f'{tname} bitcoin_block'
    ck['verify_by_fingerprint'] = {'verify': True, 'get_fingerprint': True}

    # 10. Envelope parity with the worker's /api/v1/verify for the same public_id
    idt = subprocess.run(['gcloud', 'auth', 'print-identity-token'],
                         capture_output=True, text=True, timeout=90).stdout.strip()
    st, raw, _ = http(f'{STAGING_WORKER}/api/v1/verify/{GOOD}',
                      headers={'Authorization': 'Bearer ' + idt})
    assert st == 200, f'worker verify HTTP {st}'
    w = json.loads(raw)
    e = body_of(tool('get_anchor', {'public_id': GOOD}))
    shared = ['verified', 'status', 'anchor_timestamp', 'bitcoin_block',
              'network_receipt_id', 'record_uri', 'issuer_name', 'issued_date', 'expiry_date']
    diffs = {k: [w.get(k), e.get(k)] for k in shared if w.get(k) != e.get(k)}
    assert not diffs, f'edge/worker envelope divergence: {diffs}'
    ck['worker_parity'] = {'fields_compared': len(shared), 'divergences': 0}

    # 11. Auth: positive already proven above (every call used the key). Negatives:
    negs = {}
    for label, kw in (('no_key', {'api_key': None}),
                      ('bad_key', {'api_key': 'ak_live_deadbeefdeadbeefdeadbeefdeadbeef'}),
                      ('bearer_wrong_secret', {'api_key': None, 'bearer': hs256(
                          {'sub': '00000000-0000-0000-0000-000000000000', 'aud': 'authenticated',
                           'exp': int(time.time()) + 600, 'iat': int(time.time())}, 'wrong-secret')}),
                      ('bearer_expired', {'api_key': None, 'bearer': hs256(
                          {'sub': '00000000-0000-0000-0000-000000000000', 'aud': 'authenticated',
                           'exp': int(time.time()) - 600, 'iat': int(time.time()) - 1200}, JWT_SECRET)})):
        st, _ = mcp('tools/list', {}, **kw)
        assert st == 401, f'auth negative {label} returned {st}'
        negs[label] = st
    ck['auth'] = {'positive': 'X-API-Key accepted on every tool call this cycle',
                  'negatives': negs,
                  'note': 'ES256 signed-request auth is NOT on origin/main (PR #2589 open); '
                          'the deployed auth surface is X-API-Key + HS256 bearer.'}

    # 12. Audit rows re-counted after the traffic (anti-hollow: written AND re-read)
    after_rows = sql("select event_category, count(*) as n from audit_events "
                     f"where event_type='MCP_TOOL_CALL' and created_at > '{cycle_t0}'::timestamptz "
                     "group by 1;")
    after = sum(int(r['n']) for r in after_rows if r['event_category'] == 'SECURITY')
    # Every cycle drives the same tool set; cycles 1-2 of the retired window each wrote 5 rows.
    assert after >= 5, f'MCP_TOOL_CALL audit rows written since cycle start: {after} (expected >= 5)'
    assert all(r['event_category'] == 'SECURITY' for r in after_rows), \
        f'lowercase event_category regression: {after_rows}'
    ck['audit_rows'] = {'before_30m': before, 'cycle_t0': cycle_t0, 'written_since_t0': after,
                        'event_category': 'SECURITY'}

    out['allExpected'] = True
    return out


utc = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()

# Freeze the soaked inputs; any drift under a running window voids it.
paths = [SRC / p for p in subprocess.check_output(
    ['git', 'ls-files', 'services/edge'], cwd=SRC.parent.parent, text=True).splitlines()]
paths = [SRC.parent.parent / p for p in subprocess.check_output(
    ['git', 'ls-files', 'services/edge'], cwd=SRC.parent.parent, text=True).splitlines()]
paths += [D / 'wrangler.retro.toml', D / 'driver.py']
HASHES = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}
(D / 'input-hashes.json').write_text(json.dumps(HASHES, indent=2))

started = time.time()
deadline = started + float(os.environ.get('RETRO_SOAK_HOURS', '12')) * 3600
state = {
    'window': 'edge-catch-up retro-soak',
    'tier': 'T2',
    'soaked_source_sha': SHA,
    'bundle_sha256': BUNDLE_SHA,
    'worker_name': 'arkova-edge-retro-0907',
    'worker_url': WORKER_URL,
    'deployment_id': DEPLOYMENT_ID,
    'version_id': VERSION_ID,
    'staging_project_ref': RIG,
    'preflight': 'soak_artifact (prod_divergence: extra ledger row 0420 from PR #2442) — NOT clean_mirror',
    'started_at': utc(started),
    'not_before': utc(deadline),
    'status': 'running',
    'cycles': 0,
    'failures': 0,
    'cycle_interval_seconds': 900,
    'runtime_pid': os.getpid(),
    'scope': 'origin/main services/edge bundle deployed to a THROWAWAY workers.dev worker '
             '(no route, own KV namespaces) against the standing shared staging rig. Read-only '
             'verification traffic; the only rows written are the edge worker\'s own '
             'MCP_TOOL_CALL audit rows.',
}


def save():
    t = C.parent / ('status.tmp' if C.name=='cycles' else C.name+'.status.tmp')
    t.write_text(json.dumps(state, indent=2))
    t.replace(C.parent / ('status.json' if C.name=='cycles' else C.name+'.status.json'))


save()
print('edge retro-soak opened', state['started_at'], 'earliest end', state['not_before'], flush=True)
try:
    while True:
        tick = time.time()
        for name, digest in HASHES.items():
            assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == digest, \
                'soaked input changed under the window: ' + name
        result = cycle()
        assert result['allExpected']
        i = state['cycles'] + 1
        (C / f'{i:05d}.json').write_text(json.dumps(result, indent=2))
        state.update(cycles=i, last_cycle_at=utc(time.time()))
        save()
        print('cycle', i, 'passed', flush=True)
        if time.time() >= deadline:
            state.update(status='window_complete_pending_review', completed_at=utc(time.time()))
            save()
            break
        time.sleep(max(1, 900 - (time.time() - tick)))
except BaseException as error:
    state.update(status='failed', failures=state['failures'] + 1,
                 error=f'{type(error).__name__}: {error}', failed_at=utc(time.time()))
    save()
    print('SOAK FAILED:', error, flush=True)
    raise
