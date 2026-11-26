#!/usr/bin/env python3
"""Send an immutable release to the VPS's forced-command SSH endpoint."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    required = ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_PRIVATE_KEY', 'DEPLOY_KNOWN_HOSTS',
                'GH_TOKEN', 'GITHUB_ACTOR', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'DEPLOY_APP']
    if any(not os.environ.get(name) for name in required):
        raise SystemExit('Missing deployment configuration; see the CI/CD runbook.')
    app = os.environ['DEPLOY_APP']
    names = ['core', 'dashboard'] if app == 'opsbrain' else ['app'] if app == 'experts' else []
    if not names:
        raise SystemExit('Unknown deployment application')
    payload = {'commit': os.environ['GITHUB_SHA'], 'actor': os.environ['GITHUB_ACTOR'],
               'token': os.environ['GH_TOKEN'], 'run_id': os.environ['GITHUB_RUN_ID'],
               'run_number': int(os.environ['GITHUB_RUN_NUMBER']),
               'digests': {name: os.environ[name.upper() + '_DIGEST'] for name in names}}
    # Temporary files belong only to this job. Neither credential is printed.
    with tempfile.TemporaryDirectory(prefix='dio-deploy-') as folder:
        folder = Path(folder)
        key, hosts = folder / 'key', folder / 'known_hosts'
        key.write_text(os.environ['DEPLOY_SSH_PRIVATE_KEY'].rstrip() + '\n')
        key.chmod(0o600)
        hosts.write_text(os.environ['DEPLOY_KNOWN_HOSTS'].rstrip() + '\n')
        subprocess.run(['ssh', '-F', '/dev/null', '-T', '-i', str(key),
                        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                        '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(hosts),
                        '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15',
                        '-o', 'ServerAliveCountMax=20',
                        os.environ['DEPLOY_USER'] + '@' + os.environ['DEPLOY_HOST'], 'deploy'],
                       input=json.dumps(payload).encode(), check=True)


if __name__ == '__main__':
    main()
