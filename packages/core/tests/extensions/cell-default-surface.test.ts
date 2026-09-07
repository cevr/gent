import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path, Predicate, Schema, Stream } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentDefinition, AgentName, defineExtension } from "@gent/core/extensions/api"
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
        const cellAssistant = (yield* client.message.list({ branchId })).find(
          (message) =>
            message.role === "assistant" &&
            message.parts.some((part) => part.type === "tool-call" && part.id === cellToolCallId),
        )
        expect(cellAssistant).toBeDefined()
        expect(innerEvents.map((envelope) => envelope.event)).toMatchObject([
          {
            _tag: "ToolCallStarted",
            parentToolCallId: cellToolCallId,
            assistantMessageId: cellAssistant?.id,
          },
          {
            _tag: "ToolCallSucceeded",
            parentToolCallId: cellToolCallId,
            assistantMessageId: cellAssistant?.id,
          },
        ])

        // Working data from the first cell is still bound in the next turn.
        const second = yield* runTurn("use the note", "second")
        expect(second).toHaveLength(2)
        expect(second[1]).toMatchObject({ isFailure: false, result: { display: "true" } })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )

  it.scopedLive(
    "composes concurrent host calls inside one cell",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const artifact = yield* buildCellExecutable
        const directory = yield* fs.makeTempDirectoryScoped()
        const left = path.join(directory, "left.txt")
        const right = path.join(directory, "right.txt")
        yield* fs.writeFileString(left, "left half")
        yield* fs.writeFileString(right, "right half")
        // Parallel delegation is a cell recipe, not a tool mode.
        const code = [
          `const [a, b] = await Promise.all([`,
          `  tools.call('read', {path: ${encodeJson(left)}}),`,
          `  tools.call('read', {path: ${encodeJson(right)}}),`,
          `]); a.content + ' | ' + b.content`,
        ].join("\n")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code })),
          textStep("joined"),
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
        yield* client.message.send({ sessionId, branchId, content: "read both" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messageSingleText(message.parts) === "joined",
            ),
          10_000,
          "assistant reply joined",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          isFailure: false,
          result: {
            display: "1\tleft half | 1\tright half",
            operations: [
              { tool: "read", outcome: "succeeded" },
              { tool: "read", outcome: "succeeded" },
            ],
          },
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )

  it.scopedLive(
    "allowedTools scopes host tools inside the cell instead of replacing the surface",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const artifact = yield* buildCellExecutable
        const directory = yield* fs.makeTempDirectoryScoped()
        const file = path.join(directory, "note.txt")
        yield* fs.writeFileString(file, "scoped surface")
        // The agent allows `read` only and never names `cell`: the cell stays the model
        // surface and `grep` is unreachable from inside it.
        const scopedAgent = defineExtension({
          id: "@test/scoped-agent",
          agents: [
            AgentDefinition.make({
              name: AgentName.make("scoped"),
              description: "reads only",
              allowedTools: ["read"],
            }),
          ],
        })
        const code = [
          `let grep = 'reachable'`,
          `try { await tools.call('grep', {pattern: 'scoped', path: ${encodeJson(directory)}}) } catch { grep = 'unreachable' }`,
          `(await tools.call('read', {path: ${encodeJson(file)}})).content + ' | grep ' + grep`,
        ].join("\n")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code })),
          textStep("scoped"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [...shippedPreset.extensionInputs, scopedAgent],
          providerLayer,
          extraLayers: [
            Layer.succeed(
              GentPlatform,
              GentPlatform.of({ ...platform, cellWorkerPath: Effect.succeed(artifact.binaryPath) }),
            ),
          ],
        })
        yield* client.message.send({
          sessionId,
          branchId,
          content: "read the note",
          agentOverride: AgentName.make("scoped"),
        })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messageSingleText(message.parts) === "scoped",
            ),
          10_000,
          "assistant reply scoped",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          isFailure: false,
          result: { display: "1\tscoped surface | grep unreachable" },
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )
})
