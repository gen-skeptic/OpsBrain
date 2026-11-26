import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('receiver.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class ReceiverTests(unittest.TestCase):
    def payload(self):
        return {'commit': 'a' * 40, 'actor': 'owner', 'token': 'x' * 30,
                'run_id': '123', 'run_number': 1,
                'digests': {'core': 'sha256:' + 'b' * 64, 'dashboard': 'sha256:' + 'c' * 64}}

    def test_only_fixed_repositories_and_immutable_digests(self):
        images = receiver.validate_payload('opsbrain', self.payload())
        self.assertEqual(images['core'], 'ghcr.io/gen-skeptic/opsbrain@sha256:' + 'b' * 64)
        for name, value in [('commit', 'main;id'), ('actor', 'owner;id'), ('run_number', True)]:
            payload = self.payload()
            payload[name] = value
            with self.assertRaises(ValueError):
                receiver.validate_payload('opsbrain', payload)
        for digests in [{'app': 'sha256:' + 'd' * 64}, {'core': 'latest', 'dashboard': 'latest'}]:
            payload = self.payload()
            payload['digests'] = digests
            with self.assertRaises(ValueError):
                receiver.validate_payload('opsbrain', payload)
        payload = self.payload()
        payload['command'] = 'docker run attacker/image'
        with self.assertRaises(ValueError):
            receiver.validate_payload('opsbrain', payload)

    def test_failed_health_restores_previous_override_without_database_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = copy.deepcopy(receiver.APPS)
            config['experts']['directory'] = root / 'experts'
            config['experts']['directory'].mkdir()
            override = config['experts']['directory'] / 'ci.override.yml'
            old = b'{"services":{"dio-agents":{"image":"previous@sha256:abc"}}}\n'
            override.write_bytes(old)
            with patch.object(receiver, 'APPS', config), patch.object(receiver, 'ROOT', root), \
                    patch.object(receiver, 'service', return_value={'Id': 'old', 'Mounts': [{'Destination': '/data', 'Name': 'existing-chats'}]}), \
                    patch.object(receiver, 'run', return_value=b'') as run, \
                    patch.object(receiver, 'check_experts', side_effect=RuntimeError('unhealthy')), \
                    patch.object(receiver, 'healthy'), patch.object(receiver, 'save_status') as status:
                with self.assertRaises(RuntimeError):
                    receiver.deploy('experts', self.payload(), {'app': 'new@sha256:abc'})
                self.assertEqual(override.read_bytes(), old)
                self.assertEqual(status.call_args.args[1]['rollback'], 'previous-images-healthy')
                self.assertFalse(any('pg_restore' in str(call) for call in run.call_args_list))

    def test_first_release_failure_removes_new_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = copy.deepcopy(receiver.APPS)
            config['experts']['directory'] = root / 'experts'
            config['experts']['directory'].mkdir()
            with patch.object(receiver, 'APPS', config), patch.object(receiver, 'ROOT', root), \
                    patch.object(receiver, 'service', return_value={'Id': 'old', 'Mounts': [{'Destination': '/data', 'Name': 'existing-chats'}]}), \
                    patch.object(receiver, 'run', return_value=b''), \
                    patch.object(receiver, 'check_experts', side_effect=RuntimeError('unhealthy')), \
                    patch.object(receiver, 'healthy'), patch.object(receiver, 'save_status'):
                with self.assertRaises(RuntimeError):
                    receiver.deploy('experts', self.payload(), {'app': 'new@sha256:abc'})
                self.assertFalse((config['experts']['directory'] / 'ci.override.yml').exists())

    def test_wrong_image_revision_fails_before_switch_and_removes_registry_login(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'ci').mkdir()
            payload = self.payload()
            image = {'Config': {'Labels': {'org.opencontainers.image.revision': 'd' * 40,
                                          'org.opencontainers.image.source': 'https://github.com/gen-skeptic/OpsBrain'}}}
            with patch.object(receiver, 'ROOT', root), \
                    patch.object(receiver, 'run', side_effect=[b'', b'', json.dumps([image]).encode()]):
                with self.assertRaises(RuntimeError):
                    receiver.load_images('opsbrain', payload, {'core': 'immutable-image'})
            self.assertEqual(list((root / 'ci').iterdir()), [])

    def test_failure_after_pausing_core_resumes_old_services(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = copy.deepcopy(receiver.APPS)
            config['opsbrain']['directory'] = root / 'opsbrain'
            config['opsbrain']['directory'].mkdir()
            def fail(_images, _backup, state):
                state['paused'] = True
                raise RuntimeError('rehearsal failed')
            with patch.object(receiver, 'APPS', config), patch.object(receiver, 'ROOT', root), \
                    patch.object(receiver, 'deploy_opsbrain', side_effect=fail), \
                    patch.object(receiver, 'run', return_value=b'') as run, \
                    patch.object(receiver, 'service', return_value={'Id': 'old'}), \
                    patch.object(receiver, 'healthy'), patch.object(receiver, 'save_status') as status:
                with self.assertRaises(RuntimeError):
                    receiver.deploy('opsbrain', self.payload(), {})
                self.assertTrue(any('up' in call.args[0] for call in run.call_args_list))
                self.assertEqual(status.call_args.args[1]['rollback'], 'previous-images-healthy')


if __name__ == '__main__':
    unittest.main()
