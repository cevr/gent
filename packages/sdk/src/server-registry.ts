/**
 * Server registry — discovery + lifecycle for shared gent servers.
 *
 * Components:
 * - BuildFingerprint: identifies gent executable/source version
 * - ServerRegistry: per-DB registry file at ~/.gent/servers/<hash>.json
 * - CrossProcessLock: mkdir-based lock for startup serialization
 *
 * Filesystem and path operations route through Effect's `FileSystem`
 * and `Path` services. The boundary is the `FileSystem.FileSystem`
 * platform service — provided by `BunServices.layer` at the SDK edge.
 */

// @effect-diagnostics nodeBuiltinImport:off — registry key includes host identity
import { hostname } from "node:os"
import { createHash } from "node:crypto"

import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect"

// Re-export fingerprint from core (single source of truth)
export {
  computeLocalFingerprint,
  resolveBuildFingerprint,
} from "@gent/core/server/build-fingerprint.js"

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
const registryHash = (path: Path.Path, dbPath: string): string => {
  const host = hostname()
  const canonical = path.resolve(dbPath)
  return createHash("sha256").update(`${host}\0${canonical}`).digest("hex").slice(0, 16)
}

const ensureRegistryDir = (
  home: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(home, ".gent", "servers")
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
    return dir
  })

const registryPath = (
  home: string,
  dbPath: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const dir = yield* ensureRegistryDir(home)
    return path.join(dir, `${registryHash(path, dbPath)}.json`)
  })

/** Read a registry entry. Returns undefined if missing, corrupt, or from a different host. */
export const readRegistryEntry = (
  home: string,
  dbPath: string,
): Effect.Effect<ServerRegistryEntry | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* registryPath(home, dbPath)
    const content = yield* fs.readFileString(path).pipe(Effect.option)
    if (content._tag === "None") return undefined
    const decoded = Schema.decodeUnknownOption(ServerRegistryEntryJson)(content.value)
    if (decoded._tag === "None") return undefined
    if (decoded.value.hostname !== hostname()) return undefined
    return decoded.value
  })

/** Write a registry entry. */
export const writeRegistryEntry = (
  home: string,
  entry: ServerRegistryEntry,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* registryPath(home, entry.dbPath)
    const json = yield* Schema.encodeEffect(ServerRegistryEntryJson)(entry).pipe(Effect.orDie)
    yield* fs.writeFileString(path, json).pipe(Effect.ignore)
  })

/** Remove a registry entry, but only if serverId matches (prevent stale race). */
export const removeRegistryEntry = (
  home: string,
  dbPath: string,
  serverId: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const current = yield* readRegistryEntry(home, dbPath)
    if (current === undefined || current.serverId !== serverId) return false
    const path = yield* registryPath(home, dbPath)
    const removed = yield* fs.remove(path).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
    return removed
  })

/** Get the local hostname — uses node:os.hostname() (already in the keep list). */
export const getLocalHostname = (): string => hostname()

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

/** List all registry entries under the given home directory. */
export const listRegistryEntries = (
  home: string,
): Effect.Effect<ServerRegistryEntry[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(home, ".gent", "servers")
    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return []
    const files = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]))
    const entries: ServerRegistryEntry[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const content = yield* fs.readFileString(path.join(dir, file)).pipe(Effect.option)
      if (content._tag === "None") continue
      const decoded = Schema.decodeUnknownOption(ServerRegistryEntryJson)(content.value)
      if (decoded._tag === "Some") entries.push(decoded.value)
    }
    return entries
  })

// ── Cross-Process Lock ──

const LockInfoSchema = Schema.Struct({
  pid: Schema.Number,
  hostname: Schema.String,
  createdAt: Schema.Number,
})

const LockInfoJson = Schema.fromJsonString(LockInfoSchema)
const decodeLockInfo = Schema.decodeUnknownOption(LockInfoJson)
const encodeLockInfo = Schema.encodeSync(LockInfoJson)

const lockPaths = (
  home: string,
  dbPath: string,
): Effect.Effect<{ lockDir: string; infoPath: string }, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const dir = yield* ensureRegistryDir(home)
    const lockDir = path.join(dir, `${registryHash(path, dbPath)}.lock`)
    const infoPath = path.join(lockDir, "info.json")
    return { lockDir, infoPath }
  })

/** Acquire a cross-process lock via mkdir. Returns true on success. */
export const acquireLock = (
  home: string,
  dbPath: string,
  createdAt: number = 0,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { lockDir, infoPath } = yield* lockPaths(home, dbPath)

    const cleanupAndRetry = Effect.gen(function* () {
      yield* fs.remove(infoPath).pipe(Effect.ignore)
      yield* fs.remove(lockDir, { recursive: true }).pipe(Effect.ignore)
      return yield* fs.makeDirectory(lockDir).pipe(
        Effect.as(true),
        Effect.catchEager(() => Effect.succeed(false)),
      )
    })

    // Try to create lock directory (atomic on local FS)
    const createdFresh = yield* fs.makeDirectory(lockDir).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )

    if (!createdFresh) {
      // Lock dir exists — check if stale
      const infoText = yield* fs.readFileString(infoPath).pipe(Effect.option)
      const info =
        infoText._tag === "Some"
          ? decodeLockInfo(infoText.value).pipe(Option.getOrUndefined)
          : undefined

      if (info === undefined) {
        // Missing or corrupt info.json (crash between mkdir and write) — treat as stale
        const recovered = yield* cleanupAndRetry
        if (!recovered) return false
      } else {
        const isLocal = info.hostname === hostname()
        const isAlive = isLocal && isPidAlive(info.pid)
        if (isAlive) return false

        // Dead PID, different host, or age exceeded — stale
        const recovered = yield* cleanupAndRetry
        if (!recovered) return false
      }
    }

    // Write lock info
    const wrote = yield* fs
      .writeFileString(
        infoPath,
        encodeLockInfo({
          pid: process.pid,
          hostname: hostname(),
          createdAt,
        }),
      )
      .pipe(
        Effect.as(true),
        Effect.catchEager(() => Effect.succeed(false)),
      )
    if (!wrote) {
      yield* fs.remove(lockDir, { recursive: true }).pipe(Effect.ignore)
      return false
    }
    return true
  })

export interface ServerRegistryIdentity {
  readonly serverId: string
  readonly pid: number
  readonly hostname: string
  readonly dbPath: string
  readonly buildFingerprint: string
}

/** Full identity tuple a live gent server must report before its PID can be signaled. */
export const registryIdentityOf = (entry: ServerRegistryEntry): ServerRegistryIdentity => ({
  serverId: entry.serverId,
  pid: entry.pid,
  hostname: entry.hostname,
  dbPath: entry.dbPath,
  buildFingerprint: entry.buildFingerprint,
})

/** Local liveness precondition for signaling; not sufficient ownership proof by itself. */
export const canSignalRegistryEntry = (entry: ServerRegistryEntry): boolean =>
  entry.hostname === hostname() && isPidAlive(entry.pid)

/**
 * Signal a registry entry's PID with SIGTERM — only when the live process at
 * that URL proves it owns the full registry identity (serverId, pid, hostname,
 * dbPath, buildFingerprint). PID liveness alone is not sufficient: the kernel
 * may have recycled the PID to an unrelated process.
 *
 * The caller supplies a probe — an Effect that returns `true` iff the URL
 * reports an identity matching `registryIdentityOf(entry)`. Keeping the
 * HttpClient dependency in the caller lets this helper stay runtime-free.
 *
 * Returns `"signaled"` when SIGTERM was sent, `"skipped"` otherwise. Never
 * throws — signal failures map to `"skipped"`.
 */
export const signalIfIdentityOwned = <E, R>(
  entry: ServerRegistryEntry,
  probe: (entry: ServerRegistryEntry) => Effect.Effect<boolean, E, R>,
): Effect.Effect<"signaled" | "skipped", never, R> =>
  Effect.gen(function* () {
    if (!canSignalRegistryEntry(entry)) return "skipped" as const
    const owns = yield* probe(entry).pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (!owns) return "skipped" as const
    const sent = yield* Effect.try({
      try: () => process.kill(entry.pid, "SIGTERM"),
      catch: () => undefined,
    }).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
    return sent ? ("signaled" as const) : ("skipped" as const)
  })

/** Release a cross-process lock. Only releases if we own it (PID match). */
export const releaseLock = (
  home: string,
  dbPath: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { lockDir, infoPath } = yield* lockPaths(home, dbPath)
    const infoText = yield* fs.readFileString(infoPath).pipe(Effect.option)
    if (infoText._tag === "None") return
    const info = decodeLockInfo(infoText.value).pipe(Option.getOrUndefined)
    if (info === undefined) return
    if (info.pid !== process.pid || info.hostname !== hostname()) return
    yield* fs.remove(infoPath).pipe(Effect.ignore)
    yield* fs.remove(lockDir, { recursive: true }).pipe(Effect.ignore)
  })

/** Effect wrapper for lock acquire + body + release. */
export const withLock = <A, E, R>(
  home: string,
  dbPath: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LockAcquireError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const createdAt = yield* Clock.currentTimeMillis
      const acquired = yield* acquireLock(home, dbPath, createdAt)
      if (!acquired) {
        return yield* new LockAcquireError({ dbPath })
      }
    }),
    () => body,
    () => releaseLock(home, dbPath),
  )

export class LockAcquireError extends Schema.TaggedErrorClass<LockAcquireError>()(
  "LockAcquireError",
  { dbPath: Schema.String },
) {}
