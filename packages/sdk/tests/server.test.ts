import { describe, expect, it } from "effect-bun-test"
import {
  ByteSize,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Exit,
  Ref,
  Schema,
  Scope,
} from "effect"
import * as ChildProcessSpawnerNs from "effect/process/ChildProcessSpawner"
import { dateFromMillis } from "@gent/core/protocol"
import { BunGentPlatformLive, makeTempDirectoryScoped } from "@gent/core/test-utils"
import { GentPlatform } from "@gent/core/host"
import {
  buildFingerprint,
  ownBuildFingerprint,
  dataPaths,
  serverLock,
  serverLockFile,
  ServerLockEntry,
} from "../src/server"
import { BunServices } from "@effect/platform-bun"
import { homedir, hostname } from "node:os"
import { Gent } from "../src/client"
import { buildLogPaths } from "../src/logger"

// ── build fingerprint ───────────────────────────────────────────────────────

// FileSystem.layerNoop whose stat counts its calls and answers `mtime`.
const makeCountingFs = (
  counter: Ref.Ref<number>,
  mtime: Option.Option<Date>,
): Layer.Layer<FileSystem.FileSystem> =>
  FileSystem.layerNoop({
    stat: () =>
      Ref.update(counter, (n) => n + 1).pipe(
        Effect.as({
          type: "File" satisfies "File",
          mtime,
          atime: Option.none(),
          birthtime: Option.none(),
          dev: 0,
          ino: Option.none(),
          mode: 0,
          nlink: Option.none(),
          uid: Option.none(),
          gid: Option.none(),
          rdev: Option.none(),
          size: ByteSize.zero,
          blksize: Option.none(),
          blocks: Option.none(),
        }),
      ),
  })

/** Point git at no repository for the scope, so a source run cannot name its build. */
const gitFindsNoRepository = Effect.acquireRelease(
  Effect.sync(() => {
    // oxlint-disable-next-line effect/noGlobals -- git reads GIT_DIR from the environment the server's child process inherits
    const previous = Option.fromUndefinedOr(Bun.env["GIT_DIR"])
    // oxlint-disable-next-line effect/noGlobals -- git reads GIT_DIR from the environment the server's child process inherits
    Bun.env["GIT_DIR"] = "/nonexistent/gent-probe-x"
    return previous
  }),
  (previous) =>
    Effect.sync(() =>
      Option.match(previous, {
        // oxlint-disable-next-line effect/noGlobals -- git reads GIT_DIR from the environment the server's child process inherits
        onNone: () => Reflect.deleteProperty(Bun.env, "GIT_DIR"),
        // oxlint-disable-next-line effect/noGlobals -- git reads GIT_DIR from the environment the server's child process inherits
        onSome: (value) => Reflect.set(Bun.env, "GIT_DIR", value),
      }),
    ),
)

/**
 * The services of a compiled gent whose executable is `execPath`, over a
 * filesystem whose stat counts calls. The spawner dies if it reaches git.
 */
const compiledServices = (execPath: string, counter: Ref.Ref<number>, mtime: Option.Option<Date>) =>
  Layer.mergeAll(
    Layer.effect(
      GentPlatform,
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        return GentPlatform.of({ ...platform, execPath: Effect.succeed(execPath) })
      }),
    ).pipe(Layer.provide(GentPlatform.Test("bf"))),
    makeCountingFs(counter, mtime),
    Path.layer,
    Layer.succeed(
      ChildProcessSpawnerNs.ChildProcessSpawner,
      ChildProcessSpawnerNs.make(() =>
        Effect.die(new Error("ChildProcessSpawner.spawn unreachable in this test")),
      ),
    ),
  )

describe("buildFingerprint", () => {
  // `resolveServer` reads the fingerprint once, so the lock entry and the
  // identity endpoint name one build; the fingerprint itself stats once.
  it.live("a compiled build names itself by its binary's mtime, in one stat", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const mtime = dateFromMillis(36_000)
      const fingerprint = yield* buildFingerprint(Effect.succeed(true)).pipe(
        Effect.provide(
          compiledServices("/nonexistent/gent-probe-x/gent", counter, Option.some(mtime)),
        ),
      )
      expect(fingerprint).toBe(`bin-${(36_000).toString(36)}`)
      expect(yield* Ref.get(counter)).toBe(1)
    }),
  )

  // Two builds whose stats both lack an mtime must not share a fingerprint,
  // or one attaches to the other's server.
  it.live("a binary whose stat has no mtime names no build", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const fingerprint = yield* buildFingerprint(Effect.succeed(true)).pipe(
        Effect.provide(compiledServices("/nonexistent/gent-probe-x/gent", counter, Option.none())),
      )
      expect(fingerprint).toBe("unknown")
    }),
  )
})

// ── server lock ─────────────────────────────────────────────────────────────

const PlatformLayer = Layer.mergeAll(BunServices.layer, BunGentPlatformLive)

const provideFs = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | ChildProcessSpawnerNs.ChildProcessSpawner
    | FileSystem.FileSystem
    | GentPlatform
    | Path.Path
    | Scope.Scope
  >,
): Effect.Effect<A, E, Scope.Scope> => effect.pipe(Effect.provide(PlatformLayer))

const makeTmpHomeScoped = makeTempDirectoryScoped("gent-server-lock-test-")

const makeEntry = (overrides?: Partial<ServerLockEntry>) =>
  new ServerLockEntry({
    serverId: "test-server-1",
    pid: process.pid,
    hostname: hostname(),
    rpcUrl: "http://127.0.0.1:9999/rpc",
    dbPath: "/tmp/test.db",
    buildFingerprint: "test-fp",
    startedAt: 1_767_225_600_000,
    ...overrides,
  })

/**
 * Trap SIGTERM to this process and run `onSigterm` in its place. A server that
 * exits on SIGTERM releases its kernel lock there; the default ignores it.
 * Every signal goes through `GentPlatform.signal`, so the trap wraps the
 * platform the test provides; any other signal or pid reaches it unchanged.
 */
const signalTrap =
  (onSigterm: Effect.Effect<void> = Effect.void) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    { readonly result: A; readonly signals: ReadonlyArray<string | number> },
    E,
    Exclude<R, GentPlatform> | GentPlatform
  > =>
    Effect.gen(function* () {
      const signals: Array<string | number> = []
      const platform = yield* GentPlatform
      const signal: GentPlatform["Service"]["signal"] = (pid, sent) => {
        if (pid !== process.pid || sent !== "SIGTERM") return platform.signal(pid, sent)
        return Effect.sync(() => signals.push(sent)).pipe(Effect.andThen(onSigterm))
      }
      const result = yield* effect.pipe(
        Effect.provideService(GentPlatform, GentPlatform.of({ ...platform, signal })),
      )
      return { result, signals }
    })

const withSignalTrap = signalTrap()

/**
 * Hold the kernel lock as another server would, in a scope of its own. The
 * returned effect releases it, as that server's exit does.
 */
const holdAsAnotherServer = (home: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    expect(yield* serverLockFile.hold(home).pipe(Scope.provide(scope))).toBe(true)
    return { release: Scope.close(scope, Exit.void) }
  })

describe("Server Lock", () => {
  it.scopedLive(
    "a lock written under GENT_DATA_DIR lands beside that database, not under home",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const dataDir = `${home}/isolated-run`
          const entry = makeEntry()
          const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.provideService(
              effect,
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnvRecord({ GENT_DATA_DIR: dataDir }),
            )
          yield* isolated(serverLockFile.write(home, entry))
          const fs = yield* FileSystem.FileSystem
          expect(yield* fs.exists(`${dataDir}/server.lock`)).toBe(true)
          expect(yield* fs.exists(`${home}/.gent/server.lock`)).toBe(false)
          // the home-scoped reader does not see the isolated run's server
          expect(Option.isNone(yield* serverLockFile.read(home))).toBe(true)
          expect(Option.isSome(yield* isolated(serverLockFile.read(home)))).toBe(true)
        }),
      ),
  )

  // The entry's server-id guard is covered through `serverLock.stop` below
  // ("stale-entry cleanup never removes the entry a new owner writes").
  it.scopedLive("a corrupt lock entry reads as no server", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        const { serverLock: entryPath } = yield* dataPaths(home)
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true })
        // A readable entry under a free kernel lock reads Stale; this one reads as none.
        yield* fs.writeFileString(entryPath, "not json")
        expect((yield* serverLock.status(home))._tag).toBe("None")
      }),
    ),
  )

  it.scopedLive("a second sqlite Gent.server attaches to the single shared server", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const dbPath = (yield* dataPaths(home)).dbPath
        const buildFingerprint = yield* ownBuildFingerprint
        const entry = makeEntry({ dbPath, buildFingerprint })
        const fakeOwner = yield* Effect.acquireRelease(
          Effect.sync(() =>
            // oxlint-disable-next-line effect/noGlobals -- this test needs a raw Bun identity fixture server
            Bun.serve({
              port: 0,
              fetch: (request) => {
                if (new URL(request.url).pathname !== "/_gent/identity") {
                  return new Response("not found", { status: 404 })
                }
                return Response.json({
                  serverId: entry.serverId,
                  pid: entry.pid,
                  hostname: entry.hostname,
                  dbPath: entry.dbPath,
                  buildFingerprint: entry.buildFingerprint,
                })
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const fakeOwnerUrl = new URL(fakeOwner.url)
        const entryWithEndpoint = new ServerLockEntry({
          ...entry,
          rpcUrl: `${fakeOwnerUrl.origin}/rpc`,
        })
        yield* serverLockFile.write(home, entryWithEndpoint)
        yield* holdAsAnotherServer(home)

        const server = yield* Gent.server({
          cwd: `${process.cwd()}/other-workspace`,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        })
        expect(server._tag).toBe("Attached")
        expect(server.url).toBe(entryWithEndpoint.rpcUrl)
      }),
    ),
  )

  it.scopedLive(
    "a second sqlite Gent.server on the same data directory attaches to the live owner",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const options = {
            cwd: home,
            state: Gent.state.sqlite({ home }),
            provider: Gent.provider.mock(),
          }

          const owner = yield* Gent.server(options)
          expect(owner._tag).toBe("Owned")
          const ownerEntry = Option.getOrThrow(yield* serverLockFile.read(home))

          const attached = yield* Gent.server(options)
          expect(attached._tag).toBe("Attached")
          expect(attached.url).toBe(owner.url)

          // The attached server's endpoint names the owner the entry names, build included.
          const response = yield* Effect.promise(() =>
            Bun.fetch(`${attached.url.replace("/rpc", "")}/_gent/identity`),
          )
          const identity = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  serverId: Schema.String,
                  pid: Schema.Finite,
                  buildFingerprint: Schema.String,
                }),
              ),
            ),
          )
          expect(identity.serverId).toBe(ownerEntry.serverId)
          expect(identity.pid).toBe(process.pid)
          expect(identity.buildFingerprint).toBe(ownerEntry.buildFingerprint)
        }).pipe(Effect.timeout("20 seconds")),
      ),
  )

  it.scopedLive("a lock that names another database is replaced, not attached", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const ownDb = (yield* dataPaths(home)).dbPath
        const buildFingerprint = yield* ownBuildFingerprint
        const entry = makeEntry({ dbPath: `${ownDb}.other`, buildFingerprint })
        const foreignOwner = yield* Effect.acquireRelease(
          Effect.sync(() =>
            // oxlint-disable-next-line effect/noGlobals -- this test needs a raw Bun identity fixture server
            Bun.serve({
              port: 0,
              fetch: () =>
                Response.json({
                  serverId: entry.serverId,
                  pid: entry.pid,
                  hostname: entry.hostname,
                  dbPath: entry.dbPath,
                  buildFingerprint: entry.buildFingerprint,
                }),
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        yield* serverLockFile.write(
          home,
          new ServerLockEntry({ ...entry, rpcUrl: `${new URL(foreignOwner.url).origin}/rpc` }),
        )

        const { result: server } = yield* Gent.server({
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }).pipe(withSignalTrap)
        expect(server._tag).toBe("Owned")
        expect(Option.getOrThrow(yield* serverLockFile.read(home)).dbPath).toBe(ownDb)
      }),
    ),
  )

  it.scopedLive("a fixed-port server takes the lock and names itself in the entry", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const owner = yield* Gent.server({
          cwd: home,
          port: 0,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        })
        expect(owner._tag).toBe("Owned")
        expect(Option.getOrThrow(yield* serverLockFile.read(home)).rpcUrl).toBe(owner.url)
        // A client without a port finds that server and attaches to it.
        const client = yield* Gent.server({
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        })
        expect(client._tag).toBe("Attached")
        expect(client.url).toBe(owner.url)
      }),
    ),
  )

  it.scopedLive("a start that cannot write its lock entry fails instead of hiding", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeTmpHomeScoped
        // A directory where the entry goes: the write fails.
        const entryPath = (yield* dataPaths(home)).serverLock
        yield* fs.makeDirectory(entryPath, { recursive: true })
        const started = yield* Gent.server({
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }).pipe(Effect.scoped, Effect.flip, Effect.timeout("10 seconds"))
        // Without the entry every client would wait for a server that never names itself.
        expect(started.message).toContain(entryPath)
      }),
    ),
  )

  it.scopedLive("an attached client reads the workspace its cwd names", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const cwdA = yield* makeTmpHomeScoped
        const cwdB = yield* makeTmpHomeScoped
        const options = {
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }
        expect((yield* Gent.server(options))._tag).toBe("Owned")
        const attached = yield* Gent.server(options)
        expect(attached._tag).toBe("Attached")
        const clientA = (yield* Gent.client(attached, { cwd: cwdA })).client
        const clientB = (yield* Gent.client(attached, { cwd: cwdB })).client

        const created = yield* clientA.session.create({ name: "Workspace A", cwd: cwdA })
        const listed = (sessions: ReadonlyArray<{ readonly id: string }>) =>
          sessions.map((session) => session.id)
        expect(listed(yield* clientA.session.list())).toContain(created.sessionId)
        expect(listed(yield* clientB.session.list())).not.toContain(created.sessionId)
      }).pipe(Effect.timeout("20 seconds")),
    ),
  )

  it.scopedLive("a fixed-port server does not start on a database another server owns", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const options = {
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }
        const owner = yield* Gent.server(options)
        expect(owner._tag).toBe("Owned")
        const pid = Option.getOrThrow(yield* serverLockFile.read(home)).pid
        const second = yield* Gent.server({ ...options, port: 0 }).pipe(Effect.flip)
        expect(second.message).toContain(`PID ${pid}`)
      }),
    ),
  )
})

/**
 * Write `entry` as the lock, pointed at an identity endpoint that answers with
 * the entry's own identity, changed by `overrides`.
 */
const lockWithIdentity = (
  home: string,
  entry: ServerLockEntry,
  overrides: { readonly pid?: number },
) =>
  Effect.gen(function* () {
    const endpoint = yield* Effect.acquireRelease(
      Effect.sync(() =>
        // oxlint-disable-next-line effect/noGlobals -- this test needs a raw Bun identity fixture server
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              serverId: entry.serverId,
              pid: entry.pid,
              hostname: entry.hostname,
              dbPath: entry.dbPath,
              buildFingerprint: entry.buildFingerprint,
              ...overrides,
            }),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const locked = new ServerLockEntry({ ...entry, rpcUrl: `${new URL(endpoint.url).origin}/rpc` })
    yield* serverLockFile.write(home, locked)
    return locked
  })

describe("Server Lock Ownership", () => {
  // The lock names a pid no gent server owns: a reused pid. The case of the
  // new process's own pid is the end of "a crashed server's lock is released
  // by the OS, even while its pid is reused".
  it.scopedLive("a lock whose pid now belongs to another live process does not block startup", () =>
    provideFs(
      Effect.gen(function* () {
        const pid = process.ppid
        const home = yield* makeTmpHomeScoped
        const dbPath = (yield* dataPaths(home)).dbPath
        const buildFingerprint = yield* ownBuildFingerprint
        yield* serverLockFile.write(
          home,
          makeEntry({ pid, dbPath, buildFingerprint, rpcUrl: "http://127.0.0.1:1/rpc" }),
        )
        const { result, signals } = yield* Gent.server({
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }).pipe(withSignalTrap)
        expect(result._tag).toBe("Owned")
        expect(signals).toEqual([])
        expect(Option.getOrThrow(yield* serverLockFile.read(home)).serverId).not.toBe(
          "test-server-1",
        )
      }).pipe(Effect.timeout("20 seconds")),
    ),
  )

  it.scopedLive(
    "two concurrent starts on one database give one owner and one attached client",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const options = {
            cwd: home,
            state: Gent.state.sqlite({ home }),
            provider: Gent.provider.mock(),
          }
          const servers = yield* Effect.all([Gent.server(options), Gent.server(options)], {
            concurrency: "unbounded",
          }).pipe(Effect.timeout("20 seconds"))
          expect(servers.map((server) => server._tag).toSorted()).toEqual(["Attached", "Owned"])
          expect(servers[0].url).toBe(servers[1].url)
        }),
      ),
    30_000,
  )

  it.scopedLive("a status read of a data directory that does not exist creates nothing", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const { dataDir } = yield* dataPaths(home)
        expect((yield* serverLock.status(home))._tag).toBe("None")
        expect((yield* serverLock.stop(home))._tag).toBe("None")
        expect(yield* (yield* FileSystem.FileSystem).exists(dataDir)).toBe(false)
      }),
    ),
  )

  it.scopedLive("status reads the kernel lock, not the pid the entry names", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        expect((yield* serverLock.status(home))._tag).toBe("None")
        // A live pid under a free kernel lock is a server that is gone.
        yield* serverLockFile.write(home, makeEntry())
        expect((yield* serverLock.status(home))._tag).toBe("Stale")
        const { release } = yield* holdAsAnotherServer(home)
        expect((yield* serverLock.status(home))._tag).toBe("Alive")
        yield* serverLockFile.remove(home, "test-server-1")
        expect((yield* serverLock.status(home))._tag).toBe("Unnamed")
        yield* release
        expect((yield* serverLock.status(home))._tag).toBe("None")
        yield* serverLockFile.write(home, makeEntry({ hostname: "alien-host" }))
        expect((yield* serverLock.status(home))._tag).toBe("None")
      }),
    ),
  )

  it.scopedLive(
    "a live holder that does not prove its identity blocks a new server; nothing is signalled",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const buildFingerprint = yield* ownBuildFingerprint
          const dbPath = (yield* dataPaths(home)).dbPath
          // The pid is alive, but the endpoint names another process: a server
          // that cannot be confirmed may still hold the database.
          const holder = yield* lockWithIdentity(home, makeEntry({ dbPath, buildFingerprint }), {
            pid: 99999999,
          })
          yield* holdAsAnotherServer(home)
          const { result, signals } = yield* Gent.server({
            cwd: home,
            state: Gent.state.sqlite({ home }),
            provider: Gent.provider.mock(),
          }).pipe(Effect.flip, withSignalTrap)
          expect(result._tag).toBe("@gent/core/GentConnectionError")
          expect(result.message).toContain(String(holder.pid))
          expect(signals).toEqual([])
          expect(Option.getOrThrow(yield* serverLockFile.read(home)).serverId).toBe(holder.serverId)
        }),
      ),
  )

  it.scopedLive("a server of another build on the database blocks a new start unsignalled", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        // Another build is open on the same database: a TUI, perhaps with a turn in flight.
        const dbPath = (yield* dataPaths(home)).dbPath
        const holder = yield* lockWithIdentity(
          home,
          makeEntry({ dbPath, buildFingerprint: "another-build" }),
          {},
        )
        yield* holdAsAnotherServer(home)
        const { result, signals } = yield* Gent.server({
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }).pipe(Effect.flip, withSignalTrap)
        expect(result._tag).toBe("@gent/core/GentConnectionError")
        expect(result.message).toContain(`PID ${holder.pid}`)
        expect(result.message).toContain("another-build")
        expect(result.message).toContain("gent server stop")
        expect(signals).toEqual([])
        expect(Option.getOrThrow(yield* serverLockFile.read(home)).serverId).toBe(holder.serverId)
      }),
    ),
  )

  it.scopedLive(
    "a gent that cannot know its build does not attach to a server that cannot know its own",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const dbPath = (yield* dataPaths(home)).dbPath
          const holder = yield* lockWithIdentity(
            home,
            makeEntry({ dbPath, buildFingerprint: "unknown" }),
            {},
          )
          yield* holdAsAnotherServer(home)
          yield* gitFindsNoRepository
          const { result, signals } = yield* Gent.server({
            cwd: home,
            state: Gent.state.sqlite({ home }),
            provider: Gent.provider.mock(),
          }).pipe(Effect.flip, withSignalTrap)
          expect(result._tag).toBe("@gent/core/GentConnectionError")
          expect(result.message).toContain(`PID ${holder.pid}`)
          expect(result.message).toContain("gent server stop")
          expect(signals).toEqual([])
        }).pipe(Effect.timeout("20 seconds")),
      ),
  )

  it.scopedLive(
    "an identity endpoint that sends headers and never finishes its body is bounded",
    () =>
      provideFs(
        Effect.gen(function* () {
          const endpoint = yield* Effect.acquireRelease(
            Effect.sync(() =>
              // oxlint-disable-next-line effect/noGlobals -- this test needs a raw Bun endpoint that stalls its body
              Bun.serve({
                port: 0,
                fetch: () =>
                  new Response(
                    new ReadableStream({
                      start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
                    }),
                    { headers: { "content-type": "application/json" } },
                  ),
              }),
            ),
            (server) => Effect.promise(() => server.stop(true)),
          )
          const entry = makeEntry({ rpcUrl: `${new URL(endpoint.url).origin}/rpc` })
          const answered = yield* serverLock.probe(entry).pipe(Effect.timeout("5 seconds"))
          expect(answered).toBe(false)
        }),
      ),
    10_000,
  )

  it.scopedLive(
    "a crashed server's lock is released by the OS, even while its pid is reused",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const paths = yield* dataPaths(home)
          const buildFingerprint = yield* ownBuildFingerprint
          yield* (yield* FileSystem.FileSystem).makeDirectory(paths.dataDir, { recursive: true })
          // A separate process takes the kernel lock the way a server does, then dies by SIGKILL.
          const holder = yield* Effect.acquireRelease(
            Effect.sync(() =>
              // oxlint-disable-next-line effect/noGlobals -- the crash needs a real second process
              Bun.spawn(
                [
                  process.execPath,
                  "-e",
                  `const { Database } = require("bun:sqlite"); globalThis.lock = new Database(process.argv.at(-1), { create: true }); globalThis.lock.exec("BEGIN EXCLUSIVE"); console.log("held"); setInterval(() => {}, 1000)`,
                  paths.serverKernelLock,
                ],
                { stdout: "pipe" },
              ),
            ),
            (child) => Effect.sync(() => child.kill("SIGKILL")),
          )
          const firstLine = yield* Effect.promise(() => holder.stdout.getReader().read())
          expect(new TextDecoder().decode(firstLine.value)).toContain("held")
          yield* serverLockFile.write(
            home,
            makeEntry({ pid: holder.pid, dbPath: paths.dbPath, buildFingerprint }),
          )
          expect((yield* serverLock.status(home))._tag).toBe("Alive")

          holder.kill("SIGKILL")
          yield* Effect.promise(() => holder.exited)
          expect((yield* serverLock.status(home))._tag).toBe("Stale")
          // The pid now names this process, which is alive and serves nothing yet.
          yield* serverLockFile.write(
            home,
            makeEntry({ pid: process.pid, dbPath: paths.dbPath, buildFingerprint }),
          )
          const { result, signals } = yield* Gent.server({
            cwd: home,
            state: Gent.state.sqlite({ home }),
            provider: Gent.provider.mock(),
          }).pipe(withSignalTrap)
          expect(result._tag).toBe("Owned")
          expect(signals).toEqual([])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

describe("serverLock.stop", () => {
  /** An identity endpoint that answers with `identity`; the lock points at it. */
  const lockWithEndpoint = (home: string, identity: (entry: ServerLockEntry) => object) =>
    Effect.gen(function* () {
      const entry = makeEntry()
      const endpoint = yield* Effect.acquireRelease(
        Effect.sync(() =>
          // oxlint-disable-next-line effect/noGlobals -- this test needs a raw Bun identity fixture server
          Bun.serve({ port: 0, fetch: () => Response.json(identity(entry)) }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const locked = new ServerLockEntry({
        ...entry,
        rpcUrl: `${new URL(endpoint.url).origin}/rpc`,
      })
      yield* serverLockFile.write(home, locked)
      const held = yield* holdAsAnotherServer(home)
      // The server exits: its kernel lock goes, and its endpoint stops answering.
      const release = held.release.pipe(
        Effect.andThen(
          Effect.sync(() => {
            void endpoint.stop(true)
          }),
        ),
      )
      return { locked, release }
    })

  const identityOf = (entry: ServerLockEntry) => ({
    serverId: entry.serverId,
    pid: entry.pid,
    hostname: entry.hostname,
    dbPath: entry.dbPath,
    buildFingerprint: entry.buildFingerprint,
  })

  it.scopedLive("no lock, or a lock from another host, stops nothing", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        expect((yield* serverLock.stop(home))._tag).toBe("None")
        yield* serverLockFile.write(home, makeEntry({ hostname: "other-host" }))
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("None")
        expect(signals).toEqual([])
      }),
    ),
  )

  it.scopedLive("stale-entry cleanup never removes the entry a new owner writes", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const lockPath = (yield* dataPaths(home)).serverLock
        const base = yield* FileSystem.FileSystem
        const newOwner = makeEntry({ serverId: "new-owner" })
        const newOwnerScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(newOwnerScope, Exit.void))
        let paused = false
        let newOwnerTookLock = false
        // Between the cleanup's read and its removal, a new server tries to own the database.
        const racing = FileSystem.FileSystem.of({
          ...base,
          remove: (path, options) => {
            if (path !== lockPath || paused) return base.remove(path, options)
            paused = true
            return Effect.gen(function* () {
              if (yield* serverLockFile.hold(home).pipe(Scope.provide(newOwnerScope))) {
                newOwnerTookLock = true
                yield* serverLockFile.write(home, newOwner)
              }
            }).pipe(
              Effect.orDie,
              Effect.provideService(FileSystem.FileSystem, base),
              Effect.andThen(base.remove(path, options)),
            )
          },
        })
        yield* serverLockFile.write(home, makeEntry({ rpcUrl: "http://127.0.0.1:1/rpc" }))
        const result = yield* serverLock
          .stop(home, { removeStale: true })
          .pipe(Effect.provideService(FileSystem.FileSystem, racing))
        expect(result._tag).toBe("Removed")
        expect(paused).toBe(true)
        // The cleanup holds the kernel lock through the removal: the new owner waits.
        expect(newOwnerTookLock).toBe(false)
      }),
    ),
  )

  it.scopedLive(
    "a stale entry a new owner takes first is left to it and not reported removed",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const base = yield* FileSystem.FileSystem
          const newOwner = makeEntry({ serverId: "new-owner" })
          const newOwnerScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(newOwnerScope, Exit.void))
          let raced = false
          // Between the status read and the cleanup's lock, a new server owns the database.
          const racing = FileSystem.FileSystem.of({
            ...base,
            makeDirectory: (path, options) => {
              if (raced) return base.makeDirectory(path, options)
              raced = true
              return Effect.gen(function* () {
                expect(yield* serverLockFile.hold(home).pipe(Scope.provide(newOwnerScope))).toBe(
                  true,
                )
                yield* serverLockFile.write(home, newOwner)
              }).pipe(
                Effect.orDie,
                Effect.provideService(FileSystem.FileSystem, base),
                Effect.andThen(base.makeDirectory(path, options)),
              )
            },
          })
          yield* serverLockFile.write(home, makeEntry())
          const result = yield* serverLock
            .stop(home, { removeStale: true })
            .pipe(Effect.provideService(FileSystem.FileSystem, racing))
          expect(raced).toBe(true)
          expect(result._tag).toBe("NotRunning")
          expect(Option.getOrThrow(yield* serverLockFile.read(home)).serverId).toBe("new-owner")
        }),
      ),
  )

  it.scopedLive("a held lock that names no pid signals nothing", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* holdAsAnotherServer(home)
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("Unnamed")
        expect(signals).toEqual([])
      }),
    ),
  )

  it.scopedLive("a free kernel lock keeps its entry unless the caller asks to remove it", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        // The pid is this live process: only the kernel lock proves the server gone.
        yield* serverLockFile.write(home, makeEntry())
        expect((yield* serverLock.stop(home))._tag).toBe("NotRunning")
        expect(Option.isSome(yield* serverLockFile.read(home))).toBe(true)
        expect((yield* serverLock.stop(home, { removeStale: true }))._tag).toBe("Removed")
        expect(Option.isNone(yield* serverLockFile.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("a live pid whose endpoint names another process is not signalled", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* lockWithEndpoint(home, (entry) => ({ ...identityOf(entry), pid: 99999999 }))
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("NotOwned")
        expect(signals).toEqual([])
        expect(Option.isSome(yield* serverLockFile.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("an unreachable identity endpoint is not signalled", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* serverLockFile.write(home, makeEntry({ rpcUrl: "http://127.0.0.1:1/rpc" }))
        yield* holdAsAnotherServer(home)
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("NotOwned")
        expect(signals).toEqual([])
      }),
    ),
  )

  it.scopedLive("a confirmed identity that ignores SIGTERM keeps its lock", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* lockWithEndpoint(home, identityOf)
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("StillRunning")
        expect(signals).toEqual(["SIGTERM"])
        expect(Option.isSome(yield* serverLockFile.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("a confirmed identity gets SIGTERM, and its lock goes once it exits", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const { release } = yield* lockWithEndpoint(home, identityOf)
        const { result, signals } = yield* serverLock.stop(home).pipe(signalTrap(release))
        expect(result._tag).toBe("Stopped")
        expect(signals).toEqual(["SIGTERM"])
        expect(Option.isNone(yield* serverLockFile.read(home))).toBe(true)
      }),
    ),
  )
})

// ── logs ────────────────────────────────────────────────────────────────────

describe("server logs", () => {
  // Logs follow the data directory. A run without GENT_DATA_DIR logs under
  // `<home>/.gent/logs`; under the test preload the home is this file's own,
  // so the logs go away with it instead of piling up in a shared /tmp path.
  it.scopedLive("a server without a data directory logs under its home's data directory", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = `${process.cwd()}/log-location-probe`
        yield* Gent.server({ cwd, state: Gent.state.memory(), provider: Gent.provider.mock() })
        const { log } = buildLogPaths(cwd, `${homedir()}/.gent/logs`)
        expect(yield* fs.exists(log)).toBe(true)
      }).pipe(Effect.timeout("15 seconds")),
    ),
  )
})
