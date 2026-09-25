import { describe, expect, it } from "effect-bun-test"
import { Duration, Effect, FileSystem, Layer, Path, Predicate } from "effect"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import {
  GentPlatform,
  ProcessError,
  resolveDataDir,
  runProcess,
  SignalError,
  writeFileAtomic,
} from "../../src/runtime/gent-platform"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { homedir, tmpdir } from "node:os"
import { makeTempDirectoryScoped } from "../../src/test-utils/language-model"

/**
 * Locks the GentPlatform service contract end-to-end.
 *
 * `BunGentPlatformLive` is the only file in the repo allowed to call `Bun.*`,
 * so this is the only place we can assert the live wiring works. The Test
 * layer's deterministic `randomId` and stub semantics are also covered so
 * downstream tests can rely on it without re-checking each method.
 */

describe("GentPlatform", () => {
  describe("BunGentPlatformLive", () => {
    it.live("randomId mints unique UUIDv7 strings", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const a = yield* platform.randomId
        const b = yield* platform.randomId
        expect(a).not.toBe(b)
        // UUIDv7 canonical form: 8-4-4-4-12 hex with v7 in the version nibble.
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("osInfo reports the live host shape", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const info = yield* platform.osInfo
        // Spot-check shape — values are runtime-dependent. Each field must be
        // a non-empty string. `platform` is one of the documented Node values.
        expect(Predicate.isString(info.platform)).toBe(true)
        expect(info.platform.length).toBeGreaterThan(0)
        expect(Predicate.isString(info.arch)).toBe(true)
        expect(info.arch.length).toBeGreaterThan(0)
        expect(Predicate.isString(info.release)).toBe(true)
        expect(Predicate.isString(info.hostname)).toBe(true)
        expect(Predicate.isString(info.type)).toBe(true)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("pid and execPath match the live host process", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const pid = yield* platform.pid
        const execPath = yield* platform.execPath
        expect(pid).toBe(process.pid)
        expect(Predicate.isNumber(pid)).toBe(true)
        expect(pid).toBeGreaterThan(0)
        expect(execPath).toBe(process.execPath)
        expect(execPath.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("signal(pid, 0) succeeds for self-pid (liveness probe)", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const pid = yield* platform.pid
        // Probe own process — must succeed without delivering a signal.
        yield* platform.signal(pid, 0)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("signal returns a typed SignalError for an unreachable pid", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        // POSIX pid_max is bounded well below 2^31-1 on every documented
        // host (darwin: ~99999, linux default: 4194304). `process.kill`
        // therefore raises ESRCH for this pid on every CI runner we
        // support. We assert the typed `SignalError` is on the failure
        // channel — not on the defect channel — and that `code` is
        // populated (supervisor classification reads `code`, not `reason`).
        const failure = yield* Effect.flip(platform.signal(2 ** 31 - 1, 0))
        expect(failure).toBeInstanceOf(SignalError)
        expect(failure.pid).toBe(2 ** 31 - 1)
        expect(failure.signal).toBe(0)
        expect(failure.code).toBe("ESRCH")
        expect(Predicate.isString(failure.reason)).toBe(true)
        expect(failure.reason.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )
  })

  describe("GentPlatform.Test", () => {
    it.live("randomId mints monotonically with the configured prefix", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const a = yield* platform.randomId
        const b = yield* platform.randomId
        const c = yield* platform.randomId
        expect(a).toBe("t-00000001")
        expect(b).toBe("t-00000002")
        expect(c).toBe("t-00000003")
      }).pipe(Effect.provide(GentPlatform.Test("t"))),
    )

    it.live("osInfo / pid / execPath return Test stub values", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const info = yield* platform.osInfo
        expect(info.platform).toBe("linux")
        expect(info.arch).toBe("x64")
        expect(info.release).toBe("test-release")
        expect(info.hostname).toBe("test-host")
        expect(info.type).toBe("Linux")
        expect(yield* platform.pid).toBe(1)
        expect(yield* platform.execPath).toBe("/usr/bin/node")
      }).pipe(Effect.provide(GentPlatform.Test())),
    )

    it.live("signal is a Test no-op (succeeds with void)", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        yield* platform.signal(123, "SIGTERM")
        yield* platform.signal(123, 0)
      }).pipe(Effect.provide(GentPlatform.Test())),
    )
  })
})

// ── run process ─────────────────────────────────────────────────────────────

const makePlatformLayer = (): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)))
const provideBun = <A, E>(
  e: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
): Effect.Effect<A, E> => Effect.provide(e, makePlatformLayer())

const processTestTimeout = 15_000
const withProcessTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("10 seconds"))

describe("runProcess", () => {
  it.live(
    "surfaces nonzero exit code without failing the effect",
    () =>
      Effect.gen(function* () {
        // sh -c "exit 7" gives a deterministic nonzero without relying on
        // a specific binary's error semantics.
        const result = yield* provideBun(
          runProcess("/bin/sh", ["-c", "exit 7"], { stdout: "ignore", stderr: "ignore" }),
        )
        expect(result.exitCode).toBe(7)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
  it.live(
    "captures stderr separately from stdout",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runProcess("/bin/sh", ["-c", "printf out; printf err 1>&2"]),
        )
        expect(result.stdout).toBe("out")
        expect(result.stderr).toBe("err")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
  it.live(
    "a character split across output chunks decodes whole",
    () =>
      Effect.gen(function* () {
        // "é" is 0xC3 0xA9; the pause makes the two bytes arrive as two chunks.
        const script =
          "printf '\\303'; sleep 0.2; printf '\\251'; printf '\\303' 1>&2; sleep 0.2; printf '\\251' 1>&2"
        const result = yield* provideBun(runProcess("/bin/sh", ["-c", script]))
        expect(result.stdout).toBe("\u00E9")
        expect(result.stderr).toBe("\u00E9")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
  it.live(
    "respects cwd option",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
        const result = yield* provideBun(runProcess("pwd", [], { cwd }))
        // the temp root may resolve through a symlink (/private/tmp on macOS)
        expect(result.stdout.trim()).toBe(yield* fs.realPath(cwd))
        expect(result.exitCode).toBe(0)
      }).pipe(withProcessTimeout, Effect.scoped, Effect.provide(BunFileSystem.layer)),
    processTestTimeout,
  )
  it.live(
    "respects env option",
    () =>
      Effect.gen(function* () {
        // PATH is included so `sh` resolves on systems where it isn't at a
        // hard-coded path; the marker var is what we actually assert on.
        const result = yield* provideBun(
          runProcess("/bin/sh", ["-c", 'printf %s "$RUN_PROCESS_TEST_VAR"'], {
            env: { PATH: "/usr/bin:/bin:/usr/local/bin", RUN_PROCESS_TEST_VAR: "marker-value" },
          }),
        )
        expect(result.stdout).toBe("marker-value")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
  it.live(
    "timeout fails with timedOut=true when command runs too long",
    () =>
      Effect.gen(function* () {
        const failed = yield* provideBun(
          runProcess("/bin/sh", ["-c", "sleep 5"], { timeout: Duration.millis(100) }).pipe(
            Effect.flip,
          ),
        )
        expect(failed).toBeInstanceOf(ProcessError)
        expect(failed.timedOut).toBe(true)
        expect(failed.message).toContain("timed out")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
  it.live(
    "spawn failure for missing binary surfaces ProcessError",
    () =>
      Effect.gen(function* () {
        const failed = yield* provideBun(
          runProcess("definitely-not-a-real-binary-xyz", []).pipe(Effect.flip),
        )
        expect(failed).toBeInstanceOf(ProcessError)
        expect(failed.command).toBe("definitely-not-a-real-binary-xyz")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
  it.live(
    "ignores stdout when stdout option is 'ignore'",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runProcess("printf", ["should-not-appear"], { stdout: "ignore" }),
        )
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
})

// ── atomic file writes ──────────────────────────────────────────────────────

describe("writeFileAtomic", () => {
  const atomicTest = it.scopedLive.layer(BunServices.layer)

  atomicTest("follows a symlink: the target gets the content and the link stays", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const dotfiles = yield* fs.makeTempDirectoryScoped()
      const target = `${dotfiles}/target.json`
      const link = `${dir}/state.json`
      yield* fs.writeFileString(target, "target content")
      yield* fs.symlink(target, link)
      yield* writeFileAtomic(link, "replaced")
      expect(yield* fs.readLink(link)).toBe(target)
      expect(yield* fs.readFileString(target)).toBe("replaced")
      // The staged file lands beside the target; nothing is left behind.
      expect(yield* fs.readDirectory(dir)).toEqual(["state.json"])
      expect(yield* fs.readDirectory(dotfiles)).toEqual(["target.json"])
    }),
  )

  atomicTest("empty content empties the file, and bytes land as given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const file = `${dir}/state.json`
      yield* fs.writeFileString(file, "old")
      yield* writeFileAtomic(file, "")
      expect(yield* fs.readFileString(file)).toBe("")
      const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68])
      yield* writeFileAtomic(file, bytes)
      expect(Buffer.from(yield* fs.readFile(file)).equals(bytes)).toBe(true)
      expect(yield* fs.readDirectory(dir)).toEqual(["state.json"])
    }),
  )

  atomicTest("a relative dangling symlink creates the file it names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const link = `${dir}/state.json`
      yield* fs.symlink("real.json", link)
      yield* writeFileAtomic(link, "created")
      expect(yield* fs.readLink(link)).toBe("real.json")
      expect(yield* fs.readFileString(`${dir}/real.json`)).toBe("created")
    }),
  )

  // A crash skips every finalizer, so a staged directory would stay in the user's tree.
  const renamed: Array<string> = []
  /** The platform file system, recording each rename's source. */
  const recordingFs = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) =>
      FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) => {
          renamed.push(from)
          return fs.rename(from, to)
        },
      }),
    ),
  )

  atomicTest("stages a sibling file, never a directory, and removes it when the write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      renamed.length = 0
      yield* writeFileAtomic(`${dir}/state.json`, "saved")
      // A directory cannot be replaced by a file, so this rename fails.
      yield* fs.makeDirectory(`${dir}/busy/inner`, { recursive: true })
      const failed = yield* writeFileAtomic(`${dir}/busy`, "x").pipe(Effect.flip)
      expect(failed._tag).toBe("PlatformError")
      // A crash skips every finalizer, so a staged directory would stay in the user's tree.
      expect(renamed.map((from) => path.dirname(from))).toEqual([dir, dir])
      expect((yield* fs.readDirectory(dir)).toSorted()).toEqual(["busy", "state.json"])
      expect(yield* fs.readFileString(`${dir}/state.json`)).toBe("saved")
    }).pipe(Effect.provide(recordingFs)),
  )

  /** The platform file system, recording each staged sync and each rename in order. */
  const syncOrder: Array<string> = []
  const syncRecordingFs = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) =>
      FileSystem.FileSystem.of({
        ...fs,
        open: (file, options) =>
          fs.open(file, options).pipe(
            // The handle is a class instance: forward to it, bound, and
            // record its sync.
            Effect.map(
              (handle) =>
                new Proxy(handle, {
                  get: (target, key) => {
                    if (key === "sync")
                      return Effect.sync(() => syncOrder.push("sync")).pipe(
                        Effect.andThen(target.sync),
                      )
                    const value: unknown = Reflect.get(target, key, target)
                    if (Predicate.isFunction(value)) return value.bind(target)
                    return value
                  },
                }),
            ),
          ),
        rename: (from, to) =>
          Effect.sync(() => syncOrder.push("rename")).pipe(Effect.andThen(fs.rename(from, to))),
      }),
    ),
  )

  atomicTest("syncs the staged text to disk before the rename publishes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      syncOrder.length = 0
      yield* writeFileAtomic(`${dir}/state.json`, "durable")
      expect(syncOrder).toEqual(["sync", "rename"])
      expect(yield* fs.readFileString(`${dir}/state.json`)).toBe("durable")
    }).pipe(Effect.provide(syncRecordingFs)),
  )

  /**
   * The platform file system, where another writer creates the same staging
   * file just before this write's exclusive create, as a suffix collision does.
   */
  const collidingFs = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) =>
      FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (file, data, options) => {
          if (options?.flag !== "wx") return fs.writeFileString(file, data, options)
          return fs
            .writeFileString(file, "the other writer's text")
            .pipe(Effect.andThen(fs.writeFileString(file, data, options)))
        },
      }),
    ),
  )

  atomicTest("a staging name another writer holds is left to that writer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/state.json`, "before")
      const failed = yield* writeFileAtomic(`${dir}/state.json`, "mine").pipe(Effect.flip)
      expect(failed._tag).toBe("PlatformError")
      // The exclusive create failed, so the staged file is the other writer's.
      const staged = (yield* fs.readDirectory(dir)).filter((name) => name !== "state.json")
      expect(staged).toHaveLength(1)
      expect(yield* fs.readFileString(`${dir}/${staged[0]}`)).toBe("the other writer's text")
      expect(yield* fs.readFileString(`${dir}/state.json`)).toBe("before")
    }).pipe(Effect.provide(collidingFs)),
  )

  // A file name takes at most 255 bytes; the staging name adds its own tag and suffix.
  atomicTest("a file whose name is near the length limit is still replaced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      for (const name of ["a".repeat(250), `${"ü".repeat(120)}.json`]) {
        yield* fs.writeFileString(`${dir}/${name}`, "before")
        yield* writeFileAtomic(`${dir}/${name}`, "after")
        expect(yield* fs.readFileString(`${dir}/${name}`)).toBe("after")
      }
      expect(yield* fs.readDirectory(dir)).toHaveLength(2)
    }),
  )

  const modeOf = (fs: FileSystem.FileSystem, file: string) =>
    fs.stat(file).pipe(Effect.map((info) => info.mode & 0o777))

  atomicTest("keeps the mode of an executable file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const script = `${dir}/run.sh`
      yield* fs.writeFileString(script, "#!/bin/sh\necho old\n")
      yield* fs.chmod(script, 0o755)
      yield* writeFileAtomic(script, "#!/bin/sh\necho new\n")
      expect(yield* modeOf(fs, script)).toBe(0o755)
      expect(yield* fs.readFileString(script)).toBe("#!/bin/sh\necho new\n")
    }),
  )

  atomicTest("keeps a private file private", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const secret = `${dir}/secret.json`
      yield* fs.writeFileString(secret, "{}")
      yield* fs.chmod(secret, 0o600)
      yield* writeFileAtomic(secret, '{"key":"x"}')
      expect(yield* modeOf(fs, secret)).toBe(0o600)
    }),
  )

  atomicTest("a new file takes the mode the caller passes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const secret = `${dir}/new.json`
      yield* writeFileAtomic(secret, "{}", { mode: 0o600 })
      expect(yield* modeOf(fs, secret)).toBe(0o600)
    }),
  )

  atomicTest("a new file without a mode gets the default file mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const plain = `${dir}/plain.json`
      const reference = `${dir}/reference.json`
      yield* fs.writeFileString(reference, "")
      yield* writeFileAtomic(plain, "{}")
      expect(yield* modeOf(fs, plain)).toBe(yield* modeOf(fs, reference))
    }),
  )
})

// ── data directory ──────────────────────────────────────────────────────────

describe("resolveDataDir", () => {
  // The shared test preload gives each test process a temp home and clears
  // GENT_DATA_DIR, so a test that forgets to scope a data directory writes
  // under a temp directory, never the real home.
  it.effect("a test that sets no data directory resolves a temp one, not the real home", () =>
    Effect.gen(function* () {
      expect(homedir().startsWith(tmpdir())).toBe(true)
      expect(yield* resolveDataDir(homedir())).toBe(`${homedir()}/.gent`)
    }),
  )
})
