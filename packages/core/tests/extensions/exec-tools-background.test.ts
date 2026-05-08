import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { toolCallStep, textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset.js"

describe("exec-tools background runtime", () => {
  it.live("drops background bash completion after session deletion", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("exec-bg-deleted-session")
      const branchId = BranchId.make("exec-bg-deleted-branch")
      const markerPath = `/tmp/gent-${sessionId}-background-done`
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("bash", {
          command: `sleep 0.3; touch ${markerPath}; printf stale-background-completion`,
          run_in_background: true,
        }),
        textStep("background command started"),
      ])
      const layer = createE2ELayer({ ...e2ePreset, providerLayer }).pipe(
        Layer.provideMerge(BunFileSystem.layer),
      )

      yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const sessions = yield* SessionStorage
        const messages = yield* MessageStorage
        const fs = yield* FileSystem.FileSystem

        yield* fs.remove(markerPath).pipe(Effect.catchEager(() => Effect.void))
        yield* ensureStorageParents({ sessionId, branchId })
        yield* runtime.runPrompt({
          sessionId,
          branchId,
          agentName: AgentName.make("cowork"),
          prompt: "start background command",
        })
        yield* sessions.deleteSession(sessionId)

        yield* waitFor(
          fs.exists(markerPath),
          (exists) => exists,
          2_000,
          "background command marker",
        )
        const remaining = yield* messages.listMessages(branchId)
        const stale = remaining.filter((message) =>
          JSON.stringify(message.parts).includes("stale-background-completion"),
        )
        expect(stale).toEqual([])
        yield* fs.remove(markerPath).pipe(Effect.catchEager(() => Effect.void))
      }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
    }),
  )
})
