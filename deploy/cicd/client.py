#!/usr/bin/env python3
"""Send an immutable release over verified HTTPS to the signed VPS receiver."""
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def main():
    required = ['DEPLOY_URL', 'DEPLOY_WEBHOOK_SECRET', 'GH_TOKEN', 'GITHUB_ACTOR',
                'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'DEPLOY_APP']
    if any(not os.environ.get(name) for name in required):
        raise SystemExit('Missing deployment configuration; see the CI/CD runbook.')
    app = os.environ['DEPLOY_APP']
    names = ['core', 'dashboard'] if app == 'opsbrain' else ['app'] if app == 'experts' else []
    url = urllib.parse.urlsplit(os.environ['DEPLOY_URL'])
    if not names or url.scheme != 'https' or url.username or url.password or url.path != '/_cicd/' + app:
        raise SystemExit('Invalid HTTPS deployment endpoint')
    payload = {'commit': os.environ['GITHUB_SHA'], 'actor': os.environ['GITHUB_ACTOR'],
               'token': os.environ['GH_TOKEN'], 'run_id': os.environ['GITHUB_RUN_ID'],
               'run_number': int(os.environ['GITHUB_RUN_NUMBER']),
               'digests': {name: os.environ[name.upper() + '_DIGEST'] for name in names}}
    body = json.dumps(payload, separators=(',', ':')).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(os.environ['DEPLOY_WEBHOOK_SECRET'].encode(), timestamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(os.environ['DEPLOY_URL'], data=body,
        headers={'Content-Type': 'application/json', 'X-Deploy-Timestamp': timestamp,
                 'X-Deploy-Signature': 'sha256=' + signature})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=1500) as response:
            report = json.loads(response.read(65536))
        print(json.dumps(report, indent=2))
    except urllib.error.HTTPError as error:
        raise SystemExit('Deployment endpoint returned HTTP ' + str(error.code) + '; inspect the sanitized VPS status report.')


if __name__ == '__main__':
    main()
