/**
 * The admin subcommands: `sessions`, `server status`, `server stop`, `doctor`
 * and `storage reset`.
 *
 * They share no state with the interactive TUI — each one opens what it needs,
 * prints, and returns — so they live beside the health readers they call rather
 * than in the entry point that renders the app.
 */
import { Command, Flag } from "effect/unstable/cli"
import { Config, Console, DateTime, Effect, Option, Schema } from "effect"
import type { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import {
  Gent,
  getLocalHostname,
  isPidAlive,
  probeServerLockEntryIdentity,
  readServerLock,
  removeServerLock,
  signalIfIdentityOwned,
  validateServerLockEntry,
  type ServerLockEntry,
} from "@gent/sdk"
import {
  extensionHealthError,
  extensionHealthFromSnapshot,
  extensionHealthUnavailable,
  formatDoctorReport,
  makeDoctorReport,
  resetStorage,
  type ExtensionDoctorHealth,
} from "./local-health"

export class CliStartupError extends Schema.TaggedError<CliStartupError>()("CliStartupError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Where the server lock and the storage live. `/tmp` when the shell has no HOME. */
export const readHome = Effect.map(
  Config.option(Config.string("HOME")),
  Option.getOrElse(() => "/tmp"),
)

/**
 * The one way a command reaches a running gent.
 *
 * `connect` attaches to a server someone else started. Otherwise this starts
 * one in-process, which is what every caller wants when no url is given: the
 * bundle owns its own server for the life of the call.
 */
export const resolveClientBundle = (options: {
  readonly cwd: string
  readonly connect: Option.Option<string>
  /** Keep state in memory instead of the shared SQLite file. */
  readonly inMemory: boolean
  readonly debug: boolean
  /** Serve scripted responses instead of a real provider; `empty` serves none. */
  readonly mock: Option.Option<{ readonly empty: boolean }>
  readonly authDirectory: Option.Option<string>
}) => {
  if (Option.isSome(options.connect)) return Gent.client(options.connect.value)
  let state = Gent.state.sqlite()
  if (options.inMemory) state = Gent.state.memory()
  let provider = Gent.provider.live()
  if (Option.isSome(options.mock)) provider = Gent.provider.mock(options.mock.value)
  const base = { cwd: options.cwd, state, provider, debug: options.debug }
  const configured = Option.match(options.authDirectory, {
    onNone: () => base,
    onSome: (authDirectory) => ({ ...base, authDirectory }),
  })
  return Effect.flatMap(Gent.server(configured), Gent.client)
}

export const sessions = Command.make(
  "sessions",
  {
    connect: Flag.string("connect").pipe(
      Flag.withDescription("Connect to an existing gent server"),
      Flag.optional,
    ),
    isolate: Flag.boolean("isolate").pipe(
      Flag.withDescription("Run with an in-process server (no shared server, no registry)"),
      Flag.withDefault(false),
    ),
  },
  ({ connect, isolate }) =>
    Effect.gen(function* () {
      const bundle = yield* resolveClientBundle({
        cwd: process.cwd(),
        connect,
        inMemory: isolate,
        debug: false,
        mock: Option.none(),
        authDirectory: Option.none(),
      })
      yield* bundle.runtime.lifecycle.waitForReady
      const allSessions = yield* bundle.client.session.list()

      if (allSessions.length === 0) {
        yield* Console.log("No sessions found.")
        return
      }

      yield* Console.log("Sessions:")
      for (const s of allSessions) {
        const date = DateTime.make(s.updatedAt).pipe(
          Option.match({
            onNone: () => "unknown",
            onSome: DateTime.formatIso,
          }),
        )
        const name = Option.getOrElse(Option.fromNullishOr(s.name), () => "Unnamed")
        yield* Console.log(`  ${s.id} - ${name} (${date})`)
      }
    }),
)

const serverStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    const entry = Option.fromNullishOr(yield* readServerLock(home))

    if (Option.isNone(entry)) {
      yield* Console.log("No shared server.")
      return
    }

    yield* Console.log("Shared server:\n")
    yield* Console.log(
      `${"PID".padEnd(8)} ${"STATUS".padEnd(10)} ${"SERVER ID".padEnd(40)} ${"DB PATH".padEnd(40)} ${"URL"}`,
    )
    yield* Console.log("─".repeat(120))

    const validation = yield* validateServerLockEntry(entry.value)
    let status = "alive"
    if (!validation.valid) status = `dead (${validation.reason})`
    yield* Console.log(
      `${String(entry.value.pid).padEnd(8)} ${status.padEnd(10)} ${entry.value.serverId.padEnd(40)} ${entry.value.dbPath.padEnd(40)} ${entry.value.rpcUrl}`,
    )
  }),
)

const serverStop = Command.make(
  "stop",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Stop all registered servers"),
      Flag.withDefault(false),
    ),
  },
  ({ all }) =>
    Effect.gen(function* () {
      const home = yield* readHome
      const thisHost = yield* getLocalHostname
      const entry = Option.fromNullishOr(yield* readServerLock(home))

      if (Option.isNone(entry)) {
        yield* Console.log("No shared server.")
        return
      }

      if (entry.value.hostname !== thisHost || (!all && !(yield* isPidAlive(entry.value.pid)))) {
        yield* Console.log("No live shared server to stop on this host.")
        return
      }

      // Signal target — identity-probe before SIGTERM so PID reuse after a
      // crash never kills an unrelated process (same boundary as SDK attach).
      const outcome = yield* signalIfIdentityOwned(entry.value, probeServerLockEntryIdentity)
      if (outcome === "signaled") {
        yield* Console.log(`Sent SIGTERM to PID ${entry.value.pid} (${entry.value.serverId})`)
      } else {
        yield* Console.log(
          `Skipped PID ${entry.value.pid} (${entry.value.serverId}): identity probe failed`,
        )
      }

      // Wait for the process to exit, then cleanup the server lock.
      yield* Effect.sleep("2 seconds")

      if (yield* isPidAlive(entry.value.pid)) {
        yield* Console.log("\nShared server is still running after SIGTERM.")
      } else {
        yield* removeServerLock(home, entry.value.serverId)
        yield* Console.log("\nShared server stopped and cleaned up.")
      }
    }),
)

export const server = Command.make("server", {}, () =>
  Console.log("Usage: gent server <status|stop>"),
).pipe(Command.withSubcommands([serverStatus, serverStop]))

const readDoctorExtensionHealth = (
  entry: ServerLockEntry,
): Effect.Effect<ExtensionDoctorHealth, never, GentPlatform> =>
  Effect.gen(function* () {
    const validation = yield* validateServerLockEntry(entry)
    if (!validation.valid) {
      let reason = "Shared server is not local to this host."
      if (validation.reason === "dead-pid") reason = "Shared server lock is stale."
      return extensionHealthUnavailable(reason)
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* Gent.client(entry.rpcUrl, { cwd: process.cwd() })
        yield* bundle.runtime.lifecycle.waitForReady
        const snapshot = yield* bundle.client.extension.listStatus({})
        return extensionHealthFromSnapshot(snapshot)
      }),
    ).pipe(Effect.catch((error) => Effect.succeed(extensionHealthError(String(error)))))
  })

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    const entry = Option.fromNullishOr(yield* readServerLock(home))
    const extensions = yield* Option.match(entry, {
      onNone: () => Effect.succeed(extensionHealthUnavailable("No shared server.")),
      onSome: readDoctorExtensionHealth,
    })
    const report = yield* makeDoctorReport(home, entry, extensions)
    yield* Console.log(formatDoctorReport(report))
  }),
)

const storageReset = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    const entry = Option.fromNullishOr(yield* readServerLock(home))
    if (Option.isSome(entry) && (yield* validateServerLockEntry(entry.value)).valid) {
      yield* Console.error(
        "Error: shared server is running. Stop it with `gent server stop` first.",
      )
      return yield* new CliStartupError({
        message: "shared server is running; refusing to reset storage",
      })
    }

    const result = yield* resetStorage(home)
    if (result.archived.length === 0) {
      yield* Console.log("No storage files found.")
      return
    }

    yield* Console.log(`Archived storage files to ${result.archiveDir}`)
    for (const file of result.archived) {
      yield* Console.log(`  ${file}`)
    }
  }),
)

export const storage = Command.make("storage", {}, () =>
  Console.log("Usage: gent storage <reset>"),
).pipe(Command.withSubcommands([storageReset]))
