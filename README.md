# pi-squared (`pi2`)

Runs [Pi Coding Agent](https://pi.dev) inside a Docker or Podman container, so the agent only
sees the working directory and the mounts you give it.

```sh
pi2                       # same as `pi`, but sandboxed
pi2 -c                    # continue the latest session (in the container that owns it)
pi2 -m ~/datasets:ro      # add a read-only mount at /workspace/datasets
pi2 -p "explain this repo"
```

All `pi` arguments are accepted and forwarded unchanged. Requires Node.js ≥ 22.18 and `docker`
or `podman` on macOS or Linux.

## How it works

- **Image**: pi2 builds one image from the config: base image, system packages, custom commands,
  pi at the configured version, and Pi packages (`pi install`). Its tag is a hash of the
  generated Dockerfile, so it is rebuilt only when something changes. Old images are pruned once
  no container uses them.
- **Containers**: the working directory is mounted at `/workspace/<dir name>`. Containers are
  long-lived (`sleep infinity`), and each pi session is an `exec` into one. A container is
  stopped when its last session exits, and removed after `containerTtl` without use.
  - `pi2`: reuses any existing container of the working directory.
  - `pi2 --no-mounts`: the container with only the global mounts from the config.
  - `pi2 -m <mount>`: the container with exactly the global mounts plus these.
  - `pi2 -c`, `--session <id>`, `--fork <id>`: the container that owns that session.
- **Sessions**: each container keeps its own Pi sessions. They are stored on the host and survive
  container removal; a removed container is recreated with the same mounts when needed.
- **Agent files**: `auth.json`, `models.json`, `mcp.json`, `keybindings.json`, `AGENTS.md`,
  `prompts/`, `skills/` and `themes/` from `~/.pi/agent` are shared with the container. Host
  extensions and packages are not. The container gets its own `settings.json`, seeded from the
  host one, with packages taken from the image.

State lives in `~/.pi/agent/containers/`, which is never mounted into containers:

```
containers/
  cache.json                  # resolved pi version, image settings, last prune time
  settings.json               # settings.json shared by all containers
  --Users-me-proj--/          # one dir per working directory (Pi's encoding)
    pi2-19a3f2c4b1e.json      # container record: cwd, mounts, image, timestamps
    pi2-19a3f2c4b1e/          # that container's Pi sessions (*.jsonl)
```

## Commands

| Command                                  |                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `pi2 shell`                              | Shell in the working directory's container (accepts `-m`/`--no-mounts`)       |
| `pi2 ps`                                 | List containers, their state, mounts and last use                             |
| `pi2 stop [--all]`                       | Stop this directory's containers (or all)                                     |
| `pi2 build [--rebuild]`                  | Build the image if it is out of date                                          |
| `pi2 prune`                              | Remove expired containers and unused images now                               |
| `pi2 install <src>` / `pi2 remove <src>` | Add/remove a Pi package in the image (`-l` installs into the project instead) |
| `pi2 update`                             | Re-resolve `latest` and rebuild without cache                                 |
| `pi2 list`                               | Show image packages and version                                               |

`config`, `auth` and `mcp` are forwarded to pi inside the container.

## Configuration

`~/.pi/agent/pi2.json` (or `$PI2_CONFIG`). Every key is optional; these are the defaults:

```jsonc
{
  "runtime": "auto", // auto | docker | podman (or PI2_RUNTIME)
  "pi": { "version": "latest" },
  "image": {
    "base": "node:24-bookworm-slim", // must provide node ≥ 22.19 and npm
    "packageManager": null, // apt | apk | dnf; detected from the base image name
    "systemPackages": ["curl", "ripgrep", "fd-find", "python3"], // git is always installed
    "commands": [], // extra RUN steps
    "env": {},
  },
  "packages": [], // Pi packages, e.g. "npm:@scope/ext", "git:github.com/user/repo"
  "mounts": [], // global mounts: "<host>[:<container>][:ro]"
  "env": {}, // set on every exec
  "forwardEnv": ["*_API_KEY", "TERM", "COLORTERM", "LANG", "LC_ALL"],
  "shareAgentFiles": [
    "auth.json",
    "models.json",
    "mcp.json",
    "keybindings.json",
    "AGENTS.md",
    "prompts",
    "skills",
    "themes",
  ],
  "settings": {}, // merged into the container's settings.json
  "containerArgs": [], // extra `create` arguments, e.g. ["--memory=4g"]
  "containerTtl": "7d", // s/m/h/d/w; null disables
}
```

## Development

```sh
pnpm install
pnpm dev --version   # runs src/index.ts directly (Node type stripping, no build)
pnpm check           # typecheck, lint, format check, tests
```
