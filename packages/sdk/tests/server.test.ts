import { describe, expect, it } from "effect-bun-test"
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  type Scope,
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

// ── build-fingerprint.test ──────────────────────────────────────────────────

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
      homeDirectory: Effect.succeed("/tmp"),
      pathListSeparator: Effect.succeed(":"),
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

        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        const result = yield* program.pipe(Effect.provide(buildFp))

        // Caching contract: only one underlying stat call, all three fingerprints identical.
        expect(result.statCalls).toBe(1)
        expect(result.fp1).toBe(result.fp2)
        expect(result.fp2).toBe(result.fp3)
        expect(result.fp1).toMatch(/^bin-/)
      }),
  )

  it.live("Test layer returns deterministic fingerprint", () =>
    Effect.gen(function* () {
      const bf = yield* BuildFingerprint
      expect(yield* bf.current).toBe("test-fingerprint")
    }).pipe(Effect.provide(BuildFingerprint.Test())),
  )

  it.live("Test layer with override returns custom fingerprint", () =>
    Effect.gen(function* () {
      const bf = yield* BuildFingerprint
      const fp = yield* bf.current
      expect(fp).toBe("custom-fp")
    }).pipe(Effect.provide(BuildFingerprint.Test("custom-fp"))),
  )
})

// ── launch-config.test ──────────────────────────────────────────────────────

/**
 * The launch values `apps/server/src/main.ts` reads its environment through.
 *
 * A launcher gets strings. Before this config, `Number()` accepted anything
 * finite and an unknown mode string fell through to the default, so two wrong
 * values ran instead of stopping: `GENT_IDLE_TIMEOUT_MS=-1` made the idle
 * watcher shut the server down on its first poll, and a misspelled
 * `GENT_PROVIDER_MODE` selected the live provider for a caller that asked for
 * the scripted one. Each test below names the value that used to pass.
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

describe("GENT_IDLE_TIMEOUT_MS", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({})
      expect(launch.idleTimeoutMs).toBe(30_000)
    }),
  )

  it.effect("a positive whole number is taken as given", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({ GENT_IDLE_TIMEOUT_MS: "250" })
      expect(launch.idleTimeoutMs).toBe(250)
    }),
  )

  it.effect("a negative timeout fails instead of shutting the server down at once", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "-1" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("greater than 0")
    }),
  )

  it.effect("zero fails: an idle window of no length stops the server immediately", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "0" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("greater than 0")
    }),
  )

  it.effect("a fractional timeout fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "1.5" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("an integer")
    }),
  )

  it.effect("text that is not a number fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "soon" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("finite number")
    }),
  )
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
      expect(launch.serverMode).toBe("standalone")
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

  it.effect("a misspelled server mode fails instead of running standalone forever", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_SERVER_MODE: "share" })
      expect(failure).toContain("GENT_SERVER_MODE")
      expect(failure).toContain('"standalone" | "shared"')
    }),
  )

  it.effect("the mode comparison is exact, not a prefix", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_SERVER_MODE: "shared-extra" })
      expect(failure).toContain("GENT_SERVER_MODE")
      expect(failure).toContain('"standalone" | "shared"')
    }),
  )
})

// ── server-lock.test ────────────────────────────────────────────────────────

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
 * Trap SIGTERM to this process. A trapped SIGTERM marks the pid gone, so the
 * liveness probe that follows sees the server exit.
 */
const withSignalTrap = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly result: A; readonly signals: ReadonlyArray<string | number> },
  E,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const signals: Array<string | number> = []
    // oxlint-disable-next-line typescript/unbound-method -- this test restores the exact host function after its signal trap
    const originalKill = process.kill
    const replacement: typeof process.kill = (pid: number, signal?: string | number) => {
      if (pid !== process.pid) return originalKill(pid, signal)
      if (signal === "SIGTERM") {
        signals.push(signal)
        return true
      }
      // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- the trap keeps process.kill's contract: a gone pid throws ESRCH
      if (signals.length > 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
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
          const ownerStatus = yield* (yield* Gent.client(owner)).client.runtime.status()

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
          expect(identity.serverId).toBe(ownerStatus.serverId)
          expect(identity.pid).toBe(ownerStatus.pid)
        }),
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
})

describe("Server Lock Ownership", () => {
  it.scopedLive("status reads a live pid as alive and a gone pid as stale", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        expect((yield* serverLock.status(home))._tag).toBe("None")
        yield* serverLock.write(home, makeEntry())
        expect((yield* serverLock.status(home))._tag).toBe("Alive")
        yield* serverLock.write(home, makeEntry({ pid: 99999999 }))
        expect((yield* serverLock.status(home))._tag).toBe("Stale")
        yield* serverLock.write(home, makeEntry({ hostname: "alien-host" }))
        expect((yield* serverLock.status(home))._tag).toBe("None")
      }),
    ),
  )

  it.scopedLive("PID-reused stale server locks are removed without SIGTERM", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry({
          pid: process.pid,
          buildFingerprint: "stale-fingerprint",
        })
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
                  pid: 99999999,
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

        const signals: Array<{ pid: number; signal: string | number }> = []
        // oxlint-disable-next-line typescript/unbound-method -- this test restores the exact host function after its signal trap
        const originalKill = process.kill
        const replacement: typeof process.kill = (pid: number, signal?: string | number) => {
          if (signal === "SIGTERM") {
            signals.push({ pid, signal })
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
        yield* Gent.server({
          cwd: process.cwd(),
          state: Gent.state.sqlite({ home }),
          provider: Gent.provider.mock(),
        })

        expect(signals).toEqual([])
        const after = Option.getOrThrow(yield* serverLock.read(home))
        expect(after.serverId).not.toBe(entryWithEndpoint.serverId)
      }),
    ),
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
      return locked
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

  it.scopedLive("a gone pid keeps its lock unless the caller asks to remove it", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* serverLock.write(home, makeEntry({ pid: 99999999 }))
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
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("NotOwned")
        expect(signals).toEqual([])
      }),
    ),
  )

  it.scopedLive("a confirmed identity gets SIGTERM, and its lock goes once it exits", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* lockWithEndpoint(home, identityOf)
        const { result, signals } = yield* serverLock.stop(home).pipe(withSignalTrap)
        expect(result._tag).toBe("Stopped")
        expect(signals).toEqual(["SIGTERM"])
        expect(Option.isNone(yield* serverLock.read(home))).toBe(true)
      }),
    ),
  )
})
