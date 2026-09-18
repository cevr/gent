/**
 * Single shared server discovery file.
 *
 * `~/.gent/server.lock` is a pidfile-style identity record for the one
 * shared gent server on this host. Clients attach only after the server's
 * identity endpoint confirms the full tuple, so PID reuse cannot signal an
 * unrelated process.
 */

import { Predicate, Effect, FileSystem, Schema } from "effect"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"

export { BuildFingerprint } from "./build-fingerprint.js"
import { dataPaths } from "./data-paths.js"

export class ServerLockEntry extends Schema.Class<ServerLockEntry>("ServerLockEntry")({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  rpcUrl: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
  startedAt: Schema.Finite,
}) {}

const ServerLockEntryJson = Schema.fromJsonString(ServerLockEntry)

/**
 * The lock sits in the data directory `data-paths.ts` resolves, beside the
 * database it guards. Under `~/.gent` it was shared by every `GENT_DATA_DIR`
 * run on the machine: a second run saw a foreign `dbPath`, signalled the
 * first run's server as stale, and that TUI lost its server.
 */
const serverLockPath = (home: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* dataPaths(home)
    yield* fs.makeDirectory(paths.dataDir, { recursive: true }).pipe(Effect.ignore)
    return paths.serverLock
  })

export const readServerLock = (
  home: string,
): Effect.Effect<
  // oxlint-disable-next-line effect/noNullish -- The lock file is an optional process boundary record consumed by the TUI.
  ServerLockEntry | undefined,
  never,
  FileSystem.FileSystem | GentPlatform
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const content = yield* fs.readFileString(path).pipe(Effect.option)
    // oxlint-disable-next-line effect/noNullish -- A missing lock file is the documented absent-server result.
    if (content._tag === "None") return undefined
    const decoded = Schema.decodeOption(ServerLockEntryJson)(content.value)
    // oxlint-disable-next-line effect/noNullish -- Invalid lock content is treated as no active server.
    if (decoded._tag === "None") return undefined
    // oxlint-disable-next-line effect/noNullish -- A lock owned by another host is invisible to this client.
    if (decoded.value.hostname !== osInfo.hostname) return undefined
    return decoded.value
  })

export const writeServerLock = (
  home: string,
  entry: ServerLockEntry,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const json = yield* Schema.encodeEffect(ServerLockEntryJson)(entry).pipe(Effect.orDie)
    yield* fs.writeFileString(path, json).pipe(Effect.ignore)
  })

export const removeServerLock = (
  home: string,
  serverId: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const current = yield* readServerLock(home)
    if (Predicate.isUndefined(current) || current.serverId !== serverId) return false
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

interface ServerLockIdentity {
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

const canSignalServerLockEntry = (
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
    if (!(yield* canSignalServerLockEntry(entry))) return "skipped"
    const owns = yield* probe(entry).pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (!owns) return "skipped"
    const platform = yield* GentPlatform
    const sent = yield* platform.signal(entry.pid, "SIGTERM").pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
    if (sent) return "signaled"
    return "skipped"
  })
