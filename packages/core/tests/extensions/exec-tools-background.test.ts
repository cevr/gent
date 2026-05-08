import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { toolCallStep, textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { e2ePreset } from "./helpers/test-preset.js"

describe("exec-tools background runtime", () => {
  it.live("drops background bash completion after session deletion", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("exec-bg-deleted-session")
      const branchId = BranchId.make("exec-bg-deleted-branch")
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("bash", {
          command: "sleep 0.3; printf stale-background-completion",
          run_in_background: true,
        }),
        textStep("background command started"),
      ])
      const layer = createE2ELayer({ ...e2ePreset, providerLayer })

      yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const sessions = yield* SessionStorage
        const messages = yield* MessageStorage

        yield* ensureStorageParents({ sessionId, branchId })
        yield* runtime.runPrompt({
          sessionId,
          branchId,
          agentName: AgentName.make("cowork"),
          prompt: "start background command",
        })
        yield* sessions.deleteSession(sessionId)
        yield* Effect.sleep("600 millis")

        const remaining = yield* messages.listMessages(branchId)
        const stale = remaining.filter((message) =>
          JSON.stringify(message.parts).includes("stale-background-completion"),
        )
        expect(stale).toEqual([])
      }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
    }),
  )
})
