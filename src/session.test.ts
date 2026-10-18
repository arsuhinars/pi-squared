import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { parseArgs } from "./cli.ts"
import { encodeCwd, parseConfig } from "./config.ts"
import { imageTag, renderDockerfile } from "./render.ts"
import {
  findSessionOwner,
  listRecords,
  normalizeMounts,
  parseMount,
  selectRecord,
  sessionsPath,
  writeContainerSettings,
} from "./session.ts"
import { newId } from "./util.ts"

let root: string
let project: string
let data: string

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi2-test-")))
  process.env.PI_CODING_AGENT_DIR = join(root, "agent")
  project = join(root, "proj")
  data = join(root, "data")
  mkdirSync(project)
  mkdirSync(data)
})

test("encodeCwd matches pi", () => {
  assert.equal(encodeCwd("/Users/foo/bar"), "--Users-foo-bar--")
})

test("newId is hex and strictly increasing", () => {
  const ids = Array.from({ length: 50 }, newId)
  assert.ok(ids.every((id) => /^[0-9a-f]+$/.test(id)))
  for (let i = 1; i < ids.length; i++) assert.ok(parseInt(ids[i]!, 16) > parseInt(ids[i - 1]!, 16))
})

test("parseMount defaults and options", () => {
  assert.deepEqual(parseMount("data", root), {
    host: data,
    target: "/workspace/data",
    readonly: false,
  })
  assert.deepEqual(parseMount(`${data}:/d:ro`, "/"), { host: data, target: "/d", readonly: true })
  assert.throws(() => parseMount(join(root, "missing"), "/"), /does not exist/)
  assert.throws(() => parseMount(`${data}:rel`, "/"), /absolute/)
  assert.throws(
    () => normalizeMounts([parseMount(`${data}:/workspace/proj`, "/")], "/workspace/proj"),
    /collides/,
  )
})

test("config defaults and validation", () => {
  const config = parseConfig({})
  assert.equal(config.runtime, "auto")
  assert.equal(config.pi.version, "latest")
  assert.equal(config.containerTtl, "7d")
  assert.ok(config.image.systemPackages.includes("ripgrep"))
  assert.throws(() => parseConfig({ runtime: "lxc" }), /runtime/)
  assert.throws(() => parseConfig({ containerTtl: "soon" }), /containerTtl/)
  assert.throws(() => parseConfig({ typo: 1 }), /typo/)
})

test("dockerfile hash is stable and tracks config", () => {
  const config = parseConfig({ packages: ["npm:foo"] })
  const a = renderDockerfile(config, "1.3.0")
  assert.equal(
    imageTag(a),
    imageTag(renderDockerfile(parseConfig({ packages: ["npm:foo"] }), "1.3.0")),
  )
  assert.notEqual(imageTag(a), imageTag(renderDockerfile(config, "1.3.1")))
  assert.match(a, /RUN pi install npm:foo/)
  assert.match(renderDockerfile(parseConfig({ image: { base: "node:24-alpine" } }), "1"), /apk add/)
})

test("container selection", () => {
  const config = parseConfig({})
  const none = new Set<string>()

  const first = selectRecord(config, parseArgs([]), project, "pi2:a", none)
  assert.equal(first.created, true)
  assert.match(first.record.name, /^pi2-[0-9a-f]+$/)
  assert.equal(first.record.workdir, "/workspace/proj")

  // No mount flags: reuse whatever exists.
  assert.equal(
    selectRecord(config, parseArgs([]), project, "pi2:a", none).record.name,
    first.record.name,
  )

  // Explicit mounts: a separate container, reused for the same mounts.
  const mounted = selectRecord(config, parseArgs(["-m", data]), project, "pi2:a", none)
  assert.equal(mounted.created, true)
  assert.equal(
    selectRecord(config, parseArgs(["-m", data]), project, "pi2:a", none).record.name,
    mounted.record.name,
  )

  // Plain run prefers the running container; --no-mounts picks the mount-less one.
  const running = new Set([mounted.record.name])
  assert.equal(
    selectRecord(config, parseArgs([]), project, "pi2:a", running).record.name,
    mounted.record.name,
  )
  assert.equal(
    selectRecord(config, parseArgs(["--no-mounts"]), project, "pi2:a", running).record.name,
    first.record.name,
  )

  // -c follows the newest session.
  writeFileSync(join(sessionsPath(first.record), "2026-10-18T10-00-00_aaaa-1.jsonl"), "{}\n")
  assert.equal(
    selectRecord(config, parseArgs(["-c"]), project, "pi2:a", running).record.name,
    first.record.name,
  )
  assert.equal(
    findSessionOwner(listRecords(project), { continue: false, resume: false, session: "aaaa" })
      ?.name,
    first.record.name,
  )
})

test("container settings take packages from the image only", () => {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true })
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
    JSON.stringify({ theme: "dark", packages: ["npm:host-only"], sessionDir: "/host" }),
  )
  const config = parseConfig({ settings: { defaultThinkingLevel: "high" } })
  writeContainerSettings(config, { packages: ["npm:image"] })
  const path = writeContainerSettings(config, { packages: ["npm:image"] })
  const written = JSON.parse(readFileSync(path, "utf8"))
  assert.deepEqual(written, {
    theme: "dark",
    packages: ["npm:image"],
    defaultThinkingLevel: "high",
  })
})
