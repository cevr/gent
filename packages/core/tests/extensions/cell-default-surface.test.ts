import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path, Predicate, Schema, Stream } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import {
  LanguageModelLayers,
  type SequenceStep,
} from "@gent/core-internal/test-utils/language-model"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { buildCellExecutable } from "../runtime/cell-worker-fixture.js"
import { shippedPreset } from "../../../extensions/tests/helpers/test-preset.js"

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const isToolLifecycleEvent = Predicate.or(
  Predicate.isTagged("ToolCallStarted"),
  Predicate.isTagged("ToolCallSucceeded"),
)

const cellOnly = (step: SequenceStep): SequenceStep => ({
  ...step,
  assertOptions: (options) => {
    expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
  },
})

describe.skipIf(process.platform !== "darwin")("shipped model surface", () => {
  it.scopedLive(
    "advertises only cell and serves builtin host tools inside it",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const artifact = yield* buildCellExecutable
        const directory = yield* fs.makeTempDirectoryScoped()
        const file = path.join(directory, "note.txt")
        yield* fs.writeFileString(file, "shipped surface")
        const readNote = `const note = (await tools.call('read', {path: ${encodeJson(file)}})).content; note`
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code: readNote })),
          textStep("first"),
          cellOnly(toolCallStep("cell", { code: "note.includes('shipped surface')" })),
          textStep("second"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          extraLayers: [
            Layer.succeed(
              GentPlatform,
              GentPlatform.of({ ...platform, cellWorkerPath: Effect.succeed(artifact.binaryPath) }),
            ),
          ],
        })
        const runTurn = Effect.fn("Test.runTurn")(function* (content: string, reply: string) {
          yield* client.message.send({ sessionId, branchId, content })
          const completed = yield* waitFor(
            client.message.list({ branchId }),
            (messages) =>
              messages.some(
                (message) =>
                  message.role === "assistant" && messageSingleText(message.parts) === reply,
              ),
            10_000,
            `assistant reply ${reply}`,
          )
          return completed
            .flatMap((message) => message.parts)
            .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
            .filter((part) => part.name === "cell")
        })

        const first = yield* runTurn("read through the cell", "first")
        expect(first).toHaveLength(1)
        expect(first[0]).toMatchObject({
          isFailure: false,
          result: {
            display: expect.stringContaining("shipped surface"),
            // The saved result carries inner-operation receipts for the transcript.
            operations: [{ tool: "read", outcome: "succeeded" }],
          },
        })
        const cellToolCallId = first[0]?.id
        // The inner call is published as an event nested under its cell.
        const innerEvents = yield* client.session.events({ sessionId, branchId, after: 0 }).pipe(
          Stream.filter(
            (envelope) =>
              isToolLifecycleEvent(envelope.event) && envelope.event.toolName === "read",
          ),
          Stream.take(2),
          Stream.runCollect,
        )
        expect(innerEvents.map((envelope) => envelope.event)).toMatchObject([
          { _tag: "ToolCallStarted", parentToolCallId: cellToolCallId },
          { _tag: "ToolCallSucceeded", parentToolCallId: cellToolCallId },
        ])

        // Working data from the first cell is still bound in the next turn.
        const second = yield* runTurn("use the note", "second")
        expect(second).toHaveLength(2)
        expect(second[1]).toMatchObject({ isFailure: false, result: { display: "true" } })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )
})
