#!/usr/bin/env python3
"""Private bridge-bound HTTPS relay; only the existing proxy publishes it.

Runs as dio-deploy, authenticates each app with a separate HMAC key and calls
only the installed root receiver. Never logs headers, bodies or credentials.
"""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import time

PATHS = {'/_cicd/opsbrain': 'opsbrain', '/_cicd/experts': 'experts'}


def authenticated(app, timestamp, signature, body, now=None):
    if not timestamp.isdigit() or len(timestamp) > 12 or abs((now or time.time()) - int(timestamp)) > 300:
        return False
    secret = os.environ.get(app.upper() + '_DEPLOY_SECRET', '')
    if len(secret) < 32:
        return False
    expected = 'sha256=' + hmac.new(secret.encode(), timestamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode(), signature.encode())


class Handler(BaseHTTPRequestHandler):
    server_version = 'DIODeployment'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *_):
        pass

    def respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.respond(200, {'ok': True}) if self.path in ['/healthz', '/_cicd/healthz'] else self.respond(404, {'error': 'Not found'})

    def do_POST(self):
        app = PATHS.get(self.path)
        if app is None:
            return self.respond(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= 16384 or self.headers.get('Transfer-Encoding'):
            return self.respond(413, {'error': 'Invalid release descriptor size'})
        body = self.rfile.read(length)
        if not authenticated(app, self.headers.get('X-Deploy-Timestamp', ''), self.headers.get('X-Deploy-Signature', ''), body):
            return self.respond(401, {'error': 'Unauthorized'})
        try:
            result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I',
                                     '/usr/local/lib/dio-cicd/receiver.py', app],
                                    input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1500)
            if result.returncode:
                return self.respond(502, {'error': 'Deployment failed; inspect the sanitized VPS status report'})
            report = json.loads(result.stdout)
            self.respond(200, report)
        except (Exception, BrokenPipeError):
            self.respond(502, {'error': 'Deployment did not finish; inspect the sanitized VPS status report'})


if __name__ == '__main__':
    for app in ['opsbrain', 'experts']:
        if len(os.environ.get(app.upper() + '_DEPLOY_SECRET', '')) < 32:
            raise SystemExit('Missing per-application authentication configuration')
    ThreadingHTTPServer((os.environ['DEPLOY_BIND_ADDRESS'], 8765), Handler).serve_forever()
