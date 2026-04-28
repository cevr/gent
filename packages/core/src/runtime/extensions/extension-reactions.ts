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
} from "../../domain/extension.js"
import type { ExtensionId } from "../../domain/ids.js"
import type { ServiceKey } from "../../domain/actor.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { Message } from "../../domain/message.js"
import type { PermissionResult } from "../../domain/permission.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { AnyProjectionContribution, ProjectionTurnContext } from "../../domain/projection.js"
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

interface ProjectionSystemPromptSlot {
  readonly extensionId: ExtensionId
  readonly projectionId: string
  readonly query: AnyProjectionContribution["query"]
  readonly systemPrompt: NonNullable<AnyProjectionContribution["systemPrompt"]>
}

interface ProjectionTurnSlot {
  readonly extensionId: ExtensionId
  readonly projectionId: string
  readonly query: AnyProjectionContribution["query"]
  readonly prompt?: NonNullable<AnyProjectionContribution["prompt"]>
  readonly policy?: NonNullable<AnyProjectionContribution["policy"]>
}

interface RegisteredActorRoute {
  readonly extensionId: ExtensionId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ServiceKey<M> is contravariant; storage erases M
  readonly serviceKey: ServiceKey<any>
}

interface ProjectionContextMessagesSlot {
  readonly extensionId: ExtensionId
  readonly projectionId: string
  readonly query: AnyProjectionContribution["query"]
  readonly contextMessages: NonNullable<AnyProjectionContribution["contextMessages"]>
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

const collectActorRoutes = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredActorRoute> => {
  const routes: RegisteredActorRoute[] = []
  for (const ext of sortExtensions(extensions)) {
    const explicit = ext.contributions.actorRoute
    if (explicit !== undefined) {
      routes.push({ extensionId: ext.manifest.id, serviceKey: explicit })
      continue
    }
    for (const behavior of ext.contributions.actors ?? []) {
      if (behavior.serviceKey === undefined) continue
      routes.push({ extensionId: ext.manifest.id, serviceKey: behavior.serviceKey })
    }
  }
  return routes
}

const runProjectionQuery = (
  extensionId: ExtensionId,
  projectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
  query: (ctx: ProjectionTurnContext) => Effect.Effect<any, any, any>,
  ctx: ProjectionTurnContext,
) =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for existential ProjectionContribution
  sealErasedEffect(() => query(ctx), {
    onFailure: (error) =>
      Effect.logWarning("extension.reaction.query.failed").pipe(
        Effect.annotateLogs({ extensionId, projectionId, error: String(error) }),
        Effect.as(undefined),
      ),
    onDefect: (defect) =>
      Effect.logWarning("extension.reaction.query.defect").pipe(
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

export const compileExtensionReactions = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledExtensionReactions => {
  const sorted = sortExtensions(extensions)
  const systemPromptSlots: ProjectionSystemPromptSlot[] = []
  const contextMessageSlots: ProjectionContextMessagesSlot[] = []
  const turnProjectionSlots: ProjectionTurnSlot[] = []
  const actorRoutes = collectActorRoutes(sorted)
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
      if (projection.prompt !== undefined || projection.policy !== undefined) {
        turnProjectionSlots.push({
          extensionId: ext.manifest.id,
          projectionId: projection.id,
          query: projection.query,
          ...(projection.prompt !== undefined ? { prompt: projection.prompt } : {}),
          ...(projection.policy !== undefined ? { policy: projection.policy } : {}),
        })
      }
    }

    const reactions = ext.contributions.reactions
    if (reactions === undefined) continue
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
                Effect.logWarning("extension.reaction.context-messages.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    projectionId: slot.projectionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.logWarning("extension.reaction.context-messages.defect").pipe(
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
                Effect.logWarning("extension.reaction.system-prompt.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    projectionId: slot.projectionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.logWarning("extension.reaction.system-prompt.defect").pipe(
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

    resolveTurnProjection: (ctx) =>
      Effect.gen(function* () {
        const sectionsById = new Map<string, PromptSection>()
        const policyFragments: ToolPolicyFragment[] = []

        for (const slot of turnProjectionSlots) {
          const value = yield* runProjectionQuery(
            slot.extensionId,
            slot.projectionId,
            slot.query,
            ctx,
          )
          if (value === undefined) continue
          const prompt = slot.prompt
          if (prompt !== undefined) {
            const sectionsExit = yield* Effect.exit(Effect.sync(() => prompt(value)))
            if (sectionsExit._tag === "Success") {
              for (const section of sectionsExit.value) sectionsById.set(section.id, section)
            } else {
              yield* Effect.logWarning("extension.reaction.prompt-projection.failed").pipe(
                Effect.annotateLogs({
                  extensionId: slot.extensionId,
                  projectionId: slot.projectionId,
                }),
              )
            }
          }
          const policy = slot.policy
          if (policy !== undefined) {
            const policyExit = yield* Effect.exit(Effect.sync(() => policy(value, ctx)))
            if (policyExit._tag === "Success") {
              policyFragments.push(policyExit.value)
            } else {
              yield* Effect.logWarning("extension.reaction.policy-projection.failed").pipe(
                Effect.annotateLogs({
                  extensionId: slot.extensionId,
                  projectionId: slot.projectionId,
                }),
              )
            }
          }
        }

        if (actorRoutes.length > 0) {
          const engine = yield* ActorEngine
          const receptionist = yield* Receptionist
          for (const route of actorRoutes) {
            const refsExit = yield* Effect.exit(receptionist.find(route.serviceKey))
            if (refsExit._tag === "Failure") {
              yield* Effect.logWarning("extension.actor-view.find.failed").pipe(
                Effect.annotateLogs({ extensionId: route.extensionId }),
              )
              continue
            }
            for (const ref of refsExit.value) {
              const viewExit = yield* Effect.exit(engine.peekView(ref))
              if (viewExit._tag === "Failure") {
                yield* Effect.logWarning("extension.actor-view.peek.failed").pipe(
                  Effect.annotateLogs({ extensionId: route.extensionId }),
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
