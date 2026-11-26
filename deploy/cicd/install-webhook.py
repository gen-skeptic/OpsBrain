#!/usr/bin/env python3
"""Install the signed HTTPS transport when hosted runners cannot reach SSH.

The listener is bound only to the existing Docker proxy bridge gateway. Pangolin
publishes /_cicd/ on the existing OpsBrain HTTPS hostname; no new public TCP port
or SSH firewall rule is added. Requires the prior restricted receiver setup.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
CODE = Path('/usr/local/lib/dio-cicd')
CONFIG = Path('/etc/dio-cicd')
DYNAMIC = Path('/opt/pangolin/config/traefik/dynamic_config.yml')


def run(args):
    return subprocess.run([str(x) for x in args], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def write(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), 0, 0)
        output.write(data)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo in your private terminal')
    os.umask(0o077)
    import yaml
    if not (CODE / 'receiver.py').exists() or pwd.getpwnam('dio-deploy').pw_uid == 0:
        raise RuntimeError('Install the restricted receiver first')
    manifest = json.loads((HERE / 'webhook-manifest.json').read_text())
    source = (HERE / 'webhook.py').read_bytes()
    if hashlib.sha256(source).hexdigest() != manifest['sha256']:
        raise RuntimeError('Relay source checksum mismatch')
    secrets_file = HERE / 'webhook.env'
    values = secrets_file.read_text().splitlines() if secrets_file.exists() else (CONFIG / 'webhook.env').read_text().splitlines()
    keys = dict(line.split('=', 1) for line in values if line)
    if set(keys) != {'OPSBRAIN_DEPLOY_SECRET', 'EXPERTS_DEPLOY_SECRET'} or not all(re.fullmatch('[0-9a-f]{64}', key) for key in keys.values()):
        raise RuntimeError('Invalid private relay authentication configuration')
    network = json.loads(run(['docker', 'network', 'inspect', 'openbrain-proxy']))[0]
    gateway = next(entry['Gateway'] for entry in network['IPAM']['Config'] if ':' not in entry.get('Gateway', ''))
    if not ipaddress.ip_address(gateway).is_private:
        raise RuntimeError('The proxy bridge must have a private gateway')
    CONFIG.mkdir(mode=0o700, exist_ok=True)
    CONFIG.chmod(0o700)
    write(CONFIG / 'webhook.env', '\n'.join(name + '=' + value for name, value in keys.items()) + '\n')
    write(CODE / 'webhook.py', source.decode(), 0o644)
    unit = '''[Unit]
Description=DIO signed deployment relay (private proxy bridge)
After=network-online.target docker.service
Requires=docker.service

[Service]
User=dio-deploy
Group=dio-deploy
EnvironmentFile=/etc/dio-cicd/webhook.env
Environment=DEPLOY_BIND_ADDRESS=GATEWAY
ExecStart=/usr/bin/python3 -I /usr/local/lib/dio-cicd/webhook.py
Restart=on-failure
RestartSec=3
PrivateTmp=true
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
'''.replace('GATEWAY', gateway)
    # sudo must invoke the exact receiver; do not enable NoNewPrivileges or
    # a filesystem sandbox that hides the receiver's deployment paths.
    write(Path('/etc/systemd/system/dio-cicd-webhook.service'), unit, 0o644)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'dio-cicd-webhook.service'])
    run(['systemctl', 'restart', 'dio-cicd-webhook.service'])
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://' + gateway + ':8765/healthz', timeout=2) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError('Private deployment relay did not become healthy')
    # Test the actual proxy network before publishing any route.
    probe = "const r=await fetch('http://" + gateway + ":8765/healthz',{signal:AbortSignal.timeout(10000)});if(!r.ok)process.exit(2);"
    bridge_rule = False
    try:
        run(['docker', 'exec', 'pangolin-pangolin-1', 'node', '--input-type=module', '-e', probe])
    except subprocess.CalledProcessError:
        # If UFW blocks bridge-to-host traffic, allow only this private bridge
        # subnet to this private listener. Never widen public or SSH access.
        if not Path('/usr/sbin/ufw').exists() or not run(['/usr/sbin/ufw', 'status']).startswith('Status: active'):
            raise RuntimeError('The proxy bridge cannot reach its private relay; inspect host firewall policy')
        bridge = network.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + network['Id'][:12]
        subnet = next(entry['Subnet'] for entry in network['IPAM']['Config'] if ':' not in entry.get('Subnet', ''))
        if not re.fullmatch('[A-Za-z0-9_.-]+', bridge) or not ipaddress.ip_network(subnet).is_private:
            raise RuntimeError('Unexpected private proxy bridge configuration')
        run(['/usr/sbin/ufw', 'allow', 'in', 'on', bridge, 'from', subnet, 'to', gateway,
             'port', '8765', 'proto', 'tcp', 'comment', 'DIO private deployment relay'])
        bridge_rule = True
        run(['docker', 'exec', 'pangolin-pangolin-1', 'node', '--input-type=module', '-e', probe])
    original = DYNAMIC.read_bytes()
    config = yaml.safe_load(original) or {}
    http = config.setdefault('http', {})
    routers = http.setdefault('routers', {})
    for name, router in routers.items():
        if '/_cicd/' in str(router.get('rule', '')) and name != 'dio-cicd':
            raise RuntimeError('A different deployment route already exists')
    http.setdefault('services', {})['dio-cicd'] = {'loadBalancer': {'servers': [{'url': 'http://' + gateway + ':8765'}]}}
    routers['dio-cicd'] = {'rule': 'Host(`opsbrain.dautel.cloud`) && PathPrefix(`/_cicd/`)',
                          'entryPoints': ['websecure'], 'priority': 1000, 'service': 'dio-cicd',
                          'tls': {'certResolver': 'letsencrypt'}}
    backup = Path('/opt/dio-platform/proxy-backups') / ('before-ci-webhook-' + str(time.time_ns()) + '.yml')
    write(backup, original.decode())
    if DYNAMIC.read_bytes() != original:
        raise RuntimeError('Proxy configuration changed concurrently; inspect before retrying')
    pending = DYNAMIC.with_name('.dio-cicd.pending')
    write(pending, yaml.safe_dump(config, sort_keys=False))
    stat = DYNAMIC.stat()
    os.chown(pending, stat.st_uid, stat.st_gid)
    os.chmod(pending, stat.st_mode & 0o777)
    os.replace(pending, DYNAMIC)
    secrets_file.unlink(missing_ok=True)
    report = {'status': 'signed-https-relay-ready', 'bind_address': gateway + ':8765',
              'public_url': 'https://opsbrain.dautel.cloud/_cicd/', 'proxy_backup': str(backup),
              'relay_sha256': manifest['sha256'], 'ssh_firewall_changed': False,
              'private_bridge_firewall_rule_added': bridge_rule}
    write(Path('/var/lib/dio-cicd/webhook-installation.json'), json.dumps(report, indent=2) + '\n', 0o644)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('HTTPS deployment setup stopped: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
