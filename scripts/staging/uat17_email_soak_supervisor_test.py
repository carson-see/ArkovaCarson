import json
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import uat17_email_soak_supervisor as supervisor  # noqa: E402


class Uat17SoakSupervisorTest(unittest.TestCase):
    def manifest(self):
        return {
            'projectRef': supervisor.driver.OWNED_PROJECT_REF,
            'projectName': 'arkova-soak-uat17-0914',
            'supabaseUrl': supervisor.driver.OWNED_SUPABASE_ORIGIN,
            'appUrl': supervisor.driver.OWNED_APP_ORIGIN,
            'head': 'a' * 40,
            'frontendContentSha256': 'b' * 64,
            'workerService': supervisor.OWNED_WORKER_SERVICE,
            'workerGcpProject': supervisor.OWNED_WORKER_PROJECT,
            'workerRegion': supervisor.OWNED_WORKER_REGION,
            'workerRevision': 'arkova-worker-uat17-0914-staging-00001-abc',
            'workerImageDigest': f'sha256:{"c" * 64}',
            'workerUrl': supervisor.OWNED_WORKER_URL,
        }

    def test_requires_a_24_hour_window_and_safe_email_cadence(self):
        self.assertEqual(
            supervisor.validate_settings(self.manifest(), 24, 60)['head'], 'a' * 40)
        with self.assertRaisesRegex(ValueError, 'at least 24 hours'):
            supervisor.validate_settings(self.manifest(), 23.99, 60)
        with self.assertRaisesRegex(ValueError, 'at least 60 seconds'):
            supervisor.validate_settings(self.manifest(), 24, 59)

    def test_refreshes_credentials_without_returning_unrecognized_values(self):
        payload = {key: f'value-{index}' for index, key in enumerate(supervisor.REQUIRED_CREDENTIALS)}
        payload['UNRELATED_SECRET'] = 'must-not-propagate'
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory) / 'uat17-credentials.py'
            helper.write_text('#!/bin/sh\ncat <<\'JSON\'\n' + json.dumps(payload) + '\nJSON\n')
            helper.chmod(0o700)
            digest = hashlib.sha256(helper.read_bytes()).hexdigest()
            completed = type('Completed', (), {'returncode': 0, 'stdout': json.dumps(payload)})()
            with (patch.object(supervisor, 'APPROVED_CREDENTIALS_HELPER', helper),
                  patch.object(supervisor, 'APPROVED_CREDENTIALS_HELPER_SHA256', digest),
                  patch.object(supervisor.subprocess, 'run', return_value=completed)):
                refreshed = supervisor.refresh_credentials(supervisor.validate_helper(str(helper)))
        self.assertEqual(set(refreshed), set(supervisor.REQUIRED_CREDENTIALS))
        self.assertNotIn('must-not-propagate', json.dumps(refreshed))

    def test_summary_contains_no_credentials_or_fixture_identity(self):
        started = supervisor.utc_now()
        summary = supervisor.redacted_summary(
            self.manifest(), started, started, 3, 'running')
        encoded = json.dumps(summary)
        self.assertLess(summary['emailsPerHourUpperBound'], 12)
        self.assertNotIn('@', encoded)
        self.assertNotIn('SUPABASE_ACCESS_TOKEN', encoded)
        self.assertFalse(summary['containsSecretsOrFixtureIdentity'])

    def test_rejects_frontend_hash_mislabelled_as_a_worker_digest(self):
        invalid = self.manifest()
        invalid['workerImageDigest'] = invalid['frontendContentSha256']
        with self.assertRaisesRegex(ValueError, 'worker image digest'):
            supervisor.validate_settings(invalid, 24, 60)

    def test_worker_identity_binds_ready_revision_digest_head_and_health(self):
        manifest = self.manifest()
        responses = [
            {'status': {
                'latestReadyRevisionName': manifest['workerRevision'],
                'url': manifest['workerUrl'],
                'traffic': [{'revisionName': manifest['workerRevision'], 'percent': 100}],
            }},
            {
                'metadata': {'labels': {'arkova-source-head': manifest['head']}},
                'status': {'imageDigest': f'image@{manifest["workerImageDigest"]}'},
            },
            {'status': 'healthy', 'git_sha': manifest['head'], 'uptime': 86401},
        ]
        with patch.object(supervisor, 'json_get', side_effect=responses) as get:
            self.assertEqual(
                supervisor.worker_identity_observation(manifest, 'access', 'identity'), 86401)
            self.assertTrue(get.call_args_list[-1].kwargs['serverless'])
            self.assertEqual(get.call_args_list[0].args[0],
                             'https://us-central1-run.googleapis.com/apis/serving.knative.dev/'
                             'v1/namespaces/arkova1/services/arkova-worker-uat17-0914-staging')
            self.assertEqual(get.call_args_list[-1].args[0], supervisor.OWNED_WORKER_URL + '/health')

        responses[0]['status']['latestReadyRevisionName'] = 'wrong-revision'
        with patch.object(supervisor, 'json_get', side_effect=responses):
            self.assertIsNone(supervisor.worker_identity_observation(manifest, 'access', 'identity'))

    def test_rejects_unapproved_modified_relative_or_symlinked_credential_helpers(self):
        with self.assertRaisesRegex(ValueError, 'Exact approved'):
            supervisor.validate_helper('relative-helper')
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'uat17-credentials.py'
            target.write_text('#!/bin/sh\nexit 0\n')
            target.chmod(0o700)
            alternate = Path(directory) / 'attacker-helper'
            alternate.write_bytes(target.read_bytes())
            alternate.chmod(0o700)
            link = Path(directory) / 'helper-link'
            os.symlink(target, link)
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            with (patch.object(supervisor, 'APPROVED_CREDENTIALS_HELPER', target),
                  patch.object(supervisor, 'APPROVED_CREDENTIALS_HELPER_SHA256', digest)):
                self.assertEqual(supervisor.validate_helper(str(target)), target)
                with self.assertRaisesRegex(ValueError, 'Exact approved'):
                    supervisor.validate_helper(str(alternate))
                with self.assertRaisesRegex(ValueError, 'Exact approved'):
                    supervisor.validate_helper(str(link))
                target.write_text('#!/bin/sh\necho attacker\n')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    supervisor.validate_helper(str(target))

    def test_rejects_attacker_worker_host_project_and_region(self):
        for key, value in (
                ('workerUrl', 'https://attacker-service-abc-uc.a.run.app'),
                ('workerGcpProject', 'attacker-project'),
                ('workerRegion', 'europe-west1')):
            invalid = self.manifest()
            invalid[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Exact'):
                supervisor.validate_settings(invalid, 24, 60)

    def test_observation_url_allowlist_rejects_attacker_and_api_traversal(self):
        service = (supervisor.OWNED_GCP_OBSERVATION_BASE
                   + '/services/' + supervisor.OWNED_WORKER_SERVICE)
        self.assertEqual(supervisor.trusted_observation_url(service), service)
        for url in (
                'https://attacker-service-abc-uc.a.run.app/health',
                supervisor.OWNED_GCP_OBSERVATION_BASE + '/services/../secrets',
                supervisor.OWNED_GCP_OBSERVATION_BASE + '/services/attacker-service'):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'Exact owned'):
                supervisor.trusted_observation_url(url)


if __name__ == '__main__':
    unittest.main()
