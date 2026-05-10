import { Cause, Effect, Schema } from "effect"
import type {
  ExtensionReaction,
  ExtensionReactions,
  ExtensionScope,
  LoadedExtension,
  SystemPromptInput,
  ToolPolicyFragment,
  ToolResultInput,
  TurnAfterInput,
  ProjectionTurnContext,
} from "../../domain/extension.js"
import type { ExtensionId } from "../../domain/ids.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { PromptSection } from "../../domain/prompt.js"
import { provideExtensionServices } from "../../domain/extension-services.js"
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
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
    ctx: ExtensionReactionContext,
  ) => Effect.Effect<string>
  readonly resolveTurnProjection: (
    ctx: ExtensionReactionContext,
  ) => Effect.Effect<ExtensionTurnProjection>
  readonly transformToolResult: (
    input: ToolResultInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown>
  readonly emitTurnAfter: (
    input: TurnAfterInput,
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
      provideLifecycleHostContext(ctx, reaction.slot.handler(input)),
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

const provideLifecycleHostContext = <A, E, R>(
  ctx: ExtensionHostContext & { readonly turn?: ProjectionTurnContext["turn"] },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  ctx.capabilityContext === undefined
    ? provideExtensionServices(ctx, effect)
    : provideExtensionServices(ctx, effect).pipe(Effect.provideContext(ctx.capabilityContext))

const provideProjectionContext = <A, E, R>(
  ctx: ExtensionReactionContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const hostCtx: ExtensionHostContext & { readonly turn: ProjectionTurnContext["turn"] } = {
    ...ctx.host,
    turn: ctx.projection.turn,
  }
  return provideLifecycleHostContext(hostCtx, effect)
}

const collectTurnProjection = (
  projection: ExtensionTurnProjection | undefined,
  sectionsById: Map<string, PromptSection>,
  policyFragments: ToolPolicyFragment[],
) => {
  if (projection === undefined) return
  for (const section of projection.promptSections) sectionsById.set(section.id, section)
  for (const fragment of projection.policyFragments) policyFragments.push(fragment)
}

const runTurnProjectionReaction = (
  slot: ReactionTurnProjectionSlot,
  ctx: ExtensionReactionContext,
) =>
  sealErasedEffect(
    () =>
      provideProjectionContext(
        ctx,
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        slot.handler().pipe(
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
  const systemPromptSlots: RegisteredSystemPromptRewrite[] = []
  const turnProjectionSlots: ReactionTurnProjectionSlot[] = []
  const turnAfterSlots: RegisteredReaction<TurnAfterInput>[] = []
  const toolResultSlots: RegisteredToolResultTransform[] = []

  for (const ext of sorted) {
    const reactions = ext.contributions.reactions
    if (reactions === undefined) continue
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
    if (reactions.turnAfter !== undefined) {
      turnAfterSlots.push({ extensionId: ext.manifest.id, slot: reactions.turnAfter })
    }
    if (reactions.toolResult !== undefined) {
      toolResultSlots.push({ extensionId: ext.manifest.id, handler: reactions.toolResult })
    }
  }

  return {
    resolveSystemPrompt: (input, ctx) =>
      Effect.gen(function* () {
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          current = yield* sealErasedEffect(
            () =>
              provideLifecycleHostContext(
                ctx.host,
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off
                slot.handler({ ...input, basePrompt: current }),
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

    transformToolResult: (input, ctx) =>
      Effect.gen(function* () {
        let current: unknown = input.result
        for (const slot of toolResultSlots) {
          const next = yield* sealErasedEffect(
            () =>
              provideLifecycleHostContext(
                ctx,
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot
                slot.handler({ ...input, result: current }),
              ),
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

    emitTurnAfter: (input, ctx) =>
      Effect.gen(function* () {
        for (const slot of turnAfterSlots) yield* runReaction(input, ctx, slot)
      }),
  }
}
