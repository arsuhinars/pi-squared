import { spawn, spawnSync, type StdioOptions } from "node:child_process"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { join } from "node:path"
import { agentDir, type Config } from "./config.ts"
import { AGENT_DIR, SESSIONS_DIR } from "./render.ts"
import {
  containerSettingsPath,
  deleteRecord,
  isInside,
  listAllRecords,
  readCache,
  saveRecord,
  sessionsPath,
  updateCache,
  type ContainerRecord,
} from "./session.ts"
import { log, parseDuration, Pi2Error } from "./util.ts"

export type RuntimeName = "docker" | "podman"

export interface ContainerInfo {
  id: string
  name: string
  running: boolean
  labels: Record<string, string>
}

interface RawContainer {
  Id: string
  Name: string
  State?: { Running?: boolean }
  Config?: { Labels?: Record<string, string> | null }
}

interface RawImage {
  Id: string
  RepoTags?: string[] | null
}

export interface Result {
  code: number
  stdout: string
  stderr: string
}

function available(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0
}

/** Thin wrapper over the `docker`/`podman` CLI; both accept the same commands used here. */
export class Engine {
  readonly name: RuntimeName

  constructor(name: RuntimeName) {
    this.name = name
  }

  static detect(preference: Config["runtime"]): Engine {
    const env = process.env.PI2_RUNTIME
    const wanted = env || preference
    if (wanted === "docker" || wanted === "podman") {
      if (!available(wanted)) throw new Pi2Error(`${wanted} not found in PATH`)
      return new Engine(wanted)
    }
    if (wanted !== "auto") throw new Pi2Error(`unknown runtime "${wanted}"`)
    for (const name of ["docker", "podman"] as const) {
      if (available(name)) return new Engine(name)
    }
    throw new Pi2Error("neither docker nor podman found in PATH")
  }

  capture(args: string[]): Result {
    const result = spawnSync(this.name, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    if (result.error) throw new Pi2Error(`failed to run ${this.name}: ${result.error.message}`)
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
  }

  run(args: string[]): string {
    const result = this.capture(args)
    if (result.code !== 0) {
      throw new Pi2Error(
        `${this.name} ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      )
    }
    return result.stdout
  }

  /** Runs with inherited stdio, forwarding termination signals; resolves with the exit code. */
  spawn(
    args: string[],
    options: { stdio?: StdioOptions; env?: NodeJS.ProcessEnv } = {},
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.name, args, { stdio: options.stdio ?? "inherit", env: options.env })
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
      const forward = (signal: NodeJS.Signals) => child.kill(signal)
      for (const signal of signals) process.on(signal, forward)
      child.on("error", (error) =>
        reject(new Pi2Error(`failed to run ${this.name}: ${error.message}`)),
      )
      child.on("exit", (code, signal) => {
        for (const s of signals) process.off(s, forward)
        resolve(code ?? 128 + (signal ? constants.signals[signal] : 1))
      })
    })
  }

  inspectContainers(ids: string[]): ContainerInfo[] {
    if (ids.length === 0) return []
    const result = this.capture(["container", "inspect", ...ids])
    // Exit code is non-zero if any id is missing, but the found ones are still printed.
    const raw = JSON.parse(result.stdout.trim() || "[]") as RawContainer[]
    return raw.map((c) => ({
      id: c.Id,
      name: c.Name.replace(/^\//, ""),
      running: c.State?.Running === true,
      labels: c.Config?.Labels ?? {},
    }))
  }

  containerInfo(name: string): ContainerInfo | undefined {
    return this.inspectContainers([name])[0]
  }

  listContainers(labels: Record<string, string> = {}): ContainerInfo[] {
    const filters = Object.entries({ "pi2.managed": "1", ...labels }).flatMap(([key, value]) => [
      "--filter",
      `label=${key}=${value}`,
    ])
    const ids = this.run(["ps", "-aq", "--no-trunc", ...filters])
      .split("\n")
      .filter(Boolean)
    return this.inspectContainers([...new Set(ids)])
  }

  imageExists(tag: string): boolean {
    return this.capture(["image", "inspect", "--format", "{{.Id}}", tag]).code === 0
  }

  listImages(): RawImage[] {
    const ids = this.run(["images", "-q", "--no-trunc", "--filter", "label=pi2.managed=1"])
      .split("\n")
      .filter(Boolean)
    if (ids.length === 0) return []
    return JSON.parse(
      this.capture(["image", "inspect", ...new Set(ids)]).stdout.trim() || "[]",
    ) as RawImage[]
  }

  /** Processes running in the container besides its init and `sleep infinity`. */
  activeProcesses(name: string): number {
    const result = this.capture(["top", name])
    if (result.code !== 0) return 0
    return result.stdout
      .trim()
      .split("\n")
      .slice(1)
      .filter((line) => line.trim() && !line.includes("sleep infinity")).length
  }

  stopIfIdle(name: string): void {
    if (this.activeProcesses(name) === 0) this.capture(["stop", "-t", "2", name])
  }
}

// --- Creation -------------------------------------------------------------------------------

const RESERVED_AGENT_FILES = new Set([
  "settings.json",
  "sessions",
  "containers",
  "npm",
  "git",
  "pi2.json",
])

function agentFileMounts(config: Config): string[] {
  const args: string[] = []
  for (const entry of config.shareAgentFiles) {
    if (RESERVED_AGENT_FILES.has(entry) || entry.includes("..") || entry.startsWith("/")) {
      throw new Pi2Error(`shareAgentFiles: "${entry}" cannot be shared`)
    }
    const host = join(agentDir(), entry)
    // Create auth.json up front so logins made inside the container persist on the host.
    if (entry === "auth.json" && !existsSync(host)) writeFileSync(host, "{}\n", { mode: 0o600 })
    if (existsSync(host))
      args.push("--mount", `type=bind,source=${host},target=${AGENT_DIR}/${entry}`)
  }
  return args
}

function userArgs(engine: Engine): string[] {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || uid === 0) return []
  if (engine.name === "podman") return ["--userns=keep-id"]
  return ["--user", `${uid}:${gid}`]
}

function createArgs(engine: Engine, config: Config, record: ContainerRecord): string[] {
  const mounts = record.mounts.flatMap((m) => {
    if (isInside(agentDir(), m.host))
      log(`warning: mount ${m.host} exposes ${agentDir()} to the container`)
    return [
      "--mount",
      `type=bind,source=${m.host},target=${m.target}${m.readonly ? ",readonly" : ""}`,
    ]
  })
  return [
    "create",
    "--name",
    record.name,
    "--label",
    "pi2.managed=1",
    "--label",
    `pi2.cwd=${record.cwd}`,
    "--label",
    `pi2.mounts=${record.mountsKey}`,
    "--label",
    `pi2.image=${record.image}`,
    "--init",
    "-w",
    record.workdir,
    "--mount",
    `type=bind,source=${record.cwd},target=${record.workdir}`,
    ...mounts,
    "--mount",
    `type=bind,source=${sessionsPath(record)},target=${SESSIONS_DIR}`,
    "--mount",
    `type=bind,source=${containerSettingsPath()},target=${AGENT_DIR}/settings.json`,
    ...agentFileMounts(config),
    ...userArgs(engine),
    ...config.containerArgs,
    record.image,
    "sleep",
    "infinity",
  ]
}

/** Makes sure the record's container exists on the current image and is running. */
export function ensureContainer(
  engine: Engine,
  config: Config,
  record: ContainerRecord,
  image: string,
): void {
  let info = engine.containerInfo(record.name)
  if (info && info.labels["pi2.image"] !== image) {
    if (info.running) {
      log(`${record.name} runs an outdated image; it is recreated once all its sessions exit`)
    } else {
      engine.run(["rm", "-f", record.name])
      info = undefined
    }
  }
  if (!info) {
    record.image = image
    engine.run(createArgs(engine, config, record))
    saveRecord(record)
  }
  if (!info?.running) engine.run(["start", record.name])
}

// --- Pruning --------------------------------------------------------------------------------

/** Removes stopped containers unused for longer than `containerTtl`, and orphaned ones. */
export function pruneContainers(engine: Engine, config: Config): void {
  const ttl = config.containerTtl === null ? undefined : parseDuration(config.containerTtl)
  const now = Date.now()
  const infos = new Map(engine.listContainers().map((info) => [info.name, info]))
  const known = new Set<string>()

  for (const record of listAllRecords()) {
    known.add(record.name)
    const info = infos.get(record.name)
    if (info?.running) continue
    const expired = ttl !== undefined && now - Date.parse(record.lastUsedAt) > ttl
    if (!expired) continue
    if (info) {
      engine.capture(["rm", "-f", record.name])
      log(`removed unused container ${record.name} (${record.cwd})`)
    }
    // Keep the record while it has sessions, so they can be resumed in a recreated container.
    const dir = sessionsPath(record)
    if (!existsSync(dir) || readdirSync(dir).length === 0) deleteRecord(record)
  }

  for (const info of infos.values()) {
    if (!known.has(info.name) && !info.running) engine.capture(["rm", "-f", info.name])
  }
}

function hasTag(image: RawImage, tag: string): boolean {
  return (image.RepoTags ?? []).some((t) => t === tag || t.endsWith(`/${tag}`))
}

/** Removes stopped containers on stale images, then pi2 images no container uses anymore. */
export function pruneImages(engine: Engine, currentTag: string): void {
  for (const info of engine.listContainers()) {
    if (!info.running && info.labels["pi2.image"] !== currentTag)
      engine.capture(["rm", "-f", info.name])
  }
  for (const image of engine.listImages()) {
    if (hasTag(image, currentTag)) continue
    // Fails while a running container still uses the image; retried on a later prune.
    if (engine.capture(["rmi", image.Id]).code === 0)
      log(`removed old image ${image.RepoTags?.[0] ?? image.Id}`)
  }
}

const MAINTENANCE_INTERVAL = 60 * 60 * 1000

/** Runs container and image pruning at most once per hour. */
export function maintenance(
  engine: Engine,
  config: Config,
  currentTag: string,
  force = false,
): void {
  const last = readCache().lastPruneAt
  if (!force && last && Date.now() - Date.parse(last) < MAINTENANCE_INTERVAL) return
  updateCache({ lastPruneAt: new Date().toISOString() })
  pruneContainers(engine, config)
  pruneImages(engine, currentTag)
}
