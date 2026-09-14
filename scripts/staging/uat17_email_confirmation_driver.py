#!/usr/bin/env python3
"""SCRUM-5145 isolated hosted email-confirmation probe; dry-run by default.

The live mode creates only uniquely labelled Resend test users on an approved
isolated project, reads only the matching sent message body, and deletes its
own Auth users. Tokens, links, addresses, and message content stay in memory.
"""
import argparse
from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

PROD_REF = 'vzwyaatejekddvltxyye'
SHARED_REFS = {'ujtlwnoqfhtitcmsnrpq', 'gnkuaywlpmsaezwvlvhk', PROD_REF}
OWNED_PROJECT_NAME = 'arkova-soak-uat17-0914'
AUTH_LINK_EXPIRY_SECONDS = 900
AUTH_LINK_EXPIRY_GRACE_SECONDS = 5
ARTIFACT_ROOT = Path(__file__).resolve().parents[2] / 'artifacts' / 'uat17-email'
MANAGEMENT = 'https://api.supabase.com/v1/projects/'
RESEND = 'https://api.resend.com'
TRIGGER_CATALOG_QUERY = Path(__file__).with_name('uat17_trigger_catalog.sql').read_text(encoding='utf-8').strip()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def artifact_path(value):
    root = ARTIFACT_ROOT
    if root.resolve() != root:
        raise ValueError('Artifact directory must not traverse a symlink')
    path = (root / value).resolve()
    if not path.is_relative_to(root) or path == root or path.suffix != '.json':
        raise ValueError('JSON path within artifacts/uat17-email required')
    return path


def validate_manifest(value):
    ref = value.get('projectRef', '')
    name = value.get('projectName', '')
    if not re.fullmatch(r'[a-z]{20}', ref) or ref in SHARED_REFS:
        raise ValueError('Owned isolated project reference required')
    if name != OWNED_PROJECT_NAME:
        raise ValueError(f'Exact owned project name {OWNED_PROJECT_NAME} required')
    if not re.fullmatch(r'[a-f0-9]{40}', value.get('head', '')):
        raise ValueError('Exact candidate head required')
    supabase = urlparse(value.get('supabaseUrl', ''))
    if (supabase.scheme != 'https' or supabase.hostname != f'{ref}.supabase.co'
            or supabase.path not in ('', '/') or supabase.query or supabase.fragment):
        raise ValueError('Supabase URL must match the isolated project reference')
    app = urlparse(value.get('appUrl', ''))
    if (app.scheme != 'https' or not app.hostname or app.hostname in ('app.arkova.ai', 'arkova.ai')
            or app.username or app.password or app.port or app.path not in ('', '/')
            or app.query or app.fragment):
        raise ValueError('Isolated app origin required')
    return value


def validate_auth_config(value):
    expected = {
        'mailer_otp_exp': 900,
        'smtp_max_frequency': 90,
        'rate_limit_email_sent': 30,
        'smtp_host': 'smtp.resend.com',
        'smtp_admin_email': 'noreply@arkova.ai',
        'smtp_sender_name': 'Arkova',
        'mailer_subjects_confirmation': 'Confirm your Arkova account',
    }
    failed = [key for key, expected_value in expected.items() if value.get(key) != expected_value]
    template = value.get('mailer_templates_confirmation_content', '')
    if 'Arkova' not in template or re.search('supabase', template, re.I):
        failed.append('mailer_templates_confirmation_content')
    if failed:
        raise ValueError(f'Auth configuration mismatch: {",".join(sorted(failed))}')
    return True


def sent_rows(payload):
    rows = payload.get('data', []) if isinstance(payload, dict) else []
    if isinstance(rows, dict):
        rows = rows.get('data', [])
    return rows if isinstance(rows, list) else []


def parse_utc_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def select_fixture_message(payload, recipient, issued_after, excluded_ids=frozenset()):
    threshold = parse_utc_timestamp(issued_after)
    if threshold is None:
        raise ValueError('issued_after must be an ISO-8601 timestamp')
    matches = []
    for row in sent_rows(payload):
        recipients = row.get('to', [])
        created = parse_utc_timestamp(row.get('created_at'))
        if (row.get('id') not in excluded_ids and recipient in recipients
                and created is not None and created >= threshold):
            matches.append(row)
    if len(matches) > 1:
        matches.sort(key=lambda row: parse_utc_timestamp(row.get('created_at')), reverse=True)
    return matches[0] if matches else None


def extract_confirmation_url(message, supabase_origin, callback):
    if not isinstance(message, dict):
        raise ValueError('Confirmation message body was unavailable')
    if message.get('subject') != 'Confirm your Arkova account':
        raise ValueError('Unexpected confirmation subject')
    sender = message.get('from', '')
    content = html.unescape((message.get('html') or '') + '\n' + (message.get('text') or ''))
    visible_content = re.sub(r'<[^>]+>', ' ', message.get('html') or '')
    visible_content += re.sub(r'https://\S+', ' ', message.get('text') or '')
    if 'Arkova' not in sender or re.search('supabase', sender + visible_content, re.I):
        raise ValueError('Confirmation message is not Arkova-branded')
    candidates = re.findall(r'https://[^\s<>"\']+', content)
    for candidate in candidates:
        parsed = urlparse(candidate)
        query = parse_qs(parsed.query)
        if (f'{parsed.scheme}://{parsed.netloc}' == supabase_origin
                and parsed.path == '/auth/v1/verify'
                and query.get('type') == ['signup']
                and query.get('redirect_to') == [callback]):
            return candidate
    raise ValueError('Bound signup confirmation URL not found')


def request(method, url, headers=None, body=None, no_redirect=False):
    data = None if body is None else json.dumps(body).encode()
    req = Request(url, method=method, data=data, headers={
        'Content-Type': 'application/json',
        'User-Agent': 'Arkova-UAT17/1.0',
        **(headers or {}),
    })
    opener = build_opener(NoRedirect()) if no_redirect else build_opener()
    try:
        with opener.open(req, timeout=30) as response:
            raw = response.read()
            try:
                parsed = json.loads(raw) if raw else None
            except ValueError:
                parsed = None
            return response.status, parsed, dict(response.headers)
    except HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        return error.code, parsed, dict(error.headers)
    except (URLError, TimeoutError, ValueError):
        return 0, None, {}


def poll_message(resend_key, recipient, issued_after, excluded_ids=frozenset(), timeout=60):
    deadline = time.monotonic() + timeout
    headers = {'Authorization': f'Bearer {resend_key}'}
    while time.monotonic() < deadline:
        status, payload, _ = request('GET', f'{RESEND}/emails?limit=100', headers)
        if status == 200:
            match = select_fixture_message(payload, recipient, issued_after, excluded_ids)
            if match:
                status, message, _ = request('GET', f'{RESEND}/emails/{quote(match["id"])}', headers)
                if status == 200:
                    return match['id'], message
        time.sleep(2)
    raise RuntimeError('Timed out waiting for the unique fixture message')


def evidence(head, checks, complete, elapsed):
    completed = {check['name'] for check in checks if check['passed']}
    remaining = ['independent release approval']
    if 'hosted_browser_mfa_and_consumed_link' not in completed:
        remaining.insert(0, '1280px and 375px hosted callback and MFA UAT')
    if 'expired_after_15_minutes' not in completed:
        remaining.insert(0, '15-minute expiry boundary')
    return {
        'driver': 'uat17-email-confirmation',
        'head': head,
        'checks': checks,
        'allPassed': bool(checks) and complete and all(check['passed'] for check in checks),
        'elapsedSeconds': round(elapsed),
        'containsSecretsOrMessageContent': False,
        'remainingReleaseGates': remaining,
    }


def read_trigger_catalog(project_ref, management_headers, database_url=''):
    query = TRIGGER_CATALOG_QUERY
    status, catalog, _ = request(
        'POST', f'{MANAGEMENT}{project_ref}/database/query', management_headers, {'query': query})
    if status in (200, 201):
        return catalog
    if not database_url:
        raise RuntimeError('Auth trigger catalog read failed and no read-only database fallback was supplied')

    parsed = urlparse(database_url)
    if (parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname
            or not parsed.username or not parsed.password or not parsed.path.strip('/')
            or (project_ref not in parsed.hostname and project_ref not in parsed.username)):
        raise RuntimeError('Database fallback does not identify the owned project')
    command_env = {
        **os.environ,
        'PGHOST': parsed.hostname,
        'PGPORT': str(parsed.port or 5432),
        'PGDATABASE': parsed.path.strip('/'),
        'PGUSER': unquote(parsed.username),
        'PGPASSWORD': unquote(parsed.password),
        'PGSSLMODE': parse_qs(parsed.query).get('sslmode', ['require'])[0],
    }
    result = subprocess.run(
        ['psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--command', query],
        env=command_env, capture_output=True, text=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('Read-only database fallback could not read the auth trigger catalog')
    return {'result': result.stdout.strip()}


def trigger_catalog_is_canonical(catalog):
    if isinstance(catalog, dict):
        if catalog.get('canonical_auth_user_triggers') is True:
            return True
        return any(trigger_catalog_is_canonical(value) for value in catalog.values())
    if isinstance(catalog, list):
        return any(trigger_catalog_is_canonical(value) for value in catalog)
    return isinstance(catalog, str) and catalog.strip().lower() in ('t', 'true')


def membership_rows(supabase_origin, user_id, admin_headers):
    status, rows, _ = request(
        'GET',
        f'{supabase_origin}/rest/v1/org_members?user_id=eq.{quote(user_id)}&select=org_id',
        admin_headers,
    )
    if status != 200 or not isinstance(rows, list):
        raise RuntimeError('Verified-domain membership read failed')
    return rows


def run_hosted_browser(app_origin, project_ref, confirmed_callback, consumed_callback, recipient):
    helper = Path(__file__).resolve().parents[2] / 'e2e' / 'uat17-hosted-callback.mjs'
    allowed_environment = {
        key: os.environ[key]
        for key in ('PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'CI')
        if key in os.environ
    }
    browser_env = {
        **allowed_environment,
        'UAT17_BROWSER_APP_URL': f'{app_origin}/',
        'UAT17_BROWSER_PROJECT_REF': project_ref,
        'UAT17_BROWSER_CONFIRMED_CALLBACK': confirmed_callback,
        'UAT17_BROWSER_CONSUMED_CALLBACK': consumed_callback,
        'UAT17_BROWSER_PENDING_EMAIL': recipient,
    }
    result = subprocess.run(
        ['node', str(helper)], cwd=helper.parents[1], env=browser_env,
        capture_output=True, text=True, timeout=180, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('Hosted callback browser proof failed')
    try:
        outcome = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('Hosted callback browser proof returned invalid evidence') from None
    if outcome.get('hostedBrowserPassed') is not True:
        raise RuntimeError('Hosted callback browser proof did not pass')
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--evidence-out', default='latest.json')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--browser', action='store_true')
    args = parser.parse_args()
    manifest = validate_manifest(json.loads(Path(args.manifest).read_text()))
    out = artifact_path(args.evidence_out)
    if out.exists():
        raise SystemExit('Refusing to overwrite UAT-17 evidence')
    if not args.apply:
        print(json.dumps({'dryRun': True, 'projectRef': manifest['projectRef'], 'projectName': manifest['projectName']}))
        return

    required = ('SUPABASE_ACCESS_TOKEN', 'UAT17_ANON_KEY', 'UAT17_SERVICE_ROLE_KEY', 'RESEND_API_KEY')
    env = {name: os.environ.get(name, '') for name in required}
    if any(not env[name] for name in required):
        raise SystemExit('Required in-memory credentials are missing')

    started = time.monotonic()
    issued_after = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    label = secrets.token_hex(10)
    recipient = f'delivered+uat17-{label}@resend.dev'
    password = secrets.token_urlsafe(24)
    supabase_origin = manifest['supabaseUrl'].rstrip('/')
    app_origin = manifest['appUrl'].rstrip('/')
    callback = f'{app_origin}/auth/callback'
    auth_headers = {'apikey': env['UAT17_ANON_KEY'], 'Authorization': f'Bearer {env["UAT17_ANON_KEY"]}'}
    admin_headers = {'apikey': env['UAT17_SERVICE_ROLE_KEY'], 'Authorization': f'Bearer {env["UAT17_SERVICE_ROLE_KEY"]}'}
    management_headers = {'Authorization': f'Bearer {env["SUPABASE_ACCESS_TOKEN"]}'}
    checks = []
    created_user_ids = []
    complete = False
    try:
        status, project, _ = request('GET', f'{MANAGEMENT}{manifest["projectRef"]}', management_headers)
        if status != 200 or not isinstance(project, dict) or project.get('name') != manifest['projectName']:
            raise RuntimeError('Management API did not confirm the owned project identity')
        checks.append({'name': 'owned_project', 'passed': True})

        status, config, _ = request('GET', f'{MANAGEMENT}{manifest["projectRef"]}/config/auth', management_headers)
        if status != 200 or not isinstance(config, dict):
            raise RuntimeError('Auth configuration read failed')
        validate_auth_config(config)
        checks.append({'name': 'auth_config_900_90_hourly_30', 'passed': True})

        catalog = read_trigger_catalog(
            manifest['projectRef'], management_headers, os.environ.get('UAT17_DATABASE_URL', ''))
        if not trigger_catalog_is_canonical(catalog):
            raise RuntimeError('Canonical auth.users triggers are not deployed')
        checks.append({'name': 'deployed_auth_triggers', 'passed': True})

        status, organizations, _ = request(
            'GET',
            f'{supabase_origin}/rest/v1/organizations?domain=eq.resend.dev&domain_verified=eq.true&select=id',
            admin_headers,
        )
        if status != 200 or not isinstance(organizations, list) or len(organizations) != 1:
            raise RuntimeError('Owned project needs exactly one verified resend.dev fixture organization')
        fixture_org_id = organizations[0].get('id')
        if not fixture_org_id:
            raise RuntimeError('Verified resend.dev fixture organization has no ID')
        checks.append({'name': 'verified_domain_fixture', 'passed': True})

        signup_url = f'{supabase_origin}/auth/v1/signup?{urlencode({"redirect_to": callback})}'
        expiry_label = secrets.token_hex(10)
        expiry_recipient = f'delivered+uat17-expiry-{expiry_label}@resend.dev'
        expiry_started = time.monotonic()
        status, expiry_signup, _ = request(
            'POST', signup_url, auth_headers, {'email': expiry_recipient, 'password': password})
        if status != 200 or not isinstance(expiry_signup, dict):
            raise RuntimeError('Expiry fixture signup failed')
        expiry_user = expiry_signup.get('user') or expiry_signup
        if (not isinstance(expiry_user, dict) or expiry_signup.get('access_token')
                or expiry_user.get('confirmation_sent_at') is None or not expiry_user.get('id')):
            raise RuntimeError('Expiry fixture did not enter confirmation-pending state')
        expiry_user_id = expiry_user['id']
        created_user_ids.append(expiry_user_id)
        _, expiry_message = poll_message(env['RESEND_API_KEY'], expiry_recipient, issued_after)
        expiry_link = extract_confirmation_url(expiry_message, supabase_origin, callback)
        if membership_rows(supabase_origin, expiry_user_id, admin_headers):
            raise RuntimeError('Unconfirmed expiry fixture was associated to an organization')
        checks.append({'name': 'unconfirmed_user_has_no_membership', 'passed': True})

        status, signup, _ = request('POST', signup_url, auth_headers, {'email': recipient, 'password': password})
        if status != 200 or not isinstance(signup, dict):
            raise RuntimeError('Signup request failed')
        signup_user = signup.get('user') or signup
        if (not isinstance(signup_user, dict) or signup.get('access_token')
                or signup_user.get('confirmation_sent_at') is None):
            raise RuntimeError('Signup did not enter confirmation-pending state')
        user_id = signup_user.get('id')
        if not user_id:
            raise RuntimeError('Signup response omitted the fixture user ID')
        created_user_ids.append(user_id)
        if membership_rows(supabase_origin, user_id, admin_headers):
            raise RuntimeError('Unconfirmed primary fixture was associated to an organization')
        checks.append({'name': 'signup_confirmation_pending', 'passed': True})

        first_id, first_message = poll_message(env['RESEND_API_KEY'], recipient, issued_after)
        first_link = extract_confirmation_url(first_message, supabase_origin, callback)
        checks.append({'name': 'first_branded_message', 'passed': True})

        resend_url = f'{supabase_origin}/auth/v1/resend?{urlencode({"redirect_to": callback})}'
        status, _, _ = request('POST', resend_url, auth_headers, {'type': 'signup', 'email': recipient})
        if status != 429:
            raise RuntimeError('Auth accepted resend before the 90-second boundary')
        checks.append({'name': 'early_resend_refused', 'passed': True})

        time.sleep(91)
        status, _, _ = request('POST', resend_url, auth_headers, {'type': 'signup', 'email': recipient})
        if status != 200:
            raise RuntimeError('Auth rejected resend after the 90-second boundary')
        second_id, second_message = poll_message(env['RESEND_API_KEY'], recipient, issued_after, {first_id})
        second_link = extract_confirmation_url(second_message, supabase_origin, callback)
        if second_id == first_id or second_link == first_link:
            raise RuntimeError('Resend did not produce a fresh confirmation message')
        checks.append({'name': 'resend_after_90_seconds', 'passed': True})

        status, _, headers = request('GET', second_link, no_redirect=True)
        location = headers.get('Location', '')
        parsed_location = urlparse(location)
        if status not in (302, 303) or f'{parsed_location.scheme}://{parsed_location.netloc}{parsed_location.path}' != callback:
            raise RuntimeError('Confirmation did not redirect to the bound app callback')
        fragment = parse_qs(parsed_location.fragment)
        access_token = fragment.get('access_token', [None])[0]
        if not access_token:
            raise RuntimeError('Confirmation callback did not establish a session')
        status, user, _ = request('GET', f'{supabase_origin}/auth/v1/user', {
            'apikey': env['UAT17_ANON_KEY'], 'Authorization': f'Bearer {access_token}'})
        if status != 200 or user.get('id') != user_id or not user.get('email_confirmed_at'):
            raise RuntimeError('Authoritative confirmed user did not match the fixture')
        checks.append({'name': 'callback_expected_session', 'passed': True})

        memberships = membership_rows(supabase_origin, user_id, admin_headers)
        if len(memberships) != 1 or memberships[0].get('org_id') != fixture_org_id:
            raise RuntimeError('Verified-domain membership was not created exactly once')
        checks.append({'name': 'verified_domain_membership_once', 'passed': True})

        status, _, _ = request('GET', f'{supabase_origin}/rest/v1/profiles?id=eq.{quote(user_id)}&select=id', {
            'apikey': env['UAT17_ANON_KEY'], 'Authorization': f'Bearer {access_token}'})
        if status not in (401, 403):
            raise RuntimeError('Confirmed AAL1 session bypassed the mandatory MFA data gate')
        checks.append({'name': 'mfa_gate_closed', 'passed': True})

        status, _, headers = request('GET', second_link, no_redirect=True)
        consumed_location = headers.get('Location', '')
        consumed = parse_qs(urlparse(consumed_location).fragment)
        if status not in (302, 303) or consumed.get('error_code') != ['otp_expired']:
            raise RuntimeError('Consumed confirmation link did not fail closed')
        status, same_user, _ = request('GET', f'{supabase_origin}/auth/v1/user', {
            'apikey': env['UAT17_ANON_KEY'], 'Authorization': f'Bearer {access_token}'})
        if status != 200 or same_user.get('id') != user_id:
            raise RuntimeError('Consumed-link check invalidated the established session')
        checks.append({'name': 'consumed_link_session_remains_valid', 'passed': True})

        if args.browser:
            run_hosted_browser(
                app_origin, manifest['projectRef'], location, consumed_location, recipient)
            checks.append({'name': 'hosted_browser_mfa_and_consumed_link', 'passed': True})

        expiry_wait = AUTH_LINK_EXPIRY_SECONDS + AUTH_LINK_EXPIRY_GRACE_SECONDS - (time.monotonic() - expiry_started)
        if expiry_wait > 0:
            time.sleep(expiry_wait)
        status, _, headers = request('GET', expiry_link, no_redirect=True)
        expired = parse_qs(urlparse(headers.get('Location', '')).fragment)
        if status not in (302, 303) or expired.get('error_code') != ['otp_expired']:
            raise RuntimeError('Unconsumed confirmation link remained valid after 15 minutes')
        if membership_rows(supabase_origin, expiry_user_id, admin_headers):
            raise RuntimeError('Expired unconfirmed fixture gained an organization membership')
        checks.append({'name': 'expired_after_15_minutes', 'passed': True})
        complete = True
    finally:
        cleanup_ok = bool(created_user_ids)
        for user_id in created_user_ids:
            delete_status, _, _ = request(
                'DELETE', f'{supabase_origin}/auth/v1/admin/users/{quote(user_id)}', admin_headers)
            read_status, _, _ = request(
                'GET', f'{supabase_origin}/auth/v1/admin/users/{quote(user_id)}', admin_headers)
            cleanup_ok = cleanup_ok and delete_status in (200, 204) and read_status == 404
        checks.append({'name': 'fixture_cleanup_verified', 'passed': cleanup_ok})
        report = evidence(manifest.get('head', ''), checks, complete and cleanup_ok, time.monotonic() - started)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
        if complete and not cleanup_ok:
            raise RuntimeError('Fixture cleanup could not be verified')


if __name__ == '__main__':
    main()
