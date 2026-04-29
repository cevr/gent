import { Cause, Effect } from "effect"
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
import type { ServiceKey } from "../../domain/actor.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { Message } from "../../domain/message.js"
import type { PermissionResult } from "../../domain/permission.js"
import type { PromptSection } from "../../domain/prompt.js"
import { ActorEngine } from "./actor-engine.js"
import { exitErasedEffect, sealErasedEffect } from "./effect-membrane.js"
import { Receptionist } from "./receptionist.js"

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
  ) => Effect.Effect<ExtensionTurnProjection, never, ActorEngine | Receptionist>
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

interface RegisteredActorViewSource {
  readonly extensionId: ExtensionId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ServiceKey<M> is contravariant; storage erases M
  readonly serviceKey: ServiceKey<any>
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

const collectActorViewSources = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredActorViewSource> => {
  const sources: RegisteredActorViewSource[] = []
  for (const ext of sortExtensions(extensions)) {
    for (const behavior of ext.contributions.actors ?? []) {
      if (behavior.serviceKey === undefined) continue
      sources.push({ extensionId: ext.manifest.id, serviceKey: behavior.serviceKey })
    }
  }
  return sources
}

const runReaction = <Input>(
  input: Input,
  ctx: ExtensionHostContext,
  reaction: RegisteredReaction<Input>,
) =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous ExtensionReaction
    const exit = yield* exitErasedEffect(() => reaction.slot.handler(input, ctx))
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
        return yield* Effect.die(Cause.squash(cause))
    }
  })

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
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous turn-projection slot
      slot.handler(ctx).pipe(
        Effect.map((projection) => ({
          promptSections: projection.promptSections ?? [],
          policyFragments: projection.toolPolicy !== undefined ? [projection.toolPolicy] : [],
        })),
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
  const actorViewSources = collectActorViewSources(sorted)
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
            () => slot.handler({ ...input, content: current }, ctx),
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
            () => slot.handler({ ...input, current }, ctx),
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
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous context-messages slot
            () => slot.handler({ ...input, messages: current }, ctx.host),
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
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous system-prompt slot
          current = yield* sealErasedEffect(
            () => slot.handler({ ...input, basePrompt: current }, ctx.host),
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

        if (actorViewSources.length > 0) {
          const engine = yield* ActorEngine
          const receptionist = yield* Receptionist
          for (const source of actorViewSources) {
            const refsExit = yield* Effect.exit(receptionist.find(source.serviceKey))
            if (refsExit._tag === "Failure") {
              yield* Effect.logWarning("extension.actor-view.find.failed").pipe(
                Effect.annotateLogs({ extensionId: source.extensionId }),
              )
              continue
            }
            for (const ref of refsExit.value) {
              const viewExit = yield* Effect.exit(engine.peekView(ref))
              if (viewExit._tag === "Failure") {
                yield* Effect.logWarning("extension.actor-view.peek.failed").pipe(
                  Effect.annotateLogs({ extensionId: source.extensionId }),
                )
                continue
              }
              const view = viewExit.value
              if (view === undefined) continue
              if (view.prompt !== undefined) {
                for (const section of view.prompt) sectionsById.set(section.id, section)
              }
              if (view.toolPolicy !== undefined) {
                policyFragments.push(view.toolPolicy)
              }
            }
          }
        }

        return { promptSections: [...sectionsById.values()], policyFragments }
      }),

    executeTool: (input, base, ctx) =>
      Effect.gen(function* () {
        let current = yield* base(input)
        for (const slot of toolExecuteSlots) {
          current = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-execute slot
            () => slot.handler({ ...input, current }, ctx),
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
      }) as Effect.Effect<unknown>,

    transformToolResult: (input, ctx) =>
      Effect.gen(function* () {
        let current: unknown = input.result
        for (const slot of toolResultSlots) {
          const next = yield* sealErasedEffect(
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot
            () => slot.handler({ ...input, result: current }, ctx),
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
