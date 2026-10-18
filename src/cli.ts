import { Pi2Error } from "./util.ts"

/** Pi flags that always consume the next argument. */
const PI_VALUE_FLAGS = new Set([
  "--mode",
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
])

/** Pi flags that consume the next argument only if it doesn't look like a flag. */
const PI_OPTIONAL_VALUE_FLAGS = new Set(["--use-theme", "--tui-mode", "--list-models"])

const PI_BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--print",
  "-p",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--no-session",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-extensions",
  "-ne",
  "--no-mcp",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
])

/** pi2's own subcommands. */
export const PI2_COMMANDS = new Set(["shell", "ps", "stop", "build", "prune"])
/** Pi subcommands that pi2 takes over, since they change the image. */
export const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list"])
/** Pi subcommands forwarded into the container. */
export const PI_COMMANDS = new Set(["config", "auth", "mcp"])

export interface SessionTarget {
  continue: boolean
  resume: boolean
  session?: string
  fork?: string
}

export interface ParsedArgs {
  /** First argument, when it is a known subcommand. */
  command?: string
  /** Arguments to forward to pi (pi2 flags removed), including the subcommand. */
  piArgs: string[]
  mounts: string[]
  noMounts: boolean
  rebuild: boolean
  help: boolean
  version: boolean
  target: SessionTarget
}

function isFlagLike(arg: string): boolean {
  return arg.startsWith("-") || arg.startsWith("@")
}

/**
 * Splits argv into pi2 options and the arguments forwarded to pi. Mirrors pi's own parsing rules
 * (a subcommand is only recognised as the first argument, unknown `--flags` take the next
 * non-flag argument as their value) so that values are never mistaken for pi2 flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0]
  const command =
    first !== undefined &&
    (PI2_COMMANDS.has(first) || PACKAGE_COMMANDS.has(first) || PI_COMMANDS.has(first))
      ? first
      : undefined
  const out: ParsedArgs = {
    command,
    piArgs: command ? [command] : [],
    mounts: [],
    noMounts: false,
    rebuild: false,
    help: false,
    version: false,
    target: { continue: false, resume: false },
  }

  for (let i = command ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      out.piArgs.push(...argv.slice(i))
      break
    }

    if (arg === "-m" || arg === "--mount") {
      const value = argv[++i]
      if (value === undefined) throw new Pi2Error(`${arg} requires a value`)
      out.mounts.push(value)
      continue
    }
    if (arg.startsWith("--mount=")) {
      out.mounts.push(arg.slice("--mount=".length))
      continue
    }
    if (arg === "--no-mounts") {
      out.noMounts = true
      continue
    }
    if (arg === "--rebuild") {
      out.rebuild = true
      continue
    }

    out.piArgs.push(arg)
    // Subcommands have their own grammar; only pi2 flags are extracted from them.
    if (command) continue

    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--version" || arg === "-v") out.version = true
    else if (arg === "--continue" || arg === "-c") out.target.continue = true
    else if (arg === "--resume" || arg === "-r") out.target.resume = true
    else if (PI_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1]
      if (value === undefined) continue
      out.piArgs.push(value)
      i++
      if (arg === "--session") out.target.session = value
      else if (arg === "--fork") out.target.fork = value
    } else if (PI_OPTIONAL_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1]
      if (value !== undefined && !isFlagLike(value)) {
        out.piArgs.push(value)
        i++
      }
    } else if (arg.startsWith("--") && !arg.includes("=") && !PI_BOOLEAN_FLAGS.has(arg)) {
      // Unknown (extension-registered) flag: pi treats the next non-flag argument as its value.
      const value = argv[i + 1]
      if (value !== undefined && !isFlagLike(value)) {
        out.piArgs.push(value)
        i++
      }
    }
  }

  return out
}

export const HELP = `
pi2 — runs pi inside a Docker/Podman container. All pi arguments are accepted.

Options:
  -m, --mount <host>[:<container>][:ro]
                     Extra bind mount for this session (repeatable). The container
                     path defaults to /workspace/<name>. Picks or creates the
                     container that has exactly the global + these mounts.
  --no-mounts        Use the container that has only the global mounts.
  --rebuild          Rebuild the image from scratch before running.

Commands:
  pi2 shell          Open a shell in this directory's container
  pi2 ps             List pi2 containers
  pi2 stop [--all]   Stop this directory's containers (or all of them)
  pi2 build          Build the image if it is out of date
  pi2 prune          Remove unused containers and images now
  pi2 install <src>  Add a Pi package to the image (-l: install into the project)
  pi2 remove <src>   Remove a Pi package from the image
  pi2 update         Re-resolve versions and rebuild the image
  pi2 list           Show image packages

Without -m/--no-mounts, pi2 reuses any existing container of the working directory.
Config: ~/.pi/agent/pi2.json (override with PI2_CONFIG). Runtime: PI2_RUNTIME=docker|podman.
`.trimStart()
