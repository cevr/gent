import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentName as AgentNameType } from "../../domain/agent.js"
import {
  type BranchId,
  type MessageId,
  type SessionId,
  ToolCallId,
  ToolId,
} from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { GentPlatform } from "../gent-platform.js"
import type { ResourceDescriptor } from "../../domain/resource-graph.js"
import type { ResourceGenerationId } from "../../domain/resource-generation.js"
import type { ToolBindingIdentity } from "../../domain/tool-binding.js"
import { ToolRunner, type ResolvedToolCapability } from "./tool-runner"
import {
  attachToolBindingIdentity,
  bindingMismatchReason,
  bindingResourcesFromPlan,
  makeBindingReplayError,
  sameToolBindingIdentity,
  type ToolBindingReplayReason,
} from "./tool-binding-replay.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import { persistAssistantPartsWithBindings, persistToolParts } from "./turn-persistence.js"
import type { AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import {
  processLocalReplayBindingKey,
  sameProcessLocalGeneration,
  ProcessLocalToolReplay,
  type ProcessLocalToolReplayService,
} from "./process-local-tool-replay.js"

const TOOL_CONCURRENCY = 8

/** InteractionPendingError enriched with the toolCallId that triggered it */
export class ToolInteractionPending extends Schema.TaggedError<ToolInteractionPending>(
  "@gent/core/src/runtime/agent/turn-tool-execution/ToolInteractionPending",
)("ToolInteractionPending", {
  pending: InteractionPendingError,
  toolCallId: ToolCallId,
  completedResults: Schema.Array(Prompt.ToolResultPart),
}) {}

export class ToolInvocationInteractionError extends Schema.TaggedError<ToolInvocationInteractionError>(
  "@gent/core/src/runtime/agent/turn-tool-execution/ToolInvocationInteractionError",
)("ToolInvocationInteractionError", {
  message: Schema.String,
  toolCallId: ToolCallId,
}) {}

export const executeToolCalls = Effect.fn("TurnHelpers.executeToolCalls")(function* (params: {
  toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
}) {
  const toolRunner = yield* ToolRunner
  const hostCtx = yield* CurrentExtensionHostContext
  const exits = yield* Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.exit(
        Effect.gen(function* () {
          const toolHostCtx = {
            ...hostCtx,
            agentName: params.currentTurnAgent,
            toolCallId: ToolCallId.make(toolCall.id),
          }
          const toolCallInput = {
            toolCallId: ToolCallId.make(toolCall.id),
            toolName: toolCall.name,
            input: toolCall.params,
          }
          return yield* toolRunner
            .runBound(toolCallInput, Option.fromUndefinedOr(params.toolBindings.get(toolCall.name)))
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolInteractionPending({
                    pending: e,
                    toolCallId: ToolCallId.make(toolCall.id),
                    completedResults: [],
                  }),
              ),
              provideCurrentHostCtx(toolHostCtx),
            )
        }),
      ),
    { concurrency: Math.max(1, TOOL_CONCURRENCY) },
  )
  const results: Array<Prompt.ToolResultPart> = []
  let pending = Option.none<ToolInteractionPending>()
  for (const exit of exits) {
    if (Exit.isSuccess(exit)) {
      results.push(exit.value)
      continue
    }
    const error = Cause.findErrorOption(exit.cause)
    if (Option.isSome(error)) {
      if (Option.isNone(pending)) pending = error
      continue
    }
    return yield* Effect.failCause(exit.cause)
  }
  if (Option.isSome(pending)) {
    return yield* new ToolInteractionPending({
      pending: pending.value.pending,
      toolCallId: pending.value.toolCallId,
      completedResults: results,
    })
  }
  return results
})

interface InvocationReplayParams {
  readonly assistantMessageId: MessageId
  readonly toolResultMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly current: Option.Option<ResolvedToolCapability>
  readonly currentGeneration: Option.Option<ResourceGenerationId>
  readonly localBindingKey: string
  readonly processLocalReplay: ProcessLocalToolReplayService
}

const failInvocationReplay = (
  params: InvocationReplayParams,
  reason: ToolBindingReplayReason,
  message: string,
) => {
  const error = makeBindingReplayError({
    assistantMessageId: params.assistantMessageId,
    toolCallId: params.toolCallId,
    toolId: ToolId.make(params.toolName),
    reason,
    message,
  })
  return Effect.gen(function* () {
    yield* persistToolParts({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: [
        Prompt.toolResultPart({
          id: params.toolCallId,
          name: params.toolName,
          isFailure: true,
          providerExecuted: false,
          result: { error: error.message, reason: error.reason },
        }),
      ],
    })
    return yield* error
  })
}

const sameLocalEntry = (left: ResolvedToolCapability, right: ResolvedToolCapability) =>
  left.extensionId === right.extensionId &&
  left.origin === right.origin &&
  left.capability === right.capability

const localBindingMismatchReason = (
  left: ResolvedToolCapability,
  right: ResolvedToolCapability,
): Option.Option<ToolBindingReplayReason> => {
  if (Predicate.isUndefined(left.binding) && Predicate.isUndefined(right.binding)) {
    return Option.none()
  }
  if (Predicate.isUndefined(left.binding) || Predicate.isUndefined(right.binding)) {
    return Option.some("MissingSourceIdentity")
  }
  if (!sameToolBindingIdentity(left.binding, right.binding)) {
    return Option.some(bindingMismatchReason(left.binding, right.binding))
  }
  return Option.none()
}

const resolveLocalInvocationBinding = Effect.fn("TurnHelpers.resolveLocalInvocationBinding")(
  function* (params: InvocationReplayParams) {
    const local = yield* params.processLocalReplay.getBinding(params.localBindingKey)
    if (Option.isNone(local)) {
      return yield* failInvocationReplay(
        params,
        "MissingBinding",
        `No durable binding was recorded for tool ${params.toolName}`,
      )
    }
    if (!sameProcessLocalGeneration(local.value.generationId, params.currentGeneration)) {
      yield* params.processLocalReplay.removeBinding(params.localBindingKey)
      return yield* failInvocationReplay(
        params,
        "SourceMismatch",
        `Tool ${params.toolName} belongs to a retired resource generation`,
      )
    }
    if (Option.isNone(params.current)) {
      yield* params.processLocalReplay.removeBinding(params.localBindingKey)
      return yield* failInvocationReplay(
        params,
        "ToolUnavailable",
        `Tool ${params.toolName} is not available in the loaded extension profile`,
      )
    }
    if (!sameLocalEntry(local.value.entry, params.current.value)) {
      yield* params.processLocalReplay.removeBinding(params.localBindingKey)
      return yield* failInvocationReplay(
        params,
        "SourceMismatch",
        `Tool ${params.toolName} changed before same-process replay`,
      )
    }
    const mismatch = localBindingMismatchReason(local.value.entry, params.current.value)
    if (Option.isSome(mismatch)) {
      yield* params.processLocalReplay.removeBinding(params.localBindingKey)
      return yield* failInvocationReplay(
        params,
        mismatch.value,
        `Tool ${params.toolName} binding identity changed (${mismatch.value})`,
      )
    }
    return local.value.entry
  },
)

const resolveDurableInvocationBinding = Effect.fn("TurnHelpers.resolveDurableInvocationBinding")(
  function* (params: InvocationReplayParams & { readonly stored: ToolBindingIdentity }) {
    if (params.stored.source._tag === "DynamicNonReplayable") {
      return yield* failInvocationReplay(
        params,
        "DynamicNonReplayable",
        `Tool ${params.toolName} was provided by a dynamic registration and cannot be replayed`,
      )
    }
    if (Option.isNone(params.current)) {
      return yield* failInvocationReplay(
        params,
        "ToolUnavailable",
        `Tool ${params.toolName} is not available in the loaded extension profile`,
      )
    }
    if (Predicate.isUndefined(params.current.value.binding)) {
      return yield* failInvocationReplay(
        params,
        "MissingSourceIdentity",
        `Tool ${params.toolName} has no trusted loaded source identity`,
      )
    }
    if (!sameToolBindingIdentity(params.stored, params.current.value.binding)) {
      const reason = bindingMismatchReason(params.stored, params.current.value.binding)
      return yield* failInvocationReplay(
        params,
        reason,
        `Tool ${params.toolName} binding identity changed (${reason})`,
      )
    }
    return params.current.value
  },
)

const resolveInvocationBinding = Effect.fn("TurnHelpers.resolveInvocationBinding")(function* (
  params: InvocationReplayParams & { readonly stored: Option.Option<ToolBindingIdentity> },
) {
  if (Option.isNone(params.stored)) return yield* resolveLocalInvocationBinding(params)
  return yield* resolveDurableInvocationBinding({ ...params, stored: params.stored.value })
})

export const invokeTool = Effect.fn("TurnHelpers.invokeTool")(function* (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  turnProfile: AgentLoopTurnProfile
}) {
  const toolRunner = yield* ToolRunner
  const messageStorage = yield* MessageStorage
  const processLocalReplay = yield* ProcessLocalToolReplay
  const storageTransaction = yield* makeStorageTransaction

  const localBindingKey = processLocalReplayBindingKey({
    sessionId: params.sessionId,
    branchId: params.branchId,
    assistantMessageId: params.assistantMessageId,
    toolCallId: params.toolCallId,
  })
  const currentGeneration = Option.fromUndefinedOr(params.turnProfile.turnPublication?.generationId)

  return yield* Effect.gen(function* () {
    const existingResult = yield* messageStorage.getMessage(params.toolResultMessageId)
    if (!Predicate.isUndefined(existingResult)) return
    const existingAssistant = yield* messageStorage.getMessage(params.assistantMessageId)
    let toolCall = Prompt.toolCallPart({
      id: params.toolCallId,
      name: params.toolName,
      params: params.input,
      providerExecuted: false,
    })
    if (!Predicate.isUndefined(existingAssistant)) {
      const storedToolCall = existingAssistant.parts.find(
        (part): part is Prompt.ToolCallPart =>
          part.type === "tool-call" && part.id === params.toolCallId,
      )
      if (Predicate.isUndefined(storedToolCall) || storedToolCall.name !== params.toolName) {
        return yield* makeBindingReplayError({
          assistantMessageId: params.assistantMessageId,
          toolCallId: params.toolCallId,
          toolId: ToolId.make(params.toolName),
          reason: "MissingBinding",
          message: `Stored assistant tool call ${params.toolCallId} does not match ${params.toolName}`,
        })
      }
      toolCall = storedToolCall
    }

    const extensionRegistry = yield* ExtensionRegistry
    const platform = yield* GentPlatform
    const captured = yield* toolRunner.capture({
      sessionId: params.sessionId,
      toolName: toolCall.name,
    })
    let resources: ReadonlyArray<ResourceDescriptor> = []
    if (Predicate.isNotUndefined(params.turnProfile.turnPublication)) {
      resources = bindingResourcesFromPlan(
        params.turnProfile.turnPublication.plan.descriptors,
        params.turnProfile.turnPublication.plan.startOrder,
      )
    }
    const bindingContext = {
      extensions: extensionRegistry.getResolved().extensions,
      resources,
      publicationRevision: params.turnProfile.turnPublication?.publicationRevision,
      hash: (input: string) => platform.hash("sha256", input),
    }
    const current = Option.map(captured, (entry) =>
      attachToolBindingIdentity(entry, bindingContext),
    )
    const toolBindings = new Map<string, ResolvedToolCapability>()
    if (!Predicate.isUndefined(existingAssistant)) {
      const bindingStorage = yield* ToolCallBindingStorage
      const stored = Option.fromUndefinedOr(
        yield* bindingStorage.get({
          assistantMessageId: params.assistantMessageId,
          toolCallId: params.toolCallId,
          sessionId: params.sessionId,
          branchId: params.branchId,
        }),
      )
      const binding = yield* resolveInvocationBinding({
        assistantMessageId: params.assistantMessageId,
        toolResultMessageId: params.toolResultMessageId,
        toolCallId: params.toolCallId,
        toolName: toolCall.name,
        sessionId: params.sessionId,
        branchId: params.branchId,
        current,
        currentGeneration,
        localBindingKey,
        processLocalReplay,
        stored,
      })
      toolBindings.set(toolCall.name, binding)
    } else if (Option.isSome(current)) {
      toolBindings.set(toolCall.name, current.value)
    }
    const toolCalls = [toolCall]

    const persisted = yield* persistAssistantPartsWithBindings({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.assistantMessageId,
      parts: toolCalls,
      toolBindings,
      storageTransaction,
      agentName: params.currentTurnAgent,
    })
    if (Option.isSome(persisted) && persisted.value.inserted && Option.isSome(current)) {
      yield* processLocalReplay.setBinding(localBindingKey, {
        entry: current.value,
        generationId: currentGeneration,
      })
    }

    const toolResults = yield* executeToolCalls({
      toolCalls,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentTurnAgent: params.currentTurnAgent,
      toolBindings,
    })
    yield* persistToolParts({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: toolResults,
    })
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)
        if (Option.isSome(error) && Schema.is(ToolInteractionPending)(error.value))
          return Effect.void
      }
      return Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          const assistant = yield* messageStorage.getMessage(params.assistantMessageId)
          if (Predicate.isNotUndefined(assistant)) {
            yield* persistToolParts({
              sessionId: params.sessionId,
              branchId: params.branchId,
              messageId: params.toolResultMessageId,
              parts: assistant.parts.flatMap((part) => {
                if (part.type !== "tool-call" || part.id !== params.toolCallId) return []
                return [
                  Prompt.toolResultPart({
                    id: part.id,
                    name: part.name,
                    isFailure: true,
                    providerExecuted: false,
                    result: { error: Cause.pretty(exit.cause) },
                  }),
                ]
              }),
            })
          }
        }
      }).pipe(Effect.ensuring(processLocalReplay.removeBinding(localBindingKey)))
    }),
  )
})
