import { Cause, Effect, type FileSystem, type Path } from "effect"
import {
  SCOPE_PRECEDENCE,
  type ExtensionReaction,
  type ExtensionReactions,
  type ExtensionHookSlot,
  type LoadedExtension,
  type SystemPromptInput,
  type ToolCallInput,
  type ToolCallPreflightResult,
  type ToolPolicyFragment,
  type ToolResultInput,
  type TurnAfterInput,
  type ProjectionTurnContext,
} from "../../domain/extension.js"
import type { ExtensionId } from "../../domain/ids.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { PromptSection } from "../../domain/prompt.js"
import { type ExtensionContext, provideExtensionServices } from "../../domain/extension-services.js"
import { exitErasedEffect, sealErasedEffect } from "./extension-effect-membrane.js"
import {
  CurrentProjectionReactionContext,
  CurrentReactionHostContext,
} from "./extension-reaction-context.js"
import { provideExtensionCapabilityContext } from "./extension-capability-context.js"
export type { ExtensionReactionContext } from "./extension-reaction-context.js"

export interface CompiledExtensionReactions {
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
  ) => Effect.Effect<string, never, CurrentReactionHostContext>
  readonly resolveTurnProjection: () => Effect.Effect<
    ExtensionTurnProjection,
    never,
    CurrentReactionHostContext | CurrentProjectionReactionContext
  >
  readonly transformToolResult: (
    input: ToolResultInput,
  ) => Effect.Effect<unknown, never, CurrentReactionHostContext>
  readonly preflightToolCall: (
    input: ToolCallInput,
  ) => Effect.Effect<ToolCallPreflightResult, never, CurrentReactionHostContext>
  readonly emitTurnAfter: (
    input: TurnAfterInput,
  ) => Effect.Effect<void, never, CurrentReactionHostContext>
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
  readonly handler: (input: ToolResultInput) => Effect.Effect<unknown, unknown, unknown>
}

interface RegisteredToolCallPreflight {
  readonly extensionId: ExtensionId
  readonly handler: (input: ToolCallInput) => Effect.Effect<ToolCallPreflightResult>
}

const sortExtensions = (extensions: ReadonlyArray<LoadedExtension>) =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const runReaction = <Input>(input: Input, reaction: RegisteredReaction<Input>) =>
  Effect.gen(function* () {
    const ctx = yield* CurrentReactionHostContext
    const exit = yield* exitErasedEffect(() =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      provideLifecycleHostContext(ctx, reaction.slot.handler(input)),
    )
    if (exit._tag === "Success") return
    yield* Effect.logWarning("extension.reaction.handler.failed").pipe(
      Effect.annotateLogs({
        extensionId: reaction.extensionId,
        cause: Cause.pretty(exit.cause),
      }),
    )
  })

const provideLifecycleHostContext = <A, E, R>(
  ctx: ExtensionHostContext & { readonly turn?: ProjectionTurnContext["turn"] },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext> | FileSystem.FileSystem | Path.Path> =>
  provideExtensionServices(ctx, effect).pipe(provideExtensionCapabilityContext)

const provideProjectionContext = <A, E, R>(
  projection: ProjectionTurnContext,
  host: ExtensionHostContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext> | FileSystem.FileSystem | Path.Path> => {
  const hostCtx: ExtensionHostContext & { readonly turn: ProjectionTurnContext["turn"] } = {
    ...host,
    turn: projection.turn,
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

const runTurnProjectionReaction = (slot: ReactionTurnProjectionSlot) =>
  sealErasedEffect(
    () =>
      Effect.gen(function* () {
        const projection = yield* CurrentProjectionReactionContext
        const host = yield* CurrentReactionHostContext
        return yield* provideProjectionContext(
          projection,
          host,
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          slot.handler().pipe(
            Effect.map((projection) => ({
              promptSections: projection.promptSections ?? [],
              policyFragments: projection.toolPolicy !== undefined ? [projection.toolPolicy] : [],
            })),
          ),
        )
      }),
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

const eraseHookEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- hook effects cross the extension membrane; compile-time E/R are erased and resealed by sealErasedEffect at every invocation site
  effect as Effect.Effect<A>

const collectHookSlot = (
  ext: LoadedExtension,
  slot: ExtensionHookSlot<never, never>,
  slots: {
    systemPrompt: RegisteredSystemPromptRewrite[]
    turnProjection: ReactionTurnProjectionSlot[]
    turnAfter: RegisteredReaction<TurnAfterInput>[]
    toolCall: RegisteredToolCallPreflight[]
    toolResult: RegisteredToolResultTransform[]
  },
) => {
  switch (slot.kind) {
    case "systemPrompt":
      slots.systemPrompt.push({ extensionId: ext.manifest.id, handler: slot.hook.handler })
      return
    case "turnProjection":
      slots.turnProjection.push({
        extensionId: ext.manifest.id,
        handler: () => eraseHookEffect(slot.hook.handler(undefined)),
      })
      return
    case "turnAfter":
      slots.turnAfter.push({
        extensionId: ext.manifest.id,
        slot: { handler: slot.hook.handler },
      })
      return
    case "toolCall":
      slots.toolCall.push({ extensionId: ext.manifest.id, handler: slot.hook.handler })
      return
    case "toolResult":
      slots.toolResult.push({ extensionId: ext.manifest.id, handler: slot.hook.handler })
      return
  }
}

export const compileExtensionReactions = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledExtensionReactions => {
  const sorted = sortExtensions(extensions)
  const systemPromptSlots: RegisteredSystemPromptRewrite[] = []
  const turnProjectionSlots: ReactionTurnProjectionSlot[] = []
  const turnAfterSlots: RegisteredReaction<TurnAfterInput>[] = []
  const toolResultSlots: RegisteredToolResultTransform[] = []
  const toolCallSlots: RegisteredToolCallPreflight[] = []
  const hookSlots = {
    systemPrompt: systemPromptSlots,
    turnProjection: turnProjectionSlots,
    turnAfter: turnAfterSlots,
    toolCall: toolCallSlots,
    toolResult: toolResultSlots,
  }

  for (const ext of sorted) {
    for (const slot of ext.contributions.hooks ?? []) {
      collectHookSlot(ext, slot, hookSlots)
    }
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
    resolveSystemPrompt: (input) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentReactionHostContext
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          current = yield* sealErasedEffect(
            () =>
              provideLifecycleHostContext(
                ctx,
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
      }),

    resolveTurnProjection: () =>
      Effect.gen(function* () {
        const sectionsById = new Map<string, PromptSection>()
        const policyFragments: ToolPolicyFragment[] = []

        for (const slot of turnProjectionSlots) {
          collectTurnProjection(
            yield* runTurnProjectionReaction(slot),
            sectionsById,
            policyFragments,
          )
        }

        return { promptSections: [...sectionsById.values()], policyFragments }
      }),

    transformToolResult: (input) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentReactionHostContext
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
      }),

    preflightToolCall: (input) =>
      Effect.gen(function* () {
        for (const slot of toolCallSlots) {
          const ctx = yield* CurrentReactionHostContext
          const decision = yield* sealErasedEffect(
            () => provideLifecycleHostContext(ctx, eraseHookEffect(slot.handler(input))),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.reaction.tool-call.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(undefined),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.reaction.tool-call.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(undefined),
                ),
            },
          )
          if (decision?._tag === "deny") return decision
        }
      }),

    emitTurnAfter: (input) =>
      Effect.gen(function* () {
        for (const slot of turnAfterSlots) yield* runReaction(input, slot)
      }),
  }
}
