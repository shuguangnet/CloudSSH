// Unit tests for the docker container upgrade path: inspect parsing, run-arg
// reconstruction, backup naming, and the full upgrade/rollback orchestration
// against a scripted fake exec (no SSH involved).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInspectOutput,
  buildRunArgsFromInspect,
  buildRunCommand,
  backupNameFor,
  performContainerUpgrade,
  inspectScript,
} from '../../standalone/docker.mjs';

const INSPECT_FIXTURE = {
  Name: '/webapp',
  Id: 'abc123',
  Config: {
    Image: 'nginx:1.25',
    Hostname: 'myhost',
    Domainname: '',
    User: '1000:1000',
    WorkingDir: '/srv',
    Env: ['PATH=/usr/bin', 'TOKEN=abc=def', 'EMPTY='],
    Labels: { 'com.example.app': 'web', 'com.example.empty': '' },
    Entrypoint: ['/docker-entrypoint.sh', '-e', 'flag'],
    Cmd: ['nginx', '-g', 'daemon off;'],
    Privileged: false,
  },
  HostConfig: {
    Privileged: false,
    PortBindings: {
      '80/tcp': [{ HostIp: '', HostPort: '8080' }],
      '443/tcp': [{ HostIp: '127.0.0.1', HostPort: '8443' }],
      '53/udp': [{ HostIp: '', HostPort: '' }], // auto-assigned: must be dropped
    },
    Binds: ['/data:/data:ro', 'webconf:/etc/nginx'],
    Devices: [{ PathOnHost: '/dev/ttyUSB0', PathInContainer: '/dev/ttyUSB0' }],
    ExtraHosts: ['db:10.0.0.2'],
    RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
    NetworkMode: 'bridge',
  },
  NetworkSettings: { Networks: { bridge: {}, frontend: {}, backend: {} } },
  State: { Running: true },
};

test('parseInspectOutput accepts arrays and tolerates prefixed warnings', () => {
  assert.equal(parseInspectOutput(null), null);
  assert.equal(parseInspectOutput(''), null);
  assert.equal(parseInspectOutput('not json'), null);
  const parsed = parseInspectOutput(`Warning: something\n${JSON.stringify([INSPECT_FIXTURE])}`);
  assert.equal(parsed.Name, '/webapp');
});

test('buildRunArgsFromInspect reconstructs run flags from inspect config', () => {
  const args = buildRunArgsFromInspect(INSPECT_FIXTURE, 'nginx:1.27');
  const joined = args.map((a) => ` ${a} `).join('');
  assert.equal(args[0], 'run');
  assert.ok(args.includes('-d'));
  assert.ok(args.includes('--name'));
  assert.ok(args.includes('webapp'));

  // env entries keep their exact K=V form (even with '=' inside the value)
  assert.ok(args.includes('-e') && args.includes('TOKEN=abc=def') && args.includes('EMPTY='));
  // ports: plain + host-ip binding, auto-assign dropped
  assert.ok(args.includes('-p') && args.includes('8080:80/tcp') && args.includes('127.0.0.1:8443:443/tcp'));
  assert.equal(joined.includes('53/udp'), false);
  // volumes: bind + named volume preserved verbatim
  assert.ok(args.includes('-v') && args.includes('/data:/data:ro') && args.includes('webconf:/etc/nginx'));
  // restart policy with retries
  assert.ok(args.includes('--restart') && args.includes('on-failure:5'));
  // networks: non-default attachments only
  assert.ok(args.includes('--network') && args.includes('frontend') && args.includes('backend'));
  assert.equal(joined.includes(' --network bridge '), false);
  // user / workdir / hostname
  assert.ok(args.includes('--user') && args.includes('1000:1000'));
  assert.ok(args.includes('--workdir') && args.includes('/srv'));
  assert.ok(args.includes('--hostname') && args.includes('myhost'));
  // multi-element entrypoint: first via --entrypoint, tail prepended to cmd
  const entryIndex = args.indexOf('--entrypoint');
  assert.equal(args[entryIndex + 1], '/docker-entrypoint.sh');
  const imageIndex = args.indexOf('nginx:1.27');
  assert.deepEqual(args.slice(imageIndex + 1), ['-e', 'flag', 'nginx', '-g', 'daemon off;']);
  // labels: with and without value
  assert.ok(args.includes('-l') && args.includes('com.example.app=web') && args.includes('com.example.empty='));
  // devices and extra hosts
  assert.ok(args.includes('--device') && args.includes('/dev/ttyUSB0:/dev/ttyUSB0'));
  assert.ok(args.includes('--add-host') && args.includes('db:10.0.0.2'));

  // shell quoting: every value survives as a single quoted argument
  const command = buildRunCommand(args);
  assert.ok(command.startsWith('docker '));
  // "daemon off;" contains a space and must be quoted in the command string
  assert.ok(command.includes("'daemon off;'"));
});

test('buildRunArgsFromInspect rejects hostile names and image refs', () => {
  for (const image of ['', 'nginx; rm -rf /', '$(id)', 'a b', 'x'.repeat(400), 'nginx..evil']) {
    assert.throws(() => buildRunArgsFromInspect(INSPECT_FIXTURE, image), /Invalid image/);
  }
  const hostile = JSON.parse(JSON.stringify(INSPECT_FIXTURE));
  hostile.Name = "/web'; rm -rf /";
  assert.throws(() => buildRunArgsFromInspect(hostile, 'nginx:1.27'), /Invalid container name/);
  assert.throws(() => buildRunArgsFromInspect(null, 'nginx:1.27'), /Invalid inspect/);
});

test('backupNameFor stays within the 128-char docker name limit', () => {
  const name = backupNameFor('webapp', Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.match(name, /^webapp-bak-20260102030405$/);
  const long = 'a'.repeat(120);
  const longBackup = backupNameFor(long);
  assert.ok(longBackup.length <= 128, longBackup);
  assert.ok(longBackup.startsWith('a'.repeat(109)));
});

function fakeExec(script, label) {
  // `script` maps a command (or /regex/) to { exitCode, stdout, stderr }.
  const calls = [];
  const exec = async (command, timeout) => {
    calls.push({ command, timeout });
    for (const key of Object.keys(script)) {
      const hit = key.startsWith('/') && key.endsWith('/')
        ? new RegExp(key.slice(1, -1)).test(command)
        : command.includes(key);
      if (hit) {
        const outcome = script[key];
        return typeof outcome === 'function' ? outcome() : { exitCode: 0, stdout: '', stderr: '', ...outcome };
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls, label };
}

function baseScript(extra = {}) {
  return {
    "docker inspect 'webapp'": { exitCode: 0, stdout: JSON.stringify([INSPECT_FIXTURE]) },
    'docker pull': { exitCode: 0 },
    'docker stop': { exitCode: 0 },
    'docker rename': { exitCode: 0 },
    '/^docker run -d/': { exitCode: 0 },
    '/\\.State\\.Running/': { exitCode: 0, stdout: 'true\n' },
    'docker logs': { exitCode: 0, stdout: 'log line\n' },
    ...extra,
  };
}

test('performContainerUpgrade happy path: stop → rename → run → verify → drop backup', async () => {
  const { exec, calls } = fakeExec(baseScript({ 'docker rm': { exitCode: 0 } }));
  const result = await performContainerUpgrade({ exec, container: 'webapp', image: 'nginx:1.27', keepBackup: false });
  assert.equal(result.ok, true);
  assert.equal(result.backupRemoved, true);
  assert.match(result.steps.join('\n'), /inspect: webapp/);
  assert.match(result.steps.join('\n'), /backup-removed/);
  const sequence = calls.map((call) => call.command.split(' ').slice(0, 2).join(' '));
  // strict ordering: no stop/run/rm before pull succeeded
  assert.ok(sequence.indexOf('docker pull') < sequence.indexOf('docker stop'));
  assert.ok(sequence.indexOf('docker rename') < sequence.indexOf('docker run'));
  assert.ok(sequence.indexOf('docker run') < calls.findIndex((call) => call.command.includes('.State.Running')));
  const rm = calls.find((call) => call.command.startsWith('docker rm '));
  assert.ok(rm && !rm.command.includes(' -f ')); // backup removal is rm, not rm -f
});

test('performContainerUpgrade keeps the backup when asked', async () => {
  const { exec, calls } = fakeExec(baseScript({ 'docker rm': { exitCode: 1, stderr: 'nope' } }));
  const result = await performContainerUpgrade({ exec, container: 'webapp', image: 'nginx:1.27', keepBackup: true });
  assert.equal(result.ok, true);
  assert.equal(result.keepBackup, true);
  assert.equal(calls.some((call) => call.command.startsWith('docker rm ')), false);
});

test('performContainerUpgrade aborts before any mutation when pull fails', async () => {
  const { exec, calls } = fakeExec(baseScript({ 'docker pull': { exitCode: 1, stderr: 'manifest unknown' } }));
  const result = await performContainerUpgrade({ exec, container: 'webapp', image: 'nginx:nope' });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'pull');
  assert.match(result.error, /manifest unknown/);
  assert.equal(calls.some((call) => /docker (stop|rename|run)/.test(call.command)), false);
});

test('performContainerUpgrade inspects the stopped case and skips docker stop', async () => {
  const fixture = JSON.parse(JSON.stringify(INSPECT_FIXTURE));
  fixture.State.Running = false;
  const { exec, calls } = fakeExec(baseScript({ "docker inspect 'webapp'": { exitCode: 0, stdout: JSON.stringify([fixture]) }, 'docker rm': { exitCode: 0 } }));
  const result = await performContainerUpgrade({ exec, container: 'webapp', image: 'nginx:1.27' });
  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.command.startsWith('docker stop')), false);
});

test('performContainerUpgrade rolls back when docker run fails', async () => {
  const { exec, calls } = fakeExec(baseScript({ '/^docker run -d/': { exitCode: 125, stderr: 'port already allocated' } }));
  const result = await performContainerUpgrade({ exec, container: 'webapp', image: 'nginx:1.27' });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.match(result.error, /port already allocated/);
  const commands = calls.map((call) => call.command);
  const runIndex = commands.findIndex((command) => command.startsWith('docker run '));
  const rollbackRm = commands.findIndex((command) => command.startsWith('docker rm -f '));
  const rollbackRename = commands.findIndex((command) => /^docker rename '[^']+' 'webapp'$/.test(command));
  const rollbackStart = commands.findIndex((command) => command.startsWith('docker start '));
  assert.ok(runIndex >= 0 && rollbackRm > runIndex, 'rollback rm -f after failed run');
  assert.ok(rollbackRename > runIndex, 'rollback rename restores original name');
  assert.ok(rollbackStart > rollbackRename, 'rollback restarts the original container');
});

test('performContainerUpgrade rolls back when the replacement never runs', async () => {
  const { exec, calls } = fakeExec(baseScript({ '/\\.State\\.Running/': { exitCode: 0, stdout: 'false\n' } }));
  const result = await performContainerUpgrade({ exec, container: 'webapp', image: 'nginx:broken' });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.match(result.logs, /log line/);
  const commands = calls.map((call) => call.command);
  const logsIndex = commands.findIndex((command) => command.startsWith('docker logs'));
  assert.ok(logsIndex >= 0, 'failure logs captured before rollback');
  assert.ok(commands.some((command) => command.startsWith('docker start ')));
});

test('inspectScript validates the container name', () => {
  assert.equal(inspectScript('webapp').command, "docker inspect 'webapp'");
  for (const evil of ['', 'x; id', 'a b', "a'b", '-dash']) {
    assert.throws(() => inspectScript(evil), /Invalid container/);
  }
});
