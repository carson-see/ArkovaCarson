import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name('uat17_email_confirmation_driver.py')
SPEC = importlib.util.spec_from_file_location('uat17_email_confirmation_driver', MODULE_PATH)
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)


class Uat17DriverTest(unittest.TestCase):
    def manifest(self):
        return {
            'projectRef': 'abcdefghijklmnopqrst',
            'projectName': 'arkova-soak-uat17-0914',
            'supabaseUrl': 'https://abcdefghijklmnopqrst.supabase.co',
            'appUrl': 'https://arkova-uat17-candidate.vercel.app',
            'head': 'a' * 40,
        }

    def config(self):
        return {
            'mailer_otp_exp': 900,
            'smtp_max_frequency': 90,
            'rate_limit_email_sent': 30,
            'smtp_host': 'smtp.resend.com',
            'smtp_admin_email': 'noreply@arkova.ai',
            'smtp_sender_name': 'Arkova',
            'mailer_subjects_confirmation': 'Confirm your Arkova account',
            'mailer_templates_confirmation_content': '<p>Welcome to Arkova</p>',
        }

    def test_accepts_only_owned_isolated_targets(self):
        self.assertEqual(driver.validate_manifest(self.manifest())['projectName'], 'arkova-soak-uat17-0914')
        for ref in driver.SHARED_REFS:
            invalid = self.manifest()
            invalid['projectRef'] = ref
            invalid['supabaseUrl'] = f'https://{ref}.supabase.co'
            with self.assertRaisesRegex(ValueError, 'Owned isolated'):
                driver.validate_manifest(invalid)
        invalid = self.manifest()
        invalid['appUrl'] = 'https://app.arkova.ai'
        with self.assertRaisesRegex(ValueError, 'Isolated app'):
            driver.validate_manifest(invalid)
        invalid = self.manifest()
        invalid['projectName'] = 'arkova-uat17-almost-owned'
        with self.assertRaisesRegex(ValueError, 'Exact owned project name'):
            driver.validate_manifest(invalid)

    def test_distinguishes_interval_from_hourly_quota(self):
        self.assertTrue(driver.validate_auth_config(self.config()))
        invalid = self.config()
        invalid['rate_limit_email_sent'] = 90
        with self.assertRaisesRegex(ValueError, 'rate_limit_email_sent'):
            driver.validate_auth_config(invalid)
        invalid = self.config()
        invalid['smtp_max_frequency'] = 1
        with self.assertRaisesRegex(ValueError, 'smtp_max_frequency'):
            driver.validate_auth_config(invalid)

    def test_requires_positive_canonical_trigger_catalog_result(self):
        self.assertTrue(driver.trigger_catalog_is_canonical(
            [{'canonical_auth_user_triggers': True}]))
        self.assertTrue(driver.trigger_catalog_is_canonical({'result': 't'}))
        self.assertFalse(driver.trigger_catalog_is_canonical(
            [{'canonical_auth_user_triggers': False}]))

    def test_selects_only_the_exact_fresh_fixture_recipient(self):
        payload = {'object': 'list', 'data': [
            {'id': 'unrelated', 'to': ['person@example.com'], 'created_at': '2026-09-14T12:02:00Z'},
            {'id': 'old', 'to': ['delivered+uat17-owned@resend.dev'], 'created_at': '2026-09-13T12:02:00Z'},
            {'id': 'owned', 'to': ['delivered+uat17-owned@resend.dev'], 'created_at': '2026-09-14T12:02:00.123+00:00'},
        ]}
        selected = driver.select_fixture_message(
            payload, 'delivered+uat17-owned@resend.dev', '2026-09-14T12:00:00Z')
        self.assertEqual(selected['id'], 'owned')
        self.assertIsNone(driver.select_fixture_message(
            payload, 'delivered+uat17-owned@resend.dev', '2026-09-14T12:00:00Z', {'owned'}))
        with self.assertRaisesRegex(ValueError, 'ISO-8601'):
            driver.select_fixture_message(payload, 'delivered+uat17-owned@resend.dev', 'not-a-time')

    def test_extracts_only_bound_arkova_confirmation_link(self):
        callback = 'https://arkova-uat17-candidate.vercel.app/auth/callback'
        link = ('https://abcdefghijklmnopqrst.supabase.co/auth/v1/verify?token=secret'
                '&amp;type=signup&amp;redirect_to=https%3A%2F%2Farkova-uat17-candidate.vercel.app%2Fauth%2Fcallback')
        message = {
            'from': 'Arkova <noreply@arkova.ai>',
            'subject': 'Confirm your Arkova account',
            'html': f'<a href="{link}">Confirm</a>',
        }
        extracted = driver.extract_confirmation_url(
            message, 'https://abcdefghijklmnopqrst.supabase.co', callback)
        self.assertIn('token=secret', extracted)
        message['html'] += '<p>Supabase</p>'
        with self.assertRaisesRegex(ValueError, 'branded'):
            driver.extract_confirmation_url(message, 'https://abcdefghijklmnopqrst.supabase.co', callback)

    def test_browser_helper_receives_callback_state_only_through_environment(self):
        completed = type('Completed', (), {
            'returncode': 0,
            'stdout': json.dumps({'hostedBrowserPassed': True}),
        })()
        with patch.object(driver.subprocess, 'run', return_value=completed) as run:
            self.assertTrue(driver.run_hosted_browser(
                'https://arkova-uat17-candidate.vercel.app',
                'abcdefghijklmnopqrst',
                'https://arkova-uat17-candidate.vercel.app/auth/callback#access_token=secret',
                'https://arkova-uat17-candidate.vercel.app/auth/callback#error_code=otp_expired',
                'delivered+uat17-aabbcc@resend.dev',
            ))
        command, = run.call_args.args
        child_env = run.call_args.kwargs['env']
        self.assertNotIn('secret', ' '.join(command))
        self.assertNotIn('SUPABASE_ACCESS_TOKEN', child_env)
        self.assertIn('access_token=secret', child_env['UAT17_BROWSER_CONFIRMED_CALLBACK'])

    def test_cleanup_soft_deletes_and_verifies_deactivation_without_touching_audit(self):
        responses = [(200, {}, {}), (200, {'deleted_at': '2026-09-14T00:00:00Z'}, {}),
                     (204, None, {}), (204, None, {}), (200, [], {}),
                     (200, [{'deleted_at': '2026-09-14T00:00:00Z'}], {})]
        with patch.object(driver, 'request', side_effect=responses) as request:
            self.assertTrue(driver.cleanup_fixture_user('https://fixture.supabase.co', 'owned-id', {}))
            self.assertEqual(request.call_args_list[0].args[3], {'should_soft_delete': True})
            self.assertFalse(any('audit_events' in str(call) for call in request.call_args_list))
        with patch.object(driver, 'request', side_effect=[(200, {}, {}), (200, {}, {})]):
            self.assertFalse(driver.cleanup_fixture_user('https://fixture.supabase.co', 'owned-id', {}))

    def test_evidence_contains_no_fixture_identity_or_message(self):
        report = driver.evidence('a' * 40, [{'name': 'owned_project', 'passed': True}], True, 92)
        encoded = json.dumps(report)
        self.assertTrue(report['allPassed'])
        self.assertNotIn('@', encoded)
        self.assertNotIn('access_token', encoded)
        self.assertFalse(report['containsSecretsOrMessageContent'])
        self.assertIn('15-minute expiry boundary', report['remainingReleaseGates'])

        complete_checks = [
            {'name': 'expired_after_15_minutes', 'passed': True},
            {'name': 'fixture_cleanup_verified', 'passed': True},
        ]
        completed = driver.evidence('a' * 40, complete_checks, True, 905)
        self.assertNotIn('15-minute expiry boundary', completed['remainingReleaseGates'])


if __name__ == '__main__':
    unittest.main()
