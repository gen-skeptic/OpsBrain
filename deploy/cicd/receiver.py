#!/usr/bin/env python3
"""Root-owned, forced-command receiver. Install explicitly; CI cannot replace it.

Input is a small JSON release descriptor on stdin, never a shell command or a
Compose file. Only fixed GHCR repositories and the existing service definitions
are used. Credentials, databases, networking and proxy settings stay on the VPS.
"""
import copy
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/dio-platform')
STATUS = Path('/var/lib/dio-cicd/status')
APPS = {
    'opsbrain': {'repository': 'gen-skeptic/OpsBrain', 'project': 'opsbrain',
                'directory': ROOT / 'opsbrain/deploy', 'services': ['opsbrain', 'para-export', 'dashboard'],
                'images': {'core': 'ghcr.io/gen-skeptic/opsbrain', 'dashboard': 'ghcr.io/gen-skeptic/opsbrain-dashboard'}},
    'experts': {'repository': 'gen-skeptic/experts', 'project': 'dio-agents',
               'directory': ROOT / 'experts/deploy/dio', 'services': ['dio-agents'],
               'images': {'app': 'ghcr.io/gen-skeptic/dio-agents'}},
}


def run(args, *, data=None):
    return subprocess.run([str(a) for a in args], input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True).stdout


def private_file(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(data.encode() if isinstance(data, str) else data)


def atomic(path, data):
    pending = path.with_name(path.name + '.pending')
    private_file(pending, data)
    os.replace(pending, path)


def compose(app, *args):
    config = APPS[app]
    directory = config['directory']
    command = ['docker', 'compose', '--project-name', config['project'], '--project-directory', directory,
               '-f', directory / 'docker-compose.yml', '-f', directory / 'vps.override.yml']
    if (directory / 'ci.override.yml').exists():
        command += ['-f', directory / 'ci.override.yml']
    command += ['--env-file', directory / '.env']
    if app == 'opsbrain':
        command += ['--profile', 'local-ai', '--profile', 'dashboard']
    return [str(x) for x in [*command, *args]]


def inspect(container):
    return json.loads(run(['docker', 'inspect', container]))[0]


def service(app, name):
    return inspect(run(compose(app, 'ps', '-q', name)).decode().strip())


def healthy(container, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        state = inspect(container)['State']
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        if state['Status'] in ['dead', 'exited']:
            raise RuntimeError('A release container exited before becoming healthy')
        time.sleep(3)
    raise RuntimeError('A release container did not become healthy in time')


def request(url, key=None):
    req = urllib.request.Request(url, headers={'x-brain-key': key} if key else {})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b''


def validate_payload(app, payload):
    if not isinstance(payload, dict) or set(payload) != {'commit', 'actor', 'token', 'run_id', 'run_number', 'digests'}:
        raise ValueError('Invalid release descriptor')
    if not re.fullmatch('[0-9a-f]{40}', payload['commit']):
        raise ValueError('Invalid commit')
    if not re.fullmatch(r'[a-zA-Z0-9_\[\]-]{1,100}', payload['actor']):
        raise ValueError('Invalid registry actor')
    if not isinstance(payload['token'], str) or not 20 <= len(payload['token']) <= 4096 or '\n' in payload['token']:
        raise ValueError('Invalid temporary registry credential')
    if not re.fullmatch('[0-9]{1,25}', payload['run_id']) or type(payload['run_number']) is not int or payload['run_number'] < 1:
        raise ValueError('Invalid workflow run')
    if set(payload['digests']) != set(APPS[app]['images']):
        raise ValueError('Unexpected image set')
    for digest in payload['digests'].values():
        if not re.fullmatch('sha256:[0-9a-f]{64}', digest):
            raise ValueError('Image must use an immutable digest')
    return {name: repository + '@' + payload['digests'][name] for name, repository in APPS[app]['images'].items()}


def load_images(app, payload, images):
    with tempfile.TemporaryDirectory(prefix='dio-registry-', dir=ROOT / 'ci') as folder:
        run(['docker', '--config', folder, 'login', 'ghcr.io', '-u', payload['actor'], '--password-stdin'],
            data=payload['token'].encode())
        for image in images.values():
            run(['docker', '--config', folder, 'pull', image])
            config = json.loads(run(['docker', 'image', 'inspect', image]))[0]
            labels = config['Config'].get('Labels') or {}
            if labels.get('org.opencontainers.image.revision') != payload['commit']:
                raise RuntimeError('Image revision does not match the tested commit')
            expected = 'https://github.com/' + APPS[app]['repository']
            if labels.get('org.opencontainers.image.source', '').lower().rstrip('/') != expected.lower():
                raise RuntimeError('Image repository does not match this deployment key')
    # The short-lived GitHub token and Docker login file are no longer needed.
    payload.pop('token', None)


def volume(container, destination):
    return next(m.get('Name') for m in container['Mounts'] if m['Destination'] == destination)


def deploy_opsbrain(images, backup, state):
    current = service('opsbrain', 'opsbrain')
    pg_volume = volume(service('opsbrain', 'db'), '/var/lib/postgresql/data')
    env = dict(item.split('=', 1) for item in current['Config']['Env'] if '=' in item)
    db_url = urllib.parse.urlsplit(env['DATABASE_URL'])
    user, database = urllib.parse.unquote(db_url.username), db_url.path.lstrip('/')
    if not all(re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*', value) for value in [user, database]):
        raise RuntimeError('Unexpected database identifiers')
    key = (ROOT / 'secrets/dio-web-harness-key').read_text().strip()
    fingerprint_sql = """SELECT json_build_object('records', count(*),
      'content_hash', md5(coalesce(string_agg(id::text || ':' || md5(content), ',' ORDER BY id), '')),
      'principals', (SELECT count(*) FROM ops_principals),
      'keys', (SELECT count(*) FROM ops_principal_keys)) FROM thoughts"""

    def psql(db, sql):
        return run(compose('opsbrain', 'exec', '-T', 'db', 'psql', '-X', '-qAt', '-U', user,
                           '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql)).decode().strip()

    scratch = 'dio_ci_' + str(time.time_ns())
    scratch_container = scratch.replace('_', '-')
    scratch_env, live_env = backup / 'rehearsal.env', backup / 'migration.env'
    scratch_created = False
    state['paused'] = True
    run(compose('opsbrain', 'stop', 'para-export', 'opsbrain'))
    try:
        before = json.loads(psql(database, fingerprint_sql))
        dump = backup / 'database.dump'
        with dump.open('wb') as output:
            subprocess.run(compose('opsbrain', 'exec', '-T', 'db', 'pg_dump', '-U', user, '-Fc', database),
                           stdout=output, stderr=subprocess.PIPE, check=True)
        os.chmod(dump, 0o600)
        run(compose('opsbrain', 'exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', scratch))
        scratch_created = True
        with dump.open('rb') as source:
            subprocess.run(compose('opsbrain', 'exec', '-T', 'db', 'pg_restore', '-U', user,
                                   '--no-owner', '--no-privileges', '-d', scratch),
                           stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        common = '\nEMBEDDING_DIM=' + env.get('EMBEDDING_DIM', '768') + '\nEMBEDDING_PROVIDER=none\nOPSBRAIN_UI_ENABLED=false\n'
        scratch_url = urllib.parse.urlunsplit(db_url._replace(path='/' + scratch))
        private_file(scratch_env, 'DATABASE_URL=' + scratch_url + common + 'VERIFY_MCP_KEY=' + key + '\n')
        run(['docker', 'run', '--rm', '--network', 'opsbrain_default', '--env-file', scratch_env, images['core'], 'task', 'migrate'])
        if json.loads(psql(scratch, fingerprint_sql)) != before:
            raise RuntimeError('Rehearsal changed existing record contents or identity counts')
        run(['docker', 'run', '-d', '--name', scratch_container, '--network', 'opsbrain_default',
             '--env-file', scratch_env, current['Image']])
        healthy(scratch_container, 120)
        compat = r"""const r=await fetch('http://127.0.0.1:8787/mcp',{method:'POST',headers:{'x-opsbrain-key':Deno.env.get('VERIFY_MCP_KEY'),'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_record',arguments:{id:'3581d274-ee6f-411f-8235-d99e384e2802'}}})});
const t=await r.text();const result=JSON.parse(t.trim().startsWith('{')?t:t.split('\n').find(l=>l.startsWith('data:')).slice(5));if(!r.ok||result.error||result.result.isError)Deno.exit(1);"""
        run(['docker', 'exec', scratch_container, 'deno', 'eval', compat])
        if json.loads(psql(database, fingerprint_sql)) != before:
            raise RuntimeError('Database changed while writes were paused')
        private_file(live_env, 'DATABASE_URL=' + env['DATABASE_URL'] + common)
        run(['docker', 'run', '--rm', '--network', 'opsbrain_default', '--env-file', live_env, images['core'], 'task', 'migrate'])
        if json.loads(psql(database, fingerprint_sql)) != before:
            raise RuntimeError('Live migration changed existing record contents or identity counts')
        state['database_backup'] = str(dump)
        state['database_backup_sha256'] = hashlib.sha256(dump.read_bytes()).hexdigest()
        state['records_before'] = before['records']
        state['migration_rehearsal'] = 'passed'
        state['previous_runtime_compatibility'] = 'passed'
        state['database_volume'] = pg_volume
    finally:
        subprocess.run(['docker', 'rm', '-f', scratch_container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if scratch_created:
            subprocess.run(compose('opsbrain', 'exec', '-T', 'db', 'dropdb', '-U', user, '--if-exists', '--force', scratch),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        scratch_env.unlink(missing_ok=True)
        live_env.unlink(missing_ok=True)


def check_opsbrain(state):
    for name in ['opsbrain', 'dashboard']:
        healthy(service('opsbrain', name)['Id'])
    if volume(service('opsbrain', 'db'), '/var/lib/postgresql/data') != state['database_volume']:
        raise RuntimeError('Database volume changed')
    owner_key = (ROOT / 'secrets/erich-opsbrain-key').read_text().strip()
    service_key = (ROOT / 'secrets/dio-web-harness-key').read_text().strip()
    for key, expected in [(owner_key, 200), (None, 401), (service_key, 403)]:
        if request('http://127.0.0.1:8787/open-brain-rest/health', key)[0] != expected:
            raise RuntimeError('REST authentication check failed')
    record_id = '3581d274-ee6f-411f-8235-d99e384e2802'
    status, body = request('http://127.0.0.1:8787/open-brain-rest/thought/' + record_id, owner_key)
    if status != 200 or json.loads(body).get('id') != record_id:
        raise RuntimeError('Existing memory readback failed')
    for url in ['https://opsbrain.dautel.cloud/healthz', 'https://opsbrain-dash.dautel.cloud/login']:
        if request(url)[0] != 200:
            raise RuntimeError('Public HTTPS check failed')
    state['human_auth_and_agent_refusal'] = 'passed'
    state['existing_memory_readback'] = 'passed'


def check_experts(state, commit):
    current = service('experts', 'dio-agents')
    healthy(current['Id'])
    if volume(current, '/data') != state['conversation_volume']:
        raise RuntimeError('Conversation volume changed')
    script = """import {readFileSync} from 'node:fs';import {loadConfig} from './build/server/config.js';import {McpHub} from './build/server/mcp.js';
const m=JSON.parse(readFileSync('./build/data/manual.json','utf8'));if(!m.source.includes(process.argv[1].slice(0,7)))process.exit(2);
const h=new McpHub(loadConfig().mcp);await h.tools(['opsbrain']);const r=await h.call('mcp__opsbrain__whoami',{acting_as:'dio-quality-reviewer'},AbortSignal.timeout(15000));if(r.isError)process.exit(3);process.exit(0);"""
    run(compose('experts', 'exec', '-T', 'dio-agents', 'node', '--input-type=module', '-e', script, commit))
    if request('https://dio.dautel.cloud/healthz')[0] != 200:
        raise RuntimeError('Experts public HTTPS check failed')
    state['delegated_memory_connection'] = 'passed'


def deploy(app, payload, images):
    config = APPS[app]
    path = config['directory'] / 'ci.override.yml'
    old = path.read_bytes() if path.exists() else None
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + payload['commit'][:12] + '-' + payload['run_id']
    backup = ROOT / 'ci/backups' / app / stamp
    backup.mkdir(parents=True, mode=0o700)
    if old is not None:
        private_file(backup / 'ci.override.yml', old)
    private_file(backup / 'previous-config.json', json.dumps({'had_ci_override': old is not None}))
    state = {'application': app, 'repository': config['repository'], 'commit': payload['commit'],
             'run_id': payload['run_id'], 'run_number': payload['run_number'], 'images': images,
             'backup_directory': str(backup), 'paused': False, 'switched': False}
    try:
        if app == 'opsbrain':
            deploy_opsbrain(images, backup, state)
            overrides = {'opsbrain': {'image': images['core']}, 'para-export': {'image': images['core']},
                         'dashboard': {'image': images['dashboard']}}
        else:
            current = service(app, 'dio-agents')
            state['conversation_volume'] = volume(current, '/data')
            if not state['conversation_volume']:
                raise RuntimeError('Missing persistent conversation volume')
            overrides = {'dio-agents': {'image': images['app']}}
        if (path.read_bytes() if path.exists() else None) != old:
            raise RuntimeError('Deployment override changed concurrently')
        state['switched'] = True
        atomic(path, json.dumps({'services': overrides}, indent=2) + '\n')
        run(compose(app, 'config', '--quiet'))
        run(compose(app, 'up', '-d', '--no-build', *config['services']))
        if app == 'opsbrain':
            check_opsbrain(state)
        else:
            check_experts(state, payload['commit'])
        state['paused'] = False
        state['status'] = 'healthy'
    except BaseException:
        if state['switched']:
            if old is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, old)
        if state['paused'] or state['switched']:
            try:
                run(compose(app, 'up', '-d', '--no-build', *config['services']))
                for name in ['opsbrain', 'dashboard'] if app == 'opsbrain' else ['dio-agents']:
                    healthy(service(app, name)['Id'])
                state['rollback'] = 'previous-images-healthy'
            except Exception:
                state['rollback'] = 'needs-operator-attention'
        state['status'] = 'failed'
        save_status(app + '-last-failure', state)
        raise
    state.pop('paused', None)
    state.pop('switched', None)
    save_status(app, state)
    return state


def save_status(name, state):
    state['checked_at'] = datetime.now(timezone.utc).isoformat()
    STATUS.mkdir(parents=True, exist_ok=True, mode=0o755)
    path = STATUS / (name + '.json')
    atomic(path, json.dumps(state, indent=2) + '\n')
    path.chmod(0o644)  # Deliberately sanitized; no credentials, content or raw logs.


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in APPS:
        raise ValueError('Use the installed forced-command deployment key')
    os.umask(0o077)
    app = sys.argv[1]
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise ValueError('Release descriptor too large')
    payload = json.loads(raw)
    if payload == {'probe': True}:
        print(json.dumps({'application': app, 'access': 'forced-command-only', 'receiver': 'ready'}))
        return
    images = validate_payload(app, payload)
    (ROOT / 'ci').mkdir(parents=True, exist_ok=True, mode=0o700)
    with open('/run/lock/dio-cicd.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        prior_path = STATUS / (app + '.json')
        prior = json.loads(prior_path.read_text()) if prior_path.exists() else {}
        if prior.get('run_number', 0) > payload['run_number']:
            raise ValueError('Refusing a stale workflow run; use the current main workflow')
        load_images(app, payload, images)
        result = deploy(app, payload, images)
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    for signum in [signal.SIGTERM, signal.SIGHUP]:
        signal.signal(signum, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        # Never expose captured subprocess output or the stdin credential.
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
        print('Deployment failed: ' + message, file=sys.stderr)
        sys.exit(1)
