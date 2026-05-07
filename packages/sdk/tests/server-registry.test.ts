import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, FileSystem, Layer, Path, type Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { BunGentPlatformLive } from "@gent/core/runtime/gent-platform-bun.js"
// @effect-diagnostics nodeBuiltinImport:off
import { hostname, tmpdir } from "node:os"
import { Gent } from "../src/client"
import {
  ServerRegistryEntry,
  computeLocalFingerprint,
  resolveBuildFingerprint,
  readRegistryEntry,
  writeRegistryEntry,
  removeRegistryEntry,
  listRegistryEntries,
  validateRegistryEntry,
  isPidAlive,
  registryIdentityOf,
  canSignalRegistryEntry,
  signalIfIdentityOwned,
  acquireLock,
  releaseLock,
  withLock,
} from "../src/server-registry"

const PlatformLayer = Layer.mergeAll(BunServices.layer, BunGentPlatformLive)

const provideFs = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Effect.Effect<A, E, Scope.Scope> => effect.pipe(Effect.provide(BunServices.layer))

const makeTmpHomeScoped = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(tmpdir(), `gent-registry-test-${Bun.randomUUIDv7()}`)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* Effect.addFinalizer(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore))
  return dir
})

const makeEntry = (overrides?: Partial<ServerRegistryEntry>) =>
  new ServerRegistryEntry({
    serverId: "test-server-1",
    pid: process.pid,
    hostname: hostname(),
    rpcUrl: "ws://127.0.0.1:9999",
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

describe("Server Registry", () => {
  it.scopedLive("writeRegistryEntry + readRegistryEntry roundtrip", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* writeRegistryEntry(home, entry)
        const read = yield* readRegistryEntry(home, entry.dbPath)
        expect(read).toBeDefined()
        expect(read!.serverId).toBe(entry.serverId)
        expect(read!.pid).toBe(entry.pid)
        expect(read!.rpcUrl).toBe(entry.rpcUrl)
        expect(read!.dbPath).toBe(entry.dbPath)
        expect(read!.buildFingerprint).toBe(entry.buildFingerprint)
      }),
    ),
  )

  it.scopedLive("readRegistryEntry returns undefined for missing entry", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const read = yield* readRegistryEntry(home, "/nonexistent.db")
        expect(read).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("readRegistryEntry returns undefined for corrupt file", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        const dir = path.join(home, ".gent", "servers")
        yield* fs.makeDirectory(dir, { recursive: true })
        const entry = makeEntry()
        yield* writeRegistryEntry(home, entry)
        const files = (yield* fs.readDirectory(dir)).filter((f) => f.endsWith(".json"))
        if (files.length > 0) {
          yield* fs.writeFileString(path.join(dir, files[0]!), "not json")
        }
        const read = yield* readRegistryEntry(home, entry.dbPath)
        expect(read).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("readRegistryEntry rejects entry from different host", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry({ hostname: "other-host.example.com" })
        yield* writeRegistryEntry(home, entry)
        const read = yield* readRegistryEntry(home, entry.dbPath)
        expect(read).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("removeRegistryEntry removes matching entry", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* writeRegistryEntry(home, entry)
        const removed = yield* removeRegistryEntry(home, entry.dbPath, entry.serverId)
        expect(removed).toBe(true)
        const after = yield* readRegistryEntry(home, entry.dbPath)
        expect(after).toBeUndefined()
      }),
    ),
  )

  it.scopedLive("removeRegistryEntry rejects mismatched serverId", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry()
        yield* writeRegistryEntry(home, entry)
        const removed = yield* removeRegistryEntry(home, entry.dbPath, "wrong-id")
        expect(removed).toBe(false)
        const after = yield* readRegistryEntry(home, entry.dbPath)
        expect(after).toBeDefined()
      }),
    ),
  )

  it.scopedLive("registry key is stable for same dbPath", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry1 = makeEntry({ serverId: "s1" })
        yield* writeRegistryEntry(home, entry1)
        const read1 = yield* readRegistryEntry(home, entry1.dbPath)
        expect(read1?.serverId).toBe("s1")

        const entry2 = makeEntry({ serverId: "s2" })
        yield* writeRegistryEntry(home, entry2)
        const read2 = yield* readRegistryEntry(home, entry2.dbPath)
        expect(read2?.serverId).toBe("s2")
      }),
    ),
  )

  it.scopedLive("different dbPaths get different registry files", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry1 = makeEntry({ dbPath: "/tmp/a.db", serverId: "s1" })
        const entry2 = makeEntry({ dbPath: "/tmp/b.db", serverId: "s2" })
        yield* writeRegistryEntry(home, entry1)
        yield* writeRegistryEntry(home, entry2)

        const a = yield* readRegistryEntry(home, "/tmp/a.db")
        const b = yield* readRegistryEntry(home, "/tmp/b.db")
        expect(a?.serverId).toBe("s1")
        expect(b?.serverId).toBe("s2")
      }),
    ),
  )
})

describe("listRegistryEntries", () => {
  it.scopedLive("returns empty array when no registry dir exists", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entries = yield* listRegistryEntries(home)
        expect(entries).toEqual([])
      }),
    ),
  )

  it.scopedLive("returns all written entries", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const entry1 = makeEntry({ dbPath: "/tmp/a.db", serverId: "s1" })
        const entry2 = makeEntry({ dbPath: "/tmp/b.db", serverId: "s2" })
        yield* writeRegistryEntry(home, entry1)
        yield* writeRegistryEntry(home, entry2)

        const entries = yield* listRegistryEntries(home)
        expect(entries.length).toBe(2)
        const ids = entries.map((e) => e.serverId).sort()
        expect(ids).toEqual(["s1", "s2"])
      }),
    ),
  )

  it.scopedLive("skips corrupt files", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        const entry = makeEntry({ dbPath: "/tmp/good.db", serverId: "good" })
        yield* writeRegistryEntry(home, entry)

        const dir = path.join(home, ".gent", "servers")
        yield* fs.writeFileString(path.join(dir, "corrupt.json"), "not json at all")

        const entries = yield* listRegistryEntries(home)
        expect(entries.length).toBe(1)
        expect(entries[0]!.serverId).toBe("good")
      }),
    ),
  )

  it.scopedLive("includes entries from other hosts", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        // listRegistryEntries returns all entries — filtering is caller's job
        const local = makeEntry({ dbPath: "/tmp/local.db", serverId: "local" })
        const remote = makeEntry({
          dbPath: "/tmp/remote.db",
          serverId: "remote",
          hostname: "other-host",
        })
        yield* writeRegistryEntry(home, local)
        yield* writeRegistryEntry(home, remote)

        const entries = yield* listRegistryEntries(home)
        expect(entries.length).toBe(2)
      }),
    ),
  )
})

describe("Validate Registry Entry", () => {
  it.live("validates entry with alive PID and correct host", () =>
    Effect.sync(() => {
      const entry = makeEntry()
      const result = validateRegistryEntry(entry)
      expect(result.valid).toBe(true)
    }),
  )

  it.live("rejects entry from different host", () =>
    Effect.sync(() => {
      const entry = makeEntry({ hostname: "alien-host" })
      const result = validateRegistryEntry(entry)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe("different-host")
    }),
  )

  it.live("rejects entry with dead PID", () =>
    Effect.sync(() => {
      // PID 99999999 should not exist
      const entry = makeEntry({ pid: 99999999 })
      const result = validateRegistryEntry(entry)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe("dead-pid")
    }),
  )
})

describe("Registry Process Ownership", () => {
  it.live("registryIdentityOf returns the owned identity tuple", () =>
    Effect.sync(() => {
      const entry = makeEntry()
      expect(registryIdentityOf(entry)).toEqual({
        serverId: entry.serverId,
        pid: entry.pid,
        hostname: entry.hostname,
        dbPath: entry.dbPath,
        buildFingerprint: entry.buildFingerprint,
      })
    }),
  )

  it.live("canSignalRegistryEntry requires same host and live PID", () =>
    Effect.sync(() => {
      expect(canSignalRegistryEntry(makeEntry())).toBe(true)
      expect(canSignalRegistryEntry(makeEntry({ hostname: "other-host" }))).toBe(false)
      expect(canSignalRegistryEntry(makeEntry({ pid: 99999999 }))).toBe(false)
    }),
  )

  it.scopedLive("PID-reused stale registry entries are removed without SIGTERM", () =>
    provideFs(
      Effect.gen(function* () {
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        const dbPath = path.join(home, "pid-reuse.db")
        const entry = makeEntry({
          pid: process.pid,
          dbPath,
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
        const entryWithEndpoint = new ServerRegistryEntry({
          ...entry,
          rpcUrl: `${fakeOwnerUrl.origin}/rpc`,
        })
        yield* writeRegistryEntry(home, entryWithEndpoint)

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
          state: Gent.state.sqlite({ home, dbPath }),
          provider: Gent.provider.mock(),
        })

        expect(signals).toEqual([])
        const after = yield* readRegistryEntry(home, dbPath)
        expect(after?.serverId).not.toBe(entryWithEndpoint.serverId)
      }),
    ),
  )
})

describe("isPidAlive", () => {
  it.live("returns true for current process", () =>
    Effect.sync(() => {
      expect(isPidAlive(process.pid)).toBe(true)
    }),
  )

  it.live("returns false for non-existent PID", () =>
    Effect.sync(() => {
      expect(isPidAlive(99999999)).toBe(false)
    }),
  )
})

describe("Cross-Process Lock", () => {
  it.scopedLive("acquireLock succeeds on first call", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const acquired = yield* acquireLock(home, "/tmp/test.db")
        expect(acquired).toBe(true)
      }),
    ),
  )

  it.scopedLive("acquireLock fails on second call (already held)", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* acquireLock(home, "/tmp/test.db")
        const second = yield* acquireLock(home, "/tmp/test.db")
        expect(second).toBe(false)
      }),
    ),
  )

  it.scopedLive("releaseLock allows re-acquire", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* acquireLock(home, "/tmp/test.db")
        yield* releaseLock(home, "/tmp/test.db")
        const reacquired = yield* acquireLock(home, "/tmp/test.db")
        expect(reacquired).toBe(true)
      }),
    ),
  )

  it.scopedLive("different dbPaths have independent locks", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const a = yield* acquireLock(home, "/tmp/a.db")
        const b = yield* acquireLock(home, "/tmp/b.db")
        expect(a).toBe(true)
        expect(b).toBe(true)
      }),
    ),
  )

  it.scopedLive("withLock acquires and releases", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        let inside = false
        yield* withLock(
          home,
          "/tmp/test.db",
          Effect.gen(function* () {
            inside = true
            // Lock should be held during body
            const blocked = yield* acquireLock(home, "/tmp/test.db")
            expect(blocked).toBe(false)
          }),
        )
        expect(inside).toBe(true)
        // Lock should be released after body
        const reacquired = yield* acquireLock(home, "/tmp/test.db")
        expect(reacquired).toBe(true)
      }),
    ),
  )

  it.scopedLive("withLock releases on error", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        const result = yield* Effect.exit(withLock(home, "/tmp/test.db", Effect.fail("boom")))
        expect(result._tag).toBe("Failure")
        // Lock should still be released
        const reacquired = yield* acquireLock(home, "/tmp/test.db")
        expect(reacquired).toBe(true)
      }),
    ),
  )

  it.scopedLive("withLock fails with LockAcquireError when lock is held", () =>
    provideFs(
      Effect.gen(function* () {
        const home = yield* makeTmpHomeScoped
        yield* acquireLock(home, "/tmp/test.db")
        const result = yield* Effect.exit(withLock(home, "/tmp/test.db", Effect.succeed("ok")))
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.scopedLive("stale lock from dead PID is cleaned up", () =>
    provideFs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTmpHomeScoped
        const dir = path.join(home, ".gent", "servers")
        yield* fs.makeDirectory(dir, { recursive: true })
        // Use the same hash logic — acquire first, then tamper
        yield* acquireLock(home, "/tmp/stale.db")
        // Find the lock dir and rewrite the info with a dead PID
        const lockDirs = (yield* fs.readDirectory(dir)).filter((f) => f.endsWith(".lock"))
        // Release first, then manually create stale lock
        yield* releaseLock(home, "/tmp/stale.db")

        // Now manually create a stale lock
        const hash = lockDirs[0] ?? "fallback.lock"
        const lockDir = path.join(dir, hash)
        yield* fs.makeDirectory(lockDir, { recursive: true })
        const createdAt = yield* Clock.currentTimeMillis
        yield* fs.writeFileString(
          path.join(lockDir, "info.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            pid: 99999999,
            hostname: hostname(),
            createdAt,
          }),
        )

        // Should succeed because the existing lock has a dead PID
        const acquired = yield* acquireLock(home, "/tmp/stale.db")
        expect(acquired).toBe(true)
      }),
    ),
  )
})

describe("signalIfIdentityOwned", () => {
  it.live("skips when PID is not alive (PID-reuse guard)", () =>
    Effect.gen(function* () {
      const entry = makeEntry({ pid: 99999999 })
      let probeCalled = false
      const result = yield* signalIfIdentityOwned(entry, () => {
        probeCalled = true
        return Effect.succeed(true)
      })
      expect(result).toBe("skipped")
      expect(probeCalled).toBe(false)
    }),
  )

  it.scopedLive("skips when probe says identity does not match", () =>
    Effect.gen(function* () {
      // Spawn a subprocess that outlives the test window so PID stays alive
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" })),
        (subprocess) => Effect.sync(() => subprocess.kill()),
      )
      const entry = makeEntry({ pid: proc.pid })
      const result = yield* signalIfIdentityOwned(entry, () => Effect.succeed(false))
      expect(result).toBe("skipped")
      // Subprocess should still be alive — we didn't signal it
      expect(isPidAlive(proc.pid)).toBe(true)
    }),
  )

  it.live("skips on cross-host entry", () =>
    Effect.gen(function* () {
      const entry = makeEntry({ hostname: "definitely-not-this-host" })
      let probeCalled = false
      const result = yield* signalIfIdentityOwned(entry, () => {
        probeCalled = true
        return Effect.succeed(true)
      })
      expect(result).toBe("skipped")
      expect(probeCalled).toBe(false)
    }),
  )

  it.scopedLive("signals when probe confirms identity", () =>
    Effect.gen(function* () {
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" })),
        (subprocess) =>
          Effect.sync(() => {
            if (isPidAlive(subprocess.pid)) subprocess.kill()
          }),
      )
      const entry = makeEntry({ pid: proc.pid })
      const result = yield* signalIfIdentityOwned(entry, () => Effect.succeed(true))
      expect(result).toBe("signaled")
      yield* Effect.promise(() => proc.exited).pipe(Effect.timeout("2 seconds"))
      expect(isPidAlive(proc.pid)).toBe(false)
    }),
  )

  it.scopedLive("skips when probe fails (treated as no identity proof)", () =>
    Effect.gen(function* () {
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" })),
        (subprocess) => Effect.sync(() => subprocess.kill()),
      )
      const entry = makeEntry({ pid: proc.pid })
      const result = yield* signalIfIdentityOwned(entry, () => Effect.fail("probe boom"))
      expect(result).toBe("skipped")
      expect(isPidAlive(proc.pid)).toBe(true)
    }),
  )
})
