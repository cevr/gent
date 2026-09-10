import { describe, expect, it } from "effect-bun-test"
import { DateTime, Effect, Layer, Ref } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { AgentDefinition, DEFAULT_AGENT_NAME, DEFAULT_MODEL_ID } from "../../src/domain/agent"
import { MessageId } from "../../src/domain/ids"
import { Message } from "../../src/domain/message"
import { ModelId } from "../../src/domain/model"
import { EventPublisher } from "../../src/domain/event-publisher"
import { EventStore } from "../../src/domain/event"
import { CurrentResolveModelAssertion, ModelResolver } from "../../src/providers/model-resolver"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent/agent-loop.session-governance"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { SessionCommands } from "../../src/server/session-commands"
import { MessageStorage } from "../../src/storage/message-storage"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { sessionRuntimeLayer } from "./session-commands/helpers"

/**
 * Branch summarization runs on a model. Core must not pin a vendor SKU for
 * that: it asks the registry which model this install is configured to use.
 */
describe("branch summarization model selection", () => {
  const registryWithDefaultAgent = (model: ModelId) =>
    ExtensionRegistry.fromResolved({
      ...resolveExtensions([]),
      agents: new Map([
        [DEFAULT_AGENT_NAME, new AgentDefinition({ name: DEFAULT_AGENT_NAME, model })],
      ]),
    })

  const makeLayer = (
    registry: Layer.Layer<ExtensionRegistry>,
    requested: Ref.Ref<ReadonlyArray<string>>,
  ) => {
    const storageLayer = SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
      Layer.provide(GentPlatform.Test()),
    )
    const deps = Layer.mergeAll(
      storageLayer,
      sessionRuntimeLayer(),
      EventStore.Memory,
      EventPublisher.Test(),
      AgentLoopSessionGovernance.Live,
      LanguageModelLayers.debug(),
      // The assertion hook is read when the resolver layer is BUILT, so it has
      // to be provided to that layer -- a sibling in `mergeAll` is not in scope
      // yet and the resolver would silently see the `undefined` default.
      ModelResolver.fromLanguageModel(LanguageModelLayers.debug()).pipe(
        Layer.provide(
          Layer.succeed(CurrentResolveModelAssertion, (request) =>
            Ref.update(requested, (seen) => [...seen, String(request.modelId)]),
          ),
        ),
      ),
      GentPlatform.Test(),
      registry,
    )
    return Layer.provideMerge(
      SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
      deps,
    )
  }

  const summarizeAcrossBranches = Effect.fn("summarizeAcrossBranches")(function* () {
    const commands = yield* SessionCommands
    const created = yield* commands.createSession({ cwd: "/tmp/summary" })
    const target = yield* commands.createBranch({
      sessionId: created.sessionId,
      name: "target",
    })
    // A branch with no messages summarizes to "" before reaching the model,
    // so seed one directly in storage to force model resolution.
    const messageStorage = yield* MessageStorage
    const platform = yield* GentPlatform
    yield* messageStorage.createMessage(
      Message.cases.regular.make({
        id: MessageId.make(yield* platform.randomId),
        sessionId: created.sessionId,
        branchId: created.branchId,
        role: "user",
        parts: [Prompt.textPart({ text: "something worth summarizing" })],
        createdAt: yield* DateTime.nowAsDate,
      }),
    )
    yield* commands.switchBranch({
      sessionId: created.sessionId,
      fromBranchId: created.branchId,
      toBranchId: target.branchId,
      summarize: true,
    })
  })

  it.live("summarizes on the registered default agent's model", () => {
    const model = ModelId.make("openai/gpt-5.6-luna")
    return Effect.gen(function* () {
      const requested = yield* Ref.make<ReadonlyArray<string>>([])
      yield* summarizeAcrossBranches().pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(makeLayer(registryWithDefaultAgent(model), requested)),
      )
      expect(yield* Ref.get(requested)).toContain(model)
    }).pipe(Effect.timeout("4 seconds"))
  })

  it.live("falls back to the default model when no agent is registered", () =>
    Effect.gen(function* () {
      const requested = yield* Ref.make<ReadonlyArray<string>>([])
      yield* summarizeAcrossBranches().pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(makeLayer(ExtensionRegistry.Test(), requested)),
      )
      expect(yield* Ref.get(requested)).toContain(DEFAULT_MODEL_ID)
    }).pipe(Effect.timeout("4 seconds")),
  )
})
