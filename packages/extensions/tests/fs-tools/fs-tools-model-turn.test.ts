/**
 * FS tools model-turn acceptance test — exercises a real model tool call
 * through the extension layer, not the direct tool executor.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, FileSystem, Path, Stream } from "effect"
import { toolCallStep } from "@gent/core/debug/provider"
import { createRpcHarness } from "@gent/core/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core/test-utils/language-model"
import { AgentsExtension } from "@gent/extensions/agents"
import { FsToolsExtension } from "@gent/extensions/fs-tools"
import { e2ePreset } from "../helpers/test-preset"

describe("FsToolsExtension via model turn", () => {
  const modelTurnTest = it.scopedLive.layer(BunServices.layer)

  modelTurnTest(
    "read tool call succeeds through a real agent turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const cwd = yield* fs.makeTempDirectoryScoped()
          const filePath = path.join(cwd, "fixture.txt")
          yield* fs.writeFileString(filePath, "Hello from fs model turn\n")

          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("read", { path: filePath }),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, FsToolsExtension],
            cwd,
          })
          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed" ||
                  envelope.event._tag === "ToolCallStarted") &&
                (envelope.event as { readonly toolName?: string }).toolName === "read",
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "Read fixture.txt",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          expect(events.some((event) => event.event._tag === "ToolCallStarted")).toBe(true)
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          expect(succeeded?.event._tag).toBe("ToolCallSucceeded")
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("Hello from fs model turn")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
