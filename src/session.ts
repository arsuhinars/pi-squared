import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, posix, resolve } from "node:path"
import type { ParsedArgs } from "./cli.ts"
import { agentDir, encodeCwd, expandHome, stateDir, type Config } from "./config.ts"
import { WORKSPACE_DIR } from "./render.ts"
import { newId, Pi2Error, shortHash } from "./util.ts"

export interface Mount {
  host: string
  target: string
  readonly: boolean
}

export interface ContainerRecord {
  name: string
  cwd: string
  workdir: string
  mounts: Mount[]
  mountsKey: string
  image: string
  createdAt: string
  lastUsedAt: string
}

// --- Mounts ---------------------------------------------------------------------------------

export function workdirFor(cwd: string): string {
  return posix.join(WORKSPACE_DIR, basename(cwd) || "root")
}

/** Parses `<host>[:<container>][:ro|rw]`. Relative host paths resolve against `base`. */
export function parseMount(spec: string, base: string): Mount {
  const parts = spec.split(":")
  let readonly = false
  const mode = parts.at(-1)
  if (parts.length > 1 && (mode === "ro" || mode === "rw")) {
    readonly = mode === "ro"
    parts.pop()
  }
  if (parts.length > 2 || !parts[0]) throw new Pi2Error(`invalid mount "${spec}"`)

  const hostPath = resolve(base, expandHome(parts[0]))
  let host: string
  try {
    host = realpathSync(hostPath)
  } catch {
    throw new Pi2Error(`mount source does not exist: ${hostPath}`)
  }
  const target = parts[1] ?? posix.join(WORKSPACE_DIR, basename(host) || "root")
  if (!target.startsWith("/")) throw new Pi2Error(`mount target must be absolute: "${spec}"`)
  if (host.includes(",") || target.includes(",")) {
    throw new Pi2Error(`mount paths must not contain commas: "${spec}"`)
  }
  return { host, target: posix.normalize(target), readonly }
}

/** Merges mount lists (later entries win per target) and sorts them by target. */
export function normalizeMounts(mounts: Mount[], workdir: string): Mount[] {
  const byTarget = new Map<string, Mount>()
  for (const mount of mounts) byTarget.set(mount.target, mount)
  if (byTarget.has(workdir)) {
    throw new Pi2Error(
      `mount target ${workdir} collides with the working directory; set an explicit target`,
    )
  }
  return [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target))
}

export function mountsKey(mounts: Mount[]): string {
  return shortHash(JSON.stringify(mounts.map((m) => [m.host, m.target, m.readonly])))
}

// --- Records --------------------------------------------------------------------------------

export function cwdStateDir(cwd: string): string {
  return join(stateDir(), encodeCwd(cwd))
}

export function recordPath(record: Pick<ContainerRecord, "cwd" | "name">): string {
  return join(cwdStateDir(record.cwd), `${record.name}.json`)
}

/** Host directory holding this container's Pi sessions. */
export function sessionsPath(record: Pick<ContainerRecord, "cwd" | "name">): string {
  return join(cwdStateDir(record.cwd), record.name)
}

function readRecords(dir: string): ContainerRecord[] {
  if (!existsSync(dir)) return []
  const records: ContainerRecord[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("pi2-") || !entry.endsWith(".json")) continue
    try {
      records.push(JSON.parse(readFileSync(join(dir, entry), "utf8")) as ContainerRecord)
    } catch {
      // Ignore unreadable records; they are recreated on demand.
    }
  }
  return records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
}

/** Records for one working directory, most recently used first. */
export function listRecords(cwd: string): ContainerRecord[] {
  return readRecords(cwdStateDir(cwd))
}

export function listAllRecords(): ContainerRecord[] {
  const root = stateDir()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((entry) => entry.startsWith("--"))
    .flatMap((entry) => readRecords(join(root, entry)))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
}

export function saveRecord(record: ContainerRecord): void {
  writeFileSync(recordPath(record), `${JSON.stringify(record, null, 2)}\n`)
}

/** Creates a record with a fresh `pi2-<hex timestamp>` name, atomically claimed on disk. */
export function createRecord(cwd: string, mounts: Mount[], image: string): ContainerRecord {
  mkdirSync(cwdStateDir(cwd), { recursive: true })
  const now = new Date().toISOString()
  for (let attempt = 0; attempt < 10; attempt++) {
    const record: ContainerRecord = {
      name: `pi2-${newId()}`,
      cwd,
      workdir: workdirFor(cwd),
      mounts,
      mountsKey: mountsKey(mounts),
      image,
      createdAt: now,
      lastUsedAt: now,
    }
    try {
      writeFileSync(recordPath(record), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
    mkdirSync(sessionsPath(record), { recursive: true })
    return record
  }
  throw new Pi2Error("could not allocate a container name")
}

export function deleteRecord(record: ContainerRecord): void {
  rmSync(recordPath(record), { force: true })
  rmSync(sessionsPath(record), { recursive: true, force: true })
}

// --- Sessions -------------------------------------------------------------------------------

interface SessionFile {
  record: ContainerRecord
  file: string
  id: string
  mtime: number
}

export function sessionFiles(record: ContainerRecord): SessionFile[] {
  const dir = sessionsPath(record)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => ({
      record,
      file,
      id: file.slice(file.indexOf("_") + 1, -".jsonl".length),
      mtime: statSync(join(dir, file)).mtimeMs,
    }))
}

/** Finds the container owning the session that `-c`, `--session` or `--fork` refer to. */
export function findSessionOwner(
  records: ContainerRecord[],
  target: ParsedArgs["target"],
): ContainerRecord | undefined {
  const files = records.flatMap(sessionFiles)
  if (target.continue) {
    return files.sort((a, b) => b.mtime - a.mtime)[0]?.record
  }
  const query = target.session ?? target.fork
  if (query === undefined) return undefined
  if (query.endsWith(".jsonl") || query.includes("/")) {
    const name = basename(query)
    return files.find((f) => f.file === name)?.record
  }
  return (files.find((f) => f.id === query) ?? files.find((f) => f.id.startsWith(query)))?.record
}

// --- Selection ------------------------------------------------------------------------------

export interface Selection {
  record: ContainerRecord
  created: boolean
}

/**
 * Picks the container record for this invocation:
 * - `-m`/`--no-mounts`: the record with exactly global (+ explicit) mounts;
 * - `-c`/`--session`/`--fork`: the record owning that session;
 * - otherwise: any record of the cwd, running ones first.
 */
export function selectRecord(
  config: Config,
  args: ParsedArgs,
  cwd: string,
  image: string,
  running: Set<string>,
): Selection {
  const records = listRecords(cwd)
  const workdir = workdirFor(cwd)
  const globalMounts = config.mounts.map((spec) => parseMount(spec, homedir()))

  if (args.mounts.length > 0 || args.noMounts) {
    const explicit = args.mounts.map((spec) => parseMount(spec, cwd))
    const mounts = normalizeMounts([...globalMounts, ...explicit], workdir)
    const key = mountsKey(mounts)
    const record = records.find((r) => r.mountsKey === key)
    return record
      ? { record, created: false }
      : { record: createRecord(cwd, mounts, image), created: true }
  }

  const owner = findSessionOwner(records, args.target)
  if (owner) return { record: owner, created: false }

  const record = records.find((r) => running.has(r.name)) ?? records[0]
  if (record) return { record, created: false }
  return { record: createRecord(cwd, normalizeMounts(globalMounts, workdir), image), created: true }
}

// --- Shared state files ---------------------------------------------------------------------

export interface Cache {
  latestPiVersion?: string
  checkedAt?: string
  lastPruneAt?: string
  image?: { tag: string; settings: Record<string, unknown> }
}

function cachePath(): string {
  return join(stateDir(), "cache.json")
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function readCache(): Cache {
  return (readJson(cachePath()) as Cache | undefined) ?? {}
}

export function updateCache(update: Partial<Cache>): Cache {
  const cache = { ...readCache(), ...update }
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(cachePath(), `${JSON.stringify(cache, null, 2)}\n`)
  return cache
}

export function containerSettingsPath(): string {
  return join(stateDir(), "settings.json")
}

/**
 * Writes the settings.json mounted into every container. Starts from the previous container
 * settings (so changes made inside persist) or the host settings, but always takes packages
 * and extensions from the image and drops host-only paths.
 */
export function writeContainerSettings(
  config: Config,
  imageSettings: Record<string, unknown>,
): string {
  const path = containerSettingsPath()
  const base = readJson(path) ?? readJson(join(agentDir(), "settings.json")) ?? {}
  delete base.packages
  delete base.extensions
  delete base.sessionDir
  const merged: Record<string, unknown> = { ...base }
  if (imageSettings.packages !== undefined) merged.packages = imageSettings.packages
  if (imageSettings.extensions !== undefined) merged.extensions = imageSettings.extensions
  Object.assign(merged, config.settings)
  const content = `${JSON.stringify(merged, null, 2)}\n`
  mkdirSync(stateDir(), { recursive: true })
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content)
  return path
}

export function isInside(path: string, dir: string): boolean {
  return isAbsolute(path) && (path === dir || path.startsWith(`${dir}/`))
}
