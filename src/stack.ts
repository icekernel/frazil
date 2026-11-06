// The stack tool's rules, free of I/O beyond reading files: how a checkout's
// stack, project, ports and image tag are derived. cli.ts does the rest.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Ports of one slot sit this far from the next slot's. */
export const SLOT_STRIDE = 100;

/** Volume labels, read back by `status` and `prune`. */
export const LABEL_CHECKOUT = 'dev.stack.checkout';
export const LABEL_PROJECT = 'com.docker.compose.project';
export const LABEL_SERVICE = 'com.docker.compose.service';

export interface Config {
  prefix: string;
  envFiles?: string[];
  ports?: Record<string, number>;
  image?: { var: string; inputs: string[] };
  /** A BuildKit cache mount shared by builds: `status` reports it. */
  store?: { cacheId: string; target: string };
  volumes?: {
    /** Rebuilt from nothing: `down` removes them. */
    derived?: string[];
    /** The developer's: only `down -v`, `reset` or `prune --data`. */
    data?: string[];
    /** One per host, outside any project: created, never removed. */
    shared?: string[];
    /** Names no longer in the compose file: `prune` treats them as derived. */
    retired?: string[];
    /**
     * A volume no other application would have. `prune` calls an unlabelled
     * project ours only if it holds one, or carries the prefix.
     */
    marker?: string[];
  };
  requiredEnv?: string[];
  addresses?: Record<string, string>;
  test?: {
    vars?: Record<string, string>;
    /** Steps before the first digest, such as bringing the stack up. */
    prepare?: string[][];
    /** Prints a digest of what a test run must leave as it found it. */
    digest?: string[];
    before?: string[][];
    run: string[];
    /** Before `after`, when a step failed, while there is still something to read. */
    onFailure?: string[][];
    after?: string[][];
  };
}

/** A stack name from a dir name: what compose itself would keep of it. */
export function stackName(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '');
  if (!name) throw new Error(`no valid stack name in "${raw}"; pass --stack <name>`);
  return name;
}

export function projectName(prefix: string, stack: string): string {
  return stack === prefix ? prefix : `${prefix}-${stack}`;
}

export function portsFor(base: Record<string, number>, slot: number): Record<string, number> {
  return Object.fromEntries(Object.entries(base).map(([k, p]) => [k, p + slot * SLOT_STRIDE]));
}

export async function pickSlot(
  taken: number[],
  isFree: (slot: number) => boolean | Promise<boolean>,
): Promise<number> {
  for (let slot = 0; ; slot++) {
    if (!taken.includes(slot) && (await isFree(slot))) return slot;
  }
}

export function envFileFlags(files: string[]): string[] {
  return files
    .filter((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile())
    .flatMap((f) => ['--env-file', f]);
}

export function imageKey(dir: string, inputs: string[]): string {
  const hash = createHash('sha256');
  for (const input of inputs) {
    hash.update(input).update('\0').update(fs.readFileSync(path.join(dir, input)));
  }
  return hash.digest('hex').slice(0, 16);
}

export function composeEnv(s: {
  project: string;
  stack: string;
  checkout: string;
  ports: Record<string, number>;
  imageVar?: string | undefined;
  imageTag?: string | undefined;
}): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: s.project,
    STACK_NAME: s.stack,
    STACK_CHECKOUT: s.checkout,
    ...Object.fromEntries(Object.entries(s.ports).map(([k, p]) => [k, String(p)])),
    ...(s.imageVar && s.imageTag ? { [s.imageVar]: s.imageTag } : {}),
  };
}

/** `${NAME}` from `vars`; an unknown name is left as it is. */
export function expand(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

/** A `docker ... --format json` Labels field: `a=b,c=d`, values may hold commas. */
export function parseLabels(field: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  let last = '';
  for (const part of (field ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      last = part.slice(0, eq);
      labels[last] = part.slice(eq + 1);
    } else if (last) {
      labels[last] += `,${part}`;
    }
  }
  return labels;
}
