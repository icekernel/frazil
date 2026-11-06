# stack

Runs one named compose stack per checkout, several at once on one docker host,
and finds them again. Node 24 or later and docker with compose v2; no install,
no dependencies, no build: `node tools/stack/cli.ts <verb>`.

The core knows nothing of any application. `stack.config.json`, found upward
from the working directory, holds what is the application's. `example/` is a
whole stack in a few lines.

## Verbs

| Verb | Does |
|---|---|
| `up [args]` | `compose up`, after taking a name and a slot and writing `.stack.json` |
| `down [args]` | `compose down`, then removes the derived volumes; `-v` removes all of the project's |
| `reset` | `down -v`, then `up -d --wait` |
| `logs [args]` | `compose logs` |
| `test` | runs the config's `test` steps (below) |
| `status [--json]` | every stack on the host: checkout, slot, ports, services and health, volumes; the store's path and size |
| `prune` | lists what is left of gone checkouts; `--yes` removes derived volumes, `--data` data ones too, `--unknown` volumes no checkout can be traced for |
| `doctor` | docker and compose, env files and modes, required variables, this stack's ports, the package manager |
| `compose <args>` | anything else, with the stack's name, ports and env files |

`--stack <name>`, before the verb, names a stack on first use; a checkout then
keeps it. Without it the name is the checkout's directory, reduced to what
compose accepts. Two checkouts cannot hold one name.

## What a stack gets

- **A project:** `<prefix>-<stack>`, set in `COMPOSE_PROJECT_NAME`. A stack
  named as the prefix keeps the bare prefix.
- **A slot:** the lowest one not registered and with its ports free, kept in
  `$XDG_STATE_HOME/stack/<prefix>.json`. Each port is its base plus 100 per
  slot. A stack named as the prefix takes slot 0 while no other stack is
  registered there, even if its ports are held, as its own older project may
  hold them.
- **`.stack.json`** in the checkout: name, project, slot, ports and `addresses`.
  Agents and tests read this; ignore it in git.
- **An image tag:** a hash of `image.inputs`, so checkouts with the same inputs
  share one image and a change to any input builds a new one.

## stack.config.json

| Key | Holds |
|---|---|
| `prefix` | names projects and the registry |
| `envFiles` | passed to compose in order when they exist; `~/` is the home directory |
| `ports` | variable and base port; write them in compose as `${VAR:-base}` |
| `image` | `var`, the tag's variable, and `inputs`, the files it hashes |
| `store` | `cacheId` and `target` of a BuildKit cache mount, which `status` reports |
| `volumes.derived` | removed by `down` |
| `volumes.data` | removed only by `down -v`, `reset` or `prune --data` |
| `volumes.shared` | one per host, created by the tool; declare `external: true` |
| `volumes.retired` | names no longer in use, which `prune` treats as derived |
| `volumes.marker` | a volume no other application would have; see below |
| `requiredEnv` | names `doctor` looks for; values are never printed |
| `addresses` | templates for `.stack.json`, `${VAR}` from `ports` |
| `test` | `vars` (`{run}` is unique per run), `prepare`, `digest`, `before`, `run`, `after`, `onFailure`; each step is compose arguments |

`test` runs `prepare`, prints `digest`, runs `before` and `run`, on failure
`onFailure`, always `after`, then fails if `digest` changed. `run`'s exit code
is the verb's.

Give every project volume the label `dev.stack.checkout: ${STACK_CHECKOUT:-}`.
Docker keeps no link from a volume to its checkout, and `prune` needs one. A
volume without the label is "unknown". It is listed only if its project carries
the prefix or holds a `volumes.marker` volume, because a suffix alone matches
other applications' volumes. The bare prefix is never unknown, only a project
traced to a gone checkout is ever stopped, and docker refuses a volume in use.
Images are not pruned; `docker image prune` does that.

## Tests

```bash
node --test 'tools/stack/*.test.ts'                # a stub docker on PATH
STACK_LIVE=1 node --test tools/stack/live.test.ts  # real docker, the example
```
