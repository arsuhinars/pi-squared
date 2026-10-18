import { createHash } from "node:crypto"

/** Expected, user-facing failure: printed without a stack trace. */
export class Pi2Error extends Error {}

export function log(message: string): void {
  process.stderr.write(`pi2: ${message}\n`)
}

export function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

let lastId = 0

/** Unique, monotonically increasing id: current timestamp in milliseconds, hex encoded. */
export function newId(): string {
  let now = Date.now()
  if (now <= lastId) now = lastId + 1
  lastId = now
  return now.toString(16)
}

export function shQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

export const DURATION_RE = /^(\d+)(s|m|h|d|w)$/

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
}

/** Parses durations like `30m`, `12h`, `7d` into milliseconds. */
export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value)
  if (!match) throw new Pi2Error(`invalid duration "${value}"`)
  return Number(match[1]) * DURATION_UNITS[match[2]!]!
}

export function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  return new RegExp(`^${source}$`)
}
