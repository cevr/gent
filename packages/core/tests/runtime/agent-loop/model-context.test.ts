import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Predicate, Stream, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiModel from "effect/unstable/ai/Model"
import { BunServices } from "@effect/platform-bun"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import { Auth } from "@gent/core-internal/domain/auth"
import type { ModelDriverContribution } from "@gent/core-internal/domain/driver"
import { Model, ModelId, ProviderId } from "@gent/core-internal/domain/model"
import { finishPart, LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { multiToolCallStep, textStep } from "@gent/core-internal/debug/provider"
import { tool } from "@gent/core/extensions/api"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { AgentLoopTestActor } from "../../../src/runtime/agent/agent-loop.actor"
import { ConfigService } from "../../../src/runtime/config-service"
import { EventPublisherLive } from "../../../src/domain/event-publisher"
import { EventStore } from "../../../src/domain/event"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import { ModelResolver } from "../../../src/providers/model-resolver"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ApprovalService } from "../../../src/runtime/approval-service"
import { SqliteStorage } from "../../../src/storage/sqlite-storage"
import { ExtensionId } from "../../../src/domain/ids"
import { AllBuiltinAgents } from "../../../../extensions/tests/helpers/builtin-agents"
import { MODEL_OUTPUT_RESERVE_TOKENS } from "../../../src/runtime/model-context"
import { makeMessage, makeAgentLoopService, makeLayer, runAgentLoop } from "./helpers"

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content.filter(Schema.is(Prompt.TextPart)).map((part) => part.text)
    })
    .join("\n")

describe("native model context projection", () => {
  it.live("truncates the provider prompt while preserving durable history", () => {
    const oldMarker = "old-context-marker"
    let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()
    const providerLayer = LanguageModelLayers.testStream((options) => {
      capturedPrompt = Option.some(Prompt.make(options.prompt))
      return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
    })
    const sessionId = SessionId.make("model-context-session")
    const branchId = BranchId.make("model-context-branch")

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const messageStorage = yield* MessageStorage
        yield* messageStorage.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("old-context-message"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: `${oldMarker} ${"x".repeat(520_000)}` })],
            createdAt: dateFromMillis(1),
          }),
        )

        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fresh request"))

        expect(Option.isSome(capturedPrompt)).toBe(true)
        if (Option.isNone(capturedPrompt)) return yield* Effect.die("provider did not run")
        const submittedText = promptText(capturedPrompt.value)
        expect(submittedText).toContain("fresh request")
        expect(submittedText).not.toContain(oldMarker)

        const durableMessages = yield* messageStorage.listMessages(branchId)
        expect(
          durableMessages.some((message) =>
            message.parts.some((part) => part.type === "text" && part.text.includes(oldMarker)),
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("5 seconds"))
  })

  it.live("keeps parallel native tool calls and results paired", () => {
    const readTool = tool({
      id: "read",
      description: "Read a test path.",
      params: Schema.Struct({ path: Schema.String }),
      output: Schema.String,
      execute: (input) => Effect.succeed(input.path),
    })
    let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()

    return Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        multiToolCallStep(
          { toolName: "read", input: { path: "first.txt" }, toolCallId: ToolCallId.make("pair-1") },
          {
            toolName: "read",
            input: { path: "second.txt" },
            toolCallId: ToolCallId.make("pair-2"),
          },
        ),
        {
          ...textStep("done"),
          assertOptions: (options) => {
            capturedPrompt = Option.some(Prompt.make(options.prompt))
          },
        },
      ])
      const run = Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const sessionId = SessionId.make("model-context-tool-session")
        const branchId = BranchId.make("model-context-tool-branch")
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "run parallel tools"))
        yield* controls.assertDone

        expect(Option.isSome(capturedPrompt)).toBe(true)
        if (Option.isNone(capturedPrompt)) return yield* Effect.die("second provider call missing")
        const messages = capturedPrompt.value.content
        const callIds = messages.flatMap((message) => {
          if (message.role !== "assistant" || Predicate.isString(message.content)) return []
          return message.content.filter(Schema.is(Prompt.ToolCallPart)).map((part) => part.id)
        })
        const resultIds = messages.flatMap((message) => {
          if (message.role !== "tool" || Predicate.isString(message.content)) return []
          return message.content.filter(Schema.is(Prompt.ToolResultPart)).map((part) => part.id)
        })
        expect(callIds).toEqual([ToolCallId.make("pair-1"), ToolCallId.make("pair-2")])
        expect(resultIds).toEqual([ToolCallId.make("pair-1"), ToolCallId.make("pair-2")])
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The provider layer is created by this test.
        Effect.provide(makeLayer(providerLayer, [readTool])),
      )
      yield* run
    }).pipe(Effect.timeout("5 seconds"))
  })

  it.live("passes the output reserve to the resolved provider driver", () => {
    const modelId = ModelId.make("context-driver/model")
    let observedMaxTokens = Option.none<number>()
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
    )
    const driver: ModelDriverContribution = {
      id: "context-driver",
      name: "Context driver",
      resolveModel: (_modelName, _authInfo, hints) =>
        Effect.sync(() => {
          const maxTokens = Option.fromUndefinedOr(hints).pipe(
            Option.flatMap((value) => Option.fromUndefinedOr(value.maxTokens)),
          )
          if (Option.isSome(maxTokens)) observedMaxTokens = maxTokens
          return AiModel.make("context-driver", "model", providerLayer)
        }),
    }
    const resolved = resolveExtensions([
      {
        manifest: { id: ExtensionId.make("model-context-driver") },
        scope: "builtin",
        sourcePath: "test",
        contributions: { agents: AllBuiltinAgents, modelDrivers: [driver] },
      },
    ])
    const extensionRegistry = ExtensionRegistry.fromResolved(resolved)
    const driverRegistry = DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    })
    const modelResolver = ModelResolver.Live.pipe(
      Layer.provide(Layer.mergeAll(Auth.Test(), driverRegistry)),
    )
    const deps = Layer.mergeAll(
      SqliteStorage.TestWithSql(),
      extensionRegistry,
      driverRegistry,
      RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      EventStore.Memory,
      ToolRunner.Test(),
      ApprovalService.Test(),
      BunServices.layer,
      ModelRegistry.Test([
        Model.make({
          id: modelId,
          name: "Context model",
          provider: ProviderId.make("context-driver"),
          contextLength: 128_000,
        }),
      ]),
      GentPlatform.Test(),
      modelResolver,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
      ),
    )

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(
          agentLoop,
          makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "request provider budget",
          ),
          { runSpec: { overrides: { modelId } } },
        )
        expect(observedMaxTokens).toEqual(Option.some(MODEL_OUTPUT_RESERVE_TOKENS))
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
  })
})
