import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
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

const makeTmpHome = () => {
  const dir = join(tmpdir(), `gent-registry-test-${Bun.randomUUIDv7()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const makeEntry = (overrides?: Partial<ServerRegistryEntry>) =>
  new ServerRegistryEntry({
    serverId: "test-server-1",
    pid: process.pid,
    hostname: hostname(),
    rpcUrl: "ws://127.0.0.1:9999",
    dbPath: "/tmp/test.db",
    buildFingerprint: "test-fp",
    startedAt: Date.now(),
    ...overrides,
  })

describe("Build Fingerprint", () => {
  test("computeLocalFingerprint returns a non-empty string", async () => {
    const fp = await Effect.runPromise(
      computeLocalFingerprint.pipe(Effect.provide(BunServices.layer)),
    )
    expect(fp).toBeTruthy()
    expect(typeof fp).toBe("string")
    expect(fp.length).toBeGreaterThan(0)
  })

  test("computeLocalFingerprint is stable across calls", async () => {
    const fp1 = await Effect.runPromise(
      computeLocalFingerprint.pipe(Effect.provide(BunServices.layer)),
    )
    const fp2 = await Effect.runPromise(
      computeLocalFingerprint.pipe(Effect.provide(BunServices.layer)),
    )
    expect(fp1).toBe(fp2)
  })

  test("resolveBuildFingerprint resolves to a string", async () => {
    const fp = await Effect.runPromise(
      resolveBuildFingerprint.pipe(Effect.provide(BunServices.layer)),
    )
    expect(typeof fp).toBe("string")
    expect(fp.length).toBeGreaterThan(0)
  })
})

describe("Server Registry", () => {
  let home: string

  beforeEach(() => {
    home = makeTmpHome()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("writeRegistryEntry + readRegistryEntry roundtrip", () => {
    const entry = makeEntry()
    writeRegistryEntry(home, entry)
    const read = readRegistryEntry(home, entry.dbPath)
    expect(read).toBeDefined()
    expect(read!.serverId).toBe(entry.serverId)
    expect(read!.pid).toBe(entry.pid)
    expect(read!.rpcUrl).toBe(entry.rpcUrl)
    expect(read!.dbPath).toBe(entry.dbPath)
    expect(read!.buildFingerprint).toBe(entry.buildFingerprint)
  })

  test("readRegistryEntry returns undefined for missing entry", () => {
    const read = readRegistryEntry(home, "/nonexistent.db")
    expect(read).toBeUndefined()
  })

  test("readRegistryEntry returns undefined for corrupt file", () => {
    const dir = join(home, ".gent", "servers")
    mkdirSync(dir, { recursive: true })
    // Write a corrupt file with the right hash name
    const entry = makeEntry()
    writeRegistryEntry(home, entry)
    // Corrupt the file
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    if (files.length > 0) {
      writeFileSync(join(dir, files[0]!), "not json")
    }
    const read = readRegistryEntry(home, entry.dbPath)
    expect(read).toBeUndefined()
  })

  test("readRegistryEntry rejects entry from different host", () => {
    const entry = makeEntry({ hostname: "other-host.example.com" })
    writeRegistryEntry(home, entry)
    const read = readRegistryEntry(home, entry.dbPath)
    expect(read).toBeUndefined()
  })

  test("removeRegistryEntry removes matching entry", () => {
    const entry = makeEntry()
    writeRegistryEntry(home, entry)
    const removed = removeRegistryEntry(home, entry.dbPath, entry.serverId)
    expect(removed).toBe(true)
    expect(readRegistryEntry(home, entry.dbPath)).toBeUndefined()
  })

  test("removeRegistryEntry rejects mismatched serverId", () => {
    const entry = makeEntry()
    writeRegistryEntry(home, entry)
    const removed = removeRegistryEntry(home, entry.dbPath, "wrong-id")
    expect(removed).toBe(false)
    expect(readRegistryEntry(home, entry.dbPath)).toBeDefined()
  })

  test("registry key is stable for same dbPath", () => {
    const entry1 = makeEntry({ serverId: "s1" })
    writeRegistryEntry(home, entry1)
    const read1 = readRegistryEntry(home, entry1.dbPath)
    expect(read1?.serverId).toBe("s1")

    // Overwrite with different serverId, same dbPath
    const entry2 = makeEntry({ serverId: "s2" })
    writeRegistryEntry(home, entry2)
    const read2 = readRegistryEntry(home, entry2.dbPath)
    expect(read2?.serverId).toBe("s2")
  })

  test("different dbPaths get different registry files", () => {
    const entry1 = makeEntry({ dbPath: "/tmp/a.db", serverId: "s1" })
    const entry2 = makeEntry({ dbPath: "/tmp/b.db", serverId: "s2" })
    writeRegistryEntry(home, entry1)
    writeRegistryEntry(home, entry2)

    expect(readRegistryEntry(home, "/tmp/a.db")?.serverId).toBe("s1")
    expect(readRegistryEntry(home, "/tmp/b.db")?.serverId).toBe("s2")
  })
})

describe("listRegistryEntries", () => {
  let home: string

  beforeEach(() => {
    home = makeTmpHome()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("returns empty array when no registry dir exists", () => {
    expect(listRegistryEntries(home)).toEqual([])
  })

  test("returns all written entries", () => {
    const entry1 = makeEntry({ dbPath: "/tmp/a.db", serverId: "s1" })
    const entry2 = makeEntry({ dbPath: "/tmp/b.db", serverId: "s2" })
    writeRegistryEntry(home, entry1)
    writeRegistryEntry(home, entry2)

    const entries = listRegistryEntries(home)
    expect(entries.length).toBe(2)
    const ids = entries.map((e) => e.serverId).sort()
    expect(ids).toEqual(["s1", "s2"])
  })

  test("skips corrupt files", () => {
    const entry = makeEntry({ dbPath: "/tmp/good.db", serverId: "good" })
    writeRegistryEntry(home, entry)

    // Write a corrupt file
    const dir = join(home, ".gent", "servers")
    writeFileSync(join(dir, "corrupt.json"), "not json at all")

    const entries = listRegistryEntries(home)
    expect(entries.length).toBe(1)
    expect(entries[0]!.serverId).toBe("good")
  })

  test("includes entries from other hosts", () => {
    // listRegistryEntries returns all entries — filtering is caller's job
    const local = makeEntry({ dbPath: "/tmp/local.db", serverId: "local" })
    const remote = makeEntry({
      dbPath: "/tmp/remote.db",
      serverId: "remote",
      hostname: "other-host",
    })
    writeRegistryEntry(home, local)
    writeRegistryEntry(home, remote)

    const entries = listRegistryEntries(home)
    expect(entries.length).toBe(2)
  })
})

describe("Validate Registry Entry", () => {
  test("validates entry with alive PID and correct host", () => {
    const entry = makeEntry()
    const result = validateRegistryEntry(entry)
    expect(result.valid).toBe(true)
  })

  test("rejects entry from different host", () => {
    const entry = makeEntry({ hostname: "alien-host" })
    const result = validateRegistryEntry(entry)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("different-host")
  })

  test("rejects entry with dead PID", () => {
    // PID 99999999 should not exist
    const entry = makeEntry({ pid: 99999999 })
    const result = validateRegistryEntry(entry)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("dead-pid")
  })
})

describe("Registry Process Ownership", () => {
  let home: string

  beforeEach(() => {
    home = makeTmpHome()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("registryIdentityOf returns the owned identity tuple", () => {
    const entry = makeEntry()
    expect(registryIdentityOf(entry)).toEqual({
      serverId: entry.serverId,
      pid: entry.pid,
      hostname: entry.hostname,
      dbPath: entry.dbPath,
      buildFingerprint: entry.buildFingerprint,
    })
  })

  test("canSignalRegistryEntry requires same host and live PID", () => {
    expect(canSignalRegistryEntry(makeEntry())).toBe(true)
    expect(canSignalRegistryEntry(makeEntry({ hostname: "other-host" }))).toBe(false)
    expect(canSignalRegistryEntry(makeEntry({ pid: 99999999 }))).toBe(false)
  })

  test("PID-reused stale registry entries are removed without SIGTERM", async () => {
    const dbPath = join(home, "pid-reuse.db")
    const entry = makeEntry({
      pid: process.pid,
      dbPath,
      buildFingerprint: "stale-fingerprint",
    })
    const fakeOwner = Bun.serve({
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
    })
    const fakeOwnerUrl = new URL(fakeOwner.url)
    const entryWithEndpoint = new ServerRegistryEntry({
      ...entry,
      rpcUrl: `${fakeOwnerUrl.origin}/rpc`,
    })
    writeRegistryEntry(home, entryWithEndpoint)

    const signals: Array<{ pid: number; signal: string | number | undefined }> = []
    const originalKill = Reflect.get(process, "kill") as typeof process.kill
    const replacement = ((pid: number, signal?: string | number) => {
      if (signal === "SIGTERM") {
        signals.push({ pid, signal })
        return true
      }
      return originalKill(pid, signal)
    }) as typeof process.kill

    process.kill = replacement
    try {
      await Effect.runPromise(
        Effect.scoped(
          Gent.server({
            cwd: process.cwd(),
            state: Gent.state.sqlite({ home, dbPath }),
            provider: Gent.provider.mock(),
          }),
        ),
      )
    } finally {
      process.kill = originalKill
      fakeOwner.stop(true)
    }

    expect(signals).toEqual([])
    expect(readRegistryEntry(home, dbPath)?.serverId).not.toBe(entryWithEndpoint.serverId)
  })
})

describe("isPidAlive", () => {
  test("returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  test("returns false for non-existent PID", () => {
    expect(isPidAlive(99999999)).toBe(false)
  })
})

describe("Cross-Process Lock", () => {
  let home: string

  beforeEach(() => {
    home = makeTmpHome()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("acquireLock succeeds on first call", () => {
    expect(acquireLock(home, "/tmp/test.db")).toBe(true)
  })

  test("acquireLock fails on second call (already held)", () => {
    acquireLock(home, "/tmp/test.db")
    expect(acquireLock(home, "/tmp/test.db")).toBe(false)
  })

  test("releaseLock allows re-acquire", () => {
    acquireLock(home, "/tmp/test.db")
    releaseLock(home, "/tmp/test.db")
    expect(acquireLock(home, "/tmp/test.db")).toBe(true)
  })

  test("different dbPaths have independent locks", () => {
    expect(acquireLock(home, "/tmp/a.db")).toBe(true)
    expect(acquireLock(home, "/tmp/b.db")).toBe(true)
  })

  test("withLock acquires and releases", async () => {
    let inside = false
    await Effect.runPromise(
      withLock(
        home,
        "/tmp/test.db",
        Effect.sync(() => {
          inside = true
          // Lock should be held during body
          expect(acquireLock(home, "/tmp/test.db")).toBe(false)
        }),
      ),
    )
    expect(inside).toBe(true)
    // Lock should be released after body
    expect(acquireLock(home, "/tmp/test.db")).toBe(true)
  })

  test("withLock releases on error", async () => {
    const result = await Effect.runPromiseExit(withLock(home, "/tmp/test.db", Effect.fail("boom")))
    expect(result._tag).toBe("Failure")
    // Lock should still be released
    expect(acquireLock(home, "/tmp/test.db")).toBe(true)
  })

  test("withLock fails with LockAcquireError when lock is held", async () => {
    acquireLock(home, "/tmp/test.db")
    const result = await Effect.runPromiseExit(withLock(home, "/tmp/test.db", Effect.succeed("ok")))
    expect(result._tag).toBe("Failure")
  })

  test("stale lock from dead PID is cleaned up", () => {
    // Manually create a lock with a dead PID
    const dir = join(home, ".gent", "servers")
    mkdirSync(dir, { recursive: true })
    // Use the same hash logic — acquire first, then tamper
    acquireLock(home, "/tmp/stale.db")
    // Find the lock dir and rewrite the info with a dead PID
    const lockDirs = readdirSync(dir).filter((f) => f.endsWith(".lock"))
    // Release first, then manually create stale lock
    releaseLock(home, "/tmp/stale.db")

    // Now manually create a stale lock
    const hash = lockDirs[0] ?? "fallback.lock"
    const lockDir = join(dir, hash)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(
      join(lockDir, "info.json"),
      JSON.stringify({
        pid: 99999999,
        hostname: hostname(),
        createdAt: Date.now(),
      }),
    )

    // Should succeed because the existing lock has a dead PID
    expect(acquireLock(home, "/tmp/stale.db")).toBe(true)
  })
})

describe("signalIfIdentityOwned", () => {
  test("skips when PID is not alive (PID-reuse guard)", async () => {
    const entry = makeEntry({ pid: 99999999 })
    let probeCalled = false
    const result = await Effect.runPromise(
      signalIfIdentityOwned(entry, () => {
        probeCalled = true
        return Effect.succeed(true)
      }),
    )
    expect(result).toBe("skipped")
    expect(probeCalled).toBe(false)
  })

  test("skips when probe says identity does not match", async () => {
    // Spawn a subprocess that outlives the test window so PID stays alive
    const proc = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" })
    try {
      const entry = makeEntry({ pid: proc.pid })
      const result = await Effect.runPromise(
        signalIfIdentityOwned(entry, () => Effect.succeed(false)),
      )
      expect(result).toBe("skipped")
      // Subprocess should still be alive — we didn't signal it
      expect(isPidAlive(proc.pid)).toBe(true)
    } finally {
      proc.kill()
    }
  })

  test("skips on cross-host entry", async () => {
    const entry = makeEntry({ hostname: "definitely-not-this-host" })
    let probeCalled = false
    const result = await Effect.runPromise(
      signalIfIdentityOwned(entry, () => {
        probeCalled = true
        return Effect.succeed(true)
      }),
    )
    expect(result).toBe("skipped")
    expect(probeCalled).toBe(false)
  })

  test("signals when probe confirms identity", async () => {
    const proc = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" })
    try {
      const entry = makeEntry({ pid: proc.pid })
      const result = await Effect.runPromise(
        signalIfIdentityOwned(entry, () => Effect.succeed(true)),
      )
      expect(result).toBe("signaled")
      // Wait briefly for SIGTERM to propagate
      await new Promise((r) => setTimeout(r, 200))
      expect(isPidAlive(proc.pid)).toBe(false)
    } finally {
      if (isPidAlive(proc.pid)) proc.kill()
    }
  })

  test("skips when probe fails (treated as no identity proof)", async () => {
    const proc = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" })
    try {
      const entry = makeEntry({ pid: proc.pid })
      const result = await Effect.runPromise(
        signalIfIdentityOwned(entry, () => Effect.fail("probe boom")),
      )
      expect(result).toBe("skipped")
      expect(isPidAlive(proc.pid)).toBe(true)
    } finally {
      proc.kill()
    }
  })
})
