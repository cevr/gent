import { Effect, Option, Predicate } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import {
  ToolCallId,
  ToolId,
  type BranchId,
  type MessageId,
  type SessionId,
} from "../../domain/ids.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import type { ToolBindingIdentity } from "../../domain/tool-binding.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { GentPlatform } from "../gent-platform.js"
import type { RuntimeProfilePublication } from "../profile.js"
import {
  ProcessLocalToolReplay,
  processLocalReplayBindingKey,
  sameProcessLocalGeneration,
} from "./process-local-tool-replay.js"
import {
  attachToolBindingIdentity,
  bindingMismatchReason,
  bindingResourcesFromPlan,
  makeBindingReplayError,
  processLocalToolBindingIdentity,
  sameToolBindingIdentity,
  type ToolBindingReplayReason,
} from "./tool-binding-replay.js"
import { ToolRunner, type ResolvedToolCapability } from "./tool-runner.js"

/** Capture the loaded capability and its exact publication identity. */
export const captureCurrentToolBinding = Effect.fn("ToolBinding.captureCurrent")(
  function* (params: {
    readonly sessionId: SessionId
    readonly toolName: string
    readonly publication?: RuntimeProfilePublication
  }) {
    const runner = yield* ToolRunner
    const registry = yield* ExtensionRegistry
    const platform = yield* GentPlatform
    const captured = yield* runner.capture(params)
    const publication = Option.fromUndefinedOr(params.publication)
    const resources = Option.match(publication, {
      onNone: () => [],
      onSome: (value) => bindingResourcesFromPlan(value.plan.descriptors, value.plan.startOrder),
    })
    return Option.map(captured, (entry) =>
      attachToolBindingIdentity(entry, {
        extensions: registry.getResolved().extensions,
        resources,
        publicationRevision: params.publication?.publicationRevision,
        hash: (input: string) => platform.hash("sha256", input),
      }),
    )
  },
)

const publicationResources = (publication: RuntimeProfilePublication) =>
  bindingResourcesFromPlan(publication.plan.descriptors, publication.plan.startOrder)

/**
 * The identity a cell records for one inner host operation. A build-owned
 * binding is durable. A source run has none, so the operation names the live
 * process generation instead; resume is then valid only inside that generation.
 */
export const cellOperationBindingIdentity = Effect.fn("ToolBinding.cellOperationIdentity")(
  function* (entry: ResolvedToolCapability, publication: RuntimeProfilePublication) {
    if (Predicate.isNotUndefined(entry.binding)) return Option.some(entry.binding)
    const platform = yield* GentPlatform
    return processLocalToolBindingIdentity(entry, {
      generationId: publication.generationId,
      resources: publicationResources(publication),
      hash: (input: string) => platform.hash("sha256", input),
    })
  },
)

/** Validate an owned durable binding without assuming a model-message storage layout.
 * The caller verifies receipt ownership and holds the selected publication lease.
 */
export const resolveStoredToolBinding = Effect.fn("ToolBinding.resolveStored")(function* (params: {
  readonly sessionId: SessionId
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly binding: ToolBindingIdentity
  readonly publication?: RuntimeProfilePublication
}) {
  const toolName = String(params.binding.toolId)
  const fail = (reason: ToolBindingReplayReason, message: string) =>
    makeBindingReplayError({
      assistantMessageId: params.assistantMessageId,
      toolCallId: params.toolCallId,
      toolId: params.binding.toolId,
      reason,
      message,
    })
  if (params.binding.source._tag === "DynamicNonReplayable") {
    return yield* fail(
      "DynamicNonReplayable",
      `Tool ${toolName} was provided by a dynamic registration and cannot be replayed`,
    )
  }
  const current = yield* captureCurrentToolBinding({
    sessionId: params.sessionId,
    toolName,
    publication: params.publication,
  })
  if (Option.isNone(current)) {
    return yield* fail(
      "ToolUnavailable",
      `Tool ${toolName} is not available in the loaded extension profile`,
    )
  }
  if (params.binding.source._tag === "ProcessLocal") {
    const publication = Option.fromUndefinedOr(params.publication)
    if (Option.isNone(publication)) {
      return yield* fail(
        "SourceMismatch",
        `Tool ${toolName} was bound to a process generation that is no longer live`,
      )
    }
    const platform = yield* GentPlatform
    const live = processLocalToolBindingIdentity(current.value, {
      generationId: publication.value.generationId,
      resources: publicationResources(publication.value),
      hash: (input: string) => platform.hash("sha256", input),
    })
    if (Option.isNone(live)) {
      return yield* fail(
        "SourceMismatch",
        `Tool ${toolName} now has a different source identity than its process-local binding`,
      )
    }
    if (!sameToolBindingIdentity(params.binding, live.value)) {
      const reason = bindingMismatchReason(params.binding, live.value)
      return yield* fail(reason, `Tool ${toolName} binding identity changed (${reason})`)
    }
    return current.value
  }
  if (Predicate.isUndefined(current.value.binding)) {
    return yield* fail(
      "MissingSourceIdentity",
      `Tool ${toolName} has no trusted loaded source identity`,
    )
  }
  if (!sameToolBindingIdentity(params.binding, current.value.binding)) {
    const reason = bindingMismatchReason(params.binding, current.value.binding)
    return yield* fail(reason, `Tool ${toolName} binding identity changed (${reason})`)
  }
  return current.value
})

/**
 * Resolve replay authority for native, external, and direct tool adapters.
 * Durable rows take precedence. A missing row can use only a same-process,
 * same-generation capability that never had a durable identity.
 * Callers own result persistence and interaction policy.
 */
export const resolveReplayToolBinding = Effect.fn("ToolBinding.resolveReplay")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: MessageId
  readonly toolCall: Prompt.ToolCallPart
  readonly publication?: RuntimeProfilePublication
}) {
  const storage = yield* ToolCallBindingStorage
  const localReplay = yield* ProcessLocalToolReplay
  const address = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    assistantMessageId: params.assistantMessageId,
    toolCallId: ToolCallId.make(params.toolCall.id),
  }
  const key = processLocalReplayBindingKey(address)
  const toolName = params.toolCall.name
  const fail = (reason: ToolBindingReplayReason, message: string) =>
    Effect.andThen(
      localReplay.removeBinding(key),
      makeBindingReplayError({
        ...address,
        toolId: ToolId.make(toolName),
        reason,
        message,
      }),
    )
  const stored = Option.fromUndefinedOr(yield* storage.get(address))
  if (Option.isNone(stored)) {
    const local = yield* localReplay.getBinding(key)
    if (Option.isNone(local) || Predicate.isNotUndefined(local.value.entry.binding)) {
      return yield* fail("MissingBinding", `No durable binding was recorded for tool ${toolName}`)
    }
    const currentGeneration = Option.fromUndefinedOr(params.publication?.generationId)
    if (!sameProcessLocalGeneration(local.value.generationId, currentGeneration)) {
      if (Option.isSome(local.value.generationId)) {
        yield* localReplay.clearBindingsForGeneration(local.value.generationId.value)
      }
      return yield* fail(
        "SourceMismatch",
        `Tool ${toolName} belongs to a retired resource generation`,
      )
    }
    const current = yield* captureCurrentToolBinding({
      sessionId: params.sessionId,
      toolName,
      publication: params.publication,
    })
    if (Option.isNone(current)) {
      return yield* fail(
        "ToolUnavailable",
        `Tool ${toolName} is not available in the loaded extension profile`,
      )
    }
    if (
      local.value.entry.extensionId !== current.value.extensionId ||
      local.value.entry.origin !== current.value.origin ||
      local.value.entry.capability !== current.value.capability
    ) {
      return yield* fail("SourceMismatch", `Tool ${toolName} changed before same-process replay`)
    }
    if (Predicate.isNotUndefined(current.value.binding)) {
      return yield* fail(
        "MissingSourceIdentity",
        `Tool ${toolName} binding identity changed before replay`,
      )
    }
    return current.value
  }

  return yield* resolveStoredToolBinding({
    ...address,
    binding: stored.value,
    publication: params.publication,
  }).pipe(Effect.onError(() => localReplay.removeBinding(key)))
})
