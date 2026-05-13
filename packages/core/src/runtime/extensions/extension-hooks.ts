import { Cause, Effect, type FileSystem, type Path } from "effect"
import {
  SCOPE_PRECEDENCE,
  type ExtensionHook,
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
import { CurrentProjectionHookContext, CurrentHookHostContext } from "./extension-hook-context.js"
import { provideExtensionCapabilityContext } from "./extension-capability-context.js"
export type { ExtensionHookContext } from "./extension-hook-context.js"

export interface CompiledExtensionHooks {
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
  ) => Effect.Effect<string, never, CurrentHookHostContext>
  readonly resolveTurnProjection: () => Effect.Effect<
    ExtensionTurnProjection,
    never,
    CurrentHookHostContext | CurrentProjectionHookContext
  >
  readonly transformToolResult: (
    input: ToolResultInput,
  ) => Effect.Effect<unknown, never, CurrentHookHostContext>
  readonly preflightToolCall: (
    input: ToolCallInput,
  ) => Effect.Effect<ToolCallPreflightResult, never, CurrentHookHostContext>
  readonly emitTurnAfter: (
    input: TurnAfterInput,
  ) => Effect.Effect<void, never, CurrentHookHostContext>
}

export interface ExtensionTurnProjection {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
}

interface RegisteredSystemPromptRewrite {
  readonly extensionId: ExtensionId
  readonly handler: ExtensionHook<SystemPromptInput, string, unknown, unknown>["handler"]
}

interface HookTurnProjectionSlot {
  readonly extensionId: ExtensionId
  readonly handler: () => Effect.Effect<
    {
      readonly promptSections?: ReadonlyArray<PromptSection>
      readonly toolPolicy?: ToolPolicyFragment
    },
    unknown,
    unknown
  >
}

interface RegisteredHook<Input> {
  readonly extensionId: ExtensionId
  readonly handler: (input: Input) => Effect.Effect<void, unknown, unknown>
}

interface RegisteredToolResultTransform {
  readonly extensionId: ExtensionId
  readonly handler: (input: ToolResultInput) => Effect.Effect<unknown, unknown, unknown>
}

interface RegisteredToolCallPreflight {
  readonly extensionId: ExtensionId
  readonly handler: (
    input: ToolCallInput,
  ) => Effect.Effect<ToolCallPreflightResult, unknown, unknown>
}

const sortExtensions = (extensions: ReadonlyArray<LoadedExtension>) =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const runHook = <Input>(input: Input, registered: RegisteredHook<Input>) =>
  Effect.gen(function* () {
    const ctx = yield* CurrentHookHostContext
    const exit = yield* exitErasedEffect(() =>
      provideLifecycleHostContext(
        { ...ctx, extensionId: registered.extensionId },
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        registered.handler(input),
      ),
    )
    if (exit._tag === "Success") return
    yield* Effect.logWarning("extension.hook.handler.failed").pipe(
      Effect.annotateLogs({
        extensionId: registered.extensionId,
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
  extensionId: ExtensionId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext> | FileSystem.FileSystem | Path.Path> => {
  const hostCtx: ExtensionHostContext & { readonly turn: ProjectionTurnContext["turn"] } = {
    ...host,
    extensionId,
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

const runTurnProjectionHook = (slot: HookTurnProjectionSlot) =>
  sealErasedEffect(
    () =>
      Effect.gen(function* () {
        const projection = yield* CurrentProjectionHookContext
        const host = yield* CurrentHookHostContext
        return yield* provideProjectionContext(
          projection,
          host,
          slot.extensionId,
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
        Effect.logWarning("extension.hook.turn-projection.failed").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            error: String(error),
          }),
          Effect.as(undefined),
        ),
      onDefect: (defect) =>
        Effect.logWarning("extension.hook.turn-projection.defect").pipe(
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
    turnProjection: HookTurnProjectionSlot[]
    turnAfter: RegisteredHook<TurnAfterInput>[]
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
        handler: slot.hook.handler,
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

export const compileExtensionHooks = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledExtensionHooks => {
  const sorted = sortExtensions(extensions)
  const systemPromptSlots: RegisteredSystemPromptRewrite[] = []
  const turnProjectionSlots: HookTurnProjectionSlot[] = []
  const turnAfterSlots: RegisteredHook<TurnAfterInput>[] = []
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
  }

  return {
    resolveSystemPrompt: (input) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentHookHostContext
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          current = yield* sealErasedEffect(
            () =>
              provideLifecycleHostContext(
                { ...ctx, extensionId: slot.extensionId },
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off
                slot.handler({ ...input, basePrompt: current }),
              ),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.hook.system-prompt.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.hook.system-prompt.defect").pipe(
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
          collectTurnProjection(yield* runTurnProjectionHook(slot), sectionsById, policyFragments)
        }

        return { promptSections: [...sectionsById.values()], policyFragments }
      }),

    transformToolResult: (input) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentHookHostContext
        let current: unknown = input.result
        for (const slot of toolResultSlots) {
          const next = yield* sealErasedEffect(
            () =>
              provideLifecycleHostContext(
                { ...ctx, extensionId: slot.extensionId },
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for heterogeneous tool-result slot
                slot.handler({ ...input, result: current }),
              ),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.hook.tool-result.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.hook.tool-result.defect").pipe(
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
          const ctx = yield* CurrentHookHostContext
          const decision = yield* sealErasedEffect(
            () =>
              provideLifecycleHostContext(
                { ...ctx, extensionId: slot.extensionId },
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off
                eraseHookEffect(slot.handler(input)),
              ),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.hook.tool-call.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(undefined),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.hook.tool-call.defect").pipe(
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
        for (const slot of turnAfterSlots) yield* runHook(input, slot)
      }),
  }
}
