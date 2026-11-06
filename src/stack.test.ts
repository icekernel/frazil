// Pure rules of the stack tool: names, slots, ports, env files, the image key.
// Run with `node --test 'tools/stack/*.test.ts'`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  composeEnv,
  envFileFlags,
  imageKey,
  pickSlot,
  portsFor,
  projectName,
  stackName,
} from './stack.ts';

test('stack name: capitals and a dot, as compose would normalise them', () => {
  assert.equal(stackName('ABC-01-Probe.x'), 'abc-01-probex');
});

test('stack name: leading _ and - are stripped', () => {
  assert.equal(stackName('_Lead.x'), 'leadx');
  assert.equal(stackName('--a'), 'a');
});

test('stack name: nothing valid left is an error', () => {
  assert.throws(() => stackName('...'), /no valid stack name/);
});

test('project name: prefix and stack', () => {
  assert.equal(projectName('demo', 'feature-a'), 'demo-feature-a');
});

test('project name: a stack named as the prefix keeps the bare prefix', () => {
  assert.equal(projectName('demo', 'demo'), 'demo');
});

test('ports: base plus 100 per slot, so adjacent bases never collide', () => {
  const base = { A_PORT: 9229, B_PORT: 9230 };
  assert.deepEqual(portsFor(base, 0), { A_PORT: 9229, B_PORT: 9230 });
  assert.deepEqual(portsFor(base, 2), { A_PORT: 9429, B_PORT: 9430 });
});

test('slot: the lowest one neither taken nor busy', async () => {
  const free = () => true;
  assert.equal(await pickSlot([], free), 0);
  assert.equal(await pickSlot([0, 1, 3], free), 2);
  assert.equal(await pickSlot([0], (s) => s !== 1), 2);
});

test('env files: only those that exist, in order, a later one winning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'X=1\n');
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'c'), 'X=2\n');
    assert.deepEqual(
      envFileFlags(['a', 'b', 'missing', 'c'].map((f) => path.join(dir, f))),
      ['--env-file', path.join(dir, 'a'), '--env-file', path.join(dir, 'c')],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('image key: follows the inputs, and is the same across checkouts', () => {
  const dirs = ['one', 'two'].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'stack-')));
  try {
    for (const d of dirs) fs.writeFileSync(path.join(d, 'lock'), 'v1\n');
    const key = (d: string) => imageKey(d, ['lock']);
    assert.equal(key(dirs[0]!), key(dirs[1]!));
    assert.match(key(dirs[0]!), /^[0-9a-f]{16}$/);
    fs.writeFileSync(path.join(dirs[1]!, 'lock'), 'v2\n');
    assert.notEqual(key(dirs[0]!), key(dirs[1]!));
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('image key: a missing input is an error, not a silent hash', () => {
  assert.throws(() => imageKey(os.tmpdir(), ['no-such-file']), /no-such-file/);
});

test('compose env: names the project, the labels, the ports and the tag', () => {
  const env = composeEnv({
    project: 'demo-a',
    stack: 'a',
    checkout: '/w/a',
    ports: { A_PORT: 8100 },
    imageVar: 'DEMO_TAG',
    imageTag: 'abc',
  });
  assert.deepEqual(env, {
    COMPOSE_PROJECT_NAME: 'demo-a',
    STACK_NAME: 'a',
    STACK_CHECKOUT: '/w/a',
    A_PORT: '8100',
    DEMO_TAG: 'abc',
  });
});
