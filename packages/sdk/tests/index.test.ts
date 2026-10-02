import { describe, expect, test } from "bun:test"
import { it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { runProcess } from "@gent/core/extensions/api"
import { BunPlatformLive, GentPlatform } from "@gent/core/host"
import * as RuntimePublicSdk from "../src/index"

describe("SDK public surface", () => {
  test("exports only stable runtime values", () => {
    expect(Object.keys(RuntimePublicSdk).sort()).toEqual([
      "Gent",
      "ServerLockEntry",
      "ServerLockStatus",
      "buildLogPaths",
      "classifyLogFile",
      "dataPaths",
      "ensureLogDir",
      "makeJsonFileLogger",
      "serverLock",
    ])
  })

  test("the server lock offers a client status, probe, stop, and the hold storage reset takes", () => {
    // Reading, writing and removing the discovery entry is `Gent.server`'s own work.
    expect(Object.keys(RuntimePublicSdk.serverLock).sort()).toEqual([
      "hold",
      "probe",
      "status",
      "stop",
    ])
  })
})

// ── launch module graph ─────────────────────────────────────────────────────

/**
 * The modules only a server this process builds needs: the shipped
 * extensions, the server root that composes them, and the tracer SDK.
 */
const SERVER_STACK_MODULES = [
  "/packages/extensions/",
  "/packages/sdk/src/server.ts",
  "/@opentelemetry/",
  "/@effect/opentelemetry/",
]

const sdkEntry = new URL("../src/index.ts", import.meta.url).href

/** Run `lines` as a script in a fresh Bun with no preload; its stdout, trimmed. */
const runFresh = (lines: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-sdk-fresh-process-" })
      const script = path.join(directory, "script.ts")
      yield* fs.writeFileString(script, lines.join("\n"))
      const result = yield* runProcess(yield* platform.execPath, ["--config=/dev/null", script], {
        cwd: directory,
      })
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      })
      return result.stdout.trim()
    }),
  )

const freshProcessLayer = Layer.mergeAll(
  BunPlatformLive,
  BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
)

describe("launch module graph", () => {
  // A launch that attaches to a running server, or only reads the data
  // directory, imports the entry and never builds a server.
  it.live("importing the SDK entry loads no server stack", () =>
    Effect.gen(function* () {
      const stdout = yield* runFresh([
        `await import("${sdkEntry}")`,
        `const stack = [${SERVER_STACK_MODULES.map((part) => `"${part}"`).join(", ")}]`,
        `console.log(Object.keys(require.cache).filter((key) => stack.some((part) => key.includes(part))).join("\\n"))`,
      ])
      expect(stdout).toBe("")
    }).pipe(Effect.timeout("25 seconds"), Effect.provide(freshProcessLayer)),
  )
})
