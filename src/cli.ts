#!/usr/bin/env node
// frazil: runs one named, slotted compose stack per checkout, and finds the
// others. It knows nothing of the application; frazil.config.json, found upward
// from the working directory, holds that. See README.md.
//
//   frazil [--stack <name>] up|down|reset|logs|test|status|prune|doctor
//   frazil [--stack <name>] compose <compose arguments>

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  type Config,
  LABEL_CHECKOUT,
  LABEL_CHECKOUT_OLD,
  LABEL_PROJECT,
  LABEL_SERVICE,
  composeEnv,
  envFileFlags,
  expand,
  imageKey,
  parseLabels,
  pickSlot,
  portsFor,
  projectName,
  stackName,
} from './stack.ts';

class Failure extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

interface Registered {
  checkout: string;
  slot: number;
}
type Registry = Record<string, Registered>;

interface Stack {
  config: Config;
  checkout: string;
  name: string;
  project: string;
  slot: number;
  ports: Record<string, number>;
  flags: string[];
  env: NodeJS.ProcessEnv;
}

// --- Config and the host's registry of stacks.

const CONFIG = 'frazil.config.json';
const STACK_FILE = '.frazil.json';
/** The names before the rename to frazil (DEC-151 D3), still read and moved. */
const OLD_CONFIG = 'stack.config.json';
const OLD_STACK_FILE = '.stack.json';

function findCheckout(): string {
  for (let dir = fs.realpathSync(process.cwd()); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, CONFIG)) || fs.existsSync(path.join(dir, OLD_CONFIG))) return dir;
    if (dir === path.dirname(dir)) throw new Failure(`no ${CONFIG} here or above`, 2);
  }
}

function readConfig(checkout: string): Config {
  let file = path.join(checkout, CONFIG);
  if (!fs.existsSync(file)) {
    file = path.join(checkout, OLD_CONFIG);
    console.error(`frazil: ${OLD_CONFIG} is the old name; rename it ${CONFIG}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
}

function stateRoot(): string {
  return process.env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state');
}

function stateDir(): string {
  return path.join(stateRoot(), 'frazil');
}

/** A registry left in the old state dir moves here once, slots and all. */
function migrateRegistry(prefix: string): void {
  const old = path.join(stateRoot(), 'stack', `${prefix}.json`);
  const file = registryPath(prefix);
  if (fs.existsSync(old) && !fs.existsSync(file)) {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.renameSync(old, file);
  }
}

function registryPath(prefix: string): string {
  return path.join(stateDir(), `${prefix}.json`);
}

function readRegistry(prefix: string): Registry {
  migrateRegistry(prefix);
  try {
    const raw = fs.readFileSync(registryPath(prefix), 'utf8');
    return (JSON.parse(raw) as { stacks: Registry }).stacks;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

function writeRegistry(prefix: string, stacks: Registry): void {
  const file = registryPath(prefix);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ stacks }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** Two tools starting at once must not take one slot. */
async function withLock<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(stateDir(), { recursive: true });
  const lock = `${registryPath(prefix)}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() - started > 10_000) {
        throw new Failure(`${lock} held for 10s; remove it if no frazil command is running`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmdirSync(lock);
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

async function slotIsFree(base: Record<string, number>, slot: number): Promise<boolean> {
  const free = await Promise.all(Object.values(portsFor(base, slot)).map(portIsFree));
  return free.every(Boolean);
}

/** This checkout's name and slot, taking them on first use. */
async function claim(config: Config, checkout: string, wanted?: string): Promise<[string, number]> {
  return withLock(config.prefix, async () => {
    const stacks = readRegistry(config.prefix);
    const mine = Object.entries(stacks).find(([, s]) => s.checkout === checkout);
    const name = wanted ? stackName(wanted) : (mine?.[0] ?? stackName(path.basename(checkout)));
    const held = stacks[name];
    if (held && held.checkout !== checkout) {
      throw new Failure(`stack "${name}" already belongs to ${held.checkout}; pass --stack <name>`);
    }
    if (mine && mine[0] !== name) delete stacks[mine[0]];
    const taken = Object.values(stacks).map((s) => s.slot);
    // The prefix's stack is the checkout older than the tool: its own project may
    // be what holds the base ports, and it keeps them.
    const first = name === config.prefix && !taken.includes(0) ? 0 : undefined;
    const slot =
      held?.slot ??
      mine?.[1].slot ??
      first ??
      (await pickSlot(taken, (n) => slotIsFree(config.ports ?? {}, n)));
    stacks[name] = { checkout, slot };
    writeRegistry(config.prefix, stacks);
    return [name, slot];
  });
}

function buildStack(config: Config, checkout: string, name: string, slot: number): Stack {
  const home = os.homedir();
  const files = (config.envFiles ?? []).map((f) =>
    f.startsWith('~/') ? path.join(home, f.slice(2)) : path.resolve(checkout, f),
  );
  const project = projectName(config.prefix, name);
  const ports = portsFor(config.ports ?? {}, slot);
  const image = config.image;
  return {
    config,
    checkout,
    name,
    project,
    slot,
    ports,
    flags: envFileFlags(files),
    env: {
      ...process.env,
      ...composeEnv({
        project,
        stack: name,
        checkout,
        ports,
        imageVar: image?.var,
        imageTag: image ? imageKey(checkout, image.inputs) : undefined,
      }),
    },
  };
}

function writeStackFile(s: Stack): void {
  const vars = Object.fromEntries(Object.entries(s.ports).map(([k, p]) => [k, String(p)]));
  const addresses = Object.fromEntries(
    Object.entries(s.config.addresses ?? {}).map(([k, v]) => [k, expand(v, vars)]),
  );
  const file = {
    stack: s.name,
    project: s.project,
    slot: s.slot,
    checkout: s.checkout,
    ports: s.ports,
    addresses,
  };
  fs.writeFileSync(path.join(s.checkout, STACK_FILE), `${JSON.stringify(file, null, 2)}\n`);
  fs.rmSync(path.join(s.checkout, OLD_STACK_FILE), { force: true });
}

// --- Running docker.

function docker(args: string[], env?: NodeJS.ProcessEnv, cwd?: string): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, cwd });
  if (r.error) throw new Failure(`docker: ${r.error.message}`);
  if (r.status !== 0) throw new Failure(`docker ${args[0]}: ${r.stderr.trim()}`, r.status ?? 1);
  return r.stdout;
}

function compose(s: Stack, args: string[], env: NodeJS.ProcessEnv = s.env): number {
  // Only `exec` reads stdin, for a restore piped in. `up` and `run` may ask
  // "Recreate (data will be lost)?" of a volume whose labels differ; with no
  // stdin compose declines, keeping the data.
  const r = spawnSync('docker', ['compose', ...s.flags, ...args], {
    cwd: s.checkout,
    env,
    stdio: [args[0] === 'exec' ? 'inherit' : 'ignore', 'inherit', 'inherit'],
  });
  if (r.error) throw new Failure(`docker: ${r.error.message}`);
  return r.status ?? 1;
}

function composeOrFail(s: Stack, args: string[], env?: NodeJS.ProcessEnv): void {
  const code = compose(s, args, env);
  if (code !== 0) throw new Failure(`compose ${args[0]} failed`, code);
}

function composeOutput(s: Stack, args: string[]): string {
  return docker(['compose', ...s.flags, ...args], s.env, s.checkout);
}

function jsonLines<T>(text: string): T[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

// --- Verbs.

function createShared(s: Stack): void {
  for (const volume of s.config.volumes?.shared ?? []) docker(['volume', 'create', volume]);
}

function up(s: Stack, args: string[]): void {
  createShared(s);
  composeOrFail(s, ['up', ...args]);
}

function down(s: Stack, args: string[]): void {
  composeOrFail(s, ['down', ...args]);
  if (args.includes('-v') || args.includes('--volumes')) return;
  for (const volume of s.config.volumes?.derived ?? []) {
    docker(['volume', 'rm', '--force', `${s.project}_${volume}`]);
  }
}

function runTest(s: Stack): void {
  const t = s.config.test;
  if (!t) throw new Failure(`${CONFIG} has no "test"`, 2);
  createShared(s);
  const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const vars = Object.fromEntries(
    Object.entries(t.vars ?? {}).map(([k, v]) => [k, v.replaceAll('{run}', run)]),
  );
  const env = { ...s.env, ...vars };
  const step = (args: string[]) => args.map((a) => expand(a, vars));
  const digest = () => (t.digest ? composeOutput(s, step(t.digest)).trim() : '');

  for (const args of t.prepare ?? []) composeOrFail(s, step(args), env);
  const before = digest();
  let failed: Failure | undefined;
  try {
    for (const args of t.before ?? []) composeOrFail(s, step(args), env);
    composeOrFail(s, step(t.run), env);
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    failed = e;
    for (const args of t.onFailure ?? []) compose(s, step(args), env);
  }
  for (const args of t.after ?? []) {
    const code = compose(s, step(args), env);
    if (code !== 0) failed ??= new Failure(`after step ${args.join(' ')} failed`, code);
  }
  if (failed) throw failed;
  const after = digest();
  if (before !== after) throw new Failure(`digest changed: ${before} became ${after}`);
  if (t.digest) console.log(`frazil: digest unchanged: ${after}`);
}

interface PsRow {
  Labels?: string;
  State?: string;
  Status?: string;
  Ports?: string;
}
interface VolumeRow {
  Name: string;
  Labels?: string;
}

function containers(): (PsRow & { project: string; service: string })[] {
  return jsonLines<PsRow>(docker(['ps', '-a', '--format', 'json'])).map((row) => {
    const labels = parseLabels(row.Labels);
    return { ...row, project: labels[LABEL_PROJECT] ?? '', service: labels[LABEL_SERVICE] ?? '' };
  });
}

function health(status: string | undefined): string {
  return /\((healthy|unhealthy|health: starting)\)/.exec(status ?? '')?.[1] ?? '';
}

/** The store's size, from BuildKit; empty until a build has used the cache. */
function store(config: Config): { cacheId: string; path: string; sizes: string[] } | undefined {
  if (!config.store) return undefined;
  const { cacheId, target } = config.store;
  const r = spawnSync('docker', ['buildx', 'du', '--filter', 'type=exec.cachemount', '--format', 'json'], {
    encoding: 'utf8',
  });
  const records = r.status === 0 ? jsonLines<{ Description?: string; Size?: string }>(r.stdout) : [];
  const sizes = records
    .filter((d) => d.Description?.includes(`id "/${cacheId}"`))
    .map((d) => d.Size ?? '');
  return { cacheId, path: target, sizes };
}

function status(config: Config, checkout: string, json: boolean): void {
  const rows = containers();
  const volumeRows = jsonLines<VolumeRow>(docker(['volume', 'ls', '--format', 'json']));
  const stacks = Object.entries(readRegistry(config.prefix)).map(([name, r]) => {
    const project = projectName(config.prefix, name);
    return {
      stack: name,
      project,
      checkout: r.checkout,
      checkoutExists: fs.existsSync(r.checkout),
      slot: r.slot,
      ports: portsFor(config.ports ?? {}, r.slot),
      services: rows
        .filter((c) => c.project === project)
        .map((c) => ({ service: c.service, state: c.State ?? '', health: health(c.Status) })),
      volumes: volumeRows
        .filter((v) => parseLabels(v.Labels)[LABEL_PROJECT] === project)
        .map((v) => v.Name),
    };
  });
  const cache = store(config);
  if (json) {
    console.log(JSON.stringify({ stacks, store: cache }, null, 2));
    return;
  }
  for (const s of stacks) {
    const here = s.checkout === checkout ? ' (here)' : '';
    const gone = s.checkoutExists ? '' : ' (checkout gone)';
    console.log(`${s.project}  slot ${s.slot}  ${s.checkout}${here}${gone}`);
    console.log(`  ports ${Object.entries(s.ports).map(([k, p]) => `${k}=${p}`).join(' ')}`);
    for (const c of s.services) {
      console.log(`  ${c.service}  ${c.state}${c.health ? ` (${c.health})` : ''}`);
    }
    if (s.volumes.length) console.log(`  volumes ${s.volumes.join(' ')}`);
  }
  if (!stacks.length) console.log('no stacks yet');
  if (cache) {
    console.log(`store: BuildKit cache ${cache.cacheId} at ${cache.path}, ${cache.sizes.join(', ') || 'empty'}`);
  }
}

function prune(config: Config, flags: { yes: boolean; data: boolean; unknown: boolean }): void {
  const volumes = config.volumes ?? {};
  const derived = [...(volumes.derived ?? []), ...(volumes.retired ?? [])];
  const data = volumes.data ?? [];
  const suffix = (name: string, list: string[]) => list.some((v) => name.endsWith(`_${v}`));

  const rows = jsonLines<VolumeRow>(docker(['volume', 'ls', '--format', 'json']));
  const projectOf = (row: VolumeRow) => parseLabels(row.Labels)[LABEL_PROJECT] ?? '';
  const stacks = readRegistry(config.prefix);
  const live = new Set(
    Object.entries(stacks)
      .filter(([, s]) => fs.existsSync(s.checkout))
      .map(([name]) => projectName(config.prefix, name)),
  );
  // An untraceable volume is ours only by evidence, never by its suffix alone:
  // `_postgres-data` is any application's. The bare prefix is the checkout whose
  // project predates the labels; it is never untraceable leftovers.
  const marked = new Set(
    rows.filter((r) => suffix(r.Name, volumes.marker ?? [])).map(projectOf),
  );
  const ours = (project: string) =>
    project !== config.prefix && (project.startsWith(`${config.prefix}-`) || marked.has(project));

  const orphans = new Set<string>();
  const remove: string[] = [];
  for (const row of rows) {
    const isDerived = suffix(row.Name, derived);
    if (!isDerived && !suffix(row.Name, data)) continue;
    const project = projectOf(row);
    const labels = parseLabels(row.Labels);
    const where = labels[LABEL_CHECKOUT] ?? labels[LABEL_CHECKOUT_OLD];
    if (where ? fs.existsSync(where) : live.has(project) || !ours(project)) continue;
    const take = (isDerived || flags.data) && (Boolean(where) || flags.unknown);
    const kind = `${where ? 'orphan' : 'unknown'} ${isDerived ? 'derived' : 'data'}`;
    console.log(`${flags.yes && take ? 'remove' : 'keep  '}  ${kind}  ${row.Name}`);
    if (take) remove.push(row.Name);
    // Only a project traced to a checkout that is gone may be stopped.
    if (take && where && project) orphans.add(project);
  }

  const gone = Object.entries(stacks).filter(([, s]) => !fs.existsSync(s.checkout));
  for (const [name, s] of gone) {
    console.log(`${flags.yes ? 'free  ' : 'keep  '}  slot ${s.slot}  ${name}`);
  }
  if (!flags.yes) {
    console.log('dry run: --yes removes derived volumes, --data data ones, --unknown untraceable ones');
    return;
  }
  for (const project of orphans) docker(['compose', '-p', project, 'down']);
  const refused: string[] = [];
  for (const name of remove) {
    const r = spawnSync('docker', ['volume', 'rm', name], { encoding: 'utf8' });
    if (r.status !== 0) refused.push(`${name}: ${r.stderr.trim()}`);
  }
  for (const [name] of gone) delete stacks[name];
  if (gone.length) writeRegistry(config.prefix, stacks);
  if (refused.length) throw new Failure(`not removed:\n  ${refused.join('\n  ')}`);
}

function envFileKeys(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_]\w*)=/.exec(line)?.[1])
    .filter((k): k is string => Boolean(k));
}

async function doctor(config: Config, checkout: string): Promise<void> {
  let failures = 0;
  const check = (ok: boolean, text: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
    if (!ok) failures++;
  };
  const version = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: checkout });
    return r.status === 0 ? r.stdout.trim().split('\n').at(-1)?.trim() : undefined;
  };

  const dockerVersion = version('docker', ['--version']);
  check(Boolean(dockerVersion), dockerVersion ?? 'docker not found');
  const composeVersion = version('docker', ['compose', 'version']);
  check(Boolean(composeVersion), `compose ${composeVersion ?? 'not found'}`);

  const home = os.homedir();
  const files = (config.envFiles ?? []).map((f) =>
    f.startsWith('~/') ? path.join(home, f.slice(2)) : path.resolve(checkout, f),
  );
  const keys = new Set(Object.keys(process.env));
  for (const file of files) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    for (const key of envFileKeys(file)) keys.add(key);
    if (file.startsWith(`${home}${path.sep}`) && !file.startsWith(`${checkout}${path.sep}`)) {
      const mode = (stat.mode & 0o777).toString(8);
      check((stat.mode & 0o077) === 0, `${file} mode ${mode}, wanted 600`);
    }
  }
  for (const key of config.requiredEnv ?? []) {
    check(keys.has(key), `${key} ${keys.has(key) ? 'set' : 'not set in the shell or an env file'}`);
  }

  const mine = Object.entries(readRegistry(config.prefix)).find(([, s]) => s.checkout === checkout);
  if (mine) {
    const project = projectName(config.prefix, mine[0]);
    const running = containers().some((c) => c.project === project && c.State === 'running');
    if (running) {
      check(true, `${project} is running, its ports are its own`);
    } else {
      for (const [key, port] of Object.entries(portsFor(config.ports ?? {}, mine[1].slot))) {
        check(await portIsFree(port), `${key} ${port} free`);
      }
    }
  }

  const manifest = path.join(checkout, 'package.json');
  if (fs.existsSync(manifest)) {
    const wanted = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { packageManager?: string }).packageManager;
    if (wanted) {
      const [name, want] = wanted.split('+')[0]!.split('@') as [string, string];
      const have = version(name, ['--version']);
      check(have === want, `${name} ${have ?? 'not found'}, packageManager wants ${want}`);
    }
  }
  if (failures) throw new Failure(`${failures} problem(s)`);
}

// --- Entry point.

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  let wanted: string | undefined;
  if (args[0] === '--stack') {
    wanted = args[1];
    if (!wanted) throw new Failure('--stack needs a name', 2);
    args.splice(0, 2);
  }
  const verb = args.shift();
  const checkout = findCheckout();
  const config = readConfig(checkout);

  if (verb === 'status') return status(config, checkout, args.includes('--json'));
  if (verb === 'doctor') return doctor(config, checkout);
  if (verb === 'prune') {
    return prune(config, {
      yes: args.includes('--yes'),
      data: args.includes('--data'),
      unknown: args.includes('--unknown'),
    });
  }
  if (!['up', 'down', 'reset', 'logs', 'test', 'compose'].includes(verb ?? '')) {
    throw new Failure('usage: frazil [--stack <name>] up|down|reset|logs|test|status|prune|doctor|compose ...', 2);
  }

  const [name, slot] = await claim(config, checkout, wanted);
  const s = buildStack(config, checkout, name, slot);
  writeStackFile(s);
  if (verb === 'up') return up(s, args);
  if (verb === 'down') return down(s, args);
  if (verb === 'logs') return composeOrFail(s, ['logs', ...args]);
  if (verb === 'test') return runTest(s);
  if (verb === 'compose') {
    createShared(s);
    return composeOrFail(s, args);
  }
  composeOrFail(s, ['down', '-v']);
  up(s, ['-d', '--wait']);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof Failure) {
    console.error(`frazil: ${e.message}`);
    process.exit(e.code);
  }
  throw e;
});
