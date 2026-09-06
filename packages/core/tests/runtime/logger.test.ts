import { describe, expect, it } from "effect-bun-test"
import { Console, Context, Effect, Layer } from "effect"
import { MinimumLogLevel } from "effect/References"
import { GentLoggerPretty } from "../../src/runtime/logger"
import { buildLogPaths, LOG_DIR } from "../../src/runtime/log-paths"

describe("buildLogPaths", () => {
  it.effect("returns a deterministic shape under the central log dir", () =>
    Effect.sync(() => {
      const paths = buildLogPaths("/Users/example/repo")
      expect(paths.dir).toBe(LOG_DIR)
      expect(paths.log.startsWith(`${LOG_DIR}/`)).toBe(true)
      expect(paths.trace.endsWith("-server-trace.log")).toBe(true)
      expect(paths.client.endsWith("-client.log")).toBe(true)
    }),
  )

  it.effect("produces distinct prefixes for distinct cwds", () =>
    Effect.sync(() => {
      const a = buildLogPaths("/path/a")
      const b = buildLogPaths("/path/b")
      expect(a.log).not.toBe(b.log)
    }),
  )
})

describe("prettyLogger", () => {
  it.effect("routes Effect.logInfo output through the injected Console.error", () =>
    Effect.gen(function* () {
      const lines: string[] = []
      const captureConsole = {
        ...globalThis.console,
        error: (...args: ReadonlyArray<unknown>) => {
          lines.push(args.map(String).join(" "))
        },
      } satisfies Console.Console

      const minLevel = Layer.effectContext(Effect.succeed(Context.make(MinimumLogLevel, "Info")))

      yield* Effect.logInfo("hello-from-test").pipe(
        Effect.provideService(Console.Console, captureConsole),
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(Layer.mergeAll(GentLoggerPretty, minLevel)),
      )

      expect(lines.length).toBe(1)
      expect(lines[0]).toContain("hello-from-test")
      expect(lines[0]).toContain("INFO")
    }),
  )
})
