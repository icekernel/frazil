// The stack CLI against a stub `docker` on PATH, in a throwaway checkout, HOME
// and state dir. The stub logs every call, one line of tab-separated arguments,
// and answers from files named by the STUB_* variables. No docker daemon is
// needed. Run with `node --test 'tools/stack/*.test.ts'`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = process.env['FRAZIL_CLI']
  ? path.resolve(process.env['FRAZIL_CLI'])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');

const STUB = `#!/usr/bin/env bash
(IFS=$'\\t'; printf '%s\\n' "$*") >> "$STUB_LOG"
env | grep -E '^(COMPOSE_PROJECT_NAME|FRAZIL_|DEMO_)' | sort | tr '\\n' ' ' >> "$STUB_LOG.env"
echo >> "$STUB_LOG.env"
case "$1 $2" in
  "volume ls") cat "$STUB_VOLUMES" 2>/dev/null ;;
  "buildx du") cat "$STUB_DU" 2>/dev/null ;;
  "ps "*) cat "$STUB_PS" 2>/dev/null ;;
  "--version "*|"version "*) echo "Docker version 29.8.1" ;;
esac
if printf '%s' "$*" | grep -q 'compose.* version'; then echo 'v5.5.1'; fi
if printf '%s' "$*" | grep -q 'DIGEST'; then
  n=$(cat "$STUB_LOG.digest" 2>/dev/null || echo 0); echo $((n+1)) > "$STUB_LOG.digest"
  if [ -n "$STUB_DIGEST_CHANGES" ]; then echo "digest-$n"; else echo digest-same; fi
fi
if printf '%s' "$*" | grep -q 'RUNFAIL'; then exit 3; fi
if [ "$1 $2" = "volume rm" ] && [ -n "$STUB_RM_FAILS" ] && [ "$3" = "$STUB_RM_FAILS" ]; then
  echo "volume is in use" >&2; exit 1
fi
if [ "$1" = compose ]; then
  answer=$(head -c 1 2>/dev/null || true)
  if [ -n "$answer" ]; then echo "stdin:$answer" >> "$STUB_LOG"; fi
fi
exit 0
`;

const BASE_PORT = 41000 + (process.pid % 500) * 2;

const CONFIG = {
  prefix: 'demo',
  envFiles: ['~/.config/demo/env', '.env'],
  ports: { DEMO_PORT: BASE_PORT },
  image: { var: 'DEMO_TAG', inputs: ['lock'] },
  volumes: { derived: ['cache'], data: ['db'], shared: ['models'], retired: ['retired'], marker: ['retired'] },
  store: { cacheId: 'demo-store', target: '/store' },
  requiredEnv: ['DEMO_TOKEN'],
  addresses: { url: 'http://localhost:${DEMO_PORT}', db: 'postgres://h:${DEMO_PORT}/x' },
  test: {
    vars: { RUN_DB: 'run_{run}' },
    prepare: [['up', '-d', '--wait']],
    digest: ['exec', 'db', 'DIGEST'],
    before: [['exec', 'db', 'create', '${RUN_DB}']],
    run: ['run', '--rm', 'tests'],
    after: [['exec', 'db', 'drop', '${RUN_DB}']],
    onFailure: [['logs', 'app']],
  },
};

interface Opts {
  dir?: string;
  env?: string;
  home?: string;
  config?: unknown;
  sandbox?: Sandbox;
}

class Sandbox {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frazil-cli-')));
  homeDir = path.join(this.root, 'home');
  bin = path.join(this.root, 'bin');
  log = path.join(this.root, 'docker.log');
  volumes = path.join(this.root, 'volumes');
  ps = path.join(this.root, 'ps');
  du = path.join(this.root, 'du');
  constructor() {
    fs.mkdirSync(this.homeDir);
    fs.mkdirSync(this.bin);
    fs.writeFileSync(path.join(this.bin, 'docker'), STUB, { mode: 0o755 });
  }
  checkout({ dir = 'repo', env, home, config = CONFIG }: Opts = {}): string {
    const repo = path.join(this.root, dir);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'frazil.config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(repo, 'lock'), 'v1\n');
    if (env !== undefined) fs.writeFileSync(path.join(repo, '.env'), env);
    if (home !== undefined) {
      fs.mkdirSync(path.dirname(this.homeFile), { recursive: true });
      fs.writeFileSync(this.homeFile, home, { mode: 0o600 });
    }
    return repo;
  }
  get homeFile(): string {
    return path.join(this.homeDir, '.config', 'demo', 'env');
  }
  run(repo: string, args: string[], extra: Record<string, string> = {}, input = '') {
    fs.rmSync(this.log, { force: true });
    fs.rmSync(`${this.log}.env`, { force: true });
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        HOME: this.homeDir,
        XDG_STATE_HOME: path.join(this.root, 'state'),
        PATH: `${this.bin}:${process.env['PATH']}`,
        STUB_LOG: this.log,
        STUB_VOLUMES: this.volumes,
        STUB_PS: this.ps,
        STUB_DU: this.du,
        ...extra,
      },
    });
    const lines = fs.existsSync(this.log) ? fs.readFileSync(this.log, 'utf8').split('\n') : [];
    const envs = fs.existsSync(`${this.log}.env`) ? fs.readFileSync(`${this.log}.env`, 'utf8') : '';
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      envs,
      calls: lines.filter(Boolean).map((l) => l.split('\t')),
      compose: lines
        .filter((l) => l.startsWith('compose\t'))
        .map((l) => l.split('\t').slice(1)),
    };
  }
  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

function withBox(fn: (box: Sandbox) => void | Promise<void>) {
  return async () => {
    const box = new Sandbox();
    try {
      await fn(box);
    } finally {
      box.cleanup();
    }
  };
}

// --- The env files, on each of the four ways the tool reaches compose
// (the 17 env-file cases of the wrapper this tool replaced).

const STATES = [
  { name: 'neither file', files: {}, prefix: () => [] as string[] },
  { name: '.env only', files: { env: 'A=repo\n' }, prefix: () => ['--env-file', '.env'] },
  { name: 'home file only', files: { home: 'A=home\n' }, prefix: (h: string) => ['--env-file', h] },
  {
    name: 'both, home file first',
    files: { env: 'A=repo\n', home: 'A=home\n' },
    prefix: (h: string) => ['--env-file', h, '--env-file', '.env'],
  },
];

const CALLS = [
  { name: 'up', args: ['up', '-d'], expect: ['up', '-d'] },
  { name: 'down -v', args: ['down', '-v'], expect: ['down', '-v'] },
  { name: 'down', args: ['down'], expect: ['down'] },
  { name: 'anything else', args: ['compose', 'config'], expect: ['config'] },
];

for (const state of STATES) {
  for (const call of CALLS) {
    test(
      `${state.name}: ${call.name}`,
      withBox((box) => {
        const repo = box.checkout(state.files);
        const got = box.run(repo, call.args);
        assert.equal(got.status, 0, got.stderr);
        const pre = state.prefix(box.homeFile).map((a) => (a === '.env' ? path.join(repo, '.env') : a));
        assert.deepEqual(got.compose, [[...pre, ...call.expect]]);
      }),
    );
  }
}

test(
  'a home path that is a directory is not passed',
  withBox((box) => {
    const repo = box.checkout();
    fs.mkdirSync(box.homeFile, { recursive: true });
    assert.deepEqual(box.run(repo, ['compose', 'config']).compose, [['config']]);
  }),
);

// --- Names.

test(
  'the project comes from the dir, capitals and a dot included',
  withBox((box) => {
    const repo = box.checkout({ dir: 'ABC-01-Probe.x' });
    const got = box.run(repo, ['up', '-d']);
    assert.match(got.envs, /COMPOSE_PROJECT_NAME=demo-abc-01-probex /);
    assert.match(got.envs, new RegExp(`FRAZIL_CHECKOUT=${repo} `));
  }),
);

test(
  '--stack names the stack and is remembered for the checkout',
  withBox((box) => {
    const repo = box.checkout();
    box.run(repo, ['--stack', 'Other', 'up']);
    assert.match(box.run(repo, ['up']).envs, /COMPOSE_PROJECT_NAME=demo-other /);
  }),
);

test(
  'two checkouts cannot hold one stack name',
  withBox((box) => {
    const a = box.checkout({ dir: 'x/same' });
    const b = box.checkout({ dir: 'y/same' });
    assert.equal(box.run(a, ['up']).status, 0);
    const got = box.run(b, ['up']);
    assert.notEqual(got.status, 0);
    assert.match(got.stderr, /already belongs to/);
    assert.match(got.stderr, /--stack/);
  }),
);

// --- Two stacks.

test(
  'two checkouts get different ports and stack files',
  withBox((box) => {
    const a = box.checkout({ dir: 'a' });
    const b = box.checkout({ dir: 'b' });
    box.run(a, ['up']);
    box.run(b, ['up']);
    const fa = JSON.parse(fs.readFileSync(path.join(a, '.frazil.json'), 'utf8'));
    const fb = JSON.parse(fs.readFileSync(path.join(b, '.frazil.json'), 'utf8'));
    assert.equal(fa.project, 'demo-a');
    assert.equal(fb.project, 'demo-b');
    assert.equal(fa.slot, 0);
    assert.equal(fb.slot, 1);
    assert.equal(fa.ports.DEMO_PORT, BASE_PORT);
    assert.equal(fb.ports.DEMO_PORT, BASE_PORT + 100);
    assert.equal(fa.addresses.url, `http://localhost:${BASE_PORT}`);
    assert.equal(fb.addresses.db, `postgres://h:${BASE_PORT + 100}/x`);
  }),
);

test(
  'a stack keeps its slot across runs',
  withBox((box) => {
    const a = box.checkout({ dir: 'a' });
    const b = box.checkout({ dir: 'b' });
    box.run(a, ['up']);
    box.run(b, ['up']);
    box.run(a, ['down']);
    box.run(a, ['up']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(a, '.frazil.json'), 'utf8')).slot, 0);
  }),
);

test(
  'a slot whose port something else holds is skipped',
  withBox(async (box) => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(BASE_PORT, '0.0.0.0', r));
    try {
      const repo = box.checkout();
      box.run(repo, ['up']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.frazil.json'), 'utf8')).slot, 1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }),
);

test(
  'a stack named as the prefix takes slot 0 even while the old project holds its ports',
  withBox(async (box) => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(BASE_PORT, '0.0.0.0', r));
    try {
      const repo = box.checkout({ dir: 'demo' });
      box.run(repo, ['up']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.frazil.json'), 'utf8')).slot, 0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }),
);

// --- up and down.

test(
  'up never installs: no run, no pnpm, across two ups',
  withBox((box) => {
    const repo = box.checkout();
    for (let i = 0; i < 2; i++) {
      const got = box.run(repo, ['up', '-d']);
      assert.deepEqual(got.compose, [['up', '-d']]);
      assert.ok(!got.calls.flat().includes('pnpm'));
    }
  }),
);

test(
  'up sets the image tag from the inputs',
  withBox((box) => {
    const repo = box.checkout();
    assert.match(box.run(repo, ['up']).envs, /DEMO_TAG=[0-9a-f]{16} /);
  }),
);

test(
  'up creates the shared volume outside any project',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['up']);
    assert.ok(got.calls.some((c) => c.join(' ') === 'volume create models'));
  }),
);

test(
  'down removes derived volumes by the real project name and keeps data',
  withBox((box) => {
    const repo = box.checkout({ dir: 'Some.Dir' });
    const rm = box.run(repo, ['down']).calls.filter((c) => c[0] === 'volume' && c[1] === 'rm');
    assert.deepEqual(rm, [['volume', 'rm', '--force', 'demo-somedir_cache']]);
  }),
);

test(
  'down -v leaves removal to compose',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['down', '--volumes']);
    assert.deepEqual(got.calls.filter((c) => c[1] === 'rm'), []);
  }),
);

test(
  'reset is down -v, then up -d --wait',
  withBox((box) => {
    const repo = box.checkout();
    assert.deepEqual(box.run(repo, ['reset']).compose, [['down', '-v'], ['up', '-d', '--wait']]);
  }),
);

test(
  'a failing compose call fails the tool with its code',
  withBox((box) => {
    const repo = box.checkout();
    assert.equal(box.run(repo, ['compose', 'RUNFAIL']).status, 3);
  }),
);

test(
  'no config is a clear error',
  withBox((box) => {
    const got = box.run(box.root, ['up']);
    assert.notEqual(got.status, 0);
    assert.match(got.stderr, /frazil\.config\.json/);
  }),
);

// Compose asks "Recreate (data will be lost)?" when a volume's labels differ, as
// for one made before the labels or a moved checkout. With no stdin it declines.
for (const args of [['up', '-d'], ['reset'], ['compose', 'up'], ['compose', 'run', 'x']]) {
  test(
    `${args.join(' ')} gives compose no stdin to answer with`,
    withBox((box) => {
      const repo = box.checkout();
      const got = box.run(repo, args, {}, 'y\n');
      assert.ok(!got.calls.flat().some((a) => a.startsWith('stdin:')));
    }),
  );
}

test(
  'compose exec keeps stdin, for a restore piped in',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['compose', 'exec', '-T', 'db', 'restore'], {}, 'y\n');
    assert.ok(got.calls.flat().includes('stdin:y'));
  }),
);

// --- test: a per-run variable, steps around the run, the digest.

test(
  'test runs before, run, after, with the run variable, digest around them',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['test']);
    assert.equal(got.status, 0, got.stderr);
    const c = got.compose.slice(1);
    assert.deepEqual(got.compose[0], ['up', '-d', '--wait']);
    assert.deepEqual(c[0], ['exec', 'db', 'DIGEST']);
    assert.match(c[1]!.join(' '), /^exec db create run_[0-9a-z]+$/);
    assert.deepEqual(c[2], ['run', '--rm', 'tests']);
    assert.equal(c[3]!.join(' '), c[1]!.join(' ').replace('create', 'drop'));
    assert.deepEqual(c[4], ['exec', 'db', 'DIGEST']);
  }),
);

test(
  'test runs the after steps when the run fails, and fails with its code',
  withBox((box) => {
    const config = { ...CONFIG, test: { ...CONFIG.test, run: ['RUNFAIL'] } };
    const repo = box.checkout({ config });
    const got = box.run(repo, ['test']);
    assert.equal(got.status, 3);
    const drop = got.compose.findIndex((c) => c[1] === 'db' && c[2] === 'drop');
    const logs = got.compose.findIndex((c) => c[0] === 'logs');
    assert.ok(logs >= 0 && logs < drop, 'onFailure runs before the after steps');
  }),
);

test(
  'test creates the shared volume before any step',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['test']);
    const create = got.calls.findIndex((c) => c.join(' ') === 'volume create models');
    const firstCompose = got.calls.findIndex((c) => c[0] === 'compose');
    assert.ok(create >= 0 && create < firstCompose);
  }),
);

test(
  'test fails when the digest changed',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['test'], { STUB_DIGEST_CHANGES: '1' });
    assert.equal(got.status, 1);
    assert.match(got.stderr, /digest changed/);
  }),
);

// --- status.

const vol = (name: string, labels: Record<string, string>) =>
  JSON.stringify({ Name: name, Labels: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',') });

test(
  'status --json lists every stack with its checkout and slot',
  withBox((box) => {
    const a = box.checkout({ dir: 'a' });
    const b = box.checkout({ dir: 'b' });
    box.run(a, ['up']);
    box.run(b, ['up']);
    fs.writeFileSync(
      box.ps,
      JSON.stringify({
        State: 'running',
        Status: 'Up 1 minute (healthy)',
        Labels: 'com.docker.compose.project=demo-a,com.docker.compose.service=db',
      }) + '\n',
    );
    const got = JSON.parse(box.run(a, ['status', '--json']).stdout);
    const names = got.stacks.map((s: { project: string }) => s.project).sort();
    assert.deepEqual(names, ['demo-a', 'demo-b']);
    const sa = got.stacks.find((s: { project: string }) => s.project === 'demo-a');
    assert.equal(sa.checkout, a);
    assert.equal(sa.services[0].service, 'db');
    assert.equal(sa.services[0].health, 'healthy');
  }),
);

test(
  'status lists each stack volumes, and the store with its size',
  withBox((box) => {
    const a = box.checkout({ dir: 'a' });
    box.run(a, ['up']);
    fs.writeFileSync(
      box.volumes,
      [
        vol('demo-a_db', { 'com.docker.compose.project': 'demo-a' }),
        vol('other_db', { 'com.docker.compose.project': 'other' }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      box.du,
      [
        JSON.stringify({ Description: 'cached mount with id "/demo-store"', Size: '577.3MB' }),
        JSON.stringify({ Description: 'cached mount with id "/another"', Size: '1GB' }),
      ].join('\n') + '\n',
    );
    const got = JSON.parse(box.run(a, ['status', '--json']).stdout);
    assert.deepEqual(got.stacks[0].volumes, ['demo-a_db']);
    assert.deepEqual(got.store, { cacheId: 'demo-store', path: '/store', sizes: ['577.3MB'] });
    const text = box.run(a, ['status']).stdout;
    assert.match(text, /demo-a_db/);
    assert.match(text, /\/store/);
    assert.match(text, /577\.3MB/);
  }),
);

// --- prune.

function pruneVolumes(box: Sandbox, live: string): void {
  const lines = [
    vol('demo-gone_cache', {
      'com.docker.compose.project': 'demo-gone',
      'dev.frazil.checkout': path.join(box.root, 'no-such-dir'),
    }),
    vol('demo-gone_db', {
      'com.docker.compose.project': 'demo-gone',
      'dev.frazil.checkout': path.join(box.root, 'no-such-dir'),
    }),
    vol('demo-live_db', { 'com.docker.compose.project': 'demo-live', 'dev.frazil.checkout': live }),
    vol('old_db', { 'com.docker.compose.project': 'old' }),
    vol('old_retired', { 'com.docker.compose.project': 'old' }),
    vol('stranger_db', { 'com.docker.compose.project': 'stranger' }),
    vol('demo_db', { 'com.docker.compose.project': 'demo' }),
    // Labelled before the rename to frazil (DEC-151 D3): still traced.
    vol('demo-gone_retired', {
      'com.docker.compose.project': 'demo-gone',
      'dev.stack.checkout': path.join(box.root, 'no-such-dir'),
    }),
    vol('unrelated', { 'com.docker.compose.project': 'other' }),
  ];
  fs.writeFileSync(box.volumes, lines.join('\n') + '\n');
}

// A failed `rm` is logged too; the stub refuses only STUB_RM_FAILS.
const removed = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'volume' && c[1] === 'rm').map((c) => c.at(-1)).sort();

test(
  'prune is a dry run by default',
  withBox((box) => {
    const repo = box.checkout();
    pruneVolumes(box, repo);
    const got = box.run(repo, ['prune']);
    assert.deepEqual(removed(got.calls), []);
    assert.match(got.stdout, /demo-gone_cache/);
    assert.match(got.stdout, /old_db/);
    assert.doesNotMatch(got.stdout, /demo-live_db/);
    assert.doesNotMatch(got.stdout, /unrelated/);
    assert.doesNotMatch(got.stdout, /stranger_db/);
    assert.doesNotMatch(got.stdout, /demo_db/);
  }),
);

test(
  'prune --yes removes only an orphan project derived volumes',
  withBox((box) => {
    const repo = box.checkout();
    pruneVolumes(box, repo);
    assert.deepEqual(removed(box.run(repo, ['prune', '--yes']).calls), [
      'demo-gone_cache',
      'demo-gone_retired',
    ]);
  }),
);

test(
  'prune --yes --data also removes an orphan data volumes',
  withBox((box) => {
    const repo = box.checkout();
    pruneVolumes(box, repo);
    assert.deepEqual(removed(box.run(repo, ['prune', '--yes', '--data']).calls), [
      'demo-gone_cache',
      'demo-gone_db',
      'demo-gone_retired',
    ]);
  }),
);

test(
  'prune --yes --data --unknown adds volumes no checkout can be traced for',
  withBox((box) => {
    const repo = box.checkout();
    pruneVolumes(box, repo);
    assert.deepEqual(removed(box.run(repo, ['prune', '--yes', '--data', '--unknown']).calls), [
      'demo-gone_cache',
      'demo-gone_db',
      'demo-gone_retired',
      'old_db',
      'old_retired',
    ]);
  }),
);

test(
  'prune never stops a project it cannot trace, and survives a volume in use',
  withBox((box) => {
    const repo = box.checkout();
    pruneVolumes(box, repo);
    const got = box.run(repo, ['prune', '--yes', '--data', '--unknown'], { STUB_RM_FAILS: 'old_db' });
    assert.equal(got.status, 1);
    assert.match(got.stderr, /old_db/);
    const stopped = got.calls.filter((c) => c[0] === 'compose' && c.includes('down'));
    assert.deepEqual(stopped.map((c) => c[2]), ['demo-gone']);
    assert.deepEqual(removed(got.calls).includes('old_retired'), true);
  }),
);

test(
  'prune frees the slot of a checkout that is gone',
  withBox((box) => {
    const a = box.checkout({ dir: 'a' });
    const b = box.checkout({ dir: 'b' });
    box.run(a, ['up']);
    box.run(b, ['up']);
    fs.rmSync(b, { recursive: true });
    box.run(a, ['prune', '--yes']);
    const c = box.checkout({ dir: 'c' });
    box.run(c, ['up']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c, '.frazil.json'), 'utf8')).slot, 1);
  }),
);

// --- doctor.

test(
  'doctor passes on a good setup and prints no value',
  withBox((box) => {
    const repo = box.checkout({ home: 'DEMO_TOKEN=s3cret\n' });
    const got = box.run(repo, ['doctor']);
    assert.equal(got.status, 0, got.stdout + got.stderr);
    assert.doesNotMatch(got.stdout, /s3cret/);
  }),
);

test(
  'doctor fails on a missing required variable',
  withBox((box) => {
    const repo = box.checkout({ home: 'OTHER=1\n' });
    const got = box.run(repo, ['doctor']);
    assert.equal(got.status, 1);
    assert.match(got.stdout, /DEMO_TOKEN/);
  }),
);

test(
  'doctor fails on a home env file readable by others',
  withBox((box) => {
    const repo = box.checkout({ home: 'DEMO_TOKEN=1\n' });
    fs.chmodSync(box.homeFile, 0o644);
    const got = box.run(repo, ['doctor']);
    assert.equal(got.status, 1);
    assert.match(got.stdout, /600/);
  }),
);

test(
  'doctor reports a port held by something else',
  withBox(async (box) => {
    const server = net.createServer();
    const held = BASE_PORT + 1;
    await new Promise<void>((r) => server.listen(held, '0.0.0.0', r));
    try {
      const config = { ...CONFIG, ports: { DEMO_PORT: held } };
      const repo = box.checkout({ config, home: 'DEMO_TOKEN=1\n' });
      fs.mkdirSync(path.join(box.root, 'state', 'frazil'), { recursive: true });
      fs.writeFileSync(
        path.join(box.root, 'state', 'frazil', 'demo.json'),
        JSON.stringify({ stacks: { repo: { checkout: repo, slot: 0 } } }),
      );
      const got = box.run(repo, ['doctor']);
      assert.equal(got.status, 1);
      assert.match(got.stdout, new RegExp(String(held)));
    } finally {
      await new Promise((r) => server.close(r));
    }
  }),
);

test(
  'doctor compares the host package manager with packageManager',
  withBox((box) => {
    const repo = box.checkout({ home: 'DEMO_TOKEN=1\n' });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"packageManager":"fakepm@1.2.3"}');
    fs.writeFileSync(path.join(box.bin, 'fakepm'), '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
    const got = box.run(repo, ['doctor']);
    assert.equal(got.status, 1);
    assert.match(got.stdout, /fakepm/);
    assert.match(got.stdout, /1\.2\.3/);
  }),
);

// --- the names before frazil (DEC-151 D3).

test(
  'an old stack.config.json is still found, with a notice',
  withBox((box) => {
    const repo = box.checkout();
    fs.renameSync(path.join(repo, 'frazil.config.json'), path.join(repo, 'stack.config.json'));
    const got = box.run(repo, ['up', '-d']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /frazil: stack\.config\.json is the old name; rename it frazil\.config\.json/);
    assert.ok(fs.existsSync(path.join(repo, '.frazil.json')));
  }),
);

// Copied, not moved: checkouts still on the old tool keep their slots while
// both run on one host (found 2026-11-06 on the operator's laptop).
test(
  'an old registry is copied to the frazil state dir and keeps its slots',
  withBox((box) => {
    const repo = box.checkout();
    const old = path.join(box.root, 'state', 'stack');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, 'demo.json'),
      JSON.stringify({ stacks: { repo: { checkout: repo, slot: 3 } } }),
    );
    const got = box.run(repo, ['up', '-d']);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.frazil.json'), 'utf8')).slot, 3);
    assert.ok(fs.existsSync(path.join(box.root, 'state', 'frazil', 'demo.json')));
    assert.ok(fs.existsSync(path.join(old, 'demo.json')), 'the old registry stays');
  }),
);

test(
  'an old .stack.json is removed when .frazil.json is written',
  withBox((box) => {
    const repo = box.checkout();
    fs.writeFileSync(path.join(repo, '.stack.json'), '{}');
    assert.equal(box.run(repo, ['up', '-d']).status, 0);
    assert.ok(!fs.existsSync(path.join(repo, '.stack.json')));
    assert.ok(fs.existsSync(path.join(repo, '.frazil.json')));
  }),
);

test(
  'doctor and status read the old registry and leave it in place',
  withBox((box) => {
    const repo = box.checkout({ home: 'DEMO_TOKEN=1\n' });
    const old = path.join(box.root, 'state', 'stack');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'demo.json'), JSON.stringify({ stacks: {} }));
    box.run(repo, ['doctor']);
    box.run(repo, ['status']);
    assert.ok(fs.existsSync(path.join(old, 'demo.json')));
  }),
);

test(
  'messages and usage name frazil',
  withBox((box) => {
    const repo = box.checkout();
    const got = box.run(repo, ['no-such-verb']);
    assert.equal(got.status, 2);
    assert.match(got.stderr, /^frazil: usage: frazil \[--stack <name>\]/);
  }),
);

// --- help, anywhere: a stranger's first command (FRAZIL-01 review a21ab83).

for (const args of [['--help'], ['-h'], ['help'], []]) {
  test(
    `${args.join(' ') || 'no arguments'} prints the verbs, with no config anywhere`,
    withBox((box) => {
      const got = box.run(box.root, args);
      assert.equal(got.status, args.length ? 0 : 2, got.stderr);
      const text = args.length ? got.stdout : got.stderr;
      for (const verb of ['up', 'down', 'reset', 'logs', 'test', 'status', 'prune', 'doctor', 'compose']) {
        assert.match(text, new RegExp(`\\b${verb}\\b`));
      }
      assert.match(text, /frazil\.config\.json/);
      assert.deepEqual(got.calls, [], 'help runs no docker');
    }),
  );
}

test(
  'an unknown verb prints the verbs, with no config anywhere',
  withBox((box) => {
    const got = box.run(box.root, ['bogus']);
    assert.equal(got.status, 2);
    assert.match(got.stderr, /^frazil: usage: frazil/);
    assert.match(got.stderr, /\bprune\b/);
  }),
);
