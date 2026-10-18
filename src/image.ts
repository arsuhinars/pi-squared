import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PI_PACKAGE, type Config } from "./config.ts"
import { pruneImages, type Engine } from "./container.ts"
import { AGENT_DIR, imageTag, renderDockerfile } from "./render.ts"
import { readCache, updateCache } from "./session.ts"
import { log, Pi2Error } from "./util.ts"

const VERSION_TTL = 24 * 60 * 60 * 1000

export async function resolvePiVersion(config: Config, refresh = false): Promise<string> {
  if (config.pi.version !== "latest") return config.pi.version
  const cache = readCache()
  const fresh = cache.checkedAt && Date.now() - Date.parse(cache.checkedAt) < VERSION_TTL
  const offline = process.env.PI_OFFLINE === "1"
  if (cache.latestPiVersion && (offline || (fresh && !refresh))) return cache.latestPiVersion

  try {
    const response = await fetch(`https://registry.npmjs.org/${PI_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { version } = (await response.json()) as { version: string }
    updateCache({ latestPiVersion: version, checkedAt: new Date().toISOString() })
    return version
  } catch (error) {
    if (cache.latestPiVersion) return cache.latestPiVersion
    throw new Pi2Error(
      `cannot resolve the latest pi version (${(error as Error).message}); set "pi.version" in the config`,
    )
  }
}

export interface Image {
  tag: string
  /** The image's own settings.json, written by `pi install` (packages, extensions). */
  settings: Record<string, unknown>
}

function readImageSettings(engine: Engine, tag: string): Record<string, unknown> {
  const result = engine.capture([
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    tag,
    `${AGENT_DIR}/settings.json`,
  ])
  if (result.code !== 0) return {}
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The image the current config describes, without building it. */
export async function currentImage(config: Config, refresh = false) {
  const version = await resolvePiVersion(config, refresh)
  const dockerfile = renderDockerfile(config, version)
  return { version, dockerfile, tag: imageTag(dockerfile) }
}

/**
 * Returns the image for the current config, building it if needed. `force` rebuilds without
 * cache (picking up new package versions); `refresh` re-resolves `latest` from the registry.
 */
export async function ensureImage(
  engine: Engine,
  config: Config,
  options: { force?: boolean; refresh?: boolean } = {},
): Promise<Image> {
  const { version, dockerfile, tag } = await currentImage(config, options.refresh)
  const cached = readCache().image

  if (!options.force && engine.imageExists(tag)) {
    if (cached?.tag === tag) return cached
    const image = { tag, settings: readImageSettings(engine, tag) }
    updateCache({ image })
    return image
  }

  log(`building image ${tag} (pi ${version})`)
  const dir = mkdtempSync(join(tmpdir(), "pi2-build-"))
  try {
    const file = join(dir, "Dockerfile")
    writeFileSync(file, dockerfile)
    const args = [
      "build",
      "-t",
      tag,
      "--label",
      "pi2.managed=1",
      "--label",
      `pi2.pi-version=${version}`,
      "-f",
      file,
    ]
    if (options.force)
      args.push("--no-cache", engine.name === "podman" ? "--pull=always" : "--pull")
    args.push(dir)
    // Build output goes to stderr so stdout stays clean for `pi -p`.
    const code = await engine.spawn(args, { stdio: ["ignore", 2, 2] })
    if (code !== 0) throw new Pi2Error(`image build failed (exit ${code})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const image = { tag, settings: readImageSettings(engine, tag) }
  updateCache({ image })
  pruneImages(engine, tag)
  return image
}
