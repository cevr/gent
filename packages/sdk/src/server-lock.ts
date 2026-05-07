/**
 * Single shared server discovery file.
 *
 * `~/.gent/server.lock` is a pidfile-style identity record for the one
 * shared gent server on this host. Clients attach only after the server's
 * identity endpoint confirms the full tuple, so PID reuse cannot signal an
 * unrelated process.
 */

// @effect-diagnostics nodeBuiltinImport:off — server lock identity is host-local
import { hostname } from "node:os"

import { Effect, FileSystem, Path, Schema } from "effect"

export {
  computeLocalFingerprint,
  resolveBuildFingerprint,
} from "@gent/core/server/build-fingerprint.js"

export class ServerLockEntry extends Schema.Class<ServerLockEntry>("ServerLockEntry")({
  serverId: Schema.String,
  pid: Schema.Number,
  hostname: Schema.String,
  rpcUrl: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
  startedAt: Schema.Number,
}) {}

const ServerLockEntryJson = Schema.fromJsonString(ServerLockEntry)

const ensureGentDir = (
  home: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(home, ".gent")
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
    return dir
  })

const serverLockPath = (
  home: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const dir = yield* ensureGentDir(home)
    return path.join(dir, "server.lock")
  })

export const readServerLock = (
  home: string,
): Effect.Effect<ServerLockEntry | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const content = yield* fs.readFileString(path).pipe(Effect.option)
    if (content._tag === "None") return undefined
    const decoded = Schema.decodeUnknownOption(ServerLockEntryJson)(content.value)
    if (decoded._tag === "None") return undefined
    if (decoded.value.hostname !== hostname()) return undefined
    return decoded.value
  })

export const writeServerLock = (
  home: string,
  entry: ServerLockEntry,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const json = yield* Schema.encodeEffect(ServerLockEntryJson)(entry).pipe(Effect.orDie)
    yield* fs.writeFileString(path, json).pipe(Effect.ignore)
  })

export const removeServerLock = (
  home: string,
  serverId: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const current = yield* readServerLock(home)
    if (current === undefined || current.serverId !== serverId) return false
    const path = yield* serverLockPath(home)
    return yield* fs.remove(path).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
  })

export const getLocalHostname = (): string => hostname()

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const validateServerLockEntry = (
  entry: ServerLockEntry,
): { valid: boolean; reason?: string } => {
  if (entry.hostname !== hostname()) {
    return { valid: false, reason: "different-host" }
  }
  if (!isPidAlive(entry.pid)) {
    return { valid: false, reason: "dead-pid" }
  }
  return { valid: true }
}

export interface ServerLockIdentity {
  readonly serverId: string
  readonly pid: number
  readonly hostname: string
  readonly dbPath: string
  readonly buildFingerprint: string
}

export const serverLockIdentityOf = (entry: ServerLockEntry): ServerLockIdentity => ({
  serverId: entry.serverId,
  pid: entry.pid,
  hostname: entry.hostname,
  dbPath: entry.dbPath,
  buildFingerprint: entry.buildFingerprint,
})

export const canSignalServerLockEntry = (entry: ServerLockEntry): boolean =>
  entry.hostname === hostname() && isPidAlive(entry.pid)

export const signalIfIdentityOwned = <E, R>(
  entry: ServerLockEntry,
  probe: (entry: ServerLockEntry) => Effect.Effect<boolean, E, R>,
): Effect.Effect<"signaled" | "skipped", never, R> =>
  Effect.gen(function* () {
    if (!canSignalServerLockEntry(entry)) return "skipped" as const
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
