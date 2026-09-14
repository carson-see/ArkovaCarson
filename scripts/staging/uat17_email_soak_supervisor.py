#!/usr/bin/env python3
"""Bounded 24-hour SCRUM-5145 supervisor for the isolated hosted driver."""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

import uat17_email_confirmation_driver as driver

MIN_DURATION_HOURS = 24
MIN_INTERVAL_SECONDS = 60
REQUIRED_CREDENTIALS = (
    'SUPABASE_ACCESS_TOKEN',
    'UAT17_ANON_KEY',
    'UAT17_SERVICE_ROLE_KEY',
    'RESEND_API_KEY',
    'GCP_ACCESS_TOKEN',
    'UAT17_WORKER_ID_TOKEN',
)
REPO_ROOT = Path(__file__).resolve().parents[2]


def utc_now():
    return datetime.now(timezone.utc)


def iso_utc(value):
    return value.isoformat(timespec='seconds').replace('+00:00', 'Z')


def validate_settings(manifest, duration_hours, interval_seconds):
    driver.validate_manifest(manifest)
    if not re.fullmatch(r'[a-f0-9]{64}', manifest.get('frontendContentSha256', '')):
        raise ValueError('Exact SHA-256 frontendContentSha256 required')
    if manifest.get('workerService') != 'arkova-worker-uat17-0914-staging':
        raise ValueError('Exact owned UAT-17 worker service required')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,62}', manifest.get('workerGcpProject', '')):
        raise ValueError('Worker GCP project required')
    if not re.fullmatch(r'[a-z]+-[a-z]+[0-9]', manifest.get('workerRegion', '')):
        raise ValueError('Worker region required')
    if not re.fullmatch(r'arkova-worker-uat17-0914-staging-[0-9]{5}-[a-z0-9]{3}',
                        manifest.get('workerRevision', '')):
        raise ValueError('Exact owned UAT-17 worker revision required')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', manifest.get('workerImageDigest', '')):
        raise ValueError('Exact worker image digest required')
    worker_url = driver.urlparse(manifest.get('workerUrl', ''))
    if (worker_url.scheme != 'https' or not worker_url.hostname
            or not worker_url.hostname.endswith('.run.app')
            or worker_url.path not in ('', '/') or worker_url.query or worker_url.fragment):
        raise ValueError('Exact isolated worker URL required')
    if duration_hours < MIN_DURATION_HOURS:
        raise ValueError('UAT-17 migration soak must run for at least 24 hours')
    if interval_seconds < MIN_INTERVAL_SECONDS:
        raise ValueError('UAT-17 soak requires at least 60 seconds between cycles')
    return manifest


def validate_helper(path_value):
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError('Credentials helper must be an absolute executable regular file')
    return path


def refresh_credentials(helper):
    result = subprocess.run(
        [str(helper)], capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('credential_refresh_failed')
    try:
        payload = json.loads(result.stdout)
    except (TypeError, ValueError):
        raise RuntimeError('credential_refresh_failed') from None
    if not isinstance(payload, dict) or any(not isinstance(payload.get(key), str) or not payload[key]
                                            for key in REQUIRED_CREDENTIALS):
        raise RuntimeError('credential_refresh_failed')
    return {key: value for key, value in payload.items()
            if key in REQUIRED_CREDENTIALS or key == 'UAT17_DATABASE_URL'}


def source_head():
    result = subprocess.run(
        ['git', '-C', str(REPO_ROOT), 'rev-parse', 'HEAD'],
        capture_output=True, text=True, timeout=15, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('source_head_unreadable')
    return result.stdout.strip()


def source_is_clean():
    result = subprocess.run(
        ['git', '-C', str(REPO_ROOT), 'status', '--porcelain', '--untracked-files=no'],
        capture_output=True, text=True, timeout=15, check=False,
    )
    return result.returncode == 0 and not result.stdout.strip()


def frontend_content_sha256(url):
    request = Request(url, method='GET', headers={
        'Cache-Control': 'no-cache',
        'User-Agent': 'Arkova-UAT17-Soak/1.0',
    })
    try:
        with build_opener(driver.NoRedirect()).open(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError('frontend_content_unreadable')
            return hashlib.sha256(response.read()).hexdigest()
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise RuntimeError('frontend_content_unreadable') from None


def json_get(url, bearer, serverless=False):
    request = Request(url, method='GET', headers={
        'X-Serverless-Authorization' if serverless else 'Authorization': f'Bearer {bearer}',
        'User-Agent': 'Arkova-UAT17-Soak/1.0',
    })
    try:
        with build_opener(driver.NoRedirect()).open(request, timeout=30) as response:
            payload = json.loads(response.read())
            if response.status != 200 or not isinstance(payload, dict):
                raise RuntimeError('worker_identity_unreadable')
            return payload
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise RuntimeError('worker_identity_unreadable') from None


def worker_identity_observation(manifest, access_token, id_token):
    base = (f'https://{manifest["workerRegion"]}-run.googleapis.com/'
            f'apis/serving.knative.dev/v1/namespaces/{manifest["workerGcpProject"]}')
    service = json_get(f'{base}/services/{manifest["workerService"]}', access_token)
    status = service.get('status') if isinstance(service.get('status'), dict) else {}
    traffic = status.get('traffic') if isinstance(status.get('traffic'), list) else []
    revision_name = status.get('latestReadyRevisionName')
    if (revision_name != manifest['workerRevision']
            or status.get('url', '').rstrip('/') != manifest['workerUrl'].rstrip('/')
            or not any(row.get('revisionName') == revision_name and row.get('percent') == 100
                       for row in traffic if isinstance(row, dict))):
        return None
    revision = json_get(f'{base}/revisions/{revision_name}', access_token)
    revision_status = revision.get('status') if isinstance(revision.get('status'), dict) else {}
    labels = revision.get('metadata', {}).get('labels', {})
    image_digest = revision_status.get('imageDigest', '')
    if (not image_digest.endswith(f'@{manifest["workerImageDigest"]}')
            and image_digest != manifest['workerImageDigest']):
        return None
    if labels.get('arkova-source-head') != manifest['head']:
        return None
    health = json_get(f'{manifest["workerUrl"].rstrip("/")}/health', id_token, serverless=True)
    uptime = health.get('uptime')
    if (health.get('git_sha') != manifest['head'] or health.get('status') != 'healthy'
            or not isinstance(uptime, (int, float)) or uptime < 0):
        return None
    return float(uptime)


def write_summary(path, payload):
    encoded = json.dumps(payload, indent=2) + '\n'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(encoded)
    temporary.replace(path)


def redacted_summary(manifest, started_at, deadline, cycles, status, failure=None,
                     initial_worker_uptime=None, final_worker_uptime=None):
    payload = {
        'driver': 'uat17-email-soak-supervisor',
        'head': manifest['head'],
        'frontendContentSha256': manifest['frontendContentSha256'],
        'workerRevision': manifest['workerRevision'],
        'workerImageDigest': manifest['workerImageDigest'],
        'projectName': manifest['projectName'],
        'startedAt': iso_utc(started_at),
        'deadlineAt': iso_utc(deadline),
        'cyclesCompleted': cycles,
        'status': status,
        'initialWorkerUptimeSeconds': initial_worker_uptime,
        'finalWorkerUptimeSeconds': final_worker_uptime,
        'emailsPerHourUpperBound': round(3 * 3600 / (
            driver.AUTH_LINK_EXPIRY_SECONDS
            + driver.AUTH_LINK_EXPIRY_GRACE_SECONDS
            + MIN_INTERVAL_SECONDS
        ), 2),
        'containsSecretsOrFixtureIdentity': False,
    }
    if failure:
        payload['failure'] = failure
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--credentials-helper', required=True)
    parser.add_argument('--duration-hours', type=float, default=24)
    parser.add_argument('--interval-seconds', type=int, default=60)
    parser.add_argument('--browser-first-cycle', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()

    if not re.fullmatch(r'uat17-[a-z0-9-]{6,48}', args.run_id):
        raise SystemExit('run-id must be a unique uat17-* label')
    manifest_path = Path(args.manifest).resolve()
    manifest = validate_settings(
        json.loads(manifest_path.read_text()), args.duration_hours, args.interval_seconds)
    helper = validate_helper(args.credentials_helper)
    if not args.apply:
        print(json.dumps({
            'dryRun': True,
            'runId': args.run_id,
            'durationHours': args.duration_hours,
            'intervalSeconds': args.interval_seconds,
            'projectName': manifest['projectName'],
        }))
        return 0

    run_dir = driver.artifact_path(f'{args.run_id}/probe.json').parent
    run_dir.mkdir(parents=True, exist_ok=True)
    summary_path = run_dir / 'summary.json'
    if summary_path.exists():
        raise SystemExit('Refusing to overwrite an existing UAT-17 soak')
    lock_handle = (run_dir / 'supervisor.lock').open('a+', encoding='utf8')
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('UAT-17 soak supervisor is already running') from None
    lock_handle.seek(0)
    lock_handle.truncate()
    lock_handle.write(f'{os.getpid()}\n')
    lock_handle.flush()

    started_at = utc_now()
    deadline = started_at + timedelta(hours=args.duration_hours)
    cycle = 0
    failure = None
    initial_worker_uptime = None
    final_worker_uptime = None
    write_summary(summary_path, redacted_summary(
        manifest, started_at, deadline, cycle, 'running'))
    try:
        while utc_now() < deadline:
            cycle += 1
            if source_head() != manifest['head']:
                failure = 'source_head_drift'
                break
            if not source_is_clean():
                failure = 'source_worktree_drift'
                break
            if frontend_content_sha256(manifest['appUrl']) != manifest['frontendContentSha256']:
                failure = 'frontend_content_drift'
                break

            try:
                credentials = refresh_credentials(helper)
            except RuntimeError:
                failure = 'credential_refresh_failed'
                break
            observed_uptime = worker_identity_observation(
                manifest, credentials['GCP_ACCESS_TOKEN'], credentials['UAT17_WORKER_ID_TOKEN'])
            if observed_uptime is None:
                failure = 'worker_runtime_identity_drift'
                break
            if final_worker_uptime is not None and observed_uptime < final_worker_uptime:
                failure = 'worker_uptime_decreased'
                break
            if initial_worker_uptime is None:
                initial_worker_uptime = observed_uptime
            final_worker_uptime = observed_uptime
            cycle_name = f'{args.run_id}/cycle-{cycle:04d}.json'
            child_env = {**os.environ, **credentials}
            command = [
                sys.executable,
                str(Path(__file__).with_name('uat17_email_confirmation_driver.py')),
                '--manifest', str(manifest_path),
                '--evidence-out', cycle_name,
                '--apply',
            ]
            if args.browser_first_cycle and cycle == 1:
                command.append('--browser')
            result = subprocess.run(
                command, env=child_env, capture_output=True, text=True,
                timeout=driver.AUTH_LINK_EXPIRY_SECONDS + 300, check=False,
            )
            cycle_path = driver.artifact_path(cycle_name)
            if result.returncode != 0 or not cycle_path.is_file():
                failure = 'hosted_driver_failed'
                break
            try:
                cycle_evidence = json.loads(cycle_path.read_text())
            except (OSError, ValueError):
                failure = 'cycle_evidence_unreadable'
                break
            if cycle_evidence.get('head') != manifest['head'] or cycle_evidence.get('allPassed') is not True:
                failure = 'cycle_evidence_failed'
                break
            write_summary(summary_path, redacted_summary(
                manifest, started_at, deadline, cycle, 'running',
                initial_worker_uptime=initial_worker_uptime,
                final_worker_uptime=final_worker_uptime))
            remaining = (deadline - utc_now()).total_seconds()
            if remaining <= 0:
                break
            time.sleep(min(args.interval_seconds, remaining))
    except Exception:
        failure = failure or 'supervisor_probe_failed'

    elapsed = (utc_now() - started_at).total_seconds()
    if (failure is None and elapsed >= args.duration_hours * 3600
            and (final_worker_uptime is None or final_worker_uptime < 24 * 3600)):
        failure = 'worker_uptime_below_24h'
    passed = (failure is None and cycle > 0 and elapsed >= args.duration_hours * 3600
              and final_worker_uptime is not None and final_worker_uptime >= 24 * 3600)
    write_summary(summary_path, redacted_summary(
        manifest, started_at, deadline, cycle, 'pass' if passed else 'fail', failure,
        initial_worker_uptime=initial_worker_uptime,
        final_worker_uptime=final_worker_uptime))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
