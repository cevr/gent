import { Cause, Effect } from "effect"
import type {
  ContextMessagesInput,
  ExtensionKind,
  LoadedExtension,
  MessageInputInput,
  MessageOutputInput,
  PermissionCheckInput,
  SystemPromptInput,
  ToolExecuteInput,
  ToolResultInput,
  TurnAfterInput,
  TurnBeforeInput,
} from "../../domain/extension.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { Message } from "../../domain/message.js"
import type { PermissionResult } from "../../domain/permission.js"
import type { AnyProjectionContribution, ProjectionTurnContext } from "../../domain/projection.js"
import type { ResourceReaction, ResourceRuntimeSlots } from "../../domain/resource.js"
import { exitErasedEffect, sealErasedEffect } from "./effect-membrane.js"

export interface RuntimeSlotContext {
  readonly projection: ProjectionTurnContext
  readonly host: ExtensionHostContext
}

export interface CompiledRuntimeSlots {
  readonly normalizeMessageInput: (
    input: MessageInputInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<string>
  readonly checkPermission: (
    input: PermissionCheckInput,
    base: (input: PermissionCheckInput) => Effect.Effect<PermissionResult>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<PermissionResult>
  readonly resolveContextMessages: (
    input: ContextMessagesInput,
    ctx: RuntimeSlotContext,
  ) => Effect.Effect<ReadonlyArray<Message>>
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
    ctx: RuntimeSlotContext,
  ) => Effect.Effect<string>
  readonly executeTool: (
    input: ToolExecuteInput,
    base: (input: ToolExecuteInput) => Effect.Effect<unknown>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown>
  readonly transformToolResult: (
    input: ToolResultInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown>
  readonly emitTurnBefore: (
    input: TurnBeforeInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void>
  readonly emitTurnAfter: (input: TurnAfterInput, ctx: ExtensionHostContext) => Effect.Effect<void>
  readonly emitMessageOutput: (
    input: MessageOutputInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void>
}

interface ProjectionSystemPromptSlot {
  readonly extensionId: string
  readonly projectionId: string
  readonly query: AnyProjectionContribution["query"]
  readonly systemPrompt: NonNullable<AnyProjectionContribution["systemPrompt"]>
}

interface ProjectionContextMessagesSlot {
  readonly extensionId: string
  readonly projectionId: string
  readonly query: AnyProjectionContribution["query"]
  readonly contextMessages: NonNullable<AnyProjectionContribution["contextMessages"]>
}

interface RegisteredReaction<Input> {
  readonly extensionId: string
  readonly slot: ResourceReaction<Input, unknown, unknown>
}

interface RegisteredToolResultTransform {
  readonly extensionId: string
  readonly handler: NonNullable<ResourceRuntimeSlots<unknown, unknown>["toolResult"]>
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

const sortExtensions = (extensions: ReadonlyArray<LoadedExtension>) =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const runProjectionQuery = (
  extensionId: string,
  projectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (ctx: ProjectionTurnContext) => Effect.Effect<any, any, any>,
  ctx: ProjectionTurnContext,
) =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for existential ProjectionContribution
  sealErasedEffect(() => query(ctx), {
    onFailure: (error) =>
      Effect.logWarning("extension.runtime-slot.query.failed").pipe(
        Effect.annotateLogs({ extensionId, projectionId, error: String(error) }),
        Effect.as(undefined),
      ),
    onDefect: (defect) =>
      Effect.logWarning("extension.runtime-slot.query.defect").pipe(
        Effect.annotateLogs({ extensionId, projectionId, defect: String(defect) }),
        Effect.as(undefined),
      ),
  })

const runReaction = <Input>(
  input: Input,
  ctx: ExtensionHostContext,
  reaction: RegisteredReaction<Input>,
) =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous ResourceReaction
    const exit = yield* exitErasedEffect(() => reaction.slot.handler(input, ctx))
    if (exit._tag === "Success") return
    const cause = exit.cause
    switch (reaction.slot.failureMode) {
      case "continue":
        yield* Effect.logDebug("extension.runtime-reaction.failed").pipe(
          Effect.annotateLogs({
            extensionId: reaction.extensionId,
            cause: Cause.pretty(cause),
          }),
        )
        return
      case "isolate":
        yield* Effect.logWarning("extension.runtime-reaction.failed").pipe(
          Effect.annotateLogs({
            extensionId: reaction.extensionId,
            cause: Cause.pretty(cause),
          }),
        )
        return
      case "halt":
        yield* Effect.logError("extension.runtime-reaction.halt").pipe(
          Effect.annotateLogs({
            extensionId: reaction.extensionId,
            cause: Cause.pretty(cause),
          }),
        )
        return yield* Effect.die(Cause.squash(cause))
    }
  })

export const compileRuntimeSlots = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledRuntimeSlots => {
  const sorted = sortExtensions(extensions)
  const systemPromptSlots: ProjectionSystemPromptSlot[] = []
  const contextMessageSlots: ProjectionContextMessagesSlot[] = []
  const turnBeforeSlots: RegisteredReaction<TurnBeforeInput>[] = []
  const turnAfterSlots: RegisteredReaction<TurnAfterInput>[] = []
  const messageOutputSlots: RegisteredReaction<MessageOutputInput>[] = []
  const toolResultSlots: RegisteredToolResultTransform[] = []

  for (const ext of sorted) {
    for (const projection of ext.contributions.projections ?? []) {
      if (projection.systemPrompt !== undefined) {
        systemPromptSlots.push({
          extensionId: ext.manifest.id,
          projectionId: projection.id,
          query: projection.query,
          systemPrompt: projection.systemPrompt,
        })
      }
      if (projection.contextMessages !== undefined) {
        contextMessageSlots.push({
          extensionId: ext.manifest.id,
          projectionId: projection.id,
          query: projection.query,
          contextMessages: projection.contextMessages,
        })
      }
    }

    for (const resource of ext.contributions.resources ?? []) {
      const runtime = resource.runtime
      if (runtime?.turnBefore !== undefined) {
        turnBeforeSlots.push({ extensionId: ext.manifest.id, slot: runtime.turnBefore })
      }
      if (runtime?.turnAfter !== undefined) {
        turnAfterSlots.push({ extensionId: ext.manifest.id, slot: runtime.turnAfter })
      }
      if (runtime?.messageOutput !== undefined) {
        messageOutputSlots.push({ extensionId: ext.manifest.id, slot: runtime.messageOutput })
      }
      if (runtime?.toolResult !== undefined) {
        toolResultSlots.push({ extensionId: ext.manifest.id, handler: runtime.toolResult })
      }
    }
  }

  return {
    normalizeMessageInput: (input) => Effect.succeed(input.content),

    checkPermission: (input, base) => base(input),

    resolveContextMessages: (input, ctx) =>
      Effect.gen(function* () {
        let current: ReadonlyArray<Message> = input.messages
        for (const slot of contextMessageSlots) {
          const value = yield* runProjectionQuery(
            slot.extensionId,
            slot.projectionId,
            slot.query,
            ctx.projection,
          )
          if (value === undefined) continue
          current = yield* slot
            .contextMessages(value, { ...input, messages: current }, ctx.projection)
            .pipe(
              Effect.catchEager((error) =>
                Effect.logWarning("extension.runtime-slot.context-messages.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    projectionId: slot.projectionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.logWarning("extension.runtime-slot.context-messages.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    projectionId: slot.projectionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
              ),
            )
        }
        return current
      }) as Effect.Effect<ReadonlyArray<Message>>,

    resolveSystemPrompt: (input, ctx) =>
      Effect.gen(function* () {
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          const value = yield* runProjectionQuery(
            slot.extensionId,
            slot.projectionId,
            slot.query,
            ctx.projection,
          )
          if (value === undefined) continue
          current = yield* slot
            .systemPrompt(value, { ...input, basePrompt: current }, ctx.projection)
            .pipe(
              Effect.catchEager((error) =>
                Effect.logWarning("extension.runtime-slot.system-prompt.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    projectionId: slot.projectionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.logWarning("extension.runtime-slot.system-prompt.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    projectionId: slot.projectionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
              ),
            )
        }
        return current
      }) as Effect.Effect<string>,

    executeTool: (input, base) => base(input),

    transformToolResult: (input, ctx) =>
      Effect.gen(function* () {
        let current: unknown = input.result
        for (const slot of toolResultSlots) {
          const next = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot
            () => slot.handler({ ...input, result: current }, ctx),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.runtime-slot.tool-result.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.runtime-slot.tool-result.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
          current = next
        }
        return current
      }) as Effect.Effect<unknown>,

    emitTurnBefore: (input, ctx) =>
      Effect.gen(function* () {
        for (const slot of turnBeforeSlots) yield* runReaction(input, ctx, slot)
      }),

    emitTurnAfter: (input, ctx) =>
      Effect.gen(function* () {
        for (const slot of turnAfterSlots) yield* runReaction(input, ctx, slot)
      }),

    emitMessageOutput: (input, ctx) =>
      Effect.gen(function* () {
        for (const slot of messageOutputSlots) yield* runReaction(input, ctx, slot)
      }),
  }
}
