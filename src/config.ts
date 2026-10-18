import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import * as z from "zod/mini"
import { DURATION_RE, Pi2Error } from "./util.ts"

// zod/mini ships without messages; load English ones for readable config errors.
z.config(z.locales.en())

export const PI_PACKAGE = "@earendil-works/pi-coding-agent"

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

/** Pi's agent dir on the host, honoring `PI_CODING_AGENT_DIR` like Pi does. */
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR
  return env ? resolve(expandHome(env)) : join(homedir(), ".pi", "agent")
}

/** Root of pi2's own state. Never mounted into containers. */
export function stateDir(): string {
  return join(agentDir(), "containers")
}

export function configPath(): string {
  const env = process.env.PI2_CONFIG
  return env ? resolve(expandHome(env)) : join(agentDir(), "pi2.json")
}

/** Same encoding Pi uses for its per-cwd session directories. */
export function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

const strings = (defaults: string[] = []) => z._default(z.array(z.string()), () => [...defaults])
const stringMap = () => z._default(z.record(z.string(), z.string()), () => ({}))

export const DEFAULT_SHARED_AGENT_FILES = [
  "auth.json",
  "models.json",
  "mcp.json",
  "keybindings.json",
  "AGENTS.md",
  "prompts",
  "skills",
  "themes",
]

const ConfigSchema = z.strictObject({
  $schema: z.optional(z.string()),
  runtime: z._default(z.enum(["auto", "docker", "podman"]), "auto"),
  pi: z.prefault(z.strictObject({ version: z._default(z.string(), "latest") }), {}),
  image: z.prefault(
    z.strictObject({
      base: z._default(z.string(), "node:24-bookworm-slim"),
      packageManager: z.optional(z.enum(["apt", "apk", "dnf"])),
      systemPackages: strings(["curl", "ripgrep", "fd-find", "python3"]),
      commands: strings(),
      env: stringMap(),
    }),
    {},
  ),
  packages: strings(),
  mounts: strings(),
  env: stringMap(),
  forwardEnv: strings(["*_API_KEY", "TERM", "COLORTERM", "LANG", "LC_ALL"]),
  shareAgentFiles: strings(DEFAULT_SHARED_AGENT_FILES),
  settings: z._default(z.record(z.string(), z.unknown()), () => ({})),
  containerArgs: strings(),
  containerTtl: z._default(z.nullable(z.string().check(z.regex(DURATION_RE))), "7d"),
})

export type Config = z.output<typeof ConfigSchema>

export type RawConfig = Record<string, unknown>

export function readRawConfig(): RawConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Pi2Error(`${path}: invalid JSON: ${(error as Error).message}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Pi2Error(`${path}: expected a JSON object`)
  }
  return raw as RawConfig
}

export function parseConfig(raw: unknown, source = configPath()): Config {
  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new Pi2Error(`${source}: invalid config\n${z.prettifyError(result.error)}`)
  }
  return result.data
}

export function loadConfig(): Config {
  return parseConfig(readRawConfig())
}

/** Validates and writes the raw config, keeping keys pi2 didn't touch. */
export function saveRawConfig(raw: RawConfig): Config {
  const config = parseConfig(raw)
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
  return config
}
