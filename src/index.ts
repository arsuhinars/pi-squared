#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import packageJson from "../package.json" with { type: "json" }
import { HELP, parseArgs, PI2_COMMANDS, PACKAGE_COMMANDS, type ParsedArgs } from "./cli.ts"
import { loadConfig, readRawConfig, saveRawConfig, type Config } from "./config.ts"
import { Engine, ensureContainer, maintenance } from "./container.ts"
import { currentImage, ensureImage } from "./image.ts"
import {
  deleteRecord,
  listAllRecords,
  readCache,
  saveRecord,
  selectRecord,
  writeContainerSettings,
} from "./session.ts"
import { globToRegExp, log, Pi2Error } from "./util.ts"

interface Context {
  engine: Engine
  config: Config
  args: ParsedArgs
  cwd: string
}

function isTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/**
 * Env passed to `exec`. Variables are passed by name only (`-e NAME`), so the runtime reads
 * values from our environment and secrets never appear in the process list.
 */
function execEnv(config: Config): { args: string[]; env: NodeJS.ProcessEnv } {
  const patterns = config.forwardEnv.map(globToRegExp)
  const names = new Set(
    Object.keys(process.env).filter(
      (name) => process.env[name] !== undefined && patterns.some((p) => p.test(name)),
    ),
  )
  for (const name of Object.keys(config.env)) names.add(name)
  return {
    args: [...names].flatMap((name) => ["-e", name]),
    env: { ...process.env, ...config.env },
  }
}

/** Runs `command` in the working directory's container, creating or starting it as needed. */
async function inContainer(ctx: Context, command: string[]): Promise<number> {
  const { engine, config, args, cwd } = ctx
  const image = await ensureImage(engine, config, { force: args.rebuild })
  writeContainerSettings(config, image.settings)
  const running = new Set(
    engine
      .listContainers({ "pi2.cwd": cwd })
      .filter((c) => c.running)
      .map((c) => c.name),
  )
  const { record, created } = selectRecord(config, args, cwd, image.tag, running)
  try {
    ensureContainer(engine, config, record, image.tag)
  } catch (error) {
    if (created) deleteRecord(record)
    throw error
  }
  record.lastUsedAt = new Date().toISOString()
  saveRecord(record)

  const env = execEnv(config)
  const execArgs = [
    "exec",
    "-i",
    ...(isTty() ? ["-t"] : []),
    "-w",
    record.workdir,
    ...env.args,
    record.name,
    ...command,
  ]
  const startedAt = Date.now()
  let code = await engine.spawn(execArgs, { env: env.env })
  // Another pi2 may have stopped the container just as we exec'd into it: start it and retry.
  if (code !== 0 && Date.now() - startedAt < 3000 && !engine.containerInfo(record.name)?.running) {
    engine.run(["start", record.name])
    code = await engine.spawn(execArgs, { env: env.env })
  }

  record.lastUsedAt = new Date().toISOString()
  saveRecord(record)
  engine.stopIfIdle(record.name)
  try {
    maintenance(engine, config, image.tag)
  } catch (error) {
    log(`pruning failed: ${(error as Error).message}`)
  }
  return code
}

/** Runs `command` in a throwaway container (no mounts), e.g. for `--version`. */
async function once(ctx: Context, command: string[]): Promise<number> {
  const image = await ensureImage(ctx.engine, ctx.config, { force: ctx.args.rebuild })
  return ctx.engine.spawn(["run", "--rm", "-i", ...(isTty() ? ["-t"] : []), image.tag, ...command])
}

async function packageCommand(ctx: Context): Promise<number> {
  const { engine, args } = ctx
  const [name, ...rest] = args.piArgs
  if (rest.includes("-h") || rest.includes("--help")) return once(ctx, ["pi", ...args.piArgs])
  // Project-local packages live in the mounted working directory, so pi handles them itself.
  if (
    rest.includes("-l") ||
    rest.includes("--local") ||
    (name === "update" && rest.includes("--models"))
  ) {
    return inContainer(ctx, ["pi", ...args.piArgs])
  }

  switch (name) {
    case "install":
    case "remove":
    case "uninstall": {
      const sources = rest.filter((arg) => !arg.startsWith("-"))
      if (sources.length === 0) throw new Pi2Error(`usage: pi2 ${name} <source>`)
      const raw = readRawConfig()
      const current = Array.isArray(raw.packages)
        ? raw.packages.filter((s): s is string => typeof s === "string")
        : []
      raw.packages =
        name === "install"
          ? [...new Set([...current, ...sources])]
          : current.filter((s) => !sources.includes(s))
      ctx.config = saveRawConfig(raw)
      const image = await ensureImage(engine, ctx.config, { force: args.rebuild })
      log(`image ${image.tag} is up to date`)
      return 0
    }
    case "update": {
      const image = await ensureImage(engine, ctx.config, { force: true, refresh: true })
      log(`image ${image.tag} is up to date`)
      return 0
    }
    default: {
      const { tag, version } = await currentImage(ctx.config)
      console.log(`image: ${tag}${engine.imageExists(tag) ? "" : " (not built)"}\npi: ${version}`)
      console.log(
        ctx.config.packages.length
          ? `packages:\n${ctx.config.packages.map((p) => `  ${p}`).join("\n")}`
          : "packages: none",
      )
      return 0
    }
  }
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  for (const row of rows)
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
}

function tildify(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function ps(ctx: Context): number {
  const current = readCache().image?.tag
  const infos = new Map(ctx.engine.listContainers().map((info) => [info.name, info]))
  const rows = [["NAME", "STATE", "IMAGE", "MOUNTS", "LAST USED", "CWD"]]
  for (const record of listAllRecords()) {
    const info = infos.get(record.name)
    const image = info?.labels["pi2.image"] ?? record.image
    rows.push([
      record.name,
      info ? (info.running ? "running" : "stopped") : "removed",
      image === current ? image : `${image} (old)`,
      record.mounts
        .map((m) => `${tildify(m.host)}:${m.target}${m.readonly ? ":ro" : ""}`)
        .join(",") || "-",
      relativeTime(record.lastUsedAt),
      tildify(record.cwd),
    ])
  }
  printTable(rows)
  return 0
}

function stop(ctx: Context): number {
  const all = ctx.args.piArgs.includes("--all")
  const names = ctx.engine
    .listContainers(all ? {} : { "pi2.cwd": ctx.cwd })
    .filter((c) => c.running)
    .map((c) => c.name)
  if (names.length > 0) ctx.engine.run(["stop", "-t", "2", ...names])
  log(names.length > 0 ? `stopped ${names.join(", ")}` : "no running containers")
  return 0
}

async function pi2Command(ctx: Context): Promise<number> {
  switch (ctx.args.command) {
    case "shell":
      return inContainer(ctx, ["sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"])
    case "ps":
      return ps(ctx)
    case "stop":
      return stop(ctx)
    case "build": {
      const image = await ensureImage(ctx.engine, ctx.config, { force: ctx.args.rebuild })
      console.log(image.tag)
      return 0
    }
    default: {
      const { tag } = await currentImage(ctx.config)
      maintenance(ctx.engine, ctx.config, tag, true)
      return 0
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const config = loadConfig()
  const ctx: Context = {
    engine: Engine.detect(config.runtime),
    config,
    args,
    cwd: realpathSync(process.cwd()),
  }

  if (args.command && PI2_COMMANDS.has(args.command)) return pi2Command(ctx)
  if (args.command && PACKAGE_COMMANDS.has(args.command)) return packageCommand(ctx)
  if (!args.command && args.version) {
    console.log(`pi2 ${packageJson.version}`)
    return once(ctx, ["pi", "--version"])
  }
  if (!args.command && args.help) {
    const code = await once(ctx, ["pi", "--help"])
    console.log(`\n${HELP}`)
    return code
  }
  return inContainer(ctx, ["pi", ...args.piArgs])
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (!(error instanceof Pi2Error)) throw error
    log(error.message)
    process.exit(1)
  },
)
