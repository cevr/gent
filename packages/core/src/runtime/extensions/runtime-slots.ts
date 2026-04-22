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
import type {
  AnyPipelineContribution,
  PipelineHandler,
  PipelineInput,
  PipelineKey,
  PipelineOutput,
} from "../../domain/pipeline.js"
import type { AnyProjectionContribution, ProjectionTurnContext } from "../../domain/projection.js"
import type { ResourceReaction, ResourceRuntimeSlots } from "../../domain/resource.js"
import type {
  AnySubscriptionContribution,
  SubscriptionEvent,
  SubscriptionFailureMode,
  SubscriptionHandler,
  SubscriptionKey,
} from "../../domain/subscription.js"

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

interface RegisteredSubscription<K extends SubscriptionKey> {
  readonly extensionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: SubscriptionHandler<K, any, any>
  readonly failureMode: SubscriptionFailureMode
}

type PipelineChains = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in PipelineKey]: Array<PipelineHandler<K, any, any>>
}

type SubscriptionRegistry = {
  [K in SubscriptionKey]: Array<RegisteredSubscription<K>>
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

const sortExtensions = (extensions: ReadonlyArray<LoadedExtension>) =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const emptyPipelineChains = (): PipelineChains => ({
  "prompt.system": [],
  "tool.execute": [],
  "permission.check": [],
  "context.messages": [],
  "tool.result": [],
  "message.input": [],
})

const emptySubscriptionRegistry = (): SubscriptionRegistry => ({
  "turn.before": [],
  "turn.after": [],
  "message.output": [],
})

const composePipelineChain = <K extends PipelineKey>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain: ReadonlyArray<PipelineHandler<K, any, any>>,
  base: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>,
  ctx: ExtensionHostContext,
): ((input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>) => {
  let next: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>> = base
  for (const handler of chain) {
    const previous = next
    next = (input) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — legacy pipeline R/E erased at runtime-slot boundary
      Effect.suspend(
        () =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          handler(input, previous, ctx) as Effect.Effect<PipelineOutput<K>>,
      ).pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning("extension.pipeline.defect").pipe(
            Effect.annotateLogs({ hook: String(handler.name ?? "anon"), defect: String(defect) }),
            Effect.andThen(previous(input)),
          ),
        ),
      )
  }
  return next
}

const emitLegacySubscription = <K extends SubscriptionKey>(
  event: K,
  payload: SubscriptionEvent<K>,
  ctx: ExtensionHostContext,
  registry: SubscriptionRegistry,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const subs = registry[event]
    for (const sub of subs) {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — legacy subscription R/E erased at runtime-slot boundary
      const result = yield* Effect.exit(
        Effect.suspend(
          () =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            sub.handler(payload, ctx) as Effect.Effect<void>,
        ),
      )
      if (result._tag === "Success") continue
      const cause = result.cause
      switch (sub.failureMode) {
        case "continue":
          yield* Effect.logDebug("extension.subscription.failed").pipe(
            Effect.annotateLogs({
              event,
              extensionId: sub.extensionId,
              cause: Cause.pretty(cause),
            }),
          )
          continue
        case "isolate":
          yield* Effect.logWarning("extension.subscription.failed").pipe(
            Effect.annotateLogs({
              event,
              extensionId: sub.extensionId,
              cause: Cause.pretty(cause),
            }),
          )
          continue
        case "halt":
          yield* Effect.logError("extension.subscription.halt").pipe(
            Effect.annotateLogs({
              event,
              extensionId: sub.extensionId,
              cause: Cause.pretty(cause),
            }),
          )
          return yield* Effect.die(Cause.squash(cause))
      }
    }
  })

const runProjectionQuery = (
  extensionId: string,
  projectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (ctx: ProjectionTurnContext) => Effect.Effect<any, any, any>,
  ctx: ProjectionTurnContext,
) =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — projection R/E erased at runtime-slot boundary
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  (query(ctx) as Effect.Effect<unknown, unknown>).pipe(
    Effect.catchEager((error) =>
      Effect.logWarning("extension.runtime-slot.query.failed").pipe(
        Effect.annotateLogs({ extensionId, projectionId, error: String(error) }),
        Effect.as(undefined),
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.logWarning("extension.runtime-slot.query.defect").pipe(
        Effect.annotateLogs({ extensionId, projectionId, defect: String(defect) }),
        Effect.as(undefined),
      ),
    ),
  )

const runReaction = <Input>(
  input: Input,
  ctx: ExtensionHostContext,
  reaction: RegisteredReaction<Input>,
) =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — reaction R/E erased at runtime-slot boundary
    const exit = yield* Effect.exit(
      Effect.suspend(
        () =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          reaction.slot.handler(input, ctx) as Effect.Effect<void>,
      ),
    )
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
  const pipelineChains = emptyPipelineChains()
  const subscriptionRegistry = emptySubscriptionRegistry()
  const systemPromptSlots: ProjectionSystemPromptSlot[] = []
  const contextMessageSlots: ProjectionContextMessagesSlot[] = []
  const turnBeforeSlots: RegisteredReaction<TurnBeforeInput>[] = []
  const turnAfterSlots: RegisteredReaction<TurnAfterInput>[] = []
  const messageOutputSlots: RegisteredReaction<MessageOutputInput>[] = []
  const toolResultSlots: RegisteredToolResultTransform[] = []

  for (const ext of sorted) {
    for (const contribution of ext.contributions.pipelines ?? []) {
      const c = contribution as AnyPipelineContribution
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      ;(pipelineChains[c.hook] as Array<unknown>).push(c.handler as unknown)
    }

    for (const contribution of ext.contributions.subscriptions ?? []) {
      const c = contribution as AnySubscriptionContribution
      subscriptionRegistry[c.event].push({
        extensionId: ext.manifest.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        handler: c.handler as RegisteredSubscription<typeof c.event>["handler"],
        failureMode: c.failureMode,
      } as RegisteredSubscription<typeof c.event>)
    }

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

  const runLegacyPipeline = <K extends PipelineKey>(
    key: K,
    input: PipelineInput<K>,
    base: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>,
    ctx: ExtensionHostContext,
  ): Effect.Effect<PipelineOutput<K>> => {
    const chain = pipelineChains[key]
    if (chain.length === 0) return base(input)
    return composePipelineChain(chain, base, ctx)(input)
  }

  return {
    normalizeMessageInput: (input, ctx) =>
      runLegacyPipeline("message.input", input, (state) => Effect.succeed(state.content), ctx),

    checkPermission: (input, base, ctx) => runLegacyPipeline("permission.check", input, base, ctx),

    resolveContextMessages: (input, ctx) =>
      Effect.gen(function* () {
        const legacy = yield* runLegacyPipeline(
          "context.messages",
          input,
          (state) => Effect.succeed(state.messages),
          ctx.host,
        )
        let current: ReadonlyArray<Message> = legacy
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
        const legacy = yield* runLegacyPipeline(
          "prompt.system",
          input,
          (state) => Effect.succeed(state.basePrompt),
          ctx.host,
        )
        let current = legacy
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

    executeTool: (input, base, ctx) => runLegacyPipeline("tool.execute", input, base, ctx),

    transformToolResult: (input, ctx) =>
      Effect.gen(function* () {
        const legacy = yield* runLegacyPipeline(
          "tool.result",
          input,
          (state) => Effect.succeed(state.result),
          ctx,
        )
        let current: unknown = legacy
        for (const slot of toolResultSlots) {
          const next = yield* (
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — resource runtime slot R/E erased at runtime-slot boundary
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            (slot.handler({ ...input, result: current }, ctx) as Effect.Effect<unknown>).pipe(
              Effect.catchEager((error) =>
                Effect.logWarning("extension.runtime-slot.tool-result.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.logWarning("extension.runtime-slot.tool-result.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
              ),
            )
          )
          current = next
        }
        return current
      }) as Effect.Effect<unknown>,

    emitTurnBefore: (input, ctx) =>
      Effect.gen(function* () {
        yield* emitLegacySubscription("turn.before", input, ctx, subscriptionRegistry)
        for (const slot of turnBeforeSlots) yield* runReaction(input, ctx, slot)
      }),

    emitTurnAfter: (input, ctx) =>
      Effect.gen(function* () {
        yield* emitLegacySubscription("turn.after", input, ctx, subscriptionRegistry)
        for (const slot of turnAfterSlots) yield* runReaction(input, ctx, slot)
      }),

    emitMessageOutput: (input, ctx) =>
      Effect.gen(function* () {
        yield* emitLegacySubscription("message.output", input, ctx, subscriptionRegistry)
        for (const slot of messageOutputSlots) yield* runReaction(input, ctx, slot)
      }),
  }
}
