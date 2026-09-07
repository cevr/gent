import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Predicate, Ref, Schema, Stream } from "effect"
import { ExtensionContext, tool } from "@gent/core/extensions/api"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "@gent/core-internal/domain/agent"
import { LoadedArtifactIdentity, type LoadedExtension } from "@gent/core-internal/domain/extension"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import { CellTool } from "@gent/core-internal/runtime/code-cell/cell-tool"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { buildCellExecutable } from "../cell-worker-fixture.js"

describe.skipIf(process.platform !== "darwin")("cell approvals", () => {
  it.scopedLive(
    "resumes fresh cell approvals without replaying source for allow and deny",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const artifact = yield* buildCellExecutable
        for (const approved of [true, false]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const marks = yield* Ref.make<ReadonlyArray<string>>([])
              const decisions = yield* Ref.make<ReadonlyArray<boolean>>([])
              const attempts = yield* Ref.make(0)
              const extensions: ReadonlyArray<LoadedExtension> = [
                {
                  manifest: { id: ExtensionId.make("cell-approval") },
                  scope: "builtin",
                  sourcePath: "cell-approval",
                  artifactIdentity: LoadedArtifactIdentity.make("cell-approval-source"),
                  contributions: {
                    tools: [
                      CellTool,
                      tool({
                        id: "mark",
                        description: "Record a source effect",
                        params: Schema.String,
                        output: Schema.Boolean,
                        execute: (mark) =>
                          Ref.update(marks, (values) => [...values, mark]).pipe(Effect.as(true)),
                      }),
                      tool({
                        id: "approve",
                        description: "Ask before recording a decision",
                        params: Schema.Struct({}),
                        output: Schema.Boolean,
                        execute: () =>
                          Effect.gen(function* () {
                            yield* Ref.update(attempts, (count) => count + 1)
                            const answer = yield* (yield* ExtensionContext).Interaction.approve({
                              text: "Continue cell operation?",
                            })
                            yield* Ref.update(decisions, (values) => [...values, answer.approved])
                            return answer.approved
                          }),
                      }),
                    ],
                  },
                },
              ]
              const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
                toolCallStep("cell", {
                  code: "await tools.call('mark', 'before'); await tools.call('approve', {}); await tools.call('mark', 'after')",
                }),
                textStep("Cell recovery reported"),
              ])
              const { client, sessionId, branchId } = yield* createRpcHarness({
                extensions,
                providerLayer,
                extensionInputs: [],
                durableApproval: true,
                agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
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
              yield* client.message.send({
                sessionId,
                branchId,
                content: "Run a cell with approval",
              })
              const presented = yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.map((envelope) => envelope.event),
                Stream.filter((event) => event._tag === "InteractionPresented"),
                Stream.take(1),
                Stream.runCollect,
              )
              const request = Array.from(presented)[0]
              if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
              yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
                Stream.filter((runtime) => runtime._tag === "WaitingForInteraction"),
                Stream.take(1),
                Stream.runDrain,
              )
              expect(yield* Ref.get(marks)).toEqual(["before"])
              expect(yield* Ref.get(decisions)).toEqual([])
              yield* client.interaction.respondInteraction({
                sessionId,
                branchId,
                requestId: request.requestId,
                approved,
              })
              yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
                Stream.take(1),
                Stream.runDrain,
              )
              const messages = yield* client.message.list({ branchId })
              expect(
                messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    messageSingleText(message.parts) === "Cell recovery reported",
                ),
              ).toBe(true)
              const results = messages
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool-result")
                .filter((part) => part.name === "cell")
              expect(results).toHaveLength(1)
              expect(results[0]).toMatchObject({
                isFailure: true,
                result: {
                  stateLost: true,
                  operations: [
                    { _tag: "Completed", result: { name: "mark", isFailure: false, result: true } },
                    {
                      _tag: "Completed",
                      result: { name: "approve", isFailure: false, result: approved },
                    },
                  ],
                },
              })
              expect(yield* Ref.get(marks)).toEqual(["before"])
              expect(yield* Ref.get(decisions)).toEqual([approved])
              // The host restarts at its approval boundary. Outer source does not restart.
              expect(yield* Ref.get(attempts)).toBe(2)
            }),
          )
        }
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )
})
