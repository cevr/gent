import { describe, expect, it } from "effect-bun-test"
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Exit,
  Ref,
  Schema,
  Scope,
} from "effect"
import * as ChildProcessSpawnerNs from "effect/unstable/process/ChildProcessSpawner"
import { dateFromMillis } from "@gent/core/protocol"
import { BunGentPlatformLive } from "@gent/core/test-utils"
import { GentPlatform } from "@gent/core/host"
import {
  BuildFingerprint,
  dataPaths,
  LaunchConfig,
  serverLock,
  ServerLockEntry,
} from "../src/server"
import { BunServices } from "@effect/platform-bun"
import { hostname, tmpdir } from "node:os"
import { Gent } from "../src/client"

// ── build fingerprint ───────────────────────────────────────────────────────

// Compiled-binary execPath path. computeLocalFingerprintUncached takes the
// binary-mtime branch and calls fs.stat(exe), so a counter-driven mtime
// proves whether the cache is wired correctly.
const COMPILED_BIN_PATH = "/tmp/fake-gent-binary"

// Full GentPlatform override: same shape as GentPlatform.Test but with
// execPath pointing at a fake compiled binary so isCompiledBinary(exe)
// returns true and the stat branch fires.
const PlatformCompiledBin: Layer.Layer<GentPlatform> = Layer.effect(
  GentPlatform,
  Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    return GentPlatform.of({
      bindModules: () => Effect.void,
      randomId: Ref.updateAndGet(counter, (n) => n + 1).pipe(
        Effect.map((n) => `bf-${String(n).padStart(8, "0")}`),
      ),
      osInfo: Effect.succeed({
        platform: "linux",
        arch: "x64",
        release: "test-release",
        hostname: "test-host",
        type: "Linux",
      }),
      pid: Effect.succeed(1),
      execPath: Effect.succeed(COMPILED_BIN_PATH),
      homeDirectory: Effect.succeed("/nonexistent/gent-test-home"),
      signal: () => Effect.void,
      hash: (_alg, input) => {
        let text = input
        if (!Predicate.isString(text)) text = new TextDecoder().decode(text)
        let h = 5381
        for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i)
        return (h >>> 0).toString(16).padStart(64, "0")
      },
    })
  }),
)

// FileSystem.layerNoop with a counter-driven stat: each stat call returns a
// fresh mtime. Cached: first mtime is locked in. Uncached: every read sees a
// new mtime → fingerprint changes between calls.
const makeCountingFs = (counter: Ref.Ref<number>): Layer.Layer<FileSystem.FileSystem> =>
  FileSystem.layerNoop({
    stat: () =>
      Ref.updateAndGet(counter, (n) => n + 1).pipe(
        Effect.map((n) => ({
          type: "File",
          mtime: Option.some(dateFromMillis(n * 1000)),
          atime: Option.none(),
          birthtime: Option.none(),
          dev: 0,
          ino: Option.none(),
          mode: 0,
          nlink: Option.none(),
          uid: Option.none(),
          gid: Option.none(),
          rdev: Option.none(),
          size: FileSystem.Size(0),
          blksize: Option.none(),
          blocks: Option.none(),
        })),
      ),
  })

describe("BuildFingerprint", () => {
  it.live(
    "Live caches local fingerprint across calls (regression — without cache, mtime changes per call)",
    () =>
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        const fs = makeCountingFs(counter)
        // ChildProcessSpawner stub: binary-mtime branch returns before spawn is reached.
        // Any actual call would die loudly.
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawnerNs.ChildProcessSpawner,
          ChildProcessSpawnerNs.make(() =>
            Effect.die(new Error("ChildProcessSpawner.spawn unreachable in this test")),
          ),
        )
        const platformLayer = Layer.mergeAll(PlatformCompiledBin, fs, Path.layer, spawnerLayer)
        const buildFp = BuildFingerprint.Live.pipe(Layer.provide(platformLayer))

        const program = Effect.gen(function* () {
          const bf = yield* BuildFingerprint
          const fp1 = yield* bf.current
          const fp2 = yield* bf.current
          const fp3 = yield* bf.current
          return { fp1, fp2, fp3, statCalls: yield* Ref.get(counter) }
        })

        const result = yield* program.pipe(Effect.provide(buildFp))

        // Caching contract: only one underlying stat call, all three fingerprints identical.
        expect(result.statCalls).toBe(1)
        expect(result.fp1).toBe(result.fp2)
        expect(result.fp2).toBe(result.fp3)
        expect(result.fp1).toMatch(/^bin-/)
      }),
  )
})

// ── launch config ───────────────────────────────────────────────────────────

/**
 * The launch values `apps/server/src/main.ts` reads its environment through.
 *
 * A launcher gets strings. Before this config, `Number()` accepted anything
 * finite and an unknown mode string fell through to the default, so a wrong
 * value ran instead of stopping: a misspelled `GENT_PROVIDER_MODE` selected
 * the live provider for a caller that asked for the scripted one. Each test
 * below names the value that used to pass.
 *
 * Every case drives the real `ConfigProvider`, so it exercises the same path
 * the launcher takes rather than a decoder called by hand.
 */

/** Read `LaunchConfig` against an environment holding exactly `env`. */
const launchWith = (env: Record<string, string>) =>
  LaunchConfig.parse(ConfigProvider.fromEnvRecord(env))

/** The failure `LaunchConfig` gives for `env`, as its rendered message. */
const failureOf = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(launchWith(env))
    if (result._tag === "Success") {
      const named = Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
      return yield* Effect.die(`expected a config failure for ${named}`)
    }
    return String(result.failure)
  })

describe("GENT_PORT", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({})
      expect(launch.port).toBe(3000)
    }),
  )

  it.effect("a port inside the TCP range is taken as given", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({ GENT_PORT: "8080" })
      expect(launch.port).toBe(8080)
    }),
  )

  it.effect("a port above the TCP range fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PORT: "70000" })
      expect(failure).toContain("GENT_PORT")
      expect(failure).toContain("between 1 and 65535")
    }),
  )

  it.effect("a negative port fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PORT: "-8080" })
      expect(failure).toContain("GENT_PORT")
      expect(failure).toContain("between 1 and 65535")
    }),
  )

  it.effect("port zero fails: the launcher names a port its clients dial", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PORT: "0" })
      expect(failure).toContain("GENT_PORT")
      expect(failure).toContain("between 1 and 65535")
    }),
  )
})

describe("mode words", () => {
  it.effect("unset variables take their fallbacks", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({})
      expect(launch.providerMode).toBe("live")
      expect(launch.persistenceMode).toBe("sqlite")
    }),
  )

  it.effect("a known mode is taken as given", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({ GENT_PROVIDER_MODE: "debug-scripted" })
      expect(launch.providerMode).toBe("debug-scripted")
    }),
  )

  it.effect("a misspelled provider mode fails instead of selecting the live provider", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PROVIDER_MODE: "debug-script" })
      expect(failure).toContain("GENT_PROVIDER_MODE")
      expect(failure).toContain('"live" | "debug-scripted"')
    }),
  )

  it.effect("a misspelled persistence mode fails instead of writing SQLite", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PERSISTENCE_MODE: "in-memory" })
      expect(failure).toContain("GENT_PERSISTENCE_MODE")
      expect(failure).toContain('"sqlite" | "memory"')
    }),
  )
})

// ── server lock ─────────────────────────────────────────────────────────────

// @effect-diagnostics nodeBuiltinImport:off

const PlatformBaseLayer = Layer.mergeAll(BunServices.layer, BunGentPlatformLive)
const PlatformLayer = Layer.merge(
  PlatformBaseLayer,
  BuildFingerprint.Live.pipe(Layer.provide(PlatformBaseLayer)),
)

const provideFs = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    BuildFingerprint | FileSystem.FileSystem | GentPlatform | Path.Path | Scope.Scope
  >,
): Effect.Effect<A, E, Scope.Scope> => effect.pipe(Effect.provide(PlatformLayer))

const makeTmpHomeScoped = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const dir = path.join(tmpdir(), `gent-server-lock-test-${yield* platform.randomId}`)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* Effect.addFinalizer(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore))
  return dir
})

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

describe("Build Fingerprint", () => {
  it.live("BuildFingerprint.current returns a non-empty string", () =>
    Effect.gen(function* () {
      const bf = yield* BuildFingerprint
      const fp = yield* bf.current
      expect(fp).toBeTruthy()
      expect(fp.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(PlatformLayer)),
  )

  it.live("BuildFingerprint.current is cached across calls", () =>
    Effect.gen(function* () {
      const bf = yield* BuildFingerprint
      const fp1 = yield* bf.current
      const fp2 = yield* bf.current
      expect(fp1).toBe(fp2)
    }).pipe(Effect.provide(PlatformLayer)),
  )
})

/**
 * Trap SIGTERM to this process and run `onSigterm` in its place. A server that
 * exits on SIGTERM releases its kernel lock there; the default ignores it.
 */
const signalTrap =
  (onSigterm: Effect.Effect<void> = Effect.void) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    { readonly result: A; readonly signals: ReadonlyArray<string | number> },
    E,
    R | Scope.Scope
  > =>
    Effect.gen(function* () {
      const signals: Array<string | number> = []
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      // oxlint-disable-next-line typescript/unbound-method -- this test restores the exact host function after its signal trap
      const originalKill = process.kill
      const replacement: typeof process.kill = (pid: number, signal?: string | number) => {
        if (pid !== process.pid) return originalKill(pid, signal)
        if (signal === "SIGTERM") {
          signals.push(signal)
          runSync(onSigterm)
          return true
        }
        return originalKill(pid, signal)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.kill = replacement
        }),
        () =>
          Effect.sync(() => {
            process.kill = originalKill
          }),
      )
      const result = yield* effect
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
    expect(yield* serverLock.hold(home).pipe(Scope.provide(scope))).toBe(true)
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
          yield* isolated(serverLock.write(home, entry))
          const fs = yield* FileSystem.FileSystem
          expect(yield* fs.exists(`${dataDir}/server.lock`)).toBe(true)
          expect(yield* fs.exists(`${home}/.gent/server.lock`)).toBe(false)
          // the home-scoped reader does not see the isolated run's server
          expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
          expect(Option.isSome(yield* isolated(serverLock.read(home)))).toBe(true)
        }),
      ),
  )

  it.scopedLive("a written lock reads back field for field", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* serverLock.write(home, entry)
        const read = Option.getOrThrow(yield* serverLock.read(home))
        expect(read.serverId).toBe(entry.serverId)
        expect(read.pid).toBe(entry.pid)
        expect(read.rpcUrl).toBe(entry.rpcUrl)
        expect(read.dbPath).toBe(entry.dbPath)
        expect(read.buildFingerprint).toBe(entry.buildFingerprint)
      }),
    ),
  )

  it.scopedLive("a missing or corrupt lock reads as absent", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
        yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
        yield* fs.writeFileString(path.join(home, ".gent", "server.lock"), "not json")
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("a lock from another host reads as absent", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry({ hostname: "other-host.example.com" })
        yield* serverLock.write(home, entry)
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("removing a lock needs its server id", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* serverLock.write(home, entry)
        expect(yield* serverLock.remove(home, "wrong-id")).toBe(false)
        expect(Option.isSome(yield* serverLock.read(home))).toBe(true)
        expect(yield* serverLock.remove(home, entry.serverId)).toBe(true)
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("a second sqlite Gent.server attaches to the single shared server", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const dbPath = (yield* dataPaths(home)).dbPath
        const buildFingerprint = yield* (yield* BuildFingerprint).current
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
        yield* serverLock.write(home, entryWithEndpoint)
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
          const ownerEntry = Option.getOrThrow(yield* serverLock.read(home))

          const attached = yield* Gent.server(options)
          expect(attached._tag).toBe("Attached")
          expect(attached.url).toBe(owner.url)

          const response = yield* Effect.promise(() =>
            Bun.fetch(`${attached.url.replace("/rpc", "")}/_gent/identity`),
          )
          const identity = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ serverId: Schema.String, pid: Schema.Finite }),
              ),
            ),
          )
          expect(identity.serverId).toBe(ownerEntry.serverId)
          expect(identity.pid).toBe(process.pid)
        }).pipe(Effect.timeout("20 seconds")),
      ),
  )

  it.scopedLive(
    "the lock and the identity endpoint name one build, so a second server attaches",
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
          const entry = Option.getOrThrow(yield* serverLock.read(home))
          const response = yield* Effect.promise(() =>
            Bun.fetch(`${owner.url.replace("/rpc", "")}/_gent/identity`),
          )
          const identity = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ buildFingerprint: Schema.String })),
            ),
          )
          expect(identity.buildFingerprint).toBe(entry.buildFingerprint)
          const second = yield* Gent.server(options)
          expect(second._tag).toBe("Attached")
        }).pipe(
          // An environment that names a build fingerprint must not split the two records.
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ GENT_BUILD_FINGERPRINT: "operator-pinned" }),
          ),
          Effect.timeout("20 seconds"),
        ),
      ),
  )

  it.scopedLive("a lock that names another database is replaced, not attached", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const ownDb = (yield* dataPaths(home)).dbPath
        const buildFingerprint = yield* (yield* BuildFingerprint).current
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
        yield* serverLock.write(
          home,
          new ServerLockEntry({ ...entry, rpcUrl: `${new URL(foreignOwner.url).origin}/rpc` }),
        )

        const { result: server } = yield* Gent.server({
          cwd: home,
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        }).pipe(withSignalTrap)
        expect(server._tag).toBe("Owned")
        expect(Option.getOrThrow(yield* serverLock.read(home)).dbPath).toBe(ownDb)
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
        expect(Option.getOrThrow(yield* serverLock.read(home)).rpcUrl).toBe(owner.url)
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
        const pid = Option.getOrThrow(yield* serverLock.read(home)).pid
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
    yield* serverLock.write(home, locked)
    return locked
  })

describe("Server Lock Ownership", () => {
  /** Start a sqlite server on `home` while the lock names `pid`, which no gent server owns. */
  const startOverLockNaming = (pid: number) =>
    Effect.gen(function* () {
      const home = yield* makeTmpHomeScoped
      const dbPath = (yield* dataPaths(home)).dbPath
      const buildFingerprint = yield* (yield* BuildFingerprint).current
      yield* serverLock.write(
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
      expect(Option.getOrThrow(yield* serverLock.read(home)).serverId).not.toBe("test-server-1")
    }).pipe(Effect.timeout("20 seconds"))

  it.scopedLive("a lock whose pid now belongs to another live process does not block startup", () =>
    provideFs(startOverLockNaming(process.ppid)),
  )

  it.scopedLive("a lock that names the new process's own pid does not block startup", () =>
    provideFs(startOverLockNaming(process.pid)),
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

  it.scopedLive("status reads the kernel lock, not the pid the entry names", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        expect((yield* serverLock.status(home))._tag).toBe("None")
        // A live pid under a free kernel lock is a server that is gone.
        yield* serverLock.write(home, makeEntry())
        expect((yield* serverLock.status(home))._tag).toBe("Stale")
        const { release } = yield* holdAsAnotherServer(home)
        expect((yield* serverLock.status(home))._tag).toBe("Alive")
        yield* serverLock.remove(home, "test-server-1")
        expect((yield* serverLock.status(home))._tag).toBe("Unnamed")
        yield* release
        expect((yield* serverLock.status(home))._tag).toBe("None")
        yield* serverLock.write(home, makeEntry({ hostname: "alien-host" }))
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
          const buildFingerprint = yield* (yield* BuildFingerprint).current
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
          expect(Option.getOrThrow(yield* serverLock.read(home)).serverId).toBe(holder.serverId)
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
        expect(Option.getOrThrow(yield* serverLock.read(home)).serverId).toBe(holder.serverId)
      }),
    ),
  )

  it.scopedLive(
    "an older-build server that answers but holds no kernel lock blocks startup unsignalled",
    () =>
      provideFs(
        Effect.gen(function* () {
          const home = yield* makeTmpHomeScoped
          const dbPath = (yield* dataPaths(home)).dbPath
          // A server from before the kernel lock: it serves its identity but holds no lock.
          const holder = yield* lockWithIdentity(
            home,
            makeEntry({ dbPath, buildFingerprint: "older-build" }),
            {},
          )
          expect((yield* serverLock.status(home))._tag).toBe("Alive")
          const { result, signals } = yield* Gent.server({
            cwd: home,
            state: Gent.state.sqlite({ home }),
            provider: Gent.provider.mock(),
          }).pipe(Effect.flip, withSignalTrap)
          expect(result._tag).toBe("@gent/core/GentConnectionError")
          expect(result.message).toContain(`PID ${holder.pid}`)
          expect(result.message).toContain("older-build")
          expect(signals).toEqual([])
          expect(Option.getOrThrow(yield* serverLock.read(home)).serverId).toBe(holder.serverId)
        }),
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
          const buildFingerprint = yield* (yield* BuildFingerprint).current
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
          yield* serverLock.write(
            home,
            makeEntry({ pid: holder.pid, dbPath: paths.dbPath, buildFingerprint }),
          )
          expect((yield* serverLock.status(home))._tag).toBe("Alive")

          holder.kill("SIGKILL")
          yield* Effect.promise(() => holder.exited)
          expect((yield* serverLock.status(home))._tag).toBe("Stale")
          // The pid now names this process, which is alive and serves nothing yet.
          yield* serverLock.write(
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
      yield* serverLock.write(home, locked)
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
        yield* serverLock.write(home, makeEntry({ hostname: "other-host" }))
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
              if (yield* serverLock.hold(home).pipe(Scope.provide(newOwnerScope))) {
                newOwnerTookLock = true
                yield* serverLock.write(home, newOwner)
              }
            }).pipe(
              Effect.orDie,
              Effect.provideService(FileSystem.FileSystem, base),
              Effect.andThen(base.remove(path, options)),
            )
          },
        })
        yield* serverLock.write(home, makeEntry({ rpcUrl: "http://127.0.0.1:1/rpc" }))
        const result = yield* serverLock
          .stop(home, { removeStale: true })
          .pipe(Effect.provideService(FileSystem.FileSystem, racing))
        expect(result._tag).toBe("Removed")
        expect(paused).toBe(true)
        if (newOwnerTookLock) {
          expect(Option.getOrThrow(yield* serverLock.read(home)).serverId).toBe("new-owner")
        }
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
        yield* serverLock.write(home, makeEntry())
        expect((yield* serverLock.stop(home))._tag).toBe("NotRunning")
        expect(Option.isSome(yield* serverLock.read(home))).toBe(true)
        expect((yield* serverLock.stop(home, { removeStale: true }))._tag).toBe("Removed")
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
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
        expect(Option.isSome(yield* serverLock.read(home))).toBe(true)
      }),
    ),
  )

  it.scopedLive("an unreachable identity endpoint is not signalled", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* serverLock.write(home, makeEntry({ rpcUrl: "http://127.0.0.1:1/rpc" }))
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
        expect(Option.isSome(yield* serverLock.read(home))).toBe(true)
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
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
      }),
    ),
  )
})
