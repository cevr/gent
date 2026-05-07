import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path, type Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { BunGentPlatformLive } from "@gent/core/runtime/gent-platform-bun.js"
// @effect-diagnostics nodeBuiltinImport:off
import { hostname, tmpdir } from "node:os"
import { Gent } from "../src/client"
import {
  ServerLockEntry,
  computeLocalFingerprint,
  resolveBuildFingerprint,
  readServerLock,
  writeServerLock,
  removeServerLock,
  validateServerLockEntry,
  serverLockIdentityOf,
  canSignalServerLockEntry,
  signalIfIdentityOwned,
} from "../src/server-lock"

const PlatformLayer = Layer.mergeAll(BunServices.layer, BunGentPlatformLive)

const provideFs = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Effect.Effect<A, E, Scope.Scope> => effect.pipe(Effect.provide(BunServices.layer))

const makeTmpHomeScoped = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(tmpdir(), `gent-server-lock-test-${Bun.randomUUIDv7()}`)
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
  it.live("computeLocalFingerprint returns a non-empty string", () =>
    Effect.gen(function* () {
      const fp = yield* computeLocalFingerprint.pipe(Effect.provide(PlatformLayer))
      expect(fp).toBeTruthy()
      expect(typeof fp).toBe("string")
      expect(fp.length).toBeGreaterThan(0)
    }),
  )

  it.live("computeLocalFingerprint is stable across calls", () =>
    Effect.gen(function* () {
      const fp1 = yield* computeLocalFingerprint.pipe(Effect.provide(PlatformLayer))
      const fp2 = yield* computeLocalFingerprint.pipe(Effect.provide(PlatformLayer))
      expect(fp1).toBe(fp2)
    }),
  )

  it.live("resolveBuildFingerprint resolves to a string", () =>
    Effect.gen(function* () {
      const fp = yield* resolveBuildFingerprint.pipe(Effect.provide(PlatformLayer))
      expect(typeof fp).toBe("string")
      expect(fp.length).toBeGreaterThan(0)
    }),
  )
})

describe("Server Lock", () => {
  it.scopedLive("writeServerLock + readServerLock roundtrip", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* writeServerLock(home, entry)
        const read = yield* readServerLock(home)
        expect(read).toBeDefined()
        expect(read!.serverId).toBe(entry.serverId)
        expect(read!.pid).toBe(entry.pid)
        expect(read!.rpcUrl).toBe(entry.rpcUrl)
        expect(read!.dbPath).toBe(entry.dbPath)
        expect(read!.buildFingerprint).toBe(entry.buildFingerprint)
      }),
    ),
  )

  it.scopedLive("readServerLock returns undefined for missing or corrupt lock", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        expect(yield* readServerLock(home)).toBeUndefined()
        yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
        yield* fs.writeFileString(path.join(home, ".gent", "server.lock"), "not json")
        expect(yield* readServerLock(home)).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("readServerLock rejects a lock from another host", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry({ hostname: "other-host.example.com" })
        yield* writeServerLock(home, entry)
        expect(yield* readServerLock(home)).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("removeServerLock removes only the matching server id", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* writeServerLock(home, entry)
        expect(yield* removeServerLock(home, "wrong-id")).toBe(false)
        expect(yield* readServerLock(home)).toBeDefined()
        expect(yield* removeServerLock(home, entry.serverId)).toBe(true)
        expect(yield* readServerLock(home)).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("a second sqlite Gent.server attaches to the single shared server", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const dbPath = `${home}/data.db`
        const server1 = yield* Gent.server({
          cwd: process.cwd(),
          state: Gent.state.sqlite({ home, dbPath }),
          provider: Gent.provider.mock(),
        })
        const server2 = yield* Gent.server({
          cwd: `${process.cwd()}/other-workspace`,
          state: Gent.state.sqlite({ home, dbPath: `${home}/other.db` }),
          provider: Gent.provider.mock(),
        })
        expect(server1._tag).toBe("owned")
        expect(server2._tag).toBe("attached")
        expect(server2.url).toBe(server1.url)
      }),
    ),
  )
})

describe("Server Lock Ownership", () => {
  it.live("validates lock host and PID", () =>
    Effect.sync(() => {
      expect(validateServerLockEntry(makeEntry()).valid).toBe(true)
      expect(validateServerLockEntry(makeEntry({ hostname: "alien-host" })).reason).toBe(
        "different-host",
      )
      expect(validateServerLockEntry(makeEntry({ pid: 99999999 })).reason).toBe("dead-pid")
    }),
  )

  it.live("serverLockIdentityOf returns the owned identity tuple", () =>
    Effect.sync(() => {
      const entry = makeEntry()
      expect(serverLockIdentityOf(entry)).toEqual({
        serverId: entry.serverId,
        pid: entry.pid,
        hostname: entry.hostname,
        dbPath: entry.dbPath,
        buildFingerprint: entry.buildFingerprint,
      })
    }),
  )

  it.live("canSignalServerLockEntry requires same host and live PID", () =>
    Effect.sync(() => {
      expect(canSignalServerLockEntry(makeEntry())).toBe(true)
      expect(canSignalServerLockEntry(makeEntry({ hostname: "other-host" }))).toBe(false)
      expect(canSignalServerLockEntry(makeEntry({ pid: 99999999 }))).toBe(false)
    }),
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
        yield* writeServerLock(home, entryWithEndpoint)

        const signals: Array<{ pid: number; signal: string | number | undefined }> = []
        const originalKill = Reflect.get(process, "kill") as typeof process.kill
        const replacement = ((pid: number, signal?: string | number) => {
          if (signal === "SIGTERM") {
            signals.push({ pid, signal })
            return true
          }
          return originalKill(pid, signal)
        }) as typeof process.kill

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
          state: Gent.state.sqlite({ home, dbPath: entry.dbPath }),
          provider: Gent.provider.mock(),
        })

        expect(signals).toEqual([])
        const after = yield* readServerLock(home)
        expect(after?.serverId).not.toBe(entryWithEndpoint.serverId)
      }),
    ),
  )
})

describe("signalIfIdentityOwned", () => {
  const withSignalTrap = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    { readonly result: A; readonly signals: ReadonlyArray<string | number | undefined> },
    E,
    R | Scope.Scope
  > =>
    Effect.gen(function* () {
      const signals: Array<string | number | undefined> = []
      const originalKill = Reflect.get(process, "kill") as typeof process.kill
      const replacement = ((pid: number, signal?: string | number) => {
        if (pid === process.pid && signal === "SIGTERM") {
          signals.push(signal)
          return true
        }
        return originalKill(pid, signal)
      }) as typeof process.kill

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

  it.live("skips when PID is not alive", () =>
    Effect.gen(function* () {
      let probeCalled = false
      const result = yield* signalIfIdentityOwned(makeEntry({ pid: 99999999 }), () => {
        probeCalled = true
        return Effect.succeed(true)
      })
      expect(result).toBe("skipped")
      expect(probeCalled).toBe(false)
    }),
  )

  it.scopedLive("skips when probe says identity does not match", () =>
    Effect.gen(function* () {
      const { result, signals } = yield* withSignalTrap(
        signalIfIdentityOwned(makeEntry({ pid: process.pid }), () => Effect.succeed(false)),
      )
      expect(result).toBe("skipped")
      expect(signals).toEqual([])
    }),
  )

  it.scopedLive("signals when probe confirms identity", () =>
    Effect.gen(function* () {
      const { result, signals } = yield* withSignalTrap(
        signalIfIdentityOwned(makeEntry({ pid: process.pid }), () => Effect.succeed(true)),
      )
      expect(result).toBe("signaled")
      expect(signals).toEqual(["SIGTERM"])
    }),
  )

  it.scopedLive("skips when probe fails", () =>
    Effect.gen(function* () {
      const { result, signals } = yield* withSignalTrap(
        signalIfIdentityOwned(makeEntry({ pid: process.pid }), () => Effect.fail("probe boom")),
      )
      expect(result).toBe("skipped")
      expect(signals).toEqual([])
    }),
  )
})
