#!/usr/bin/env python3
"""Owned UAT-03 hosted confirmation driver; stdlib only, dry-run by default.

No provisioning, hook installation, policy activation, or production writes.
See docs/uat03-email-confirmation.md. Credentials and mailbox proof stay in memory.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
import html
import hashlib
import imaplib
import json
import os
from pathlib import Path
import re
import secrets
import select
import sys
import termios
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

OWNED_NAME = 'arkova-soak-uat03-mailbox-0905'
PREVIEW_REF = 'fbwislntqahuzlpehpxk'
PREVIEW_ID = '4b169a53-3b26-4665-aef2-42d0fdfcb958'
PARENT_REF = 'vzwyaatejekddvltxyye'
DENIED_REFS = {PARENT_REF, 'ujtlwnoqfhtitcmsnrpq', 'ryasykzdduzymschbucr'}
CONFIRM = '/api/auth/email-confirmation'
PENDING = 'arkova_email_pending'


def validate_manifest(value):
    ref = value.get('projectRef', '')
    if not re.fullmatch('[a-z]{20}', ref) or ref in DENIED_REFS:
        raise ValueError('Owned project reference required')
    if value.get('kind') == 'preview':
        if ref != PREVIEW_REF or value.get('branchId') != PREVIEW_ID:
            raise ValueError('Only the independently identified PR2655 preview is permitted')
    elif value.get('kind') != 'standalone':
        raise ValueError('Owned target kind required')
    worker = urlparse(value.get('workerUrl', ''))
    if (worker.scheme != 'https' or worker.username or worker.password or worker.port
            or worker.path not in ('', '/') or worker.query or worker.fragment
            or not re.fullmatch(r'(?:pr-2655---)?arkova-worker-uat03-mailbox-0905-staging-[a-z0-9-]+\.run\.app', worker.hostname or '')):
        raise ValueError('Exact owned UAT03 worker URL required')
    app = urlparse(value.get('appUrl', ''))
    if (app.scheme != 'https' or not app.hostname or app.hostname in ('app.arkova.ai', 'arkova.ai')
            or app.username or app.password or app.port or app.query or app.fragment or app.path not in ('', '/')):
        raise ValueError('Isolated app origin required')
    if not re.fullmatch('[a-f0-9]{40}', value.get('head', '')):
        raise ValueError('Exact candidate head required')
    if not value.get('hookUri', '').startswith('pg-functions://postgres/'):
        raise ValueError('Reviewed existing/composed PostgreSQL hook URI required')
    return value


def mailbox_proof(raw, recipient, app_origin):
    message = BytesParser(policy=policy.default).parsebytes(raw)
    addresses = {address.lower() for _, address in getaddresses(message.get_all('To', []))}
    if recipient.lower() not in addresses:
        return None
    for part in message.walk():
        if part.get_content_type() not in ('text/plain', 'text/html'):
            continue
        content = html.unescape(part.get_content())
        for candidate in re.findall(r'https://[^\s<>"\']+', content):
            url = urlparse(candidate)
            if f'{url.scheme}://{url.netloc}' != app_origin.rstrip('/') or url.path != '/signup' or url.query:
                continue
            fragment = parse_qs(url.fragment)
            values = fragment.get('token', [])
            if fragment.get('type') == ['oauth_confirmation'] and len(values) == 1 and 20 <= len(values[0]) <= 1024:
                return values[0]
    return None


def validate_mailbox_reply(reply, expected, now_ms):
    received = reply.get('receivedAtMs')
    proof = reply.get('token')
    if (reply.get('recipient') != expected['recipient'] or reply.get('appOrigin') != expected['appOrigin']
            or not isinstance(received, int) or isinstance(received, bool)
            or not expected['issuedAfterMs'] <= received <= now_ms + 30000
            or not isinstance(reply.get('messageId'), str) or not 1 <= len(reply['messageId']) <= 200
            or not isinstance(proof, str) or not 20 <= len(proof) <= 1024):
        raise ValueError('Mailbox reply is not fresh or bound to this request')
    return proof


def read_mailbox_reply(expected):
    # PTY support without credential echo. Root's Gmail adapter supplies one JSON
    # line from tool memory; neither the raw message nor proof is written to disk.
    original = None
    if sys.stdin.isatty():
        original = termios.tcgetattr(sys.stdin.fileno())
        hidden = list(original)
        hidden[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, hidden)
    try:
        print(json.dumps({'mailboxRequest': expected}), flush=True)
        ready, _, _ = select.select([sys.stdin], [], [], 180)
        if not ready:
            raise ValueError('Mailbox reply timed out')
        reply = json.loads(sys.stdin.readline(8193))
        return validate_mailbox_reply(reply, expected, int(time.time() * 1000))
    finally:
        if original is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, original)


def evidence(head, checks, complete, fixture_ids=None, elapsed=0):
    # Only constant labels, status codes and booleans. Never persist response bodies.
    return {'driver': 'uat03-mailbox', 'head': head, 'checks': checks,
            'allPassed': bool(checks) and complete and all(c['passed'] for c in checks),
            'elapsedSeconds': round(elapsed), 'fixtureIds': fixture_ids or [],
            'hostedReleaseComplete': False,
            'remainingReleaseGates': ['Google consent roundtrip', 'hosted browser account switching',
                'Storage/Realtime/MCP HTTP-WebSocket controls', 'activation rollback proof',
                'full CI and independent release approval']}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(method, url, headers=None, body=None):
    req = Request(url, method=method, headers={'Content-Type': 'application/json', 'User-Agent': 'Arkova-release-review/1.0', **(headers or {})},
                  data=None if body is None else json.dumps(body).encode())
    try:
        with build_opener(NoRedirect()).open(req, timeout=30) as response:
            data = response.read()
            return response.status, json.loads(data) if data else None
    except HTTPError as error:
        try:
            return error.code, json.loads(error.read())
        except (ValueError, UnicodeError):
            return error.code, None
    except (URLError, TimeoutError, ValueError):
        return 0, None


def role(session):
    encoded = session['access_token'].split('.')[1]
    return json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))['role']


class Runner:
    def __init__(self, manifest, duration, mailbox_mode):
        self.m = manifest
        self.duration = duration
        self.mailbox_mode = mailbox_mode
        self.started = time.monotonic()
        self.checks = []
        self.ids = []
        self.run_id = uuid.uuid4().hex[:12]
        self.sb = 'https://' + manifest['projectRef'] + '.supabase.co'
        self.admin = self.required('STAGING_SUPABASE_SERVICE_ROLE_KEY')
        self.anon = self.required('STAGING_SUPABASE_ANON_KEY')
        self.management = self.required('SUPABASE_ACCESS_TOKEN')
        self.base_mail = self.required('UAT03_TEST_MAILBOX')
        if not re.fullmatch(r'[A-Za-z0-9._-]+@[A-Za-z0-9.-]+', self.base_mail):
            raise ValueError('A test mailbox supporting plus aliases is required')
        self.imap = None
        self.iam = ''
        self.iam_at = 0

    @staticmethod
    def required(name):
        value = os.environ.get(name)
        if not value:
            raise ValueError('Missing required credential/configuration: ' + name)
        return value

    def check(self, label, passed, status=None):
        self.checks.append({'label': label, 'passed': bool(passed), **({'status': status} if status is not None else {})})
        print(json.dumps(self.checks[-1]), flush=True)
        if not passed:
            raise AssertionError(label)

    def auth(self, method, path, body=None, bearer=None, admin=False):
        key = self.admin if admin else self.anon
        return request(method, self.sb + '/auth/v1' + path,
                       {'apikey': key, 'Authorization': 'Bearer ' + (bearer or key)}, body)

    def worker(self, method, path, body=None, bearer=None):
        if time.monotonic() - self.iam_at >= 1200 or not self.iam:
            supplied = os.environ.get('STAGING_GCP_IDENTITY')
            if supplied and self.duration > 20:
                raise ValueError('Long runs require refreshable gcloud identity, not a static IAM credential')
            self.iam = supplied or subprocess.check_output(['gcloud', 'auth', 'print-identity-token'], text=True, stderr=subprocess.DEVNULL).strip()
            self.iam_at = time.monotonic()
        headers = {'X-Serverless-Authorization': 'Bearer ' + self.iam}
        if bearer:
            headers['Authorization'] = 'Bearer ' + bearer
        return request(method, self.m['workerUrl'].rstrip('/') + path, headers, body)

    def preflight(self):
        current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        self.check('exact driver source head', current == self.m['head'])
        root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
        relative = str(Path(__file__).resolve().relative_to(root))
        committed = subprocess.check_output(['git', 'show', current + ':' + relative], stderr=subprocess.DEVNULL)
        self.check('driver bytes match committed head', hashlib.sha256(committed).digest() == hashlib.sha256(Path(__file__).read_bytes()).digest())
        headers = {'Authorization': 'Bearer ' + self.management}
        if self.m['kind'] == 'standalone':
            status, project = request('GET', 'https://api.supabase.com/v1/projects/' + self.m['projectRef'], headers)
            self.check('owned standalone project identity', status == 200 and project.get('name') == OWNED_NAME, status)
        else:
            status, branches = request('GET', 'https://api.supabase.com/v1/projects/' + PARENT_REF + '/branches', headers)
            branch = next((b for b in branches if b.get('id') == PREVIEW_ID), {}) if isinstance(branches, list) else {}
            self.check('owned preview migration readiness', status == 200 and branch.get('project_ref') == PREVIEW_REF
                       and branch.get('name') == 'cto/uat03-oauth-confirmation-20260905'
                       and branch.get('status') == 'FUNCTIONS_DEPLOYED', status)
        status, config = request('GET', 'https://api.supabase.com/v1/projects/' + self.m['projectRef'] + '/config/auth', headers)
        self.check('readable reviewed hook configuration', status == 200
                   and config.get('hook_custom_access_token_enabled') is True
                   and config.get('hook_custom_access_token_uri') == self.m['hookUri'], status)
        status, health = self.worker('GET', '/health')
        self.check('exact healthy worker head', status == 200 and health.get('git_sha') == current and health.get('status') == 'healthy', status)
        if self.mailbox_mode == 'imap':
            self.imap = imaplib.IMAP4_SSL(self.required('UAT03_IMAP_HOST'), timeout=30)
            self.imap.login(self.required('UAT03_IMAP_USER'), self.required('UAT03_IMAP_PASSWORD'))
            self.imap.select('INBOX', readonly=True)
            self.check('real test mailbox accessible', True)

    def recipient(self, label):
        local, domain = self.base_mail.split('@')
        return f'{local}+uat03-{self.run_id}-{label}@{domain}'

    def create(self, label, pending=True):
        email = self.recipient(label)
        password = secrets.token_urlsafe(32)
        provider = 'google' if pending else 'email'
        status, user = self.auth('POST', '/admin/users', {'email': email, 'password': password, 'email_confirm': True,
            'app_metadata': {'provider': provider, 'providers': [provider], 'uat03_run': self.run_id}}, admin=True)
        uid = str(uuid.UUID(user['id'])) if status == 200 and isinstance(user, dict) and user.get('id') else None
        if uid:
            self.ids.append(uid)
        self.check(label + ' fixture created', status == 200 and bool(uid), status)
        status, session = self.auth('POST', '/token?grant_type=password', {'email': email, 'password': password})
        self.check(label + ' expected account state', status == 200 and role(session) == (PENDING if pending else 'authenticated'), status)
        status, actual = self.auth('GET', '/user', bearer=session['access_token'])
        self.check(label + ' real Auth identity', status == 200 and actual.get('id') == uid, status)
        return {'id': uid, 'email': email, 'session': session}

    def refresh(self, fixture, pending):
        status, session = self.auth('POST', '/token?grant_type=refresh_token', {'refresh_token': fixture['session']['refresh_token']})
        self.check('refresh preserves current account state', status == 200 and role(session) == (PENDING if pending else 'authenticated'), status)
        fixture['session'] = session

    def product(self, fixture, pending):
        bearer = fixture['session']['access_token']
        status, rows = request('GET', self.sb + '/rest/v1/profiles?select=id&id=eq.' + fixture['id'],
            {'apikey': self.anon, 'Authorization': 'Bearer ' + bearer})
        self.check('pending Data API denial' if pending else 'normal Data API own-profile control',
            status == 403 if pending else status == 200 and rows == [{'id': fixture['id']}], status)
        # Invalid empty key body cannot mint a key. Ordinary JWT must reach validation;
        # pending JWT must stop at authentication, before validation/key generation.
        status, body = self.worker('POST', '/api/v1/keys', {}, bearer)
        self.check('pending key mint denied' if pending else 'normal worker authentication control',
            status == 401 if pending else status == 400 and body.get('error') == 'validation_error', status)

    def receive(self, recipient, issued_after):
        if self.mailbox_mode == 'stdin':
            proof = read_mailbox_reply({'recipient': recipient, 'appOrigin': self.m['appUrl'].rstrip('/'),
                                       'issuedAfterMs': issued_after})
            self.check('operator mailbox receipt metadata bound to request', True)
            return proof
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            kind, found = self.imap.uid('search', None, 'HEADER', 'To', '"' + recipient + '"')
            if kind == 'OK':
                for uid in reversed(found[0].split()[-20:]):
                    kind, parts = self.imap.uid('fetch', uid, '(INTERNALDATE BODY.PEEK[])')
                    if kind == 'OK':
                        for item in parts:
                            if isinstance(item, tuple):
                                received = imaplib.Internaldate2tuple(item[0])
                                if received is None or time.mktime(received) < issued_after // 1000:
                                    continue
                                proof = mailbox_proof(item[1], recipient, self.m['appUrl'])
                                if proof:
                                    self.check('actual mailbox receipt and app link binding', True)
                                    return proof
            time.sleep(5)
        self.check('actual mailbox receipt and app link binding', False)

    def send(self, fixture):
        issued_after = int(time.time() * 1000)
        status, body = self.worker('POST', CONFIRM + '/send', {}, fixture['session']['access_token'])
        self.check('real confirmation delivery accepted', status == 200 and body.get('sent') is True
                   and set(body) <= {'required', 'sent', 'retryAfterSeconds'}, status)
        return self.receive(fixture['email'], issued_after)

    def complete(self, proof):
        return self.worker('POST', CONFIRM + '/complete', {'token': proof})

    @staticmethod
    def wait(seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            time.sleep(min(5, until - time.monotonic()))

    def run(self):
        self.preflight()
        ordinary = self.create('ordinary', False)
        pending = self.create('pending')
        self.product(ordinary, False)
        self.product(pending, True)
        self.refresh(pending, True)
        first = self.send(pending)
        status, body = self.worker('POST', CONFIRM + '/send', {}, pending['session']['access_token'])
        self.check('server resend cooldown', status == 429 and body.get('code') == 'confirmation_cooldown'
                   and 0 < body.get('retryAfterSeconds', 0) <= 90, status)
        self.wait(91)
        second = self.send(pending)
        status, _ = self.complete(first)
        self.check('superseded proof denied', status == 400, status)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.complete(second), range(4)))
        successes = [body for status, body in results if status == 200 and body.get('complete') is True]
        self.check('concurrent completion exactly once', len(successes) == 1
                   and sum(status == 400 for status, _ in results) == 3)
        self.check('completion returns ordinary account session', role(successes[0]['session']) == 'authenticated')
        status, _ = self.complete(second)
        self.check('completed proof replay denied', status == 400, status)
        self.product(pending, True)  # Already-issued pending JWT remains denied until refresh.
        self.refresh(pending, False)
        self.product(pending, False)
        changed = self.create('changed')
        stale = self.send(changed)
        status, _ = self.auth('PUT', '/admin/users/' + changed['id'],
            {'email': self.recipient('changed-new'), 'email_confirm': True}, admin=True)
        self.check('owned fixture email changed', status == 200, status)
        status, _ = self.complete(stale)
        self.check('proof for prior email denied', status == 400, status)
        expired = self.create('expiry')
        old = self.send(expired)
        self.wait(905)  # Exercise real elapsed expiry; never edit stored timestamps.
        status, _ = self.complete(old)
        self.check('real fifteen-minute expiry', status == 400, status)
        self.refresh(expired, True)
        self.product(expired, True)
        # Continue checking the changed authorization path for an admitted soak duration.
        until = self.started + self.duration * 60
        while time.monotonic() < until:
            self.wait(min(60, until - time.monotonic()))
            self.refresh(expired, True)
            self.refresh(ordinary, False)
            self.product(expired, True)
            self.product(ordinary, False)

    def cleanup(self):
        complete = True
        for uid in self.ids:
            status, _ = self.auth('DELETE', '/admin/users/' + uid, admin=True)
            passed = status in (200, 204)
            self.checks.append({'label': 'owned fixture cleanup', 'passed': passed, 'status': status})
            complete = complete and passed
        if self.imap:
            try:
                self.imap.logout()
            except Exception:
                pass
        return complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--mailbox-mode', choices=('stdin', 'imap'), default='stdin')
    parser.add_argument('--duration-minutes', type=int, default=0)
    parser.add_argument('--evidence-out')
    args = parser.parse_args()
    manifest = validate_manifest(json.loads(Path(args.manifest).read_text()))
    if not 0 <= args.duration_minutes <= 3000:
        raise ValueError('Duration must be 0..3000 minutes')
    if not args.execute:
        print(json.dumps({'mode': 'dry-run', 'hostedRequests': 0, 'fixtureWrites': 0,
                          'head': manifest['head'], 'durationMinutes': args.duration_minutes,
                          'minimumSequenceMinutes': 17, 'releaseComplete': False}))
        return 0
    if not args.evidence_out:
        raise ValueError('Evidence output path required for execution')
    runner = Runner(manifest, args.duration_minutes, args.mailbox_mode)
    completed = False
    try:
        runner.run()
        completed = True
    except (Exception, KeyboardInterrupt):
        # Transport/provider/IMAP exceptions can contain credentials or message bodies.
        runner.checks.append({'label': 'execution interrupted or failed', 'passed': False})
        print('Hosted validation failed; inspect credential-free check labels.', flush=True)
    finally:
        clean = runner.cleanup()
        result = evidence(manifest['head'], runner.checks, completed and clean,
                          runner.ids, time.monotonic() - runner.started)
        path = Path(args.evidence_out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['allPassed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('Driver configuration failed; verify the owned manifest and required environment.')
        raise SystemExit(1)
