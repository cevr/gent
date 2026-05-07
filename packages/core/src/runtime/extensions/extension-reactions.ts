import { Cause, Effect, Schema } from "effect"
import type {
  ContextMessagesInput,
  ExtensionReaction,
  ExtensionReactions,
  ExtensionScope,
  LoadedExtension,
  MessageInputInput,
  MessageOutputInput,
  PermissionCheckInput,
  SystemPromptInput,
  ToolExecuteInput,
  ToolPolicyFragment,
  ToolResultInput,
  TurnAfterInput,
  TurnBeforeInput,
  ProjectionTurnContext,
} from "../../domain/extension.js"
import type { ExtensionId } from "../../domain/ids.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { Message } from "../../domain/message.js"
import type { PermissionResult } from "../../domain/permission.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import { exitErasedEffect, sealErasedEffect } from "./extension-effect-membrane.js"

export class ExtensionReactionHaltError extends Schema.TaggedErrorClass<ExtensionReactionHaltError>()(
  "ExtensionReactionHaltError",
  {
    extensionId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export interface ExtensionReactionContext {
  readonly projection: ProjectionTurnContext
  readonly host: ExtensionHostContext
}

export interface CompiledExtensionReactions {
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
    ctx: ExtensionReactionContext,
  ) => Effect.Effect<ReadonlyArray<Message>>
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
    ctx: ExtensionReactionContext,
  ) => Effect.Effect<string>
  readonly resolveTurnProjection: (
    ctx: ProjectionTurnContext,
  ) => Effect.Effect<ExtensionTurnProjection>
  readonly executeTool: (
    input: ToolExecuteInput,
    base: (input: ToolExecuteInput) => Effect.Effect<unknown, Error | InteractionPendingError>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown, Error | InteractionPendingError>
  readonly transformToolResult: (
    input: ToolResultInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown>
  readonly emitTurnBefore: (
    input: TurnBeforeInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void, ExtensionReactionHaltError>
  readonly emitTurnAfter: (
    input: TurnAfterInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void, ExtensionReactionHaltError>
  readonly emitMessageOutput: (
    input: MessageOutputInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void, ExtensionReactionHaltError>
}

export interface ExtensionTurnProjection {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
}

interface RegisteredSystemPromptRewrite {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["systemPrompt"]>
}

interface RegisteredMessageInputRewrite {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["messageInput"]>
}

interface RegisteredContextMessagesRewrite {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["contextMessages"]>
}

interface RegisteredPermissionCheckRewrite {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["permissionCheck"]>
}

interface RegisteredToolExecuteRewrite {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["toolExecute"]>
}

interface ReactionTurnProjectionSlot {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["turnProjection"]>
}

interface RegisteredReaction<Input> {
  readonly extensionId: ExtensionId
  readonly slot: ExtensionReaction<Input, unknown, unknown>
}

interface RegisteredToolResultTransform {
  readonly extensionId: ExtensionId
  readonly handler: NonNullable<ExtensionReactions<unknown, unknown>["toolResult"]>
}

const SCOPE_ORDER: Record<ExtensionScope, number> = { builtin: 0, user: 1, project: 2 }

const sortExtensions = (extensions: ReadonlyArray<LoadedExtension>) =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const runReaction = <Input>(
  input: Input,
  ctx: ExtensionHostContext,
  reaction: RegisteredReaction<Input>,
) =>
  Effect.gen(function* () {
    const exit = yield* exitErasedEffect(() =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      provideHostContext(ctx, reaction.slot.handler(input, ctx)),
    )
    if (exit._tag === "Success") return
    const cause = exit.cause
    switch (reaction.slot.failureMode) {
      case "continue":
        yield* Effect.logDebug("extension.reaction.handler.failed").pipe(
          Effect.annotateLogs({
            extensionId: reaction.extensionId,
            cause: Cause.pretty(cause),
          }),
        )
        return
      case "isolate":
        yield* Effect.logWarning("extension.reaction.handler.failed").pipe(
          Effect.annotateLogs({
            extensionId: reaction.extensionId,
            cause: Cause.pretty(cause),
          }),
        )
        return
      case "halt":
        yield* Effect.logError("extension.reaction.handler.halt").pipe(
          Effect.annotateLogs({
            extensionId: reaction.extensionId,
            cause: Cause.pretty(cause),
          }),
        )
        return yield* new ExtensionReactionHaltError({
          extensionId: String(reaction.extensionId),
          message: String(Cause.squash(cause)),
          cause: Cause.squash(cause),
        })
    }
  })

const provideHostContext = <A, E, R>(
  ctx: ExtensionHostContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  ctx.capabilityContext === undefined
    ? effect
    : effect.pipe(Effect.provideContext(ctx.capabilityContext))

const provideProjectionContext = <A, E, R>(
  ctx: ProjectionTurnContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  ctx.capabilityContext === undefined
    ? effect
    : effect.pipe(Effect.provideContext(ctx.capabilityContext))

const collectTurnProjection = (
  projection: ExtensionTurnProjection | undefined,
  sectionsById: Map<string, PromptSection>,
  policyFragments: ToolPolicyFragment[],
) => {
  if (projection === undefined) return
  for (const section of projection.promptSections) sectionsById.set(section.id, section)
  for (const fragment of projection.policyFragments) policyFragments.push(fragment)
}

const runTurnProjectionReaction = (slot: ReactionTurnProjectionSlot, ctx: ProjectionTurnContext) =>
  sealErasedEffect(
    () =>
      provideProjectionContext(
        ctx,
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        slot.handler(ctx).pipe(
          Effect.map((projection) => ({
            promptSections: projection.promptSections ?? [],
            policyFragments: projection.toolPolicy !== undefined ? [projection.toolPolicy] : [],
          })),
        ),
      ),
    {
      onFailure: (error) =>
        Effect.logWarning("extension.reaction.turn-projection.failed").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            error: String(error),
          }),
          Effect.as(undefined),
        ),
      onDefect: (defect) =>
        Effect.logWarning("extension.reaction.turn-projection.defect").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            defect: String(defect),
          }),
          Effect.as(undefined),
        ),
    },
  )

export const compileExtensionReactions = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledExtensionReactions => {
  const sorted = sortExtensions(extensions)
  const messageInputSlots: RegisteredMessageInputRewrite[] = []
  const contextMessagesSlots: RegisteredContextMessagesRewrite[] = []
  const permissionCheckSlots: RegisteredPermissionCheckRewrite[] = []
  const systemPromptSlots: RegisteredSystemPromptRewrite[] = []
  const toolExecuteSlots: RegisteredToolExecuteRewrite[] = []
  const turnProjectionSlots: ReactionTurnProjectionSlot[] = []
  const turnBeforeSlots: RegisteredReaction<TurnBeforeInput>[] = []
  const turnAfterSlots: RegisteredReaction<TurnAfterInput>[] = []
  const messageOutputSlots: RegisteredReaction<MessageOutputInput>[] = []
  const toolResultSlots: RegisteredToolResultTransform[] = []

  for (const ext of sorted) {
    const reactions = ext.contributions.reactions
    if (reactions === undefined) continue
    if (reactions.messageInput !== undefined) {
      messageInputSlots.push({
        extensionId: ext.manifest.id,
        handler: reactions.messageInput,
      })
    }
    if (reactions.contextMessages !== undefined) {
      contextMessagesSlots.push({
        extensionId: ext.manifest.id,
        handler: reactions.contextMessages,
      })
    }
    if (reactions.permissionCheck !== undefined) {
      permissionCheckSlots.push({
        extensionId: ext.manifest.id,
        handler: reactions.permissionCheck,
      })
    }
    if (reactions.systemPrompt !== undefined) {
      systemPromptSlots.push({
        extensionId: ext.manifest.id,
        handler: reactions.systemPrompt,
      })
    }
    if (reactions.turnProjection !== undefined) {
      turnProjectionSlots.push({
        extensionId: ext.manifest.id,
        handler: reactions.turnProjection,
      })
    }
    if (reactions.turnBefore !== undefined) {
      turnBeforeSlots.push({ extensionId: ext.manifest.id, slot: reactions.turnBefore })
    }
    if (reactions.turnAfter !== undefined) {
      turnAfterSlots.push({ extensionId: ext.manifest.id, slot: reactions.turnAfter })
    }
    if (reactions.messageOutput !== undefined) {
      messageOutputSlots.push({ extensionId: ext.manifest.id, slot: reactions.messageOutput })
    }
    if (reactions.toolResult !== undefined) {
      toolResultSlots.push({ extensionId: ext.manifest.id, handler: reactions.toolResult })
    }
    if (reactions.toolExecute !== undefined) {
      toolExecuteSlots.push({ extensionId: ext.manifest.id, handler: reactions.toolExecute })
    }
  }

  return {
    normalizeMessageInput: (input, ctx) =>
      Effect.gen(function* () {
        let current = input.content
        for (const slot of messageInputSlots) {
          current = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous message-input slot
            () => provideHostContext(ctx, slot.handler({ ...input, content: current }, ctx)),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.message-input.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.message-input.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
        }
        return current
      }) as Effect.Effect<string>,

    checkPermission: (input, base, ctx) =>
      Effect.gen(function* () {
        let current = yield* base(input)
        for (const slot of permissionCheckSlots) {
          current = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous permission-check slot
            () => provideHostContext(ctx, slot.handler({ ...input, current }, ctx)),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.permission-check.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.permission-check.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
        }
        return current
      }) as Effect.Effect<PermissionResult>,

    resolveContextMessages: (input, ctx) =>
      Effect.gen(function* () {
        let current = input.messages
        for (const slot of contextMessagesSlots) {
          current = yield* sealErasedEffect(
            () =>
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              provideHostContext(ctx.host, slot.handler({ ...input, messages: current }, ctx.host)),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.context-messages.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.context-messages.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
        }
        return current
      }) as Effect.Effect<ReadonlyArray<Message>>,

    resolveSystemPrompt: (input, ctx) =>
      Effect.gen(function* () {
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          current = yield* sealErasedEffect(
            () =>
              provideHostContext(
                ctx.host,
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off
                slot.handler({ ...input, basePrompt: current }, ctx.host),
              ),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.system-prompt.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.system-prompt.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
        }
        return current
      }) as Effect.Effect<string>,

    resolveTurnProjection: (ctx) =>
      Effect.gen(function* () {
        const sectionsById = new Map<string, PromptSection>()
        const policyFragments: ToolPolicyFragment[] = []

        for (const slot of turnProjectionSlots) {
          collectTurnProjection(
            yield* runTurnProjectionReaction(slot, ctx),
            sectionsById,
            policyFragments,
          )
        }

        return { promptSections: [...sectionsById.values()], policyFragments }
      }),

    executeTool: (input, base, ctx) =>
      Effect.gen(function* () {
        let current = yield* base(input)
        for (const slot of toolExecuteSlots) {
          current = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-execute slot
            () => provideHostContext(ctx, slot.handler({ ...input, current }, ctx)),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.tool-execute.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.tool-execute.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
        }
        return current
      }),

    transformToolResult: (input, ctx) =>
      Effect.gen(function* () {
        let current: unknown = input.result
        for (const slot of toolResultSlots) {
          const next = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot
            () => provideHostContext(ctx, slot.handler({ ...input, result: current }, ctx)),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.tool-result.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.tool-result.defect").pipe(
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
