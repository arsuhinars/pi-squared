import assert from "node:assert/strict"
import { test } from "node:test"
import { parseArgs } from "./cli.ts"

test("forwards pi args unchanged and extracts pi2 flags", () => {
  const args = parseArgs([
    "-m",
    "~/data",
    "--model",
    "sonnet",
    "--mount=/tmp:/t:ro",
    "--no-mounts",
    "fix it",
  ])
  assert.deepEqual(args.mounts, ["~/data", "/tmp:/t:ro"])
  assert.equal(args.noMounts, true)
  assert.deepEqual(args.piArgs, ["--model", "sonnet", "fix it"])
  assert.equal(args.command, undefined)
})

test("values of pi flags are never treated as pi2 flags", () => {
  const args = parseArgs(["--name", "-m", "--append-system-prompt", "--rebuild"])
  assert.deepEqual(args.mounts, [])
  assert.equal(args.rebuild, false)
  assert.deepEqual(args.piArgs, ["--name", "-m", "--append-system-prompt", "--rebuild"])
})

test("subcommands are recognised only as the first argument", () => {
  assert.equal(parseArgs(["install", "npm:foo", "-l"]).command, "install")
  assert.deepEqual(parseArgs(["install", "npm:foo", "-l"]).piArgs, ["install", "npm:foo", "-l"])
  assert.equal(parseArgs(["--name", "shell"]).command, undefined)
  assert.equal(parseArgs(["build the thing"]).command, undefined)
  assert.deepEqual(parseArgs(["shell", "-m", "/x"]).mounts, ["/x"])
})

test("session targets", () => {
  assert.equal(parseArgs(["-c"]).target.continue, true)
  assert.equal(parseArgs(["--session", "abc"]).target.session, "abc")
  assert.equal(parseArgs(["--fork", "abc"]).target.fork, "abc")
  assert.equal(parseArgs(["-r"]).target.resume, true)
})

test("unknown extension flags consume a following value", () => {
  const args = parseArgs(["--plan-mode", "-m", "/x", "--ext-flag", "value", "-c"])
  assert.deepEqual(args.mounts, ["/x"])
  assert.deepEqual(args.piArgs, ["--plan-mode", "--ext-flag", "value", "-c"])
  assert.equal(args.target.continue, true)
})

test("arguments after -- are forwarded verbatim", () => {
  const args = parseArgs(["--", "-m", "x"])
  assert.deepEqual(args.mounts, [])
  assert.deepEqual(args.piArgs, ["--", "-m", "x"])
})
