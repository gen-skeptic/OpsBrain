#!/usr/bin/env python3
"""One-time private sudo provisioning for the reviewed CI/CD receiver.

Place receiver.py and manifest.json beside this installer. The manifest contains
only two SSH public keys and the expected receiver checksum. Private deployment
keys belong in the corresponding GitHub production environment, never here.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
HOME = Path('/var/lib/dio-cicd')
CODE = Path('/usr/local/lib/dio-cicd')
USER = 'dio-deploy'


def write(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), 0, 0)
        output.write(content)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo in your private terminal.')
    os.umask(0o077)
    manifest = json.loads((HERE / 'manifest.json').read_text())
    receiver = (HERE / 'receiver.py').read_bytes()
    if hashlib.sha256(receiver).hexdigest() != manifest['receiver_sha256']:
        raise RuntimeError('Receiver checksum mismatch')
    if set(manifest['public_keys']) != {'opsbrain', 'experts'}:
        raise RuntimeError('Expected exactly two scoped public keys')
    for key in manifest['public_keys'].values():
        if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9_.@-]+)?', key):
            raise RuntimeError('Unexpected SSH public key')
    if not all(Path(p).is_file() for p in ['/usr/bin/sudo', '/usr/bin/python3', '/usr/sbin/visudo']):
        raise RuntimeError('Expected sudo, Python and visudo on the inspected Ubuntu VPS')
    for directory in ['/opt/dio-platform/opsbrain/deploy', '/opt/dio-platform/experts/deploy/dio']:
        for name in ['docker-compose.yml', 'vps.override.yml', '.env']:
            if not (Path(directory) / name).is_file():
                raise RuntimeError('Existing application deployment was not found')
    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        subprocess.run(['useradd', '--system', '--no-create-home', '--home-dir', str(HOME), '--shell', '/bin/sh', USER], check=True)
        account = pwd.getpwnam(USER)
    if account.pw_dir != str(HOME) or account.pw_uid == 0 or account.pw_shell != '/bin/sh':
        raise RuntimeError('Refusing to modify an unrelated existing account')
    if HOME.exists() and not (HOME / '.dio-cicd-managed').exists():
        raise RuntimeError('Deployment home already exists without our ownership marker')
    HOME.mkdir(exist_ok=True, mode=0o755)
    os.chown(HOME, 0, 0)
    HOME.chmod(0o755)
    write(HOME / '.dio-cicd-managed', 'Managed by deploy/cicd/install.py\n', 0o644)
    CODE.mkdir(parents=True, exist_ok=True, mode=0o755)
    CODE.chmod(0o755)
    os.chown(CODE, 0, 0)
    write(CODE / 'receiver.py', receiver.decode(), 0o644)
    subprocess.run(['/usr/bin/python3', '-I', '-m', 'py_compile', str(CODE / 'receiver.py')], check=True)
    ssh = HOME / '.ssh'
    ssh.mkdir(exist_ok=True, mode=0o755)
    os.chown(ssh, 0, 0)
    ssh.chmod(0o755)
    keys, commands = [], []
    for app, key in sorted(manifest['public_keys'].items()):
        command = '/usr/bin/python3 -I /usr/local/lib/dio-cicd/receiver.py ' + app
        keys.append('restrict,command="/usr/bin/sudo -n ' + command + '" ' + key)
        commands.append(command)
    write(ssh / 'authorized_keys', '\n'.join(keys) + '\n', 0o644)
    sudoers = Path('/etc/sudoers.d/dio-cicd')
    content = USER + ' ALL=(root) NOPASSWD: ' + ', '.join(commands) + '\n'
    pending = HERE / 'sudoers.pending'
    write(pending, content, 0o440)
    subprocess.run(['/usr/sbin/visudo', '-cf', str(pending)], check=True)
    if sudoers.exists() and sudoers.read_text() != content:
        raise RuntimeError('Existing deployment sudo policy differs; review before replacing')
    write(sudoers, content, 0o440)
    pending.unlink()
    status = HOME / 'status'
    status.mkdir(exist_ok=True, mode=0o755)
    status.chmod(0o755)
    report = {'status': 'provisioned', 'user': USER, 'receiver_sha256': manifest['receiver_sha256'],
              'scope': 'one fixed application per SSH key; no shell, PTY or forwarding',
              'private_keys_on_server': False}
    write(HOME / 'installation.json', json.dumps(report, indent=2) + '\n', 0o644)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('CI/CD provisioning stopped: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
