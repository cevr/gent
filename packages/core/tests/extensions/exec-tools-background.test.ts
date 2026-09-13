import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { toolCallStep, textStep } from "../../src/test-utils/sequence-steps"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/e2e-layer"
import { ensureStorageParents } from "../../src/test-utils"
import { DEFAULT_AGENT_NAME } from "../../src/domain/agent"
import { ActorCommandId, BranchId, SessionId } from "../../src/domain/ids"
import { MessageStorage } from "../../src/storage/message-storage"
import { SessionStorage } from "../../src/storage/session-storage"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { waitFor } from "../../src/test-utils/fixtures"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset.js"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:start background command"),
          content: "start background command",
          agentOverride: DEFAULT_AGENT_NAME,
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
          encodeJson(message.parts).includes("stale-background-completion"),
        )
        expect(stale).toEqual([])
        yield* fs.remove(markerPath).pipe(Effect.catchEager(() => Effect.void))
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
    }),
  )
})
