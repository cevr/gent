import { expect, it } from "effect-bun-test"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { Effect, Fiber, Layer, Option, Predicate, Ref, Schema, Stream } from "effect"
import { Gent } from "@gent/sdk"
import {
  AgentDefinition,
  AgentRunnerService,
  DEFAULT_AGENT_NAME,
  makeRunSpec,
} from "@gent/core-internal/domain/agent"
import { ControlChildAgent } from "../../../../extensions/src/delegate/child-agent-tools.js"
import { DelegateTool } from "../../../../extensions/src/delegate/delegate-tool.js"
import { makeDurableAgentRunRuntime } from "@gent/core-internal/runtime/agent/agent-runner.durable"
import { CellToolOperationStorage } from "@gent/core-internal/storage/cell-tool-operation-storage"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SqlClient } from "effect/unstable/sql"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { ExtensionContext, tool } from "@gent/core/extensions/api"
import { makeAmbientExtensionHostContextProvider } from "@gent/core-internal/runtime/make-extension-host-context"
import { makeCellToolHost } from "@gent/core-internal/runtime/code-cell/cell-tool-host"
import { ModelContextLedger } from "@gent/core-internal/runtime/model-context-ledger"
import { CellResponse } from "@gent/core-internal/runtime/code-cell/cell-protocol"
import { InteractionStorage } from "@gent/core-internal/storage/interaction-storage"
import { LoadedArtifactIdentity, type LoadedExtension } from "@gent/core-internal/domain/extension"
import {
  ExtensionId,
  MessageId,
  RequestId,
  ToolCallId,
  type SessionId,
  type BranchId,
} from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import { CellExecutionStorage } from "@gent/core-internal/storage/cell-execution-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { AgentLoopQueueStorage } from "@gent/core-internal/storage/agent-loop-queue-storage"
import { ToolCallBindingStorage } from "@gent/core-internal/storage/tool-call-binding-storage"
import { SessionProfileCache } from "@gent/core-internal/runtime/session-profile"
import { captureCurrentToolBinding } from "@gent/core-internal/runtime/agent/tool-binding-resolution"
import { CurrentToolCall } from "@gent/core-internal/runtime/agent/current-tool-call"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "@gent/core-internal/runtime/agent/agent-loop.utils"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep } from "@gent/core-internal/debug/provider"

const cancelRecoveredChild = Effect.fn("test.cancelRecoveredChild")(function* (
  outer: Option.Option<Message["parts"][number]>,
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
) {
  if (Option.isNone(outer) || outer.value.type !== "tool-result")
    return yield* Effect.die("Missing recovered cell result")
  const recovered = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      operations: Schema.Array(
        Schema.TaggedStruct("Unknown", {
          toolName: Schema.Literal("delegate"),
          toolCallId: ToolCallId,
        }),
      ),
    }),
  )(outer.value.result)
  const operation = recovered.operations[0]
  if (Predicate.isUndefined(operation)) return yield* Effect.die("Missing unknown child operation")
  const runner = yield* AgentRunnerService
  const handle = {
    parentSessionId: parent.sessionId,
    parentBranchId: parent.branchId,
    requestId: RequestId.make(operation.toolCallId),
  }
  expect(Option.isNone((yield* runner.inspect(handle)).completion)).toBe(true)
  yield* runner.cancel(handle)
  const cancelled = yield* waitFor(
    runner.inspect(handle),
    (observed) => Option.isSome(observed.completion),
    2000,
    "cancelled child completion",
  )
  expect(Option.getOrUndefined(cancelled.completion)?.interrupted).toBe(true)
})

it.scopedLive(
  "recovers saved cells through RPC without native replay and retains sibling results",
  () =>
    Effect.gen(function* () {
      for (const state of [
        "unadmitted",
        "revoked",
        "incomplete",
        "completed",
        "waiting",
        "unknown-child",
      ]) {
        const deniedTools: string[] = []
        if (state === "revoked") deniedTools.push("cell")
        const nativeCalls = yield* Ref.make(0)
        const cellCalls = yield* Ref.make(0)
        const approvalCalls = yield* Ref.make(0)
        const selectedNames = yield* Ref.make<ReadonlyArray<string>>([])
        const extensions: ReadonlyArray<LoadedExtension> = [
          {
            manifest: { id: ExtensionId.make("cell-recovery") },
            scope: "builtin",
            sourcePath: "cell-recovery",
            artifactIdentity: LoadedArtifactIdentity.make("cell-recovery-source"),
            contributions: {
              tools: [
                DelegateTool,
                ControlChildAgent,
                tool({
                  id: "approve",
                  description: "Approve inner operation",
                  params: Schema.Struct({}),
                  output: Schema.Boolean,
                  execute: () =>
                    Effect.gen(function* () {
                      yield* Ref.update(approvalCalls, (n) => n + 1)
                      return (yield* (yield* ExtensionContext).Interaction.approve({
                        text: "Continue inner operation?",
                      })).approved
                    }),
                }),
                tool({
                  id: "cell",
                  description: "Must not replay",
                  params: Schema.Struct({ code: Schema.String }),
                  output: Schema.Finite,
                  execute: () =>
                    Effect.gen(function* () {
                      const call = yield* CurrentToolCall
                      yield* Ref.set(selectedNames, [...call.toolBindings.keys()].sort())
                      return yield* Ref.updateAndGet(cellCalls, (n) => n + 1)
                    }),
                }),
                tool({
                  id: "sibling",
                  description: "Native sibling",
                  params: Schema.Struct({}),
                  output: Schema.Finite,
                  execute: () => Ref.updateAndGet(nativeCalls, (n) => n + 1),
                }),
              ],
            },
          },
        ]
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("Recovered"),
        ])
        // Keep the real server context to seed the crash gap before actor startup.
        const context = yield* Layer.build(
          createE2ELayer({
            extensions,
            providerLayer,
            agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME, deniedTools })],
            extensionInputs: [],
            durableApproval: true,
            subagentRunner: "live",
          }),
        )
        const { client } = yield* Gent.test(Layer.succeedContext(context))
        const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
        const workspaceId = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{
            readonly workspace_id: string
          }>`SELECT workspace_id FROM sessions WHERE id = ${sessionId}`
          return yield* Schema.decodeUnknownEffect(WorkspaceId)(rows[0]?.workspace_id)
        }).pipe(Effect.provideContext(context))
        const messageId = MessageId.make("cell-recovery-user")
        const assistantMessageId = assistantMessageIdForTurn(messageId, 1)
        const cell = {
          sessionId,
          branchId,
          assistantMessageId,
          toolCallId: ToolCallId.make("outer-cell"),
        }
        const savedResult = Prompt.toolResultPart({
          id: cell.toolCallId,
          name: "cell",
          result: { display: "Saved" },
          isFailure: false,
          providerExecuted: false,
        })
        yield* Effect.gen(function* () {
          const messages = yield* MessageStorage
          const user = Message.cases.regular.make({
            id: messageId,
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "Continue" })],
            createdAt: dateFromMillis(0),
          })
          yield* messages.createMessage(user)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              createdAt: dateFromMillis(1),
              parts: [
                Prompt.toolCallPart({
                  id: cell.toolCallId,
                  name: "cell",
                  params: { code: "sideEffect()" },
                  providerExecuted: false,
                }),
                Prompt.toolCallPart({
                  id: "native-sibling",
                  name: "sibling",
                  params: {},
                  providerExecuted: false,
                }),
              ],
            }),
          )
          const cells = yield* CellExecutionStorage
          if (state !== "unadmitted" && state !== "revoked") yield* cells.claim(cell)
          if (state === "completed") yield* cells.complete(cell, savedResult)
          const profile = yield* (yield* SessionProfileCache).resolve("/tmp")
          if (state === "unknown-child") {
            const selected = yield* captureCurrentToolBinding({
              sessionId,
              toolName: "delegate",
              publication: profile.publication,
            })
            const identity = Option.flatMap(selected, (entry) =>
              Option.fromUndefinedOr(entry.binding),
            )
            if (Option.isNone(identity)) return yield* Effect.die("Missing child start binding")
            const prompt = "Admitted before the worker was lost"
            const admitted = yield* (yield* CellToolOperationStorage).admit({
              cell,
              operationId: "unknown-child-start",
              binding: identity.value,
              input: { agent: DEFAULT_AGENT_NAME, prompt },
            })
            const toolCallId = admitted.operation.toolCallId
            yield* (yield* makeDurableAgentRunRuntime).createDurableAgentRunSession({
              agent: { name: DEFAULT_AGENT_NAME },
              prompt,
              cwd: "/tmp",
              parentSessionId: sessionId,
              parentBranchId: branchId,
              toolCallId,
              admission: {
                requestId: RequestId.make(toolCallId),
                runSpec: makeRunSpec({ persistence: "durable", parentToolCallId: toolCallId }),
              },
            })
          }
          if (state === "unadmitted" || state === "revoked") {
            const captured = yield* captureCurrentToolBinding({
              sessionId,
              toolName: "cell",
              publication: profile.publication,
            })
            const identity = Option.flatMap(captured, (entry) =>
              Option.fromUndefinedOr(entry.binding),
            )
            if (Option.isNone(identity)) return yield* Effect.die("Missing outer cell binding")
            yield* (yield* ToolCallBindingStorage).save({ ...cell, binding: identity.value })
          }
          if (state === "waiting") {
            if (Predicate.isUndefined(profile.publication))
              return yield* Effect.die("Missing publication")
            const host = yield* makeAmbientExtensionHostContextProvider({
              extensionRegistry: profile.registryService,
            })
            const selected = yield* captureCurrentToolBinding({
              sessionId,
              toolName: "approve",
              publication: profile.publication,
            })
            if (Option.isNone(selected)) return yield* Effect.die("Missing approval binding")
            const suspended = yield* makeCellToolHost({
              cell,
              ledger: yield* ModelContextLedger.make,
              toolBindings: new Map([["approve", selected.value]]),
              profile: {
                turnPublication: profile.publication,
                turnExtensionRegistry: profile.registryService,
                turnDriverRegistry: profile.driverRegistryService,
                turnPermission: profile.permissionService,
                turnBaseSections: profile.baseSections,
                turnHostCtx: host.forRun(cell),
              },
            })
              .call(
                CellResponse.cases.HostCall.make({
                  cellId: "1",
                  operationId: "1",
                  name: "approve",
                  input: {},
                }),
              )
              .pipe(Effect.flip)
            expect(suspended._tag).toBe("CellToolCallSuspended")
          }
          const binding = yield* captureCurrentToolBinding({
            sessionId,
            toolName: "sibling",
            publication: profile.publication,
          })
          const identity = Option.flatMap(binding, (entry) => Option.fromUndefinedOr(entry.binding))
          if (Option.isNone(identity)) return yield* Effect.die("Missing sibling binding")
          yield* (yield* ToolCallBindingStorage).save({
            sessionId,
            branchId,
            assistantMessageId,
            toolCallId: ToolCallId.make("native-sibling"),
            binding: identity.value,
          })
          yield* (yield* AgentLoopQueueStorage).putQueueState(sessionId, branchId, {
            steering: [],
            followUp: [],
            inFlight: { message: user },
          })
        }).pipe(
          Effect.provideContext(context),
          Effect.provideService(CurrentWorkspaceId, workspaceId),
        )
        const finished = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.session.getSnapshot({ sessionId, branchId })
        if (state === "waiting") {
          yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
            Stream.filter((runtime) => runtime._tag === "WaitingForInteraction"),
            Stream.take(1),
            Stream.runDrain,
          )
          expect(yield* Ref.get(approvalCalls)).toBe(1)
          expect(yield* Ref.get(nativeCalls)).toBe(0)
          const pending = yield* Effect.gen(function* () {
            return yield* (yield* InteractionStorage).listPending({ sessionId, branchId })
          }).pipe(
            Effect.provideContext(context),
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          const request = pending[0]
          if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: request.requestId,
            approved: true,
          })
        }
        yield* Fiber.join(finished)
        const messages = yield* client.message.list({ branchId })
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" && messageSingleText(message.parts) === "Recovered",
          ),
        ).toBe(true)
        const results = messages.find(
          (message) => message.id === toolResultMessageIdForTurn(messageId, 1),
        )?.parts
        expect(results).toHaveLength(2)
        const outer = results?.find(
          (part) => part.type === "tool-result" && part.id === cell.toolCallId,
        )
        if (state === "unknown-child") {
          yield* cancelRecoveredChild(Option.fromUndefinedOr(outer), { sessionId, branchId }).pipe(
            Effect.provideContext(context),
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          expect(yield* controls.callCount).toBe(1)
        }
        if (state === "completed") expect(outer).toEqual(savedResult)
        else if (state === "unadmitted")
          expect(outer).toMatchObject({ isFailure: false, result: 1 })
        else if (state === "revoked")
          expect(outer).toMatchObject({ isFailure: true, result: { error: "Unknown tool: cell" } })
        else
          expect(outer).toMatchObject({
            isFailure: true,
            result: { stateLost: true },
          })
        if (state === "waiting") {
          expect(yield* Ref.get(approvalCalls)).toBe(2)
          expect(outer).toMatchObject({
            result: {
              operations: [
                { _tag: "Completed", operationId: "1", result: { isFailure: false, result: true } },
              ],
            },
          })
        }
        expect(
          results?.find((part) => part.type === "tool-result" && part.id === "native-sibling"),
        ).toMatchObject({ isFailure: false, result: 1 })
        if (state === "unadmitted") {
          expect(yield* Ref.get(cellCalls)).toBe(1)
          expect(yield* Ref.get(selectedNames)).toEqual([
            "agent-child",
            "approve",
            "cell",
            "delegate",
            "sibling",
          ])
        } else expect(yield* Ref.get(cellCalls)).toBe(0)
        expect(yield* Ref.get(nativeCalls)).toBe(1)
      }
    }).pipe(Effect.timeout("12 seconds")),
  15000,
)
