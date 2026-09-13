import { describe, expect, it } from "effect-bun-test"
import { Cause, Context, Effect, Exit, Layer, Option, Predicate, Schema, Scope } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { AgentName } from "../../../src/domain/agent"
import { LoadedArtifactIdentity, type LoadedExtension } from "../../../src/domain/extension"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolId,
} from "../../../src/domain/ids"
import { Message, dateFromMillis } from "../../../src/domain/message"
import {
  makeToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../../../src/domain/tool-binding"
import { MessageReceived, ToolCallSucceeded } from "../../../src/domain/event"
import { EventPublisher } from "../../../src/domain/event-publisher"
import {
  ExtensionContext,
  ExtensionHost,
  defineExtension,
  defineResource,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { MessageStorage } from "../../../src/storage/message-storage"
import { makeStorageTransaction, SqliteStorage } from "../../../src/storage/sqlite-storage"
import { ToolCallBindingStorage } from "../../../src/storage/tool-call-binding-storage"
import { ensureStorageParents } from "../../../src/test-utils"
import {
  findPersistedToolResults,
  persistAssistantPartsWithBindings,
  ToolResultReplayError,
} from "../../../src/runtime/agent/turn-persistence"
import { ToolRunner, type ResolvedToolCapability } from "../../../src/runtime/agent/tool-runner"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import {
  ProcessLocalToolReplay,
  processLocalReplayBindingKey,
} from "../../../src/runtime/agent/process-local-tool-replay"
import { EventStorage } from "../../../src/storage/event-storage"
import { encodeToolOutput } from "../../../src/domain/tool-output"
import {
  captureCurrentToolBinding,
  innerOperationBindingIdentity,
  resolveReplayToolBinding,
  resolveStoredToolBinding,
} from "../../../src/runtime/agent/tool-binding-resolution"
import { createE2ELayer } from "../../../src/test-utils/e2e-layer"
import { LanguageModelLayers } from "../../../src/test-utils/language-model"
import { SessionProfileCache } from "../../../src/runtime/session-profile"

class ReplayResource extends Context.Service<ReplayResource, { readonly value: string }>()(
  "@gent/core/tests/runtime/agent-loop/tool-binding-replay.test/ReplayResource",
) {}

const replayCases = [
  {
    name: "same-process capability",
    durable: false,
    saved: false,
    local: true,
    changed: false,
    reason: "",
  },
  {
    name: "missing process binding",
    durable: false,
    saved: false,
    local: false,
    changed: false,
    reason: "MissingBinding",
  },
  {
    name: "matching durable identity",
    durable: true,
    saved: true,
    local: false,
    changed: false,
    reason: "",
  },
  {
    name: "absent durable row with local identity",
    durable: true,
    saved: false,
    local: true,
    changed: false,
    reason: "MissingBinding",
  },
  {
    name: "changed durable source",
    durable: true,
    saved: true,
    local: true,
    changed: true,
    reason: "SourceMismatch",
  },
]

const makeTool = (): ToolCapability =>
  tool({
    id: "@test/replay-tool",
    description: "Replay test tool",
    params: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    execute: (_params: { readonly value: string }) =>
      Effect.gen(function* () {
        yield* ExtensionContext
        return "ok"
      }),
  })

const makeExtension = (toolCapability: ToolCapability): LoadedExtension => ({
  manifest: { id: ExtensionId.make("@test/replay-extension") },
  scope: "builtin",
  sourcePath: "/test/replay-extension",
  artifactIdentity: LoadedArtifactIdentity.make("replay-artifact-1"),
  contributions: { tools: [toolCapability] },
})

const makeBinding = () =>
  makeToolBindingIdentity({
    toolId: ToolId.make("@test/replay-tool"),
    extensionId: ExtensionId.make("@test/replay-extension"),
    source: ToolBindingSource.cases.Static.make({
      sourceRevision: ToolSourceRevision.make("source/legacy"),
    }),
    schemaRevision: ToolSchemaRevision.make("schema/legacy"),
  })

describe("tool binding replay", () => {
  it.scopedLive(
    "validates an inner operation binding without an assistant tool-call storage row",
    () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const layer = Layer.mergeAll(
          ExtensionRegistry.fromResolved(resolveExtensions([makeExtension(capability)])),
          ToolRunner.Live,
          GentPlatform.Test(),
        )
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          const sessionId = SessionId.make("inner-operation-session")
          const current = yield* captureCurrentToolBinding({
            sessionId,
            toolName: "@test/replay-tool",
          })
          if (Option.isNone(current) || Predicate.isUndefined(current.value.binding))
            return yield* Effect.die("Missing fixture binding")
          const binding = current.value.binding
          const address = {
            sessionId,
            assistantMessageId: MessageId.make("outer-cell-message"),
            toolCallId: ToolCallId.make("inner-operation-call"),
          }
          const resolved = yield* resolveStoredToolBinding({ ...address, binding })
          expect(resolved.capability).toBe(capability)
          const changed = yield* resolveStoredToolBinding({
            ...address,
            binding: makeToolBindingIdentity({
              ...binding,
              source: ToolBindingSource.cases.Static.make({
                sourceRevision: ToolSourceRevision.make("changed-source"),
              }),
            }),
          }).pipe(Effect.flip)
          expect(changed.reason).toBe("SourceMismatch")
          expect(changed.toolCallId).toBe(address.toolCallId)
        }).pipe(Effect.provideContext(context))
      }),
  )

  for (const scenario of replayCases) {
    it.scopedLive(`resolves ${scenario.name} through real storage and tool capture`, () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const declared = defineExtension({
          id: "@test/replay-extension",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", capability)
            yield* host.register(
              "resource",
              defineResource({
                id: "test/replay-policy-resource",
                tag: ReplayResource,
                scope: "process",
                layer: Layer.succeed(ReplayResource, ReplayResource.of({ value: "live" })),
              }),
            )
          }),
        })
        let extension = declared
        if (scenario.durable) {
          extension = {
            ...declared,
            artifactIdentity: LoadedArtifactIdentity.make("replay-artifact-1"),
          }
        }
        const layer = Layer.merge(
          createE2ELayer({
            agents: [],
            extensionInputs: [extension],
            providerLayer: LanguageModelLayers.debug(),
          }),
          ProcessLocalToolReplay.Live,
        )
        yield* Effect.gen(function* () {
          const sessionId = SessionId.make("replay-policy-session")
          const branchId = BranchId.make("replay-policy-branch")
          const assistantMessageId = MessageId.make("replay-policy-assistant")
          const toolCallId = ToolCallId.make("replay-policy-call")
          const address = { sessionId, branchId, assistantMessageId, toolCallId }
          const toolCall = Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "input" },
            providerExecuted: false,
          })
          yield* ensureStorageParents({ sessionId, branchId })
          const messages = yield* MessageStorage
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              parts: [toolCall],
              createdAt: dateFromMillis(0),
            }),
          )
          const cache = yield* SessionProfileCache
          const profile = yield* cache.resolve("/tmp")
          const current = yield* captureCurrentToolBinding({
            sessionId,
            toolName: toolCall.name,
          })
          if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
          const replay = yield* ProcessLocalToolReplay
          const key = processLocalReplayBindingKey(address)
          if (scenario.local) {
            yield* replay.setBinding(key, { entry: current.value })
          }
          if (scenario.saved) {
            const storage = yield* ToolCallBindingStorage
            let binding = current.value.binding
            if (Predicate.isUndefined(binding))
              return yield* Effect.die("Expected durable identity")
            if (scenario.changed)
              binding = makeToolBindingIdentity({
                ...binding,
                source: ToolBindingSource.cases.Static.make({
                  sourceRevision: ToolSourceRevision.make("old-source"),
                }),
              })
            yield* storage.save({ ...address, binding })
          }
          const result = yield* resolveReplayToolBinding({
            ...address,
            toolCall,
            generationId: profile.generationId,
          }).pipe(Effect.exit)
          if (Exit.isSuccess(result)) {
            expect(scenario.reason).toBe("")
            expect(result.value.capability).toBe(capability)
            return
          }
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "ToolBindingReplayError",
            reason: scenario.reason,
          })
          expect(Option.isNone(yield* replay.getBinding(key))).toBe(true)
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- Each scenario owns a production test root with its authored extension.
          Effect.provide(layer),
        )
      }).pipe(Effect.timeout("5 seconds")),
    )
  }

  it.scopedLive("resumes a process-local binding only inside its live process", () =>
    Effect.gen(function* () {
      const capability = makeTool()
      const extension = defineExtension({
        id: "@test/replay-extension",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool", capability)
        }),
      })
      const layer = Layer.merge(
        createE2ELayer({
          agents: [],
          extensionInputs: [extension],
          providerLayer: LanguageModelLayers.debug(),
        }),
        ProcessLocalToolReplay.Live,
      )
      yield* Effect.gen(function* () {
        const sessionId = SessionId.make("process-local-session")
        const address = {
          sessionId,
          assistantMessageId: MessageId.make("process-local-assistant"),
          toolCallId: ToolCallId.make("process-local-call"),
        }
        const cache = yield* SessionProfileCache
        const profile = yield* cache.resolve("/tmp")
        const generationId = profile.generationId
        const current = yield* captureCurrentToolBinding({
          sessionId,
          toolName: "@test/replay-tool",
        })
        if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
        // A source-loaded extension has no build artifact, so no durable identity.
        expect(current.value.binding).toBeUndefined()
        expect(Option.isNone(yield* innerOperationBindingIdentity(current.value))).toBe(true)
        const identity = yield* innerOperationBindingIdentity(current.value, generationId)
        if (Option.isNone(identity)) return yield* Effect.die("Expected process-local identity")
        expect(identity.value.source).toEqual({
          _tag: "ProcessLocal",
          sourceRevision: ToolSourceRevision.make(`process:${generationId}`),
        })

        const live = yield* resolveStoredToolBinding({
          ...address,
          binding: identity.value,
          generationId,
        })
        expect(live.capability).toBe(capability)

        const retired = yield* resolveStoredToolBinding({
          ...address,
          binding: makeToolBindingIdentity({
            ...identity.value,
            source: ToolBindingSource.cases.ProcessLocal.make({
              sourceRevision: ToolSourceRevision.make("process:retired-process"),
            }),
          }),
          generationId,
        }).pipe(Effect.flip)
        expect(retired).toMatchObject({ _tag: "ToolBindingReplayError", reason: "SourceMismatch" })

        const withoutProcess = yield* resolveStoredToolBinding({
          ...address,
          binding: identity.value,
        }).pipe(Effect.flip)
        expect(withoutProcess).toMatchObject({
          _tag: "ToolBindingReplayError",
          reason: "SourceMismatch",
        })
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The scenario owns a production test root with its authored extension.
        Effect.provide(layer),
      )
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("does not backfill a binding on an existing assistant message", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-existing-session")
      const branchId = BranchId.make("binding-replay-existing-branch")
      const messageId = MessageId.make("binding-replay-existing-message")
      const toolCallId = ToolCallId.make("binding-replay-existing-call")
      yield* ensureStorageParents({ sessionId, branchId })
      const messages = yield* MessageStorage
      const bindingStorage = yield* ToolCallBindingStorage
      const storageTransaction = yield* makeStorageTransaction
      const toolCallPart = Prompt.toolCallPart({
        id: toolCallId,
        name: "@test/replay-tool",
        params: { value: "legacy" },
        providerExecuted: false,
      })
      const message = Message.cases.regular.make({
        id: messageId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [toolCallPart],
        createdAt: dateFromMillis(1_767_225_600_000),
      })
      yield* messages.createMessage(message)
      const capability = makeTool()
      const entry = {
        extensionId: ExtensionId.make("@test/replay-extension"),
        capability,
        origin: "static",
        binding: makeBinding(),
      } satisfies ResolvedToolCapability

      yield* persistAssistantPartsWithBindings({
        sessionId,
        branchId,
        messageId,
        parts: [toolCallPart],
        toolBindings: new Map([["@test/replay-tool", entry]]),
        storageTransaction,
        agentName: AgentName.make("cowork"),
      })

      expect(
        yield* bindingStorage.get({
          sessionId,
          branchId,
          assistantMessageId: messageId,
          toolCallId,
        }),
      ).toBeUndefined()
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("replays the structured terminal result for the current assistant only", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-session")
      const branchId = BranchId.make("binding-replay-result-branch")
      const oldAssistantId = MessageId.make("binding-replay-result-old-assistant")
      const assistantId = MessageId.make("binding-replay-result-assistant")
      const toolCallId = ToolCallId.make("binding-replay-result-call")
      const toolCall = Prompt.toolCallPart({
        id: toolCallId,
        name: "@test/replay-tool",
        params: { value: "current" },
        providerExecuted: false,
      })
      yield* ensureStorageParents({ sessionId, branchId })
      const makeAssistant = (id: MessageId, value: string) =>
        Message.cases.regular.make({
          id,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "@test/replay-tool",
              params: { value },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(oldAssistantId, "old") }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "old display",
          resultJson: encodeToolOutput({ value: "old" }),
        }),
      )
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(assistantId, "current") }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "current display",
          resultJson: encodeToolOutput({ value: "current" }),
        }),
      )
      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: assistantId,
        toolCalls: [toolCall],
      })
      expect(results.get(toolCallId)?.result).toEqual({ value: "current" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("does not replay a terminal result without its assistant anchor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-no-anchor-session")
      const branchId = BranchId.make("binding-replay-result-no-anchor-branch")
      const toolCallId = ToolCallId.make("binding-replay-result-no-anchor-call")
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "unanchored display",
          resultJson: encodeToolOutput({ value: "unanchored" }),
        }),
      )

      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("binding-replay-result-missing-assistant"),
        toolCalls: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "missing" },
            providerExecuted: false,
          }),
        ],
      })
      expect(results.size).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("stops result replay at the next assistant message", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-window-session")
      const branchId = BranchId.make("binding-replay-result-window-branch")
      const assistantId = MessageId.make("binding-replay-result-window-assistant")
      const laterAssistantId = MessageId.make("binding-replay-result-window-later")
      const toolCallId = ToolCallId.make("binding-replay-result-window-call")
      const makeAssistant = (id: MessageId) =>
        Message.cases.regular.make({
          id,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "@test/replay-tool",
              params: { value: id },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(MessageReceived.make({ message: makeAssistant(assistantId) }))
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "current display",
          resultJson: encodeToolOutput({ value: "current" }),
        }),
      )
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(laterAssistantId) }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "later display",
          resultJson: encodeToolOutput({ value: "later" }),
        }),
      )

      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: assistantId,
        toolCalls: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "current" },
            providerExecuted: false,
          }),
        ],
      })
      expect(results.get(toolCallId)?.result).toEqual({ value: "current" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("rejects a corrupt structured terminal result", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-corrupt-session")
      const branchId = BranchId.make("binding-replay-result-corrupt-branch")
      const assistantId = MessageId.make("binding-replay-result-corrupt-assistant")
      const toolCallId = ToolCallId.make("binding-replay-result-corrupt-call")
      const message = Message.cases.regular.make({
        id: assistantId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "corrupt" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      })
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(MessageReceived.make({ message }))
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "display must not become authoritative",
          resultJson: "{invalid-json",
        }),
      )

      const exit = yield* Effect.exit(
        findPersistedToolResults({
          sessionId,
          branchId,
          assistantMessageId: assistantId,
          toolCalls: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "@test/replay-tool",
              params: { value: "corrupt" },
              providerExecuted: false,
            }),
          ],
        }),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error) && Schema.is(ToolResultReplayError)(error.value)).toBe(true)
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("isolates process-local replay state between server scopes", () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Scope.make(),
        (firstScope) =>
          Effect.acquireUseRelease(
            Scope.make(),
            (secondScope) =>
              Effect.gen(function* () {
                const firstContext = yield* Layer.buildWithScope(
                  ProcessLocalToolReplay.Live,
                  firstScope,
                )
                const secondContext = yield* Layer.buildWithScope(
                  ProcessLocalToolReplay.Live,
                  secondScope,
                )
                const first = Context.get(firstContext, ProcessLocalToolReplay)
                const second = Context.get(secondContext, ProcessLocalToolReplay)
                const key = "same-session:same-branch:assistant:call"
                const result = Prompt.toolResultPart({
                  id: "call",
                  name: "@test/replay-tool",
                  result: { value: "first-root" },
                  isFailure: false,
                  providerExecuted: false,
                })

                yield* first.setResults(key, new Map([[result.id, result]]))
                expect((yield* first.getResults(key)).get(result.id)).toEqual(result)
                expect((yield* second.getResults(key)).size).toBe(0)
              }),
            (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
          ),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    ),
  )
  it.live("clears process-local replay state when its server scope closes", () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(ProcessLocalToolReplay.Live, scope)
            const replay = Context.get(context, ProcessLocalToolReplay)
            const key = "shutdown-session:shutdown-branch:tool-result"
            const result = Prompt.toolResultPart({
              id: "shutdown-call",
              name: "@test/replay-tool",
              result: "result",
              isFailure: false,
              providerExecuted: false,
            })
            yield* replay.setResults(key, new Map([[result.id, result]]))
            return replay
          }),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    ).pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          const results = yield* service.getResults("shutdown-session:shutdown-branch:tool-result")
          expect(results.size).toBe(0)
        }),
      ),
    ),
  )
})
