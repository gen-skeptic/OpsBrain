import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('webhook', Path(__file__).with_name('webhook.py'))
webhook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webhook)


class WebhookTests(unittest.TestCase):
    def test_signature_binds_app_timestamp_and_body(self):
        body, timestamp = b'{"probe":true}', '1000'
        with patch.dict(os.environ, {'OPSBRAIN_DEPLOY_SECRET': 'a' * 64, 'EXPERTS_DEPLOY_SECRET': 'b' * 64}):
            signature = 'sha256=' + hmac.new(b'a' * 64, timestamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
            self.assertTrue(webhook.authenticated('opsbrain', timestamp, signature, body, now=1001))
            self.assertFalse(webhook.authenticated('experts', timestamp, signature, body, now=1001))
            self.assertFalse(webhook.authenticated('opsbrain', timestamp, signature, b'changed', now=1001))
            self.assertFalse(webhook.authenticated('opsbrain', timestamp, signature, body, now=1400))
            self.assertFalse(webhook.authenticated('opsbrain', 'invalid', signature, body, now=1001))

    def test_unauthenticated_post_cannot_invoke_receiver_and_signed_probe_is_scoped(self):
        server = webhook.ThreadingHTTPServer(('127.0.0.1', 0), webhook.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        body = b'{"probe":true}'
        url = 'http://127.0.0.1:' + str(server.server_port) + '/_cicd/opsbrain'
        try:
            with patch.dict(os.environ, {'OPSBRAIN_DEPLOY_SECRET': 'a' * 64}), \
                    patch.object(webhook.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'{"receiver":"ready"}')) as run:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=5)
                self.assertEqual(error.exception.code, 401)
                error.exception.close()
                run.assert_not_called()
                timestamp = str(int(time.time()))
                signature = 'sha256=' + hmac.new(b'a' * 64, timestamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
                request = urllib.request.Request(url, data=body, headers={'X-Deploy-Timestamp': timestamp, 'X-Deploy-Signature': signature})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response), {'receiver': 'ready'})
                self.assertEqual(run.call_args.args[0], ['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '/usr/local/lib/dio-cicd/receiver.py', 'opsbrain'])
                self.assertEqual(run.call_args.kwargs['input'], body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
