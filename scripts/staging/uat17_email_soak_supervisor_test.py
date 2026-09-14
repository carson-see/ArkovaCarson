import json
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
            'projectRef': 'abcdefghijklmnopqrst',
            'projectName': 'arkova-soak-uat17-0914',
            'supabaseUrl': 'https://abcdefghijklmnopqrst.supabase.co',
            'appUrl': 'https://arkova-uat17-candidate.vercel.app',
            'head': 'a' * 40,
            'frontendContentSha256': 'b' * 64,
            'workerService': 'arkova-worker-uat17-0914-staging',
            'workerGcpProject': 'arkova1',
            'workerRegion': 'us-central1',
            'workerRevision': 'arkova-worker-uat17-0914-staging-00001-abc',
            'workerImageDigest': f'sha256:{"c" * 64}',
            'workerUrl': 'https://arkova-worker-uat17-0914-staging-example-uc.a.run.app',
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
            helper = Path(directory) / 'credentials'
            helper.write_text('#!/bin/sh\ncat <<\'JSON\'\n' + json.dumps(payload) + '\nJSON\n')
            helper.chmod(0o700)
            refreshed = supervisor.refresh_credentials(supervisor.validate_helper(str(helper)))
        self.assertEqual(set(refreshed), set(supervisor.REQUIRED_CREDENTIALS))
        self.assertNotIn('must-not-propagate', json.dumps(refreshed))

    def test_union_feature_probes_fail_closed_and_use_fixed_commands(self):
        manifest = self.manifest()
        manifest['featureDrivers'] = ['uat12', 'uat24']
        credentials = {'UAT17_DATABASE_URL': 'private-db', 'UAT17_SERVICE_ROLE_KEY': 'private-key'}
        completed = type('Completed', (), {'returncode': 0, 'stdout': '', 'stderr': ''})()
        with patch.object(supervisor.subprocess, 'run', return_value=completed) as run:
            self.assertTrue(supervisor.run_feature_probes(manifest, credentials))
            self.assertEqual(run.call_count, 2)
            self.assertNotIn('private-key', str([call.args for call in run.call_args_list]))
        completed.returncode = 1
        with patch.object(supervisor.subprocess, 'run', return_value=completed):
            self.assertFalse(supervisor.run_feature_probes(manifest, credentials))

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

        responses[0]['status']['latestReadyRevisionName'] = 'wrong-revision'
        with patch.object(supervisor, 'json_get', side_effect=responses):
            self.assertIsNone(supervisor.worker_identity_observation(manifest, 'access', 'identity'))

    def test_rejects_relative_or_symlinked_credential_helpers(self):
        with self.assertRaisesRegex(ValueError, 'absolute executable'):
            supervisor.validate_helper('relative-helper')
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target'
            target.write_text('#!/bin/sh\nexit 0\n')
            target.chmod(0o700)
            link = Path(directory) / 'link'
            os.symlink(target, link)
            with self.assertRaisesRegex(ValueError, 'absolute executable'):
                supervisor.validate_helper(str(link))


if __name__ == '__main__':
    unittest.main()
