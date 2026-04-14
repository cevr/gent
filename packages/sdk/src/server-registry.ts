/**
 * Server registry — discovery + lifecycle for shared gent servers.
 *
 * Components:
 * - BuildFingerprint: identifies gent executable/source version
 * - ServerRegistry: per-DB registry file at ~/.gent/servers/<hash>.json
 * - CrossProcessLock: mkdir-based lock for startup serialization
 */

// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto"
// @effect-diagnostics nodeBuiltinImport:off
import { hostname } from "node:os"
// @effect-diagnostics nodeBuiltinImport:off
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  statSync,
} from "node:fs"
// @effect-diagnostics nodeBuiltinImport:off
import { join, resolve } from "node:path"
// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url"

import { Config, Effect, Option, Schema } from "effect"

// ── Build Fingerprint ──

/**
 * Compute a build fingerprint from local sources (no env).
 * Priority: binary mtime → gent source git hash → "unknown"
 */
export const computeLocalFingerprint = (): string => {
  // 1. Binary mtime (compiled mode)
  try {
    const stat = statSync(process.execPath)
    return `bin-${stat.mtimeMs.toString(36)}`
  } catch {
    // not a compiled binary or stat failed
  }

  // 2. Git hash from gent source root (dev mode)
  try {
    const gentRoot = resolve(fileURLToPath(import.meta.url), "../../..")
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: gentRoot })
    const hash = new TextDecoder().decode(proc.stdout).trim()
    if (hash.length > 0) return `src-${hash}`
  } catch {
    // no git or not in repo
  }

  return "unknown"
}

/**
 * Resolve the build fingerprint via Effect Config.
 * Priority: GENT_BUILD_FINGERPRINT env → local computation
 */
/** Resolve the build fingerprint. Env var takes precedence, then local computation. */
export const resolveBuildFingerprint: Effect.Effect<string> = Effect.succeed(
  computeLocalFingerprint(),
).pipe(
  Effect.flatMap((local) =>
    Effect.gen(function* () {
      const opt: Option.Option<string> = yield* Config.option(
        Config.string("GENT_BUILD_FINGERPRINT"),
      )
      return Option.isSome(opt) && opt.value !== "" ? opt.value : local
    }).pipe(Effect.catchEager(() => Effect.succeed(local))),
  ),
)

// ── Server Registry ──

export class ServerRegistryEntry extends Schema.Class<ServerRegistryEntry>("ServerRegistryEntry")({
  serverId: Schema.String,
  pid: Schema.Number,
  hostname: Schema.String,
  rpcUrl: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
  startedAt: Schema.Number,
}) {}

const ServerRegistryEntryJson = Schema.fromJsonString(ServerRegistryEntry)

/** Hash for registry key: hostname + canonical dbPath */
const registryHash = (dbPath: string): string => {
  const host = hostname()
  const canonical = resolve(dbPath)
  return createHash("sha256").update(`${host}\0${canonical}`).digest("hex").slice(0, 16)
}

const ensureRegistryDir = (home: string): string => {
  const dir = join(home, ".gent", "servers")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const registryPath = (home: string, dbPath: string): string =>
  join(ensureRegistryDir(home), `${registryHash(dbPath)}.json`)

/** Read a registry entry. Returns undefined if missing, corrupt, or from a different host. */
export const readRegistryEntry = (
  home: string,
  dbPath: string,
): ServerRegistryEntry | undefined => {
  const path = registryPath(home, dbPath)
  try {
    const content = readFileSync(path, "utf8")
    const entry = Schema.decodeUnknownSync(ServerRegistryEntryJson)(content)
    // Reject entries from a different host
    if (entry.hostname !== hostname()) return undefined
    return entry
  } catch {
    return undefined
  }
}

/** Write a registry entry. */
export const writeRegistryEntry = (home: string, entry: ServerRegistryEntry): void => {
  const path = registryPath(home, entry.dbPath)
  const json = Schema.encodeSync(ServerRegistryEntryJson)(entry)
  writeFileSync(path, json)
}

/** Remove a registry entry, but only if serverId matches (prevent stale race). */
export const removeRegistryEntry = (home: string, dbPath: string, serverId: string): boolean => {
  const current = readRegistryEntry(home, dbPath)
  if (current === undefined || current.serverId !== serverId) return false
  try {
    unlinkSync(registryPath(home, dbPath))
    return true
  } catch {
    return false
  }
}

/** Check if a PID is alive on the local machine. */
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Validate a registry entry: PID alive, serverId matches, same host. */
export const validateRegistryEntry = (
  entry: ServerRegistryEntry,
): { valid: boolean; reason?: string } => {
  if (entry.hostname !== hostname()) {
    return { valid: false, reason: "different-host" }
  }
  if (!isPidAlive(entry.pid)) {
    return { valid: false, reason: "dead-pid" }
  }
  return { valid: true }
}

// ── Cross-Process Lock ──

const LOCK_STALE_AGE_MS = 60_000

interface LockInfo {
  pid: number
  hostname: string
  createdAt: number
}

/** Acquire a cross-process lock via mkdir. Returns true on success. */
export const acquireLock = (home: string, dbPath: string): boolean => {
  const lockDir = join(ensureRegistryDir(home), `${registryHash(dbPath)}.lock`)
  const infoPath = join(lockDir, "info.json")

  // Try to create lock directory (atomic on local FS)
  try {
    mkdirSync(lockDir)
  } catch {
    // Lock exists — check if stale
    try {
      const info: LockInfo = JSON.parse(readFileSync(infoPath, "utf8"))
      const age = Date.now() - info.createdAt
      const isLocal = info.hostname === hostname()
      const isAlive = isLocal && isPidAlive(info.pid)

      if (age > LOCK_STALE_AGE_MS || (isLocal && !isAlive)) {
        // Stale lock — force cleanup and retry
        try {
          unlinkSync(infoPath)
        } catch {
          // ignore
        }
        try {
          rmdirSync(lockDir)
        } catch {
          // ignore
        }
        try {
          mkdirSync(lockDir)
        } catch {
          return false
        }
      } else {
        return false
      }
    } catch {
      return false
    }
  }

  // Write lock info
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  }
  try {
    writeFileSync(infoPath, JSON.stringify(info))
  } catch {
    // Cleanup on failure
    try {
      rmdirSync(lockDir)
    } catch {
      // ignore
    }
    return false
  }
  return true
}

/** Release a cross-process lock. Only releases if we own it (PID match). */
export const releaseLock = (home: string, dbPath: string): void => {
  const lockDir = join(ensureRegistryDir(home), `${registryHash(dbPath)}.lock`)
  const infoPath = join(lockDir, "info.json")
  try {
    const info: LockInfo = JSON.parse(readFileSync(infoPath, "utf8"))
    if (info.pid !== process.pid || info.hostname !== hostname()) return
    unlinkSync(infoPath)
    rmdirSync(lockDir)
  } catch {
    // Already gone or not ours
  }
}

/** Effect wrapper for lock acquire + body + release. */
export const withLock = <A, E>(
  home: string,
  dbPath: string,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E | LockAcquireError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (!acquireLock(home, dbPath)) {
        throw new LockAcquireError({ dbPath })
      }
    }),
    () => body,
    () => Effect.sync(() => releaseLock(home, dbPath)),
  )

export class LockAcquireError extends Schema.TaggedErrorClass<LockAcquireError>()(
  "LockAcquireError",
  { dbPath: Schema.String },
) {}
