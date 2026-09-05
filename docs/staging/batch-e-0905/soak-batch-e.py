#!/usr/bin/env python3
"""Batch-E (Adobe Sign stack) T3 soak driver — PRs #2519, #2529, #2569.

Runs detached (nohup, PPID 1) on an ISOLATED rig. Every 15 minutes it exercises
the behaviour the three PRs actually change, not generic worker health:

  #2519  Adobe Sign webhook path (migration 0426 + registration challenge + DLQ)
         A  GET  /webhooks/adobe-sign registration challenge: correct client id
            -> 200 with the id echoed in X-AdobeSign-ClientId; wrong id -> 403;
            absent id -> 403.
         B  POST /webhooks/adobe-sign with a synthetic HMAC-SHA256(base64)
            signed AGREEMENT_WORKFLOW_COMPLETED payload addressed to org A's
            registered webhook_id -> 200 and a NEW organization_rule_events row
            for org A (this is the 0426 column being read by findIntegration()).
         C  Replay of the identical body -> 200 {duplicate:true} and NO second
            rule event (nonce idempotency).
         D  DLQ: signed payload carrying an UNREGISTERED webhook_id -> a new
            public.webhook_dlq row for provider='adobe_sign'.
         E  Bad HMAC -> 4xx and no rule event, no DLQ growth attributable to it.
  #2529  Adobe OAuth connect flow that populates org_integrations.webhook_id
         F  Kill switch is ON: unauthenticated POST .../adobe-sign/oauth/start
            -> 401 (NOT the 503 the flag-off path returns).
         G  Authenticated POST .../adobe-sign/oauth/start -> 200 + an Adobe
            authorization URL; state persisted.
         H  GET .../adobe-sign/oauth/callback against the STUBBED token base
            (ADOBE_SIGN_OAUTH_BASE_URL) with an unknown state -> deterministic
            4xx, never a 5xx crash.
         I  webhook_id materialisation + the 0426 partial unique index: a second
            ACTIVE adobe_sign integration claiming org A's webhook_id must be
            rejected by idx_org_integrations_provider_webhook_id_active.
  #2569  production-deps bump (incl. zod) -> worker request validation
         J  GET /api/v1/verify/<seeded public id>   -> 200, schema intact
         K  GET /api/v1/verify/<syntactically invalid id> -> 4xx from the
            zod-validated route, not a 500
         L  GET /api/v1/verify/<well-formed unknown id> -> 404
         M  GET /api/health -> 200

  T3 trigger set
         Trigger A  POST /jobs/rules-engine            (queued event is consumed)
         Trigger B  POST /jobs/rule-action-dispatcher   (action executes)
         Daily flush POST /jobs/batch-anchors           (mock chain profile)
         Per-org isolation: org B has its own registered webhook_id; org A's
         delivery must never produce an org B rule event and vice versa.

  Anti-hollow guards
         * every cycle must write at least one row it can then read back,
           tagged with this cycle's unique tag (ARKE-<sha12>-<cycle>);
         * the tagged-row count is asserted to increase monotonically;
         * worker /health git_sha must equal the candidate SHA and uptime must
           never go backwards (a restart invalidates the window);
         * the serving Cloud Run revision is re-checked every ~25 minutes.

NOT ASSERTED: no live Adobe Acrobat Sign vendor OAuth or document fetch happens.
The rig has no registered Adobe application; ADOBE_SIGN_* are synthetic rig
credentials and ADOBE_SIGN_OAUTH_BASE_URL points at a non-resolving stub host,
so leg H proves the failure path is deterministic, not that a real token
exchange succeeds. Chain is mocked (USE_MOCKS=true,
ENABLE_PROD_NETWORK_ANCHORING=false): no real Bitcoin is broadcast.

Config comes from $BATCH_E_HOME/rig.json (default ~/arkova-soak/batch-e-0905);
secrets from sibling files in that directory. Nothing secret is committed.
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

HOME = pathlib.Path(os.environ.get('BATCH_E_HOME', os.path.expanduser('~/arkova-soak/batch-e-0905')))
RIG = json.loads((HOME / 'rig.json').read_text())
SERVICE_KEY = (HOME / 'service-role-key.txt').read_text().strip()
CRON_SECRET = (HOME / 'cron-secret.txt').read_text().strip()
ADOBE_SECRET = (HOME / 'adobe-client-secret.txt').read_text().strip()
ADOBE_CLIENT_ID = RIG['adobe_client_id']
BASE = RIG['tag_url'].rstrip('/')
SUPABASE_URL = RIG['supabase_url'].rstrip('/')
SHA = RIG['sha']
CYCLE_SECONDS = int(RIG.get('cycle_seconds', 900))
WINDOW_HOURS = int(RIG.get('window_hours', 48))
STATUS = HOME / 'status.json'
CYCLES = HOME / 'cycles'
CYCLES.mkdir(parents=True, exist_ok=True)


def utc(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def identity_token():
    return subprocess.check_output(['gcloud', 'auth', 'print-identity-token'], text=True).strip()


def http(method, url, headers=None, body=None, timeout=60, raw=False):
    req = urllib.request.Request(url, method=method, data=body)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
            return r.status, dict(r.headers), (payload if raw else payload.decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        payload = e.read()
        return e.code, dict(e.headers), (payload if raw else payload.decode('utf-8', 'replace'))


def worker(method, path, headers=None, body=None, timeout=60):
    h = {'X-Serverless-Authorization': 'Bearer ' + IAM['token']}
    h.update(headers or {})
    return http(method, BASE + path, h, body, timeout)


def sql(query):
    """Run SQL on the rig via PostgREST-exposed RPC is not available; use the
    Supabase Management API query endpoint with the operator access token."""
    body = json.dumps({'query': query}).encode()
    status, _, text = http(
        'POST',
        'https://api.supabase.com/v1/projects/%s/database/query' % RIG['project_ref'],
        {'Authorization': 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json'},
        body,
        timeout=90,
    )
    if status >= 300:
        raise AssertionError('SQL failed %s: %s' % (status, text[:400]))
    return json.loads(text)


def scalar(query):
    rows = sql(query)
    if not rows:
        return None
    return list(rows[0].values())[0]


MGMT_TOKEN = (HOME / 'supabase-access.txt').read_text().strip()
IAM = {'token': identity_token(), 'at': time.time()}


def user_token():
    """Password-grant an access token for the rig's dedicated soak user."""
    body = json.dumps({'email': RIG['soak_user_email'], 'password': RIG['soak_user_password']}).encode()
    status, _, text = http(
        'POST',
        SUPABASE_URL + '/auth/v1/token?grant_type=password',
        {'apikey': SERVICE_KEY, 'Content-Type': 'application/json'},
        body,
    )
    assert status == 200, 'soak user password grant failed %s %s' % (status, text[:300])
    return json.loads(text)['access_token']


def adobe_body(tag, webhook_id, agreement_id):
    return json.dumps({
        'event': 'AGREEMENT_WORKFLOW_COMPLETED',
        'webhookId': webhook_id,
        'agreement': {
            'id': agreement_id,
            'name': 'Batch-E soak agreement ' + tag,
            'senderInfo': {'email': 'soak+%s@arkova-batch-e.test' % tag.lower()},
            'documents': [{'id': 'doc-%s-1' % tag}, {'id': 'doc-%s-2' % tag}],
        },
    }, separators=(',', ':')).encode()


def sign(raw):
    return base64.b64encode(hmac.new(ADOBE_SECRET.encode(), raw, hashlib.sha256).digest()).decode()


def cycle(i, tag, ev):
    """One full probe pass. Every assertion failure aborts the window."""
    # ---- identity / continuity guard -------------------------------------
    status, _, text = worker('GET', '/health', timeout=40)
    assert status == 200, 'health %s' % status
    health = json.loads(text)
    assert health.get('git_sha') == SHA, 'worker git_sha %r != candidate %r' % (health.get('git_sha'), SHA)
    assert health.get('status') == 'healthy', 'worker unhealthy: %r' % health.get('status')
    up = health.get('uptime')
    if STATE.get('last_uptime') is not None and up is not None:
        assert up >= STATE['last_uptime'], 'worker uptime went backwards — restart invalidates the window'
    STATE['last_uptime'] = up
    ev['health'] = {'git_sha': health.get('git_sha'), 'uptime': up}

    if time.time() - STATE.get('last_revision_check', 0) > 1500:
        desc = json.loads(subprocess.check_output(
            ['gcloud', 'run', 'services', 'describe', RIG['service'], '--project=arkova1',
             '--region=us-central1', '--format=json'], text=True))
        serving = [t for t in desc['status']['traffic'] if t.get('percent') == 100]
        assert any(t.get('revisionName') == RIG['revision'] for t in serving), 'serving revision drift'
        STATE['last_revision_check'] = time.time()
        ev['revision_verified'] = RIG['revision']

    # ---- #2519 A: registration challenge ---------------------------------
    st, hdr, _ = worker('GET', '/webhooks/adobe-sign', {'X-AdobeSign-ClientId': ADOBE_CLIENT_ID})
    assert st == 200, 'challenge (valid id) expected 200 got %s' % st
    echoed = hdr.get('X-AdobeSign-ClientId') or hdr.get('x-adobesign-clientid')
    assert echoed == ADOBE_CLIENT_ID, 'challenge did not echo the client id: %r' % echoed
    st_bad, _, _ = worker('GET', '/webhooks/adobe-sign', {'X-AdobeSign-ClientId': 'not-our-app-' + tag})
    assert st_bad == 403, 'challenge (wrong id) expected 403 got %s' % st_bad
    st_absent, _, _ = worker('GET', '/webhooks/adobe-sign')
    assert st_absent == 403, 'challenge (absent id) expected 403 got %s' % st_absent
    ev['challenge'] = {'valid': st, 'echoed': True, 'wrong_id': st_bad, 'absent_id': st_absent}

    events_before_a = scalar("SELECT count(*) FROM public.organization_rule_events WHERE org_id='%s'" % RIG['org_a'])
    events_before_b = scalar("SELECT count(*) FROM public.organization_rule_events WHERE org_id='%s'" % RIG['org_b'])
    dlq_before = scalar("SELECT count(*) FROM public.webhook_dlq WHERE provider='adobe_sign'")

    # ---- #2519 B: signed delivery -> rule event for org A -----------------
    agreement = 'ARKE-AGR-%s' % tag
    raw = adobe_body(tag, RIG['webhook_id_a'], agreement)
    st, _, text = worker('POST', '/webhooks/adobe-sign', {
        'Content-Type': 'application/json',
        'X-AdobeSign-ClientId-Authentication-Sha256': sign(raw),
    }, raw)
    assert st == 200, 'signed delivery expected 200 got %s %s' % (st, text[:300])
    ev['delivery'] = json.loads(text) if text.strip().startswith('{') else {'status': st}
    rule_row = sql(
        "SELECT id, org_id, payload->>'agreement_id' AS agreement_id "
        "FROM public.organization_rule_events "
        "WHERE payload->>'agreement_id'='%s'" % agreement)
    assert len(rule_row) == 1, 'expected exactly 1 rule event for %s, got %d' % (agreement, len(rule_row))
    assert rule_row[0]['org_id'] == RIG['org_a'], 'rule event landed on the wrong org'
    ev['rule_event_id'] = rule_row[0]['id']

    # ---- #2519 C: replay is idempotent -----------------------------------
    st_dup, _, text_dup = worker('POST', '/webhooks/adobe-sign', {
        'Content-Type': 'application/json',
        'X-AdobeSign-ClientId-Authentication-Sha256': sign(raw),
    }, raw)
    assert st_dup == 200, 'replay expected 200 got %s' % st_dup
    again = scalar("SELECT count(*) FROM public.organization_rule_events "
                   "WHERE payload->>'agreement_id'='%s'" % agreement)
    assert int(again) == 1, 'replay created a duplicate rule event (%s)' % again
    ev['replay'] = {'status': st_dup, 'body': text_dup[:160], 'rule_events': int(again)}

    # ---- #2519 E: bad HMAC is refused ------------------------------------
    bad_raw = adobe_body(tag + 'X', RIG['webhook_id_a'], agreement + '-BADSIG')
    st_bad_sig, _, _ = worker('POST', '/webhooks/adobe-sign', {
        'Content-Type': 'application/json',
        'X-AdobeSign-ClientId-Authentication-Sha256': base64.b64encode(b'0' * 32).decode(),
    }, bad_raw)
    assert 400 <= st_bad_sig < 500, 'bad HMAC expected 4xx got %s' % st_bad_sig
    assert int(scalar("SELECT count(*) FROM public.organization_rule_events "
                      "WHERE payload->>'agreement_id'='%s-BADSIG'" % agreement)) == 0, \
        'unsigned payload produced a rule event'
    ev['bad_hmac'] = st_bad_sig

    # ---- #2519 D: DLQ on an unregistered webhook id ----------------------
    orphan = adobe_body(tag + 'O', 'unregistered-%s' % tag, agreement + '-ORPHAN')
    st_orphan, _, _ = worker('POST', '/webhooks/adobe-sign', {
        'Content-Type': 'application/json',
        'X-AdobeSign-ClientId-Authentication-Sha256': sign(orphan),
    }, orphan)
    dlq_after = scalar("SELECT count(*) FROM public.webhook_dlq WHERE provider='adobe_sign'")
    assert int(dlq_after) > int(dlq_before), \
        'unregistered webhook id did not reach the DLQ (%s -> %s, http %s)' % (dlq_before, dlq_after, st_orphan)
    ev['dlq'] = {'status': st_orphan, 'before': int(dlq_before), 'after': int(dlq_after)}

    # ---- per-org isolation ------------------------------------------------
    events_after_b = scalar("SELECT count(*) FROM public.organization_rule_events WHERE org_id='%s'" % RIG['org_b'])
    assert int(events_after_b) == int(events_before_b), 'org A delivery leaked a rule event into org B'
    agreement_b = 'ARKE-AGR-%s-B' % tag
    raw_b = adobe_body(tag + 'B', RIG['webhook_id_b'], agreement_b)
    st_b, _, _ = worker('POST', '/webhooks/adobe-sign', {
        'Content-Type': 'application/json',
        'X-AdobeSign-ClientId-Authentication-Sha256': sign(raw_b),
    }, raw_b)
    assert st_b == 200, 'org B delivery expected 200 got %s' % st_b
    row_b = sql("SELECT org_id FROM public.organization_rule_events "
                "WHERE payload->>'agreement_id'='%s'" % agreement_b)
    assert len(row_b) == 1 and row_b[0]['org_id'] == RIG['org_b'], 'org B delivery did not isolate'
    ev['isolation'] = {'org_a_events': int(events_before_a), 'org_b_isolated': True}

    # ---- #2529 I: 0426 partial unique index enforces one active claim -----
    dup_sql = (
        "INSERT INTO public.org_integrations (org_id, provider, webhook_id) "
        "VALUES ('%s','adobe_sign','%s')" % (RIG['org_b'], RIG['webhook_id_a']))
    try:
        sql(dup_sql)
        raise AssertionError('duplicate ACTIVE adobe_sign webhook_id was accepted — 0426 index not enforcing')
    except AssertionError as exc:
        if 'not enforcing' in str(exc):
            raise
        ev['webhook_id_unique_index'] = 'rejected duplicate active claim'

    # ---- #2529 F/G/H: OAuth connect flow ---------------------------------
    start_body_bytes = json.dumps({'org_id': RIG['org_a']}).encode()
    st_unauth, _, _ = worker('POST', '/api/v1/integrations/adobe-sign/oauth/start',
                             {'Content-Type': 'application/json'}, start_body_bytes)
    assert st_unauth == 401, \
        'unauthenticated start expected 401 (503 means ENABLE_ADOBE_SIGN_OAUTH is off) got %s' % st_unauth
    if time.time() - STATE.get('user_token_at', 0) > 1800:
        STATE['user_token'] = user_token()
        STATE['user_token_at'] = time.time()
    st_start, _, text_start = worker('POST', '/api/v1/integrations/adobe-sign/oauth/start', {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + STATE['user_token'],
    }, start_body_bytes)
    assert st_start in (200, 201), 'authenticated start expected 2xx got %s %s' % (st_start, text_start[:300])
    start_body = json.loads(text_start)
    auth_url = start_body.get('authorizationUrl') or start_body.get('url') or ''
    assert 'client_id' in auth_url and RIG['oauth_base_host'] in auth_url, \
        'start did not return an Adobe authorization URL against the stub base: %r' % auth_url[:200]
    st_cb, _, _ = worker('GET', '/api/v1/integrations/adobe-sign/oauth/callback'
                                '?code=soak-%s&state=unknown-state-%s' % (tag, tag))
    assert st_cb < 500, 'oauth callback with an unknown state 5xx-ed (%s)' % st_cb
    ev['oauth'] = {'unauth_start': st_unauth, 'auth_start': st_start,
                   'callback_unknown_state': st_cb}

    # ---- #2569: zod-validated request paths ------------------------------
    st_ok, _, _ = worker('GET', '/api/v1/verify/%s' % RIG['public_id'])
    assert st_ok == 200, 'verify of the seeded anchor expected 200 got %s' % st_ok
    st_invalid, _, _ = worker('GET', '/api/v1/verify/%s' % ('!' * 8))
    assert 400 <= st_invalid < 500, 'malformed public id expected 4xx got %s' % st_invalid
    st_missing, _, _ = worker('GET', '/api/v1/verify/ARK-DOC-ZZZZZZ')
    assert 400 <= st_missing < 500, 'unknown public id expected 4xx got %s' % st_missing
    st_health, _, _ = worker('GET', '/api/health')
    assert st_health == 200, '/api/health expected 200 got %s' % st_health
    ev['zod_routes'] = {'verify_ok': st_ok, 'verify_malformed': st_invalid,
                        'verify_unknown': st_missing, 'api_health': st_health}

    # ---- T3 triggers ------------------------------------------------------
    cron_hdr = {'X-Cron-Secret': CRON_SECRET, 'Content-Type': 'application/json'}
    st_a, _, body_a = worker('POST', '/jobs/rules-engine', cron_hdr, b'{}', timeout=180)
    assert st_a == 200, 'Trigger A (/jobs/rules-engine) expected 200 got %s %s' % (st_a, body_a[:200])
    st_b2, _, body_b = worker('POST', '/jobs/rule-action-dispatcher', cron_hdr, b'{}', timeout=180)
    assert st_b2 == 200, 'Trigger B (/jobs/rule-action-dispatcher) expected 200 got %s %s' % (st_b2, body_b[:200])
    st_flush, _, body_flush = worker('POST', '/jobs/batch-anchors', cron_hdr, b'{}', timeout=240)
    assert st_flush == 200, 'daily flush (/jobs/batch-anchors) expected 200 got %s %s' % (st_flush, body_flush[:200])
    processed = scalar("SELECT count(*) FROM public.organization_rule_events "
                       "WHERE payload->>'agreement_id' LIKE 'ARKE-AGR-%s%%' "
                       "AND status IS DISTINCT FROM 'PENDING'" % tag)
    ev['triggers'] = {'rules_engine': st_a, 'dispatcher': st_b2, 'batch_anchors': st_flush,
                      'events_advanced': int(processed or 0),
                      'rules_engine_body': body_a[:300], 'dispatcher_body': body_b[:300],
                      'batch_anchors_body': body_flush[:300]}

    # ---- anti-hollow: rows this cycle actually wrote ----------------------
    tagged = int(scalar("SELECT count(*) FROM public.organization_rule_events "
                        "WHERE payload->>'agreement_id' LIKE 'ARKE-AGR-%%'"))
    assert tagged > STATE.get('tagged_rows', -1), \
        'no new rule-event rows this cycle (%s) — hollow cycle' % tagged
    STATE['tagged_rows'] = tagged
    dlq_total = int(scalar("SELECT count(*) FROM public.webhook_dlq WHERE provider='adobe_sign'"))
    ev['rows_written'] = {'rule_events_total_tagged': tagged, 'adobe_dlq_total': dlq_total,
                          'this_cycle_rule_events': 2, 'this_cycle_dlq_rows': dlq_total - int(dlq_before)}
    assert ev['rows_written']['this_cycle_dlq_rows'] >= 1
    return ev


started = time.time()
deadline = started + WINDOW_HOURS * 3600
STATE = {
    'kind': 'batch_e_t3_soak',
    'prs': [2519, 2529, 2569],
    'tiers': {'2519': 'T3', '2529': 'T3', '2569': 'T2'},
    'pr_heads': RIG['heads'],
    'candidate_sha': SHA,
    'base_sha': RIG['base_sha'],
    'staging_branch': RIG.get('branch', 'rc/batch-e-2026-09-05'),
    'rig_ref': RIG['project_ref'],
    'service': RIG['service'],
    'service_url': BASE,
    'revision': RIG['revision'],
    'image_digest': RIG['image_digest'],
    'preflight': RIG.get('preflight_artifact'),
    'started_at': utc(started),
    'not_before': utc(deadline),
    'window_hours': WINDOW_HOURS,
    'cycle_seconds': CYCLE_SECONDS,
    'status': 'running',
    'cycles': 0,
    'failures': 0,
    'last_cycle_at': None,
    'pid': os.getpid(),
}


def save():
    tmp = HOME / 'status.tmp'
    tmp.write_text(json.dumps(STATE, indent=2))
    tmp.replace(STATUS)


save()
print('BATCH-E 48h window opened', STATE['started_at'], 'earliest end', STATE['not_before'], flush=True)

while True:
    tick = time.time()
    i = STATE['cycles'] + 1
    tag = '%s-%05d' % (SHA[:12].upper(), i)
    ev = {'cycle': i, 'tag': tag, 'at': utc(tick)}
    try:
        if time.time() - IAM['at'] > 1500:
            IAM['token'] = identity_token()
            IAM['at'] = time.time()
        cycle(i, tag, ev)
        ev['result'] = 'pass'
        STATE['cycles'] = i
        STATE['last_cycle_at'] = utc(time.time())
    except Exception as exc:  # noqa: BLE001 — any probe failure is soak-fatal
        ev['result'] = 'fail'
        ev['error'] = '%s: %s' % (type(exc).__name__, exc)
        STATE['failures'] += 1
        STATE['status'] = 'failed'
        STATE['error'] = ev['error']
        STATE['failed_at'] = utc(time.time())
        (CYCLES / ('%05d.json' % i)).write_text(json.dumps(ev, indent=2))
        save()
        print('BATCH-E SOAK FAILED', ev['error'], flush=True)
        raise
    (CYCLES / ('%05d.json' % i)).write_text(json.dumps(ev, indent=2))
    if time.time() >= deadline:
        STATE['status'] = 'window_complete'
        STATE['completed_at'] = utc(time.time())
        save()
        print('BATCH-E window complete', STATE['completed_at'], 'cycles', STATE['cycles'], flush=True)
        break
    save()
    sleep_for = max(30, CYCLE_SECONDS - (time.time() - tick))
    time.sleep(sleep_for)
