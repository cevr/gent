/**
 * Single shared server discovery file.
 *
 * `~/.gent/server.lock` is a pidfile-style identity record for the one
 * shared gent server on this host. Clients attach only after the server's
 * identity endpoint confirms the full tuple, so PID reuse cannot signal an
 * unrelated process.
 */

import { Effect, FileSystem, Path, Schema } from "effect"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"

export { BuildFingerprint } from "@gent/core-internal/server/build-fingerprint.js"

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
): Effect.Effect<
  ServerLockEntry | undefined,
  never,
  FileSystem.FileSystem | GentPlatform | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const content = yield* fs.readFileString(path).pipe(Effect.option)
    if (content._tag === "None") return undefined
    const decoded = Schema.decodeUnknownOption(ServerLockEntryJson)(content.value)
    if (decoded._tag === "None") return undefined
    if (decoded.value.hostname !== osInfo.hostname) return undefined
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
): Effect.Effect<boolean, never, FileSystem.FileSystem | GentPlatform | Path.Path> =>
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

export const getLocalHostname: Effect.Effect<string, never, GentPlatform> = Effect.gen(
  function* () {
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    return osInfo.hostname
  },
)

export const isPidAlive = (pid: number): Effect.Effect<boolean, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    return yield* platform.signal(pid, 0).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
  })

export const validateServerLockEntry = (
  entry: ServerLockEntry,
): Effect.Effect<{ valid: boolean; reason?: string }, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    if (entry.hostname !== osInfo.hostname) {
      return { valid: false, reason: "different-host" }
    }
    if (!(yield* isPidAlive(entry.pid))) {
      return { valid: false, reason: "dead-pid" }
    }
    return { valid: true }
  })

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

export const canSignalServerLockEntry = (
  entry: ServerLockEntry,
): Effect.Effect<boolean, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    return entry.hostname === osInfo.hostname && (yield* isPidAlive(entry.pid))
  })

export const signalIfIdentityOwned = <E, R>(
  entry: ServerLockEntry,
  probe: (entry: ServerLockEntry) => Effect.Effect<boolean, E, R>,
): Effect.Effect<"signaled" | "skipped", never, R | GentPlatform> =>
  Effect.gen(function* () {
    if (!(yield* canSignalServerLockEntry(entry))) return "skipped" as const
    const owns = yield* probe(entry).pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (!owns) return "skipped" as const
    const platform = yield* GentPlatform
    const sent = yield* platform.signal(entry.pid, "SIGTERM").pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
    return sent ? ("signaled" as const) : ("skipped" as const)
  })
