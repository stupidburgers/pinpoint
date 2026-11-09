"""Stdlib privacy gate tests; all identities here are generated fixtures."""
import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'privacy-check.py'


class PrivacyTests(unittest.TestCase):
    def test_home_paths_including_nested_json(self):
        self.assertTrue(SCRIPT.exists(), 'privacy scanner must exist')
        spec = importlib.util.spec_from_file_location('privacy', SCRIPT)
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        for path in ['C:' + '/Users/' + 'fixture-person/private',
                     '/home/' + 'fixture-person/private',
                     '/Users/' + 'fixture-person/private']:
            for text in [path, path.replace('/', '\\'), path.replace('/', '\\\\\\\\')]:
                with self.subTest(text=text):
                    self.assertIn('user-home path', gate.reasons(text))

    def test_captured_sessions_and_portable_examples(self):
        spec = importlib.util.spec_from_file_location('privacy', SCRIPT)
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        for text in ['local-' + 'a' * 64, 'local-' + '1234abcd',
                     '20260102' + '_123456_' + 'abcdef']:
            self.assertIn('captured session identity', gate.reasons(text))
        for text in ['C:/.../pinpoint', 'file:///C:/site', 'u.hostname',
                     'http://localhost:8765', 'https://github.com/stupidburgers/pinpoint',
                     'session_id', 'session_id=fixture-session', '$HOME/project']:
            self.assertEqual([], gate.reasons(text), text)

    def test_cli_scans_all_tracked_text_and_instruction_file(self):
        import os
        import subprocess
        import tempfile
        import sys
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as folder:
            tracked = ['evidence/nested.json']
            target = Path(folder) / 'evidence' / 'nested.json'
            target.parent.mkdir()
            target.write_text('safe', encoding='utf-8')
            def scan():
                return subprocess.run([sys.executable, str(SCRIPT), '--tracked-stdin'], cwd=folder,
                                      input='\0'.join(tracked) + '\0', capture_output=True, text=True)
            self.assertEqual(0, scan().returncode)
            target.write_text('C:' + '\\\\\\\\Users' + '\\\\\\\\fixture-person' + '\\\\\\\\secret', encoding='utf-8')
            result = scan()
            self.assertEqual(1, result.returncode)
            self.assertIn('evidence/nested.json:1', result.stdout)
            self.assertNotIn('fixture-person', result.stdout)
            target.write_text('safe', encoding='utf-8')
            private = Path(folder) / '.hermes.md'
            private.write_text('private instructions', encoding='utf-8')
            tracked.append('.hermes.md')
            self.assertEqual(1, scan().returncode)
            private.unlink()
            self.assertEqual(1, scan().returncode, 'tracked instruction file fails even when absent')
    def test_rig_requires_explicit_isolated_directory(self):
        import os
        import runpy
        from unittest.mock import patch
        with patch.dict(os.environ, {}, clear=True):
            rig = runpy.run_path(str(SCRIPT.parents[1] / 'demo' / 'rig' / 'rig.py'))
        with self.assertRaises(SystemExit):
            rig['guard']()


if __name__ == '__main__':
    unittest.main()
