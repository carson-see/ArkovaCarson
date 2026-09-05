"""No-network guards for the owned UAT-03 hosted driver."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('driver', Path(__file__).with_name('uat03_mailbox_driver.py'))
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)

class DriverGuards(unittest.TestCase):
    def manifest(self):
        return {'kind': 'standalone', 'projectRef': 'abcdefghijklmnopqrst',
                'workerUrl': 'https://pr-2655---arkova-worker-uat03-mailbox-0905-staging-example.run.app',
                'appUrl': 'https://uat03-mailbox-0905.example.invalid', 'head': 'a' * 40,
                'hookUri': 'pg-functions://postgres/private/oauth_email_confirmation_token_hook'}

    def test_owned_target(self):
        self.assertEqual(driver.validate_manifest(self.manifest())['projectRef'], 'abcdefghijklmnopqrst')

    def test_production_and_shared_refs_denied(self):
        for ref in ('vzwyaatejekddvltxyye', 'ujtlwnoqfhtitcmsnrpq', 'ryasykzdduzymschbucr'):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                driver.validate_manifest({**self.manifest(), 'projectRef': ref})

    def test_arbitrary_or_shared_worker_denied(self):
        for url in ('https://app.arkova.ai', 'https://arkova-worker-staging-example.run.app',
                    'https://evil.invalid', 'http://localhost:3001',
                    self.manifest()['workerUrl'] + '?redirect=1',
                    self.manifest()['workerUrl'].replace('https://', 'https://user:pass@')):
            with self.subTest(url=url), self.assertRaises(ValueError):
                driver.validate_manifest({**self.manifest(), 'workerUrl': url})

    def test_only_exact_owned_preview(self):
        p = {**self.manifest(), 'kind': 'preview', 'projectRef': 'fbwislntqahuzlpehpxk',
             'branchId': '4b169a53-3b26-4665-aef2-42d0fdfcb958'}
        self.assertEqual(driver.validate_manifest(p)['kind'], 'preview')
        with self.assertRaises(ValueError):
            driver.validate_manifest({**p, 'projectRef': 'abcdefghijklmnopqrst'})

    def test_proof_bound_to_exact_app_path_type_and_recipient(self):
        target = self.manifest()['appUrl']; address = 'fixture+uat03-run@example.invalid'
        proof = 'mailbox-proof-of-at-least-twenty-characters'
        raw = f'To: {address}\nContent-Type: text/html\n\n<a href="{target}/signup#token={proof}&amp;type=oauth_confirmation">Confirm</a>'.encode()
        self.assertEqual(driver.mailbox_proof(raw, address, target), proof)
        for changed in (raw.replace(address.encode(), b'other@example.invalid'),
                        raw.replace(target.encode(), b'https://app.arkova.ai'),
                        raw.replace(b'/signup#', b'/login#'),
                        raw.replace(b'oauth_confirmation', b'other_confirmation')):
            self.assertIsNone(driver.mailbox_proof(changed, address, target))

    def test_stdio_proof_requires_fresh_matching_mailbox_metadata(self):
        request = {'recipient': 'fixture+uat03-run@example.invalid', 'appOrigin': self.manifest()['appUrl'], 'issuedAfterMs': 1000}
        response = {'recipient': request['recipient'], 'appOrigin': request['appOrigin'], 'receivedAtMs': 1100,
                    'messageId': 'owned-gmail-message', 'token': 'mailbox-proof-long-enough-for-test'}
        self.assertEqual(driver.validate_mailbox_reply(response, request, 1200), response['token'])
        for changed in ({'recipient': 'other@example.invalid'}, {'appOrigin': 'https://app.arkova.ai'},
                        {'receivedAtMs': 900}, {'receivedAtMs': 999999}, {'messageId': ''}, {'token': 'short'}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                driver.validate_mailbox_reply({**response, **changed}, request, 1200)

    def test_stdio_does_not_echo_proof_in_a_pty(self):
        import json, os, pty, select, subprocess, sys, time
        expected = {'recipient': 'fixture+uat03-run@example.invalid', 'appOrigin': self.manifest()['appUrl'], 'issuedAfterMs': 0}
        proof = 'private-mailbox-proof-must-not-be-echoed'
        master, slave = pty.openpty()
        code = "import uat03_mailbox_driver as d; d.read_mailbox_reply(" + repr(expected) + ")"
        process = subprocess.Popen([sys.executable, '-c', code], cwd=Path(__file__).parent,
                                   stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        try:
            self.assertTrue(select.select([master], [], [], 5)[0])
            output += os.read(master, 8192)
            self.assertIn(b'mailboxRequest', output)
            reply = {**expected, 'receivedAtMs': int(time.time() * 1000), 'messageId': 'owned-message', 'token': proof}
            os.write(master, (json.dumps(reply) + '\n').encode())
            process.wait(timeout=5)
            while select.select([master], [], [], 0)[0]:
                try:
                    data = os.read(master, 8192)
                except OSError:
                    break
                if not data:
                    break
                output += data
            self.assertEqual(process.returncode, 0)
            self.assertNotIn(proof.encode(), output)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)

    def test_evidence_never_contains_body_or_credentials(self):
        evidence = driver.evidence('a' * 40, [{'label': 'proof', 'passed': False, 'status': 400}], False)
        self.assertFalse(evidence['hostedReleaseComplete'])
        self.assertFalse(evidence['allPassed'])
        self.assertNotIn('token', str(evidence).lower())

if __name__ == '__main__':
    unittest.main()
