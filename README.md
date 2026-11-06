# frazil

Runs one named docker compose stack per checkout, several at once on one docker
host, and finds them again. Each git worktree or clone of an application gets
its own compose project, its own ports and its own volumes, so people and
coding agents can run and test several branches side by side without one
stack's database or ports leaking into another's.

frazil knows nothing of any application. A `frazil.config.json` at the root of
a checkout says what is the application's; `example/` is a whole stack in a few
lines. It joins the docker hosts it is given; it never provisions one.

## Install

Node 24 or later, and docker with compose v2. Docker Desktop is not required:
any docker engine works, for example [Colima](https://github.com/abiosoft/colima)
on a Mac (`brew install colima docker docker-compose && colima start`).

```bash
npm install --global frazil   # or: npx frazil <verb>
```

frazil has no runtime dependencies.

## Quick start

```bash
cp -R example /tmp/demo-a && cp -R example /tmp/demo-b
mv /tmp/demo-a/compose.yml /tmp/demo-a/docker-compose.yml
mv /tmp/demo-b/compose.yml /tmp/demo-b/docker-compose.yml
(cd /tmp/demo-a && frazil up -d --wait)
(cd /tmp/demo-b && frazil up -d --wait)
frazil status            # from either: both stacks, their ports and volumes
cat /tmp/demo-b/.frazil.json
(cd /tmp/demo-a && frazil down -v) && (cd /tmp/demo-b && frazil down -v)
docker volume rm frazil-example-shared   # shared volumes outlive every stack
```

The two stacks get different ports (18080 and 18180) and their own volumes.

## Verbs

| Verb | Does |
|---|---|
| `up [args]` | `compose up`, after taking a name and a slot and writing `.frazil.json` |
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
  `$XDG_STATE_HOME/frazil/<prefix>.json`. Each port is its base plus 100 per
  slot. A stack named as the prefix takes slot 0 while no other stack is
  registered there, even if its ports are held, as its own older project may
  hold them.
- **`.frazil.json`** in the checkout: name, project, slot, ports and `addresses`.
  Agents and tests read this; ignore it in git.
- **An image tag:** a hash of `image.inputs`, so checkouts with the same inputs
  share one image and a change to any input builds a new one.

## frazil.config.json

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
| `addresses` | templates for `.frazil.json`, `${VAR}` from `ports` |
| `test` | `vars` (`{run}` is unique per run), `prepare`, `digest`, `before`, `run`, `after`, `onFailure`; each step is compose arguments |

`test` runs `prepare`, prints `digest`, runs `before` and `run`, on failure
`onFailure`, always `after`, then fails if `digest` changed. `run`'s exit code
is the verb's.

Give every project volume the label `dev.frazil.checkout: ${FRAZIL_CHECKOUT:-}`.
Docker keeps no link from a volume to its checkout, and `prune` needs one. A
volume without the label is "unknown". It is listed only if its project carries
the prefix or holds a `volumes.marker` volume, because a suffix alone matches
other applications' volumes. The bare prefix is never unknown, only a project
traced to a gone checkout is ever stopped, and docker refuses a volume in use.
Images are not pruned; `docker image prune` does that.

## Coming from `stack`

frazil began as `tools/stack` inside one application. It still reads what that
left behind: a `stack.config.json` (with a notice to rename it), a registry in
`$XDG_STATE_HOME/stack/` (moved to `frazil/` on first use, slots kept), a
`.stack.json` (removed when `.frazil.json` is written) and volumes labelled
`dev.stack.checkout` (docker cannot relabel a volume).

## Development

```bash
npm install
npm test             # unit tests, a stub docker on PATH
npm run test:dist    # the same tests against the built dist/cli.js
npm run test:live    # real docker, two copies of the example side by side
```

The sources are TypeScript that node runs as it is; `npm run build` writes the
JavaScript the package ships, since node does not strip types under
`node_modules`.

## License

Apache-2.0; see [LICENSE](LICENSE).
