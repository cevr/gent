import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Path } from "effect"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { provideTestSetupContext } from "@gent/core-internal/test-utils"
import { buildResourceLayer } from "@gent/core-internal/runtime/extensions/resource-host"
import type { LoadedExtension } from "@gent/core-internal/domain/extension"
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
        makeAcpSessionManager: Effect.sync(() => {
          const id = ++acpSeq
          return {
            getOrCreate: () => Effect.die("not exercised"),
            invalidate: () => Effect.void,
            invalidateDriver: (driverId) =>
              Effect.sync(() => {
                calls.push(`acp-${id}:invalidate:${driverId}`)
              }),
            disposeAll: Effect.sync(() => {
              calls.push(`acp-${id}:dispose`)
            }),
          } satisfies AcpSessionManager
        }),
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

      const first = yield* ext.setup
        .pipe(provideTestSetupContext())
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(spawnerLayer))
      const second = yield* ext.setup
        .pipe(provideTestSetupContext())
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(spawnerLayer))
      const firstProtocolDriver = Option.fromUndefinedOr(
        first.externalDrivers?.find((driver) => driver.id !== "acp-claude-code"),
      )
      const secondProtocolDriver = Option.fromUndefinedOr(
        second.externalDrivers?.find((driver) => driver.id !== "acp-claude-code"),
      )
      const firstClaudeDriver = Option.fromUndefinedOr(
        first.externalDrivers?.find((driver) => driver.id === "acp-claude-code"),
      )
      const secondClaudeDriver = Option.fromUndefinedOr(
        second.externalDrivers?.find((driver) => driver.id === "acp-claude-code"),
      )

      if (
        Option.isNone(firstProtocolDriver) ||
        Option.isNone(secondProtocolDriver) ||
        Option.isNone(firstClaudeDriver) ||
        Option.isNone(secondClaudeDriver)
      ) {
        return yield* Effect.die(new Error("expected ACP external drivers"))
      }

      const firstProtocolDriverValue = firstProtocolDriver.value
      const secondProtocolDriverValue = secondProtocolDriver.value
      const firstClaudeDriverValue = firstClaudeDriver.value
      const secondClaudeDriverValue = secondClaudeDriver.value

      yield* firstProtocolDriverValue.invalidate
      yield* secondProtocolDriverValue.invalidate
      yield* firstClaudeDriverValue.invalidate
      yield* secondClaudeDriverValue.invalidate
      // Disposal is owned by the Resource host: build each extension's
      // resource layer in its own scope via `buildResourceLayer`, then let
      // the scope close to fire the `Layer.effect(... acquireRelease ...)`
      // finalizer. This is the same path activation uses in production
      // (`activation.ts:381`).
      const firstLoaded = {
        manifest: { id: ext.manifest.id },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: first,
      } satisfies LoadedExtension
      const secondLoaded = {
        manifest: { id: ext.manifest.id },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: second,
      } satisfies LoadedExtension
      yield* Effect.scoped(
        Layer.build(buildResourceLayer([firstLoaded], "process")).pipe(Effect.asVoid),
      )
      yield* Effect.scoped(
        Layer.build(buildResourceLayer([secondLoaded], "process")).pipe(Effect.asVoid),
      )

      expect(calls).toEqual([
        `acp-1:invalidate:${firstProtocolDriverValue.id}`,
        `acp-2:invalidate:${secondProtocolDriverValue.id}`,
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
