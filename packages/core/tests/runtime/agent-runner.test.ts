import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { InProcessRunner, getSessionDepth } from "../../src/runtime/agent/agent-runner"
import { ChildCompletionDelivery } from "../../src/runtime/agent/child-completion"
import { makeDurableAgentRunRuntime } from "../../src/runtime/agent/agent-runner.durable"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent/agent-loop.session-governance"
import { makeEphemeralAgentRootLayerFactory } from "../../src/runtime/agent/ephemeral-root"
import { ConfigService } from "../../src/runtime/config-service"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { emptyQueueSnapshot } from "@gent/core-internal/domain/queue"
import { dateFromMillis, Session, Branch, Message } from "@gent/core-internal/domain/message"
import {
  AgentRunnerService,
  type AgentRunner,
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  AgentRunError,
  AgentName,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  makeRunSpec,
} from "@gent/core-internal/domain/agent"
import { AllBuiltinAgents, builtinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import {
  BranchId,
  ExtensionId,
  MessageId,
  RequestId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { ModelId } from "@gent/core-internal/domain/model"
import {
  AgentEvent,
  EventStore,
  EventStoreError,
  StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "@gent/core-internal/domain/event"
import { EventPublisher, EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { makeStorageTransaction, SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionOperationStorage } from "@gent/core-internal/storage/session-operation-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { RelationshipStorage } from "@gent/core-internal/storage/relationship-storage"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ApprovalService } from "../../src/runtime/approval-service"
import { loadAgentRunSuccessData } from "../../src/runtime/agent/agent-runner.metadata"
import {
  defineResource,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  request,
  tool,
} from "@gent/core/extensions/api"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { CapabilityError } from "@gent/core-internal/domain/capability"
import { EventStoreLive } from "../../src/runtime/event-store-live"
import {
  SequenceRecorder,
  RecordingEventStore,
  assertSequence,
} from "@gent/core-internal/test-utils"
import { SessionCommands } from "../../src/server/session-commands"
import { CurrentWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { Permission } from "@gent/core-internal/domain/permission"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import {
  SessionRuntime,
  SessionRuntimeStateSchema,
  type SessionRuntimeService,
  type SessionRuntimeState,
} from "../../src/runtime/session-runtime"
import { BunCrypto, BunFileSystem, BunPath, BunServices } from "@effect/platform-bun"
const bashStubTool = tool({
  id: "bash",
  description: "Stub bash tool for tests",
  params: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ output: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.command }),
})
const readStubTool = tool({
  id: "read",
  description: "Stub read tool for tests",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ output: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.path }),
})
const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools: [bashStubTool],
      },
    },
  ]),
)
const withEventPublisher = (baseEventStoreLayer: Layer.Layer<EventStore>) =>
  Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      baseEventStoreLayer,
      testRegistryLayer,
      RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
const makeLiveAgentRunnerLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  delivery: "silent" | "live" = "silent",
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools: [bashStubTool, readStubTool],
      },
    },
  ])
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const storageLayer = SqliteStorage.TestWithSql()
  const clusterRunnerLayer = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )
  const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
  const eventPublisherLayer = Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      registryLayer,
      RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
  const baseDeps = Layer.mergeAll(
    storageLayer,
    clusterRunnerLayer,
    eventStoreLayer,
    eventPublisherLayer,
    registryLayer,
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ToolRunner.Test(),
    ApprovalService.Test(),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    BunPlatformLive,
    ConfigService.Test(),
    ModelRegistry.Test(),
    ephemeralParentServices,
    AgentLoopSessionGovernance.Live,
  )
  const sessionRuntimeLayer = Layer.provide(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer),
  )
  const deps = Layer.mergeAll(baseDeps, sessionMutationsLayer, sessionRuntimeLayer)
  let deliverySource: typeof ChildCompletionDelivery.Live = ChildCompletionDelivery.Silent
  if (delivery === "live") deliverySource = ChildCompletionDelivery.Live
  const deliveryLayer = Layer.provide(deliverySource, deps)
  const runnerLayer = InProcessRunner({}).pipe(Layer.provide(Layer.merge(deps, deliveryLayer)))
  return Layer.mergeAll(deps, deliveryLayer, runnerLayer)
}
type ChildHandle = Parameters<AgentRunner["inspect"]>[0]
const waitForCompletion = <E, R>(
  runtime: {
    readonly inspect: (
      handle: ChildHandle,
    ) => Effect.Effect<Effect.Success<ReturnType<AgentRunner["inspect"]>>, E, R>
  },
  handle: ChildHandle,
  timeoutMs = 2000,
) =>
  waitFor(
    runtime.inspect(handle),
    (observed) => Option.isSome(observed.completion),
    timeoutMs,
    "child completion",
  )
// Extra services the parent context needs for ephemeral child runtime
const ephemeralParentDeps = Layer.mergeAll(
  BunPlatformLive,
  Permission.Live([], "allow"),
  RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ConfigService.Test(),
  ModelRegistry.Test(),
)
const ephemeralParentServices = Layer.mergeAll(
  Permission.Live([], "allow"),
  RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ConfigService.Test(),
  ModelRegistry.Test(),
)
const sessionRuntimeStub = (runPrompt: SessionRuntimeService["runPrompt"] = () => Effect.void) =>
  Layer.effect(
    SessionRuntime,
    Effect.gen(function* () {
      const runtimeState = yield* SubscriptionRef.make<SessionRuntimeState>(
        SessionRuntimeStateSchema.cases.Idle.make({
          agent: DEFAULT_AGENT_NAME,
          queue: emptyQueueSnapshot(),
        }),
      )
      return {
        sendUserMessage: () => Effect.void,
        steer: () => Effect.void,
        respondInteraction: () => Effect.void,
        runPrompt: (input) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.set(
              runtimeState,
              SessionRuntimeStateSchema.cases.Running.make({
                agent: input.agentName,
                queue: emptyQueueSnapshot(),
              }),
            )
            yield* runPrompt(input).pipe(
              Effect.ensuring(
                SubscriptionRef.set(
                  runtimeState,
                  SessionRuntimeStateSchema.cases.Idle.make({
                    agent: input.agentName,
                    queue: emptyQueueSnapshot(),
                  }),
                ),
              ),
            )
          }),
        queueFollowUp: () => Effect.void,
        dequeueFollowUp: () => Effect.succeed(false),
        requestExtension: () => Effect.void,
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getMetrics: () =>
          Effect.succeed({
            turns: 0,
            tokens: 0,
            toolCalls: 0,
            retries: 0,
            durationMs: 0,
            costUsd: 0,
            lastInputTokens: 0,
          }),
        getState: () => SubscriptionRef.get(runtimeState),
        watchState: () => Effect.succeed(SubscriptionRef.changes(runtimeState)),
        terminateSession: () => Effect.void,
      } satisfies SessionRuntimeService
    }),
  )
describe("helper run spec propagation", () => {
  it.scopedLive("an ephemeral child with inherited history sees the parent branch messages", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("pelican"),
          assertOptions: (options) => {
            const texts = [...Prompt.make(options.prompt).content].flatMap((message) => {
              if (message.role === "system") return []
              return message.content
                .filter((part): part is Prompt.TextPart => part.type === "text")
                .map((part) => part.text)
            })
            expect(texts.some((text) => text.includes("The codeword is pelican"))).toBe(true)
            expect(texts.some((text) => text.includes("Noted."))).toBe(true)
            // Hidden rows are outside the parent's own model view, so the child skips them too.
            expect(texts.some((text) => text.includes("hidden bookkeeping"))).toBe(false)
            expect(texts[texts.length - 1]).toContain("What is the codeword?")
          },
        },
      ])
      const layer = makeLiveAgentRunnerLayer(providerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const sessionId = SessionId.make("parent-history")
        const branchId = BranchId.make("parent-history-branch")
        yield* sessions.createSession(
          new Session({ id: sessionId, name: "Parent", createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
        yield* messages.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("parent-history:user:1"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "The codeword is pelican" })],
            createdAt: now,
          }),
        )
        yield* messages.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("parent-history:assistant:1"),
            sessionId,
            branchId,
            role: "assistant",
            parts: [Prompt.textPart({ text: "Noted." })],
            createdAt: dateFromMillis(1_767_225_601_000),
          }),
        )
        yield* messages.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("parent-history:hidden:1"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "hidden bookkeeping" })],
            createdAt: dateFromMillis(1_767_225_602_000),
            metadata: { hidden: true },
          }),
        )
        const observed = yield* Ref.make<ReadonlyArray<string>>([])
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "What is the codeword?",
          parentSessionId: sessionId,
          parentBranchId: branchId,
          cwd: process.cwd(),
          runSpec: makeRunSpec({ persistence: "ephemeral", history: "inherit" }),
          observe: (event) => {
            if (event._tag !== "StreamChunk") return Effect.void
            return Ref.update(observed, (chunks) => [...chunks, event.chunk])
          },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") expect(result.text).toContain("pelican")
        // The observer saw the child's stream as it happened.
        expect((yield* Ref.get(observed)).join("")).toContain("pelican")
        // The parent branch keeps its three messages; the child never writes there.
        expect((yield* messages.listMessages(branchId)).length).toBe(3)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scopedLive("durable helper-agent runSpec reaches the provider through AgentRunner", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
          },
          assertOptions: (options) => {
            expect(options.tools.map((tool) => tool.name)).toEqual(["bash"])
          },
        },
      ])
      const layer = makeLiveAgentRunnerLayer(providerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-runspec"),
            name: "Parent",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("parent-runspec-branch"),
            sessionId: SessionId.make("parent-runspec"),
            createdAt: now,
          }),
        )
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "check forwarding",
          parentSessionId: SessionId.make("parent-runspec"),
          parentBranchId: BranchId.make("parent-runspec-branch"),
          cwd: process.cwd(),
          runSpec: {
            persistence: "durable",
            tags: ["auto-loop"],
            overrides: {
              modelId: ModelId.make("custom/model"),
              allowedTools: ["bash"],
              deniedTools: ["read"],
              reasoningEffort: "high",
              systemPromptAddendum: "Extra helper-agent instructions",
            },
          },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("child result")
        }
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
describe("AgentRunner", () => {
  it.scopedLive(
    "extension RPC observes and cancels a child after its parent turn ends",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("start-child", {}),
          { ...textStep("child reply"), gated: true },
          textStep("parent finished"),
          // The cancelled child's completion arrives as a parent message and starts this turn.
          textStep("parent noticed"),
        ])
        const child = yield* Ref.make(Option.none<{ sessionId: SessionId; branchId: BranchId }>())
        const requestId = RequestId.make("rpc-child")
        const agent = new AgentDefinition({ name: AgentName.make("child") })
        const input = { agent, prompt: "Wait for the parent", requestId }
        const extension = defineExtension({
          id: "child-lifecycle",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }), agent)
            yield* host.register(
              "tool",
              tool({
                id: "start-child",
                description: "Start a durable child",
                params: Schema.Struct({}),
                output: Schema.Boolean,
                execute: Effect.fn("test.startChild")(function* () {
                  const ctx = yield* ExtensionContext
                  const first = yield* ctx.Agent.start(input)
                  expect(yield* ctx.Agent.start(input)).toEqual(first)
                  yield* Ref.set(child, Option.some(first))
                  // Hold the parent until the gated child model starts, fixing provider order.
                  yield* controls.waitForCall(1)
                  return true
                }),
              }),
            )
            yield* host.register(
              "request",
              request({
                id: "child-status",
                input: Schema.Literals(["inspect", "cancel", "unowned-start", "list"]),
                output: Schema.Boolean,
                execute: Effect.fn("test.childStatus")(
                  function* (action) {
                    const ctx = yield* ExtensionContext
                    if (action === "unowned-start") {
                      const error = yield* ctx.Agent.start(input).pipe(Effect.flip)
                      return error.message === "Child start requires a host-owned tool call"
                    }
                    if (action === "inspect")
                      return Option.isSome((yield* ctx.Agent.inspect({ requestId })).completion)
                    if (action === "cancel") {
                      yield* ctx.Agent.cancel({ requestId })
                      return true
                    }
                    const children = yield* ctx.Agent.list()
                    return children.length === 1 && children[0]?.requestId === requestId
                  },
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId: ExtensionId.make("child-lifecycle"),
                        capabilityId: "child-status",
                        reason: String(cause),
                      }),
                  ),
                ),
              }),
            )
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME }), agent],
          extensionInputs: [extension],
          subagentRunner: "live",
        })
        yield* client.message.send({ sessionId, branchId, content: "Start a child" })
        const parentEvents = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.runCollect,
        )
        expect(parentEvents.filter((envelope) => envelope.event._tag === "ErrorOccurred")).toEqual(
          [],
        )
        expect(Option.isSome(yield* Ref.get(child))).toBe(true)
        const address = {
          sessionId,
          branchId,
          extensionId: ExtensionId.make("child-lifecycle"),
          capabilityId: "child-status",
        }
        expect(yield* client.extension.request({ ...address, input: "inspect" })).toBe(false)
        expect(yield* client.extension.request({ ...address, input: "list" })).toBe(true)
        expect(yield* client.extension.request({ ...address, input: "unowned-start" })).toBe(true)
        const other = yield* client.branch.create({ sessionId })
        const foreign = yield* client.extension
          .request({ ...address, branchId: other.branchId, input: "cancel" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(foreign)).toBe(true)
        expect(yield* client.extension.request({ ...address, input: "inspect" })).toBe(false)
        expect(yield* client.extension.request({ ...address, input: "cancel" })).toBe(true)
        yield* waitFor(
          client.extension.request({ ...address, input: "inspect" }),
          (completed) => completed === true,
          2000,
          "cancelled child completion",
        )
        const handle = yield* Effect.fromOption(yield* Ref.get(child))
        const messages = yield* client.message.list({ branchId: handle.branchId })
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
        // The parent receives the outcome as an ordinary message, never through the call.
        const parentMessages = yield* waitFor(
          client.message.list({ branchId }),
          (items) =>
            items.some(
              (item) =>
                item.role === "assistant" && messageSingleText(item.parts) === "parent noticed",
            ),
          4000,
          "parent follow-up turn",
        )
        const notice = parentMessages.find(
          (item) => item.role === "user" && item.metadata?.customType === "child-completion",
        )
        expect(notice).toBeDefined()
        expect(messageSingleText(notice?.parts ?? [])).toContain("interrupted")
        expect(messageSingleText(notice?.parts ?? [])).toContain(requestId)
        expect(yield* controls.callCount).toBe(4)
      }).pipe(Effect.timeout("8 seconds")),
    10000,
  )

  it.scopedLive(
    "starts one queue-owned child and returns before its model completes",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("durable child completed"), gated: true },
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
        yield* Effect.gen(function* () {
          const runtime = yield* AgentRunnerService
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const parentSessionId = SessionId.make("start-parent")
          const parentBranchId = BranchId.make("start-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const input = {
            agent: builtinAgent,
            prompt: "Run independently",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("start-tool-call"),
            requestId: RequestId.make("stable-child-start"),
          }
          const first = yield* runtime.start(input).pipe(Effect.scoped)
          yield* controls.waitForCall(0)
          const handle = { requestId: input.requestId, parentSessionId, parentBranchId }
          expect(yield* runtime.inspect(handle)).toEqual({ ...first, completion: Option.none() })
          for (const invalid of [
            { ...handle, parentSessionId: SessionId.make("other-parent") },
            { ...handle, parentBranchId: BranchId.make("other-branch") },
            { ...handle, requestId: RequestId.make("missing-start") },
          ]) {
            const rejected = yield* runtime.inspect(invalid).pipe(Effect.flip)
            expect(rejected.message).toBe("Agent-start receipt not owned by parent")
          }
          const foreign = yield* runtime
            .inspect(handle)
            .pipe(
              Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("1".repeat(64))),
              Effect.flip,
            )
          expect(foreign.message).toBe("Agent-start receipt not owned by parent")
          expect(yield* runtime.inspect(handle)).toEqual({ ...first, completion: Option.none() })
          expect(yield* runtime.list({ parentSessionId, parentBranchId })).toEqual([
            {
              requestId: input.requestId,
              sessionId: first.sessionId,
              branchId: first.branchId,
              agentName: input.agent.name,
              completed: false,
            },
          ])
          expect(yield* runtime.start(input)).toEqual(first)
          expect(yield* controls.callCount).toBe(1)
          expect(
            yield* (yield* RelationshipStorage).getChildSessions(parentSessionId),
          ).toHaveLength(1)
          yield* controls.emitAll(0)
          const waited = yield* waitForCompletion(runtime, handle)
          expect(Option.isSome(waited.completion)).toBe(true)
          expect(yield* runtime.list({ parentSessionId, parentBranchId })).toMatchObject([
            { requestId: input.requestId, completed: true },
          ])
          const storage = yield* MessageStorage
          const completed = yield* waitFor(storage.listMessages(first.branchId), (messages) =>
            messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "durable child completed",
              ),
            ),
          )
          expect(completed.map((message) => message.role)).toEqual(["user", "assistant"])
          expect(completed[0]?.id).toBe(MessageId.make("agent-start:stable-child-start"))
          const events = yield* EventStorage
          const streamEnd = yield* events.getLatestEvent({
            ...first,
            tags: ["StreamEnded"],
            messageId: MessageId.make("agent-start:stable-child-start"),
          })
          expect(streamEnd).toEqual(
            expect.objectContaining({
              _tag: "StreamEnded",
              messageId: MessageId.make("agent-start:stable-child-start"),
              step: 1,
            }),
          )
          const completion = yield* waitFor(
            events.getLatestEvent({ ...first, tags: ["TurnCompleted"] }),
            (event) => event?._tag === "TurnCompleted",
          )
          expect(completion).toEqual(
            expect.objectContaining({
              messageId: MessageId.make("agent-start:stable-child-start"),
              streamFailed: false,
            }),
          )
          // A later turn receipt must not replace the admitted child's exact completion.
          yield* events.appendEvent(
            TurnCompleted.make({
              ...first,
              messageId: MessageId.make("unrelated-child-turn"),
              durationMs: 1,
              streamFailed: true,
            }),
          )
          expect(yield* runtime.inspect(handle)).toEqual({
            ...first,
            completion: Option.some(yield* Schema.decodeUnknownEffect(TurnCompleted)(completion)),
          })
          expect(yield* runtime.start(input)).toEqual(first)
          expect(yield* controls.callCount).toBe(1)
          yield* sessions.deleteSession(first.sessionId)
          const deleted = yield* runtime.inspect(handle).pipe(Effect.flip)
          expect(deleted.message).toBe("Agent-start child no longer exists")
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("6 seconds")),
    8000,
  )

  it.scopedLive(
    "delivers a finished child to its parent once, even when recovery runs again",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("child says hi"), gated: true },
          textStep("parent noticed"),
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer, "live"))
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const delivery = yield* ChildCompletionDelivery
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          const events = yield* EventStorage
          const parentSessionId = SessionId.make("deliver-parent")
          const parentBranchId = BranchId.make("deliver-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          // The parent branch has no history: the completion must wake it by itself.
          const requestId = RequestId.make("deliver-child")
          const child = yield* runner.start({
            agent: builtinAgent,
            prompt: "Say hi",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("deliver-tool"),
            requestId,
          })
          yield* controls.waitForCall(0)
          expect(yield* messages.listMessages(parentBranchId)).toHaveLength(0)
          yield* controls.emitAll(0)
          const noticed = yield* waitFor(
            messages.listMessages(parentBranchId),
            (items) =>
              items.some(
                (item) =>
                  item.role === "assistant" && messageSingleText(item.parts) === "parent noticed",
              ),
            4000,
            "parent follow-up turn",
          )
          const isNotice = (item: { metadata?: { customType?: string } }) =>
            item.metadata?.customType === "child-completion"
          const notice = noticed.find(isNotice)
          expect(notice).toMatchObject({
            metadata: {
              customType: "child-completion",
              details: { requestId, sessionId: child.sessionId, branchId: child.branchId },
            },
          })
          const text = messageSingleText(notice?.parts ?? [])
          expect(text).toContain(`requestId ${requestId}`)
          expect(text).toContain("child says hi")
          expect(text).toContain("Full output:")
          // A repeated delivery and a startup pass find the message and stop.
          yield* delivery.deliver(requestId)
          yield* delivery.reconcile
          const after = yield* messages.listMessages(parentBranchId)
          expect(after.filter(isNotice)).toHaveLength(1)
          const receipts = yield* events.listEvents({ sessionId: parentSessionId })
          expect(receipts.filter((entry) => entry.event._tag === "AgentRunSucceeded")).toHaveLength(
            1,
          )
          expect(yield* controls.callCount).toBe(2)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("8 seconds")),
    10000,
  )

  it.scopedLive(
    "cancels the owned child turn and leaves later work intact",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("cancelled reply"), gated: true },
          { ...textStep("later reply"), gated: true },
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const runtime = yield* SessionRuntime
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const parentSessionId = SessionId.make("cancel-parent")
          const parentBranchId = BranchId.make("cancel-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const handle = {
            requestId: RequestId.make("cancel-child"),
            parentSessionId,
            parentBranchId,
          }
          const child = yield* runner.start({
            agent: builtinAgent,
            prompt: "Wait for cancellation",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("cancel-tool"),
            requestId: handle.requestId,
          })
          yield* controls.waitForCall(0)
          const foreign = yield* runner
            .cancel({
              ...handle,
              parentBranchId: BranchId.make("foreign-branch"),
            })
            .pipe(Effect.flip)
          expect(foreign.message).toBe("Agent-start receipt not owned by parent")
          const transaction = yield* makeStorageTransaction
          const held = yield* transaction(runner.cancel(handle)).pipe(Effect.flip)
          expect(held.message).toBe("Child cancellation must run outside a caller transaction")
          yield* runner.cancel(handle)
          const stopped = yield* waitForCompletion(runner, handle)
          expect(Option.getOrUndefined(stopped.completion)?.interrupted).toBe(true)
          yield* runtime.sendUserMessage({
            ...child,
            content: "Later work",
            requestId: RequestId.make("later-child-work"),
            completion: "admission",
          })
          yield* controls.waitForCall(1)
          yield* runner.cancel(handle)
          yield* controls.emitAll(1)
          const messages = yield* waitFor(
            (yield* MessageStorage).listMessages(child.branchId),
            (items) =>
              items.some((item) =>
                item.parts.some((part) => part.type === "text" && part.text === "later reply"),
              ),
          )
          expect(messages.filter((message) => message.role === "user")).toHaveLength(2)
          expect(yield* controls.callCount).toBe(2)
          expect(yield* runner.inspect(handle)).toEqual(stopped)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("6 seconds")),
    8000,
  )

  it.scopedLive("reuses atomic child admission and rejects changed or deleted starts", () =>
    Effect.gen(function* () {
      const runtime = yield* makeDurableAgentRunRuntime
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const parentSessionId = SessionId.make("admission-parent")
      const parentBranchId = BranchId.make("admission-parent-branch")
      const now = dateFromMillis(1_767_225_600_000)
      yield* sessions.createSession(
        new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
      )
      yield* branches.createBranch(
        new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
      )
      const input = {
        agent: { name: DEFAULT_AGENT_NAME },
        prompt: "Admitted child",
        cwd: "/tmp",
        parentSessionId,
        parentBranchId,
        admission: { requestId: RequestId.make("child-start") },
      }
      const results = yield* Effect.forEach(
        [1, 2],
        () => runtime.createDurableAgentRunSession(input),
        { concurrency: 2 },
      )
      expect(results[0]).toEqual(results[1])
      const first = results[0]
      if (Predicate.isUndefined(first)) return yield* Effect.die("Missing child")
      expect(yield* (yield* RelationshipStorage).getChildSessions(parentSessionId)).toHaveLength(1)
      const changed = yield* runtime
        .createDurableAgentRunSession({ ...input, prompt: "Changed" })
        .pipe(Effect.flip)
      expect(changed).toMatchObject({
        _tag: "AgentRunError",
        message: "Agent-start request input changed",
      })
      yield* sessions.deleteSession(first.sessionId)
      const deleted = yield* runtime.createDurableAgentRunSession(input).pipe(Effect.flip)
      expect(deleted).toMatchObject({
        _tag: "AgentRunError",
        message: "Agent-start child no longer exists",
      })
      expect(yield* (yield* RelationshipStorage).getChildSessions(parentSessionId)).toEqual([])
    }).pipe(
      Effect.timeout("4 seconds"),
      Effect.provide(makeLiveAgentRunnerLayer(LanguageModelLayers.debug())),
    ),
  )

  it.scopedLive(
    "concurrent admission caps children and cancellation completes an unsubmitted child",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("finished"),
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
        yield* Effect.gen(function* () {
          const runner = yield* makeDurableAgentRunRuntime
          const parentSessionId = SessionId.make("limited-parent")
          const parentBranchId = BranchId.make("limited-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* (yield* SessionStorage).createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* (yield* BranchStorage).createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const toolCallId = ToolCallId.make("limited-start-tool")
          const runSpec = makeRunSpec({ persistence: "durable", parentToolCallId: toolCallId })
          const base = {
            agent: { name: DEFAULT_AGENT_NAME },
            prompt: "bounded child",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId,
          }
          const inputs = [0, 1, 2, 3, 4].map((id) => ({
            ...base,
            admission: { requestId: RequestId.make(`limited-${id}`), runSpec },
          }))
          const results = yield* Effect.forEach(
            inputs,
            (input) =>
              runner.createDurableAgentRunSession(input).pipe(
                Effect.map((child) => ({ input, child })),
                Effect.exit,
              ),
            { concurrency: 5 },
          )
          const accepted = results.filter(Exit.isSuccess)
          expect(accepted).toHaveLength(4)
          expect(results.filter(Exit.isFailure)).toHaveLength(1)
          expect(yield* controls.callCount).toBe(0)
          const first = accepted[0]
          if (Predicate.isUndefined(first)) return yield* Effect.die("Missing admitted child")
          const freshRunner = yield* makeDurableAgentRunRuntime
          expect(yield* freshRunner.createDurableAgentRunSession(first.value.input)).toEqual(
            first.value.child,
          )
          const extra = {
            ...base,
            admission: { requestId: RequestId.make("limited-extra"), runSpec },
          }
          const full = yield* freshRunner.createDurableAgentRunSession(extra).pipe(Effect.flip)
          expect(full.message).toBe("Parent branch already has 4 unfinished child starts")
          const wrongBranch = yield* freshRunner
            .createDurableAgentRunSession({
              ...extra,
              parentBranchId: BranchId.make("not-parent-branch"),
            })
            .pipe(Effect.flip)
          expect(wrongBranch.message).toBe("Agent-start branch does not belong to parent")
          const handle = {
            parentSessionId,
            parentBranchId,
            requestId: first.value.input.admission.requestId,
          }
          yield* freshRunner.cancel(handle)
          const cancelled = yield* waitForCompletion(freshRunner, handle)
          expect(Option.getOrUndefined(cancelled.completion)?.interrupted).toBe(true)
          yield* runner.start(first.value.input)
          yield* freshRunner.cancel(handle)
          expect(
            yield* (yield* MessageStorage).listMessages(first.value.child.branchId),
          ).toHaveLength(1)
          yield* freshRunner.createDurableAgentRunSession(extra)
          expect(
            yield* (yield* RelationshipStorage).getChildSessions(parentSessionId),
          ).toHaveLength(5)
          expect(yield* controls.callCount).toBe(0)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("5 seconds")),
    7000,
  )

  it.scopedLive(
    "child model attempts share a durable limit across concurrent calls and branches",
    () =>
      Effect.gen(function* () {
        const runner = yield* makeDurableAgentRunRuntime
        const operations = yield* SessionOperationStorage
        const branches = yield* BranchStorage
        const parentSessionId = SessionId.make("model-limit-parent")
        const parentBranchId = BranchId.make("model-limit-parent-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* (yield* SessionStorage).createSession(
          new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(
          new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
        )
        expect(
          yield* operations.reserveChildModelAttempt({
            sessionId: parentSessionId,
            branchId: parentBranchId,
          }),
        ).toEqual(Option.none())
        const toolCallId = ToolCallId.make("model-limit-tool")
        const input = {
          agent: { name: DEFAULT_AGENT_NAME },
          prompt: "Bound model calls",
          cwd: "/tmp",
          parentSessionId,
          parentBranchId,
          toolCallId,
          admission: {
            requestId: RequestId.make("model-limit-start"),
            runSpec: makeRunSpec({ persistence: "durable", parentToolCallId: toolCallId }),
          },
        }
        const child = yield* runner.createDurableAgentRunSession(input)
        const transaction = yield* makeStorageTransaction
        const held = yield* transaction(operations.reserveChildModelAttempt(child)).pipe(
          Effect.flip,
        )
        expect(held._tag).toBe("StorageError")
        const wrong = yield* operations
          .reserveChildModelAttempt({
            sessionId: parentSessionId,
            branchId: child.branchId,
          })
          .pipe(Effect.flip)
        expect(wrong._tag).toBe("StorageError")
        const results = yield* Effect.forEach(
          Array.from({ length: 33 }, (_, index) => index),
          () => operations.reserveChildModelAttempt(child),
          { concurrency: 8 },
        )
        expect(results.filter((value) => Option.isSome(value) && value.value)).toHaveLength(32)
        expect(results.filter((value) => Option.isSome(value) && !value.value)).toHaveLength(1)
        const branchId = BranchId.make("model-limit-second-branch")
        yield* branches.createBranch(
          new Branch({ id: branchId, sessionId: child.sessionId, createdAt: now }),
        )
        expect(
          yield* operations.reserveChildModelAttempt({ sessionId: child.sessionId, branchId }),
        ).toEqual(Option.some(false))
        const fresh = yield* Layer.build(Layer.fresh(SessionOperationStorage.Live))
        expect(
          yield* Context.get(fresh, SessionOperationStorage).reserveChildModelAttempt(child),
        ).toEqual(Option.some(false))
        yield* runner.start(input)
        const completed = yield* waitForCompletion(runner, {
          parentSessionId,
          parentBranchId,
          requestId: input.admission.requestId,
        })
        const receipt = yield* Effect.fromOption(completed.completion)
        expect(receipt.streamFailed).toBe(true)
        const events = yield* (yield* EventStorage).listEvents(child)
        expect(
          events.some(
            ({ event }) =>
              event._tag === "ErrorOccurred" &&
              event.error.includes("Child model-attempt budget exhausted"),
          ),
        ).toBe(true)
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(makeLiveAgentRunnerLayer(LanguageModelLayers.debug())),
      ),
  )

  it.scopedLive("stops a running child after 32 model attempts", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        ...Array.from({ length: 32 }, (_, index) =>
          toolCallStep("bash", { command: `step-${index}` }),
        ),
        textStep("Must not reach this response"),
      ])
      const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
      yield* Effect.gen(function* () {
        const parentSessionId = SessionId.make("running-limit-parent")
        const parentBranchId = BranchId.make("running-limit-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* (yield* SessionStorage).createSession(
          new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
        )
        yield* (yield* BranchStorage).createBranch(
          new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
        )
        const runner = yield* AgentRunnerService
        const requestId = RequestId.make("running-limit-start")
        const child = yield* runner.start({
          agent: { name: DEFAULT_AGENT_NAME },
          prompt: "Keep calling bash",
          cwd: "/tmp",
          parentSessionId,
          parentBranchId,
          requestId,
          toolCallId: ToolCallId.make("running-limit-tool"),
        })
        const completed = yield* waitForCompletion(
          runner,
          { parentSessionId, parentBranchId, requestId },
          3000,
        )
        const receipt = yield* Effect.fromOption(completed.completion)
        expect(receipt.streamFailed).toBe(true)
        expect(yield* controls.callCount).toBe(32)
        const messages = yield* (yield* MessageStorage).listMessages(child.branchId)
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
        const events = yield* (yield* EventStorage).listEvents(child)
        expect(
          events.some(
            ({ event }) =>
              event._tag === "ErrorOccurred" &&
              event.error.includes("Child model-attempt budget exhausted"),
          ),
        ).toBe(true)
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("does not create a durable child for a missing parent", () =>
    Effect.gen(function* () {
      const agent = builtinAgent
      const runner = yield* AgentRunnerService
      const parentSessionId = SessionId.make("missing-parent")
      const result = yield* runner.run({
        agent,
        prompt: "Must not start",
        parentSessionId,
        parentBranchId: BranchId.make("missing-branch"),
        cwd: "/tmp",
        runSpec: { persistence: "durable" },
      })
      expect(result._tag).toBe("error")
      if (result._tag === "error")
        expect(result.error).toContain("ancestry is missing or incomplete")
      expect(yield* (yield* RelationshipStorage).getChildSessions(parentSessionId)).toEqual([])
    }).pipe(
      Effect.timeout("4 seconds"),
      Effect.provide(makeLiveAgentRunnerLayer(LanguageModelLayers.debug())),
    ),
  )

  it.live("publishes spawn and complete events", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
        recorderLayer,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const recorder = yield* SequenceRecorder
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        yield* runner.run({
          agent: builtinAgent,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        const calls = yield* recorder.getCalls
        assertSequence(calls, [
          { service: "EventStore", method: "append", match: { _tag: "AgentRunSpawned" } },
          { service: "EventStore", method: "append", match: { _tag: "AgentRunSucceeded" } },
        ])
        const spawnRecord = calls.find((c) => {
          const event = Schema.decodeUnknownOption(AgentEvent)(c.args)
          return (
            c.service === "EventStore" &&
            c.method === "append" &&
            event._tag === "Some" &&
            event.value._tag === "AgentRunSpawned"
          )
        })
        expect(spawnRecord).toBeDefined()
        const spawnEvent = yield* Schema.decodeUnknownEffect(AgentEvent)(spawnRecord?.args)
        expect(spawnEvent._tag).toBe("AgentRunSpawned")
        if (spawnEvent._tag === "AgentRunSpawned") {
          const child = yield* sessions.getSession(spawnEvent.childSessionId)
          expect(child?.activeBranchId).toBe(spawnEvent.childBranchId)
        }
        // Verify enriched AgentRunSucceeded payload fields (args is the event object directly)
        const successEvent = calls
          .map((call) => ({
            call,
            event: Schema.decodeUnknownOption(AgentEvent)(call.args),
          }))
          .find(
            ({ call, event }) =>
              call.service === "EventStore" &&
              call.method === "append" &&
              Option.isSome(event) &&
              event.value._tag === "AgentRunSucceeded",
          )
        expect(successEvent).toBeDefined()
        if (Predicate.isUndefined(successEvent) || Option.isNone(successEvent.event)) return
        const event = successEvent.event.value
        if (event._tag !== "AgentRunSucceeded") return
        expect(event.preview).toBeDefined()
        expect(Predicate.isString(event.preview)).toBe(true)
        expect(event.savedPath).toBeDefined()
        expect(Predicate.isString(event.savedPath)).toBe(true)
        expect(event.savedPath).toContain("/tmp/gent/outputs/")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("rolls back durable child session when spawn event append fails", () =>
    Effect.gen(function* () {
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: () => Effect.fail(new EventStoreError({ message: "spawn append failed" })),
          deliver: () => Effect.void,
          publish: () => Effect.fail(new EventStoreError({ message: "spawn publish failed" })),
        }),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        failingPublisherLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-spawn-rollback"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-spawn-rollback"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "spawn rollback",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        expect(result._tag).toBe("error")
        const sessionsResult = yield* sessions.listSessions
        expect(
          sessionsResult.filter((candidate) => candidate.parentSessionId === session.id),
        ).toEqual([])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("propagates failures without retry (no maxAttempts)", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(() => Effect.fail(new AgentRunError({ message: "permanent failure" }))),
        recorderLayer,
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-noretr"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-noretr"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "fail test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        // Without retry, failure propagates as error result
        expect(result._tag).toBe("error")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("fails with timeout", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(() => Effect.never),
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({ timeoutMs: 5 }).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-timeout"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-timeout"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        return yield* runner.run({
          agent: builtinAgent,
          prompt: "timeout test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("error")
      if (result._tag === "error") {
        expect(result.error).toContain("timed out")
      }
    }),
  )
  it.live("ephemeral helper runs do not persist child sessions", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep("ephemeral response"),
      ])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        eventStoreLayer,
        eventPublisherLayer,
        testRegistryLayer,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(deps),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-ephemeral"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-ephemeral"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: builtinAgent,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        const sessionsResult = yield* sessions.listSessions
        return { runResult, sessionsResult }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      if (result.runResult._tag === "success") {
        expect(result.runResult.persistence).toBe("ephemeral")
        expect(result.runResult.text).toContain("ephemeral response")
      }
      expect(result.sessionsResult.map((session) => session.id)).toEqual([
        SessionId.make("parent-session-ephemeral"),
      ])
    }),
  )
  it.live("ephemeral helper runs mirror child tool events into the parent store", () =>
    Effect.gen(function* () {
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("bash", { command: "pwd" }, { toolCallId: ToolCallId.make("tc-ephemeral") }),
        textStep("tool finished"),
      ])
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        testRegistryLayer,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(deps),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-mirror"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-mirror"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: builtinAgent,
          prompt: "run helper with one tool",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        if (runResult._tag !== "success") {
          return { runResult, childTags: [] satisfies string[] }
        }
        const childEvents = yield* events.listEvents({ sessionId: session.id })
        return {
          runResult,
          childTags: childEvents.map((event) => event.event._tag),
        }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      expect(result.childTags).toContain("ToolCallStarted")
      expect(result.childTags).toContain("ToolCallSucceeded")
    }),
  )
  it.live("durable override persists child sessions for helper agents", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-durable"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-durable"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: builtinAgent,
          prompt: "persist this child",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        const sessionsResult = yield* sessions.listSessions
        return { runResult, sessionsResult }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      if (result.runResult._tag === "success") {
        expect(result.runResult.persistence).toBe("durable")
      }
      expect(result.sessionsResult).toHaveLength(2)
    }),
  )
  it.live("reasoning-only assistant response surfaces reasoning as text", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql()
      // Mock agent loop that writes a reasoning-only assistant message
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [Prompt.reasoningPart({ text: "I analyzed the repository" })],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-reasoning"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-reasoning"),
            sessionId: SessionId.make("parent-reasoning"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: builtinAgent,
          prompt: "analyze",
          parentSessionId: SessionId.make("parent-reasoning"),
          parentBranchId: BranchId.make("branch-reasoning"),
          cwd: "/tmp",
          runSpec: { persistence: "durable" },
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        expect(result.text).toBe("I analyzed the repository")
      }
    }),
  )
  it.live("mixed text+reasoning returns text, not reasoning", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql()
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                Prompt.reasoningPart({ text: "thinking step" }),
                Prompt.textPart({ text: "the actual answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-mixed"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-mixed"),
            sessionId: SessionId.make("parent-mixed"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: builtinAgent,
          prompt: "analyze",
          parentSessionId: SessionId.make("parent-mixed"),
          parentBranchId: BranchId.make("branch-mixed"),
          cwd: "/tmp",
          runSpec: { persistence: "durable" },
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        expect(result.text).toBe("the actual answer")
      }
    }),
  )
  it.live("agent run output is saved to /tmp/gent/outputs/", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql()
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                Prompt.reasoningPart({ text: "internal thinking" }),
                Prompt.textPart({ text: "visible answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-save"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-save"),
            sessionId: SessionId.make("parent-save"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: builtinAgent,
          prompt: "save test",
          parentSessionId: SessionId.make("parent-save"),
          parentBranchId: BranchId.make("branch-save"),
          cwd: "/tmp",
          runSpec: { persistence: "durable" },
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        const savedPath = result.savedPath
        expect(savedPath).toBeDefined()
        if (Predicate.isUndefined(savedPath)) return
        expect(savedPath).toContain("/tmp/gent/outputs/")
        expect(savedPath).toContain(`${DEFAULT_AGENT_NAME}_`)
        expect(savedPath).toEndWith(".md")
        // Verify file contents
        // oxlint-disable-next-line effect/noGlobals -- This test verifies the durable output file contents.
        const content = yield* Effect.promise(() => Bun.file(savedPath).text())
        expect(content).toContain("## Reasoning")
        expect(content).toContain("internal thinking")
        expect(content).toContain("## Response")
        expect(content).toContain("visible answer")
        // Cleanup
        // oxlint-disable-next-line effect/noGlobals -- This test removes the durable output fixture.
        yield* Effect.promise(() => Bun.file(savedPath).delete())
      }
    }),
  )
})
describe("agent runner metadata", () => {
  it.live("reports only complete branch stream totals and preserves known zero", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const sessionId = SessionId.make("usage-session")
      const now = dateFromMillis(1_767_225_600_000)
      yield* sessions.createSession(
        new Session({ id: sessionId, name: "Usage", createdAt: now, updatedAt: now }),
      )
      const known = { inputTokens: 10, outputTokens: 2 }
      const missing = Option.getOrUndefined(Option.none<never>())
      const cases = [
        { name: "empty", usages: [], expected: missing },
        {
          name: "zero",
          usages: [{ inputTokens: 0, outputTokens: 0 }],
          expected: { input: 0, output: 0 },
        },
        { name: "known", usages: [known, known], expected: { input: 20, output: 4 } },
        { name: "missing-last", usages: [known, missing], expected: missing },
        { name: "missing-first", usages: [missing, known], expected: missing },
        {
          name: "negative",
          usages: [known, { inputTokens: -1, outputTokens: 2 }],
          expected: missing,
        },
        { name: "fraction", usages: [{ inputTokens: 1, outputTokens: 0.5 }], expected: missing },
        {
          name: "overflow",
          usages: [{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 }, known],
          expected: missing,
        },
      ]
      // All branches share a session. Prior branch receipts must not enter the next total.
      for (const sample of cases) {
        const branchId = BranchId.make(`usage-${sample.name}`)
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
        for (const usage of sample.usages) {
          yield* events.appendEvent(StreamEnded.make({ sessionId, branchId, usage }))
        }
        const result = yield* loadAgentRunSuccessData({
          sessionId,
          branchId,
          agentName: DEFAULT_AGENT_NAME,
          persistence: "durable",
        })
        expect(result.success.usage).toEqual(sample.expected)
      }
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("keeps object tool arguments and ignores non-record inputs", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const events = yield* EventStorage
      const sessionId = SessionId.make("metadata-session")
      const branchId = BranchId.make("metadata-branch")
      const now = dateFromMillis(1_767_225_600_000)
      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "Metadata",
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("metadata-message"),
          sessionId,
          branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text: "metadata result" })],
          createdAt: now,
        }),
      )

      const started = [
        ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("metadata-scalar"),
          toolName: "scalar-tool",
          input: "scalar input",
        }),
        ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("metadata-array"),
          toolName: "array-tool",
          input: ["array", 1],
        }),
        ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("metadata-object"),
          toolName: "object-tool",
          input: { path: "src", limit: 2 },
        }),
      ]
      for (const event of started) yield* events.appendEvent(event)
      const succeeded = [
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("metadata-scalar"),
          toolName: "scalar-tool",
        }),
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("metadata-array"),
          toolName: "array-tool",
        }),
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("metadata-object"),
          toolName: "object-tool",
        }),
      ]
      for (const event of succeeded) yield* events.appendEvent(event)

      const result = yield* loadAgentRunSuccessData({
        branchId,
        sessionId,
        agentName: DEFAULT_AGENT_NAME,
        persistence: "ephemeral",
      })
      expect(result.success.toolCalls).toEqual([
        { toolName: "scalar-tool", args: {}, isError: false },
        { toolName: "array-tool", args: {}, isError: false },
        { toolName: "object-tool", args: { path: "src", limit: 2 }, isError: false },
      ])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
})
// ============================================================================
// Session depth guard
// ============================================================================
describe("session depth guard", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, SessionStorage | BranchStorage | RelationshipStorage>,
  ) => effect.pipe(Effect.timeout("4 seconds"), Effect.provide(SqliteStorage.TestWithSql()))
  const makeSession = (id: string, parentSessionId?: string) => {
    const fields = {
      id: SessionId.make(id),
      name: `session-${id}`,
      createdAt: dateFromMillis(1_767_225_600_000),
      updatedAt: dateFromMillis(1_767_225_600_000),
    }
    if (!Predicate.isUndefined(parentSessionId)) {
      Object.assign(fields, {
        parentSessionId: SessionId.make(parentSessionId),
        parentBranchId: BranchId.make(`branch-${parentSessionId}`),
      })
    }
    return new Session(fields)
  }
  const makeBranch = (sessionId: string) =>
    new Branch({
      id: BranchId.make(`branch-${sessionId}`),
      sessionId: SessionId.make(sessionId),
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const buildSessionChain = (depth: number) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(makeSession("s0"))
      yield* branches.createBranch(makeBranch("s0"))
      for (let i = 1; i <= depth; i++) {
        yield* sessions.createSession(makeSession(`s${i}`, `s${i - 1}`))
        yield* branches.createBranch(makeBranch(`s${i}`))
      }
    })
  it.live("root session has depth 0", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        expect(yield* getSessionDepth(SessionId.make("root"))).toBe(0)
      }),
    ),
  )
  it.live("child of root has depth 1", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        yield* sessions.createSession(makeSession("child", "root"))
        yield* branches.createBranch(makeBranch("child"))
        expect(yield* getSessionDepth(SessionId.make("child"))).toBe(1)
      }),
    ),
  )
  it.live("grandchild has depth 2", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        yield* sessions.createSession(makeSession("child", "root"))
        yield* branches.createBranch(makeBranch("child"))
        yield* sessions.createSession(makeSession("grandchild", "child"))
        yield* branches.createBranch(makeBranch("grandchild"))
        expect(yield* getSessionDepth(SessionId.make("grandchild"))).toBe(2)
      }),
    ),
  )
  it.live("chain at max depth reports correct depth", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH)
        const deepest = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        expect(yield* getSessionDepth(deepest)).toBe(DEFAULT_MAX_AGENT_RUN_DEPTH)
      }),
    ),
  )
  it.live("parent at max depth blocks child spawn", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH)
        const parentId = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        const parentDepth = yield* getSessionDepth(parentId)
        expect(parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    ),
  )
  it.live("parent below max depth allows child spawn", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH - 1)
        const parentId = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}`)
        const parentDepth = yield* getSessionDepth(parentId)
        expect(parentDepth < DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    ),
  )
  it.live("missing ancestry cannot grant root-level child admission", () =>
    run(
      Effect.gen(function* () {
        const error = yield* getSessionDepth(SessionId.make("nonexistent")).pipe(Effect.flip)
        expect(error._tag).toBe("AgentRunError")
        expect(error.message).toContain("ancestry is missing or incomplete")
      }),
    ),
  )
})
describe("ephemeral service propagation", () => {
  const makeEphemeralLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
    const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
    const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      eventPublisherLayer,
      testRegistryLayer,
      providerLayer,
      ModelResolver.fromLanguageModel(providerLayer),
      sessionRuntimeStub(),
      ephemeralParentDeps,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(ChildCompletionDelivery.Silent),
      Layer.provide(deps),
    )
    return Layer.mergeAll(deps, runnerLayer)
  }
  const setupParentSession = (id: SessionId) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const now = dateFromMillis(1_767_225_600_000)
      yield* sessions.createSession(
        new Session({ id, name: "Parent", createdAt: now, updatedAt: now }),
      )
      yield* branches.createBranch(
        new Branch({ id: BranchId.make(`${id}-branch`), sessionId: id, createdAt: now }),
      )
    })
  it.live("ephemeral publisher suppresses duplicate committed delivery", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("unused")])
      const parentDeps = Layer.mergeAll(
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        testRegistryLayer,
        ephemeralParentDeps,
        BunFileSystem.layer,
        BunPath.layer,
      )
      const layer = Layer.unwrap(
        Effect.gen(function* () {
          const extensionRegistry = yield* ExtensionRegistry
          const makeEphemeralAgentRootLayer = yield* makeEphemeralAgentRootLayerFactory
          return makeEphemeralAgentRootLayer({
            config: { baseSections: [] },
            extensionRegistry,
          })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(parentDeps)),
      )
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        const events = yield* EventStore
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sessionId = SessionId.make("ephemeral-duplicate-delivery")
        const branchId = BranchId.make("ephemeral-duplicate-delivery-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({ id: sessionId, name: "Child", createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
        const envelope = yield* publisher.append(
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("ephemeral-duplicate-tool-call"),
            toolName: "bash",
          }),
        )
        yield* publisher.deliver(envelope)
        const duplicate = yield* Effect.forkScoped(
          events
            .subscribe({ sessionId, branchId, after: envelope.id })
            .pipe(Stream.take(1), Stream.runCollect),
        )
        yield* publisher.deliver(envelope)
        const deliveredAgain = yield* Fiber.join(duplicate).pipe(Effect.timeoutOption("25 millis"))
        expect(deliveredAgain._tag).toBe("None")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.scoped, Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("ephemeral agent writes to ephemeral storage, not parent", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep("ephemeral text output"),
      ])
      const layer = makeEphemeralLayer(providerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const runner = yield* AgentRunnerService
        yield* setupParentSession(SessionId.make("parent-svc-prop"))
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "test service propagation",
          parentSessionId: SessionId.make("parent-svc-prop"),
          parentBranchId: BranchId.make("parent-svc-prop-branch"),
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("ephemeral text output")
        }
        // Parent storage should only have the parent session
        const sessionsResult = yield* sessions.listSessions
        expect(sessionsResult.map((s) => s.id)).toEqual([SessionId.make("parent-svc-prop")])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("ephemeral agent auto-approves interactions", () =>
    Effect.gen(function* () {
      const approveTool = tool({
        id: "approve_test",
        description: "Tests approval",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ approved: Schema.Boolean }),
        execute: Effect.fn("approve_test")(function* () {
          const ctx = yield* ExtensionContext
          const decision = yield* ctx.Interaction.approve({
            text: "approve this?",
            metadata: { type: "prompt", mode: "confirm" },
          })
          return { approved: decision.approved }
        }),
      })
      const toolRegistry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("agents") },
            scope: "builtin",
            sourcePath: "test",
            contributions: {
              agents: AllBuiltinAgents,
              tools: [approveTool],
            },
          },
        ]),
      )
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("approve_test", { text: "test" }),
        textStep("approved"),
      ])
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        toolRegistry,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(deps),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const runner = yield* AgentRunnerService
        yield* setupParentSession(SessionId.make("parent-approve"))
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "test auto-approve",
          parentSessionId: SessionId.make("parent-approve"),
          parentBranchId: BranchId.make("parent-approve-branch"),
          cwd: process.cwd(),
          runSpec: {
            persistence: "ephemeral",
            overrides: { allowedTools: ["approve_test"] },
          },
        })
        // Should succeed — approval was auto-resolved, tool ran, text followed
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("approved")
        }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("ephemeral agent rebuilds resource services without rerunning process lifecycle", () =>
    Effect.gen(function* () {
      let starts = 0
      class ProbeService extends Context.Service<
        ProbeService,
        { readonly read: Effect.Effect<string> }
      >()("@gent/core/tests/runtime/agent-runner.test/ProbeService") {}
      const probeTool = tool({
        id: "probe_resource",
        description: "Reads a resource-backed service",
        params: Schema.Struct({}),
        output: Schema.Struct({ value: Schema.String }),
        execute: Effect.fn("probe_resource")(function* () {
          const probe = yield* ProbeService
          return { value: yield* probe.read }
        }),
      })
      const registryLayer = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("agents") },
            scope: "builtin",
            sourcePath: "test",
            contributions: {
              agents: AllBuiltinAgents,
            },
          },
          {
            manifest: { id: ExtensionId.make("resource-probe") },
            scope: "builtin",
            sourcePath: "test",
            contributions: {
              resources: [
                defineResource({
                  id: "test/agent-runner/resource-probe",
                  scope: "process",
                  layer: Layer.succeed(
                    ProbeService,
                    ProbeService.of({ read: Effect.succeed("service-ok") }),
                  ),
                  start: Effect.sync(() => {
                    starts += 1
                  }),
                }),
              ],
              tools: [probeTool],
            },
          },
        ]),
      )
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("probe_resource", {}),
        textStep("done"),
      ])
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        registryLayer,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(deps),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const runner = yield* AgentRunnerService
        yield* setupParentSession(SessionId.make("parent-resource-probe"))
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "test resource service",
          parentSessionId: SessionId.make("parent-resource-probe"),
          parentBranchId: BranchId.make("parent-resource-probe-branch"),
          cwd: process.cwd(),
          runSpec: {
            persistence: "ephemeral",
            overrides: { allowedTools: ["probe_resource"] },
          },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("done")
        }
        expect(starts).toBe(0)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )
})
