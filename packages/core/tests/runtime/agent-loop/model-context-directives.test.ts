import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "@gent/core-internal/domain/agent"
import { ExtensionHost, defineExtension, tool } from "@gent/core/extensions/api"
import { LoadedArtifactIdentity } from "@gent/core-internal/domain/extension"
import { RequestId } from "@gent/core-internal/domain/ids"
import { SteerCommand } from "@gent/core-internal/domain/steer"
import type { Message } from "@gent/core-internal/domain/message"
import { CellTool } from "@gent/core-internal/runtime/code-cell/cell-tool"
import { CONTEXT_WINDOW_MESSAGE_TYPE } from "@gent/core-internal/runtime/model-context-window"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { buildCellExecutable } from "../cell-worker-fixture.js"

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)

const hasReply = (text: string) => (items: ReadonlyArray<Message>) =>
  items.some((item) => item.parts.some((part) => part.type === "text" && part.text === text))

const windowMarkers = (items: ReadonlyArray<Message>) =>
  items.filter((message) => message.metadata?.customType === CONTEXT_WINDOW_MESSAGE_TYPE)

describe.skipIf(process.platform !== "darwin")("model context directives from a cell", () => {
  it.scopedLive(
    "context.newWindow() from a cell leaves one durable marker that later turns keep",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const artifact = yield* buildCellExecutable
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "await context.newWindow(); 'windowed'" }),
          textStep("after window"),
          textStep("second turn"),
        ])
        const fixture = defineExtension({
          id: "model-context-directive-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("model-context-directive-source"),
            },
          ],
          extraLayers: [
            Layer.succeed(
              GentPlatform,
              GentPlatform.of({
                ...platform,
                cellWorkerPath: Effect.succeed(artifact.binaryPath),
              }),
            ),
          ],
        })
        yield* client.message.send({ sessionId, branchId, content: "open a new window" })
        const afterFirst = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("after window"),
        )
        const markers = windowMarkers(afterFirst)
        expect(markers).toHaveLength(1)
        // The marker anchors on the user message that started this turn.
        const anchor = afterFirst.find(
          (message) => message.role === "user" && message.id !== markers[0]?.id,
        )
        expect(markers[0]?.metadata?.details).toMatchObject({ keepFromMessageId: anchor?.id })

        yield* client.message.send({ sessionId, branchId, content: "and again" })
        const afterSecond = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("second turn"),
        )
        expect(windowMarkers(afterSecond)).toHaveLength(1)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )

  for (const directive of ["newWindow", "compact"]) {
    it.scopedLive(
      `an interrupted cell does not apply context.${directive}() to the next turn`,
      () =>
        Effect.gen(function* () {
          const platform = yield* GentPlatform
          const artifact = yield* buildCellExecutable
          const scheduled = yield* Deferred.make<void>()
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("history reply"),
            toolCallStep("cell", {
              code: `await context.${directive}(); await tools.call("hold", {})`,
            }),
            {
              ...textStep("after interrupt"),
              assertOptions: (options) => {
                const prompt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
                  options.prompt,
                )
                expect(prompt).toContain("keep older context")
                expect(prompt).not.toContain("New context window")
              },
            },
          ])
          const fixture = defineExtension({
            id: "interrupted-context-directive-fixture",
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
              yield* host.register(
                "tool",
                CellTool,
                tool({
                  id: "hold",
                  description: "Hold the cell after it schedules a context directive",
                  params: Schema.Struct({}),
                  output: Schema.String,
                  execute: () =>
                    Deferred.succeed(scheduled, void 0).pipe(Effect.andThen(Effect.never)),
                }),
              )
            }),
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            providerLayer,
            agents: [],
            extensionInputs: [
              {
                ...fixture,
                artifactIdentity: LoadedArtifactIdentity.make(
                  "interrupted-context-directive-source",
                ),
              },
            ],
            extraLayers: [
              Layer.succeed(
                GentPlatform,
                GentPlatform.of({
                  ...platform,
                  cellWorkerPath: Effect.succeed(artifact.binaryPath),
                }),
              ),
            ],
          })
          yield* client.message.send({ sessionId, branchId, content: "keep older context" })
          yield* waitFor(client.message.list({ branchId }), hasReply("history reply"))
          yield* client.message.send({ sessionId, branchId, content: "schedule then wait" })
          yield* Deferred.await(scheduled)
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Interrupt",
              sessionId,
              branchId,
              requestId: RequestId.make("interrupt-context-directive"),
            }),
          })
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              ({ event }) => event._tag === "TurnCompleted" && event.interrupted === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          )
          expect(windowMarkers(yield* client.message.list({ branchId }))).toHaveLength(0)
          yield* client.message.send({
            sessionId,
            branchId,
            content: "continue without that directive",
          })
          const messages = yield* waitFor(
            client.message.list({ branchId }),
            hasReply("after interrupt"),
          )
          expect(windowMarkers(messages)).toHaveLength(0)
          expect(
            messages.filter((message) => message.metadata?.customType === "model-compaction"),
          ).toHaveLength(0)
          expect(yield* controls.callCount).toBe(3)
          yield* controls.assertDone
        }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
      20000,
    )
  }
})
