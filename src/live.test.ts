// The stack CLI against real docker and the example stack, not a stub. Runs only
// with FRAZIL_LIVE=1. Two throwaway checkouts run at once; everything is removed
// after. `FRAZIL_LIVE=1 node --test src/live.test.ts`

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.ts');

test('two example stacks, side by side', { skip: !process.env['FRAZIL_LIVE'] }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frazil-live-')));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state') };
  const checkouts = ['Live.A', 'Live.B'].map((dir) => path.join(root, dir));
  const stack = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `stack ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' }).stdout;
  const volumes = () => docker('volume', 'ls', '--format', '{{.Name}}').split('\n');
  try {
    for (const c of checkouts) {
      fs.cpSync(path.join(HERE, '..', 'example'), c, { recursive: true });
      fs.renameSync(path.join(c, 'compose.yml'), path.join(c, 'docker-compose.yml'));
      stack(c, 'up', '-d', '--wait');
    }
    const [a, b] = checkouts.map(
      (c) => JSON.parse(fs.readFileSync(path.join(c, '.frazil.json'), 'utf8')) as {
        project: string;
        ports: Record<string, number>;
      },
    ) as [{ project: string; ports: Record<string, number> }, { project: string; ports: Record<string, number> }];
    assert.equal(a.project, 'example-livea');
    assert.equal(b.project, 'example-liveb');
    assert.notEqual(a.ports['EXAMPLE_WEB_PORT'], b.ports['EXAMPLE_WEB_PORT']);
    for (const c of checkouts) stack(c, 'test');

    // Compose agrees with the name the tool set, and the label reached docker.
    const read = stack(checkouts[0]!, 'compose', 'config', '--format', 'json');
    assert.equal((JSON.parse(read) as { name: string }).name, 'example-livea');
    const label = docker('volume', 'inspect', 'example-livea_data', '--format',
      '{{index .Labels "dev.frazil.checkout"}}');
    assert.equal(label.trim(), checkouts[0]);

    const status = JSON.parse(stack(checkouts[0]!, 'status', '--json')) as {
      stacks: { services: { health: string }[] }[];
    };
    assert.deepEqual(status.stacks.map((s) => s.services[0]?.health), ['healthy', 'healthy']);

    // down: derived gone, data kept. down -v: all of the project's gone.
    stack(checkouts[0]!, 'down');
    assert.ok(!volumes().includes('example-livea_cache'));
    assert.ok(volumes().includes('example-livea_data'));
    stack(checkouts[0]!, 'down', '-v');
    assert.ok(!volumes().includes('example-livea_data'));

    // A checkout that goes: prune finds it by the label and removes its data.
    stack(checkouts[1]!, 'compose', 'stop');
    fs.rmSync(checkouts[1]!, { recursive: true });
    const dry = stack(checkouts[0]!, 'prune');
    assert.match(dry, /keep {4}orphan data {2}example-liveb_data/);
    stack(checkouts[0]!, 'prune', '--yes', '--data');
    assert.ok(!volumes().includes('example-liveb_data'));
    assert.ok(!volumes().includes('example-liveb_cache'));
  } finally {
    for (const p of ['example-livea', 'example-liveb']) {
      spawnSync('docker', ['compose', '-p', p, 'down', '-v'], { encoding: 'utf8' });
    }
    docker('volume', 'rm', '--force', 'frazil-example-shared');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
