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
import type { ProcessGenerationId } from "../../domain/process-generation.js"
import {
  ProcessLocalToolReplay,
  processLocalReplayBindingKey,
} from "./process-local-tool-replay.js"
import {
  attachToolBindingIdentity,
  bindingMismatchReason,
  makeBindingReplayError,
  processLocalToolBindingIdentity,
  sameToolBindingIdentity,
  type ToolBindingReplayReason,
} from "./tool-binding-replay.js"
import { ToolRunner, type ResolvedToolCapability } from "./tool-runner.js"

/** Capture the loaded capability and its durable identity. */
export const captureCurrentToolBinding = Effect.fn("ToolBinding.captureCurrent")(function* (
  toolName: string,
) {
  const runner = yield* ToolRunner
  const registry = yield* ExtensionRegistry
  const captured = yield* runner.capture({ toolName })
  if (Option.isNone(captured)) return Option.none<ResolvedToolCapability>()
  return Option.some(
    yield* attachToolBindingIdentity(captured.value, registry.getResolved().extensions),
  )
})

/**
 * The identity a dispatching tool records for one inner host operation. A
 * build-owned binding is durable. A source run has none, so the operation names
 * the live process instead; resume is then valid only inside that process. A
 * turn without a process identity cannot bind a source-run tool at all.
 */
export const innerOperationBindingIdentity = Effect.fn("ToolBinding.innerOperationIdentity")(
  function* (entry: ResolvedToolCapability, generationId?: ProcessGenerationId) {
    if (Predicate.isNotUndefined(entry.binding)) return Option.some(entry.binding)
    if (Predicate.isUndefined(generationId)) return Option.none<ToolBindingIdentity>()
    return yield* processLocalToolBindingIdentity(entry, generationId)
  },
)

/** Validate an owned durable binding without assuming a model-message storage layout.
 * The caller verifies receipt ownership.
 */
export const resolveStoredToolBinding = Effect.fn("ToolBinding.resolveStored")(function* (params: {
  readonly sessionId: SessionId
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly binding: ToolBindingIdentity
  readonly generationId?: ProcessGenerationId
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
  const current = yield* captureCurrentToolBinding(toolName)
  if (Option.isNone(current)) {
    return yield* fail(
      "ToolUnavailable",
      `Tool ${toolName} is not available in the loaded extension profile`,
    )
  }
  if (params.binding.source._tag === "ProcessLocal") {
    const generationId = Option.fromUndefinedOr(params.generationId)
    if (Option.isNone(generationId)) {
      return yield* fail(
        "SourceMismatch",
        `Tool ${toolName} was bound to a process that is no longer live`,
      )
    }
    const live = yield* processLocalToolBindingIdentity(current.value, generationId.value)
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
 * Durable rows take precedence. A missing row can use only a same-process
 * capability that never had a durable identity.
 * Callers own result persistence and interaction policy.
 */
export const resolveReplayToolBinding = Effect.fn("ToolBinding.resolveReplay")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: MessageId
  readonly toolCall: Prompt.ToolCallPart
  readonly generationId?: ProcessGenerationId
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
    const current = yield* captureCurrentToolBinding(toolName)
    if (Option.isNone(current)) {
      return yield* fail(
        "ToolUnavailable",
        `Tool ${toolName} is not available in the loaded extension profile`,
      )
    }
    if (
      local.value.entry.extensionId !== current.value.extensionId ||
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
    generationId: params.generationId,
  }).pipe(Effect.onError(() => localReplay.removeBinding(key)))
})
