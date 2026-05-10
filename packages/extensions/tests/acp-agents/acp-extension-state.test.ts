import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Layer, Path, Scope } from "effect"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { testSetupCtx } from "@gent/core-internal/test-utils"
import { makeAcpAgentsExtension } from "../../src/acp-agents/index.js"
import type { AcpSessionManager } from "../../src/acp-agents/executor.js"
import type { ClaudeCodeSessionManager } from "../../src/acp-agents/claude-code-executor.js"

const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

describe("AcpAgentsExtension state ownership", () => {
  it.live("creates independent manager state per setup invocation", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      let acpSeq = 0
      let claudeSeq = 0
      const ext = makeAcpAgentsExtension({
        makeAcpSessionManager: () => {
          const id = ++acpSeq
          return {
            getOrCreate: () => Effect.die("not exercised"),
            invalidate: () => Effect.void,
            invalidateDriver: (driverId) =>
              Effect.sync(() => {
                calls.push(`acp-${id}:invalidate:${driverId}`)
              }),
            disposeAll: () =>
              Effect.sync(() => {
                calls.push(`acp-${id}:dispose`)
              }),
          } satisfies AcpSessionManager
        },
        makeClaudeCodeSessionManager: () => {
          const id = ++claudeSeq
          return {
            getOrCreate: () => Effect.die("not exercised"),
            invalidate: () => Effect.void,
            invalidateDriver: (driverId) =>
              Effect.sync(() => {
                calls.push(`claude-${id}:invalidate:${driverId}`)
              }),
            disposeAll: Effect.sync(() => {
              calls.push(`claude-${id}:dispose`)
            }),
          } satisfies ClaudeCodeSessionManager
        },
      })

      const first = yield* ext.setup(testSetupCtx()).pipe(Effect.provide(spawnerLayer))
      const second = yield* ext.setup(testSetupCtx()).pipe(Effect.provide(spawnerLayer))
      const firstProtocolDriver = first.externalDrivers?.find(
        (driver) => driver.id !== "acp-claude-code",
      )
      const secondProtocolDriver = second.externalDrivers?.find(
        (driver) => driver.id !== "acp-claude-code",
      )
      const firstClaudeDriver = first.externalDrivers?.find(
        (driver) => driver.id === "acp-claude-code",
      )
      const secondClaudeDriver = second.externalDrivers?.find(
        (driver) => driver.id === "acp-claude-code",
      )

      if (
        firstProtocolDriver === undefined ||
        secondProtocolDriver === undefined ||
        firstClaudeDriver === undefined ||
        secondClaudeDriver === undefined
      ) {
        throw new Error("expected ACP external drivers")
      }

      yield* firstProtocolDriver.invalidate()
      yield* secondProtocolDriver.invalidate()
      yield* firstClaudeDriver.invalidate()
      yield* secondClaudeDriver.invalidate()
      // Disposal moved from `Resource.stop` to `Layer.effect(... acquireRelease ...)`
      // finalizer. Build each layer in its own scope and close in order. The
      // bucket layer type is `Layer<any, any, any>` — narrow at the test
      // boundary so the Effect language-service guard doesn't flag the build
      // call sites for `any` in error/requirements channels.
      const firstLayer = first.resources?.[0]?.layer as
        | Layer.Layer<unknown, never, Scope.Scope>
        | undefined
      const secondLayer = second.resources?.[0]?.layer as
        | Layer.Layer<unknown, never, Scope.Scope>
        | undefined
      if (firstLayer === undefined || secondLayer === undefined) {
        throw new Error("expected ACP resource layers")
      }
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Layer.build(firstLayer).pipe(Scope.provide(firstScope))
      yield* Layer.build(secondLayer).pipe(Scope.provide(secondScope))
      yield* Scope.close(firstScope, Exit.void)
      yield* Scope.close(secondScope, Exit.void)

      expect(calls).toEqual([
        `acp-1:invalidate:${firstProtocolDriver.id}`,
        `acp-2:invalidate:${secondProtocolDriver.id}`,
        "claude-1:invalidate:acp-claude-code",
        "claude-2:invalidate:acp-claude-code",
        "acp-1:dispose",
        "claude-1:dispose",
        "acp-2:dispose",
        "claude-2:dispose",
      ])
    }),
  )
})
