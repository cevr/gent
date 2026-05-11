import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Option, Path, Ref } from "effect"
import * as ChildProcessSpawnerNs from "effect/unstable/process/ChildProcessSpawner"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import { BuildFingerprint } from "@gent/core-internal/server/build-fingerprint"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"

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
      env: Effect.succeed({}),
      pathListSeparator: Effect.succeed(":"),
      commandCandidates: (command) => [command],
      isPortFree: () => Effect.succeed(true),
      signal: () => Effect.void,
      exit: () => Effect.die(new Error("exit not expected in this test")),
      now: Effect.succeed(0),
      hash: (_alg, input) => {
        const text = typeof input === "string" ? input : new TextDecoder().decode(input)
        let h = 5381
        for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i)
        return (h >>> 0).toString(16).padStart(64, "0")
      },
      randomBytes: (length) => Effect.succeed(new Uint8Array(length)),
      fileURLToPath: (url) => (url.startsWith("file://") ? url.slice("file://".length) : url),
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
          type: "File" as const,
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
          size: BigInt(0) as unknown as FileSystem.Size,
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
          const fp1 = yield* bf.local
          const fp2 = yield* bf.local
          const fp3 = yield* bf.local
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

  it.live("Test layer returns deterministic fingerprint", () =>
    Effect.gen(function* () {
      const bf = yield* BuildFingerprint
      const local = yield* bf.local
      const resolved = yield* bf.resolved
      expect(local).toBe("test-fingerprint")
      expect(resolved).toBe("test-fingerprint")
    }).pipe(Effect.provide(BuildFingerprint.Test())),
  )

  it.live("Test layer with override returns custom fingerprint", () =>
    Effect.gen(function* () {
      const bf = yield* BuildFingerprint
      const fp = yield* bf.local
      expect(fp).toBe("custom-fp")
    }).pipe(Effect.provide(BuildFingerprint.Test("custom-fp"))),
  )
})
