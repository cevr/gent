import { describe, expect, it } from "effect-bun-test"
import { Cause, Context, Effect, Exit, Layer, Option, Predicate, Schema, Scope } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { AgentName } from "@gent/core-internal/domain/agent"
import { LoadedArtifactIdentity, type LoadedExtension } from "@gent/core-internal/domain/extension"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolId,
} from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import {
  makeToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "@gent/core-internal/domain/tool-binding"
import { ResourceId, ResourceRevision } from "@gent/core-internal/domain/resource-graph"
import { MessageReceived, ToolCallSucceeded } from "@gent/core-internal/domain/event"
import { EventPublisher } from "@gent/core-internal/domain/event-publisher"
import {
  ExtensionContext,
  defineExtension,
  defineResource,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { makeStorageTransaction, SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { ToolCallBindingStorage } from "@gent/core-internal/storage/tool-call-binding-storage"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import {
  attachToolBindingIdentity,
  bindingMismatchReason,
  sameToolBindingIdentity,
} from "../../../src/runtime/agent/tool-binding-replay"
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
import { ResourceGenerationId } from "@gent/core-internal/domain/resource-generation"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { encodeToolOutput } from "../../../src/domain/tool-output"
import {
  captureCurrentToolBinding,
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
    retired: false,
    changed: false,
    dynamic: false,
    reason: "",
  },
  {
    name: "missing process binding",
    durable: false,
    saved: false,
    local: false,
    retired: false,
    changed: false,
    dynamic: false,
    reason: "MissingBinding",
  },
  {
    name: "retired process generation",
    durable: false,
    saved: false,
    local: true,
    retired: true,
    changed: false,
    dynamic: false,
    reason: "SourceMismatch",
  },
  {
    name: "matching durable identity",
    durable: true,
    saved: true,
    local: false,
    retired: false,
    changed: false,
    dynamic: false,
    reason: "",
  },
  {
    name: "absent durable row with local identity",
    durable: true,
    saved: false,
    local: true,
    retired: false,
    changed: false,
    dynamic: false,
    reason: "MissingBinding",
  },
  {
    name: "changed durable source",
    durable: true,
    saved: true,
    local: true,
    retired: false,
    changed: true,
    dynamic: false,
    reason: "SourceMismatch",
  },
  {
    name: "changed resource vector",
    durable: true,
    saved: true,
    local: true,
    retired: false,
    changed: false,
    dynamic: false,
    reason: "ResourceMismatch",
  },
  {
    name: "dynamic durable marker",
    durable: true,
    saved: true,
    local: true,
    retired: false,
    changed: false,
    dynamic: true,
    reason: "DynamicNonReplayable",
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
    resources: [
      {
        id: ResourceId.make("@test/replay-resource"),
        revision: ResourceRevision.make("resource/1"),
      },
    ],
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
          const dynamic = yield* resolveStoredToolBinding({
            ...address,
            binding: makeToolBindingIdentity({
              ...binding,
              source: ToolBindingSource.cases.DynamicNonReplayable.make({
                sourceRevision: ToolSourceRevision.make("dynamic-source"),
              }),
            }),
          }).pipe(Effect.flip)
          expect(dynamic.reason).toBe("DynamicNonReplayable")
        }).pipe(Effect.provideContext(context))
      }),
  )

  for (const scenario of replayCases) {
    it.scopedLive(`resolves ${scenario.name} through real storage and tool capture`, () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const declared = defineExtension({
          id: "@test/replay-extension",
          tools: [capability],
          resources: [
            defineResource({
              id: "test/replay-policy-resource",
              tag: ReplayResource,
              scope: "process",
              layer: Layer.succeed(ReplayResource, ReplayResource.of({ value: "live" })),
            }),
          ],
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
          const publication = profile.publication
          if (Predicate.isUndefined(publication))
            return yield* Effect.die("Expected live publication")
          const current = yield* captureCurrentToolBinding({
            sessionId,
            toolName: toolCall.name,
            publication,
          })
          if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
          const replay = yield* ProcessLocalToolReplay
          const key = processLocalReplayBindingKey(address)
          if (scenario.local) {
            let generationId = Option.some(publication.generationId)
            if (scenario.retired) generationId = Option.some(ResourceGenerationId.make("retired"))
            yield* replay.setBinding(key, { entry: current.value, generationId })
            if (scenario.retired) {
              yield* replay.setBinding("another-call-in-retired-generation", {
                entry: current.value,
                generationId,
              })
            }
          }
          if (scenario.saved) {
            const storage = yield* ToolCallBindingStorage
            let binding = current.value.binding
            if (Predicate.isUndefined(binding))
              return yield* Effect.die("Expected durable identity")
            expect(binding.resources).toEqual([
              {
                id: ResourceId.make("test/replay-policy-resource"),
                revision: ResourceRevision.make("1"),
              },
            ])
            if (scenario.reason === "ResourceMismatch")
              binding = makeToolBindingIdentity({
                ...binding,
                resources: [
                  {
                    id: ResourceId.make("test/replay-policy-resource"),
                    revision: ResourceRevision.make("old"),
                  },
                ],
              })
            if (scenario.changed)
              binding = makeToolBindingIdentity({
                ...binding,
                source: ToolBindingSource.cases.Static.make({
                  sourceRevision: ToolSourceRevision.make("old-source"),
                }),
              })
            if (scenario.dynamic)
              binding = makeToolBindingIdentity({
                ...binding,
                source: ToolBindingSource.cases.DynamicNonReplayable.make({
                  sourceRevision: binding.source.sourceRevision,
                }),
              })
            yield* storage.save({ ...address, binding })
          }
          const result = yield* resolveReplayToolBinding({
            ...address,
            toolCall,
            publication,
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
          if (scenario.retired) {
            expect(
              Option.isNone(yield* replay.getBinding("another-call-in-retired-generation")),
            ).toBe(true)
          }
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- Each scenario owns a production test root with its authored extension.
          Effect.provide(layer),
        )
      }).pipe(Effect.timeout("5 seconds")),
    )
  }

  it.live("rejects a changed loaded publication revision with the same artifact and schema", () =>
    Effect.sync(() => {
      const capability = makeTool()
      const extension = makeExtension(capability)
      const entry = {
        extensionId: extension.manifest.id,
        capability,
        origin: "static",
      } satisfies ResolvedToolCapability
      const first = attachToolBindingIdentity(entry, {
        extensions: [extension],
        resources: [],
        publicationRevision: "config-revision-1",
        hash: (input) => `hash-${input.length}`,
      })
      const second = attachToolBindingIdentity(entry, {
        extensions: [extension],
        resources: [],
        publicationRevision: "config-revision-2",
        hash: (input) => `hash-${input.length}`,
      })

      expect(first.binding).toBeDefined()
      expect(second.binding).toBeDefined()
      if (Predicate.isUndefined(first.binding) || Predicate.isUndefined(second.binding)) return
      expect(sameToolBindingIdentity(first.binding, second.binding)).toBe(false)
      expect(bindingMismatchReason(first.binding, second.binding)).toBe("SourceMismatch")
    }),
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
    }).pipe(Effect.provide(Layer.mergeAll(SqliteStorage.TestWithSql(), EventPublisher.Test()))),
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
    }).pipe(Effect.provide(Layer.mergeAll(SqliteStorage.TestWithSql(), EventPublisher.Test()))),
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
    }).pipe(Effect.provide(Layer.mergeAll(SqliteStorage.TestWithSql(), EventPublisher.Test()))),
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
    }).pipe(Effect.provide(Layer.mergeAll(SqliteStorage.TestWithSql(), EventPublisher.Test()))),
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
    }).pipe(Effect.provide(Layer.mergeAll(SqliteStorage.TestWithSql(), EventPublisher.Test()))),
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
  it.live("retires process-local bindings by resource generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replay = yield* ProcessLocalToolReplay
        const capability = makeTool()
        const extension = makeExtension(capability)
        const entry = {
          extensionId: extension.manifest.id,
          capability,
          origin: "static",
        } satisfies ResolvedToolCapability
        const key = "generation-session:generation-branch:assistant:call"
        yield* replay.setBinding(key, {
          entry,
          generationId: Option.some(ResourceGenerationId.make("generation-a")),
        })

        yield* replay.clearBindingsForGeneration(ResourceGenerationId.make("generation-a"))

        expect(Option.isNone(yield* replay.getBinding(key))).toBe(true)
      }).pipe(Effect.provide(ProcessLocalToolReplay.Live)),
    ),
  )
})
