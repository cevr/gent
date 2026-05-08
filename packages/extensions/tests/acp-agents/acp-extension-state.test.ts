import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { testSetupCtx } from "@gent/core/test-utils"
import { makeAcpAgentsExtension } from "@gent/extensions/acp-agents"
import type { AcpSessionManager } from "@gent/extensions/acp-agents/executor"
import type { ClaudeCodeSessionManager } from "@gent/extensions/acp-agents/claude-code-executor"

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

      const first = yield* ext.setup(testSetupCtx())
      const second = yield* ext.setup(testSetupCtx())
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
      const firstStop = first.resources?.[0]?.stop as Effect.Effect<void> | undefined
      const secondStop = second.resources?.[0]?.stop as Effect.Effect<void> | undefined
      if (firstStop === undefined || secondStop === undefined) {
        throw new Error("expected ACP resource stop finalizers")
      }
      yield* firstStop
      yield* secondStop

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
