import { Cause, Effect, Option, Predicate } from "effect"
import {
  SCOPE_PRECEDENCE,
  type AnyExtensionHook,
  type ExtensionHook,
  type LoadedExtension,
  type SystemPromptInput,
  type ToolPolicyFragment,
  type TurnAfterInput,
  type ProjectionTurnContext,
} from "../../domain/extension.js"
import type { ExtensionId } from "../../domain/ids.js"
import type { PromptSection } from "../../domain/prompt.js"
import {
  exitErasedEffect,
  sealErasedEffect,
  provideExtensionLeaf,
} from "./extension-effect-membrane.js"
import type { CurrentExtensionHostContext } from "../agent/current-extension-host-context.js"

export interface CompiledExtensionHooks {
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
  ) => Effect.Effect<string, never, CurrentExtensionHostContext>
  readonly resolveTurnProjection: (
    projection: ProjectionTurnContext,
  ) => Effect.Effect<ExtensionTurnProjection, never, CurrentExtensionHostContext>
  readonly emitTurnAfter: (
    input: TurnAfterInput,
  ) => Effect.Effect<void, never, CurrentExtensionHostContext>
}

interface ExtensionTurnProjection {
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

const sortExtensions = (extensions: ReadonlyArray<LoadedExtension>) =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const runHook = <Input>(input: Input, registered: RegisteredHook<Input>) =>
  Effect.gen(function* () {
    const exit = yield* exitErasedEffect(() =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      registered.handler(input).pipe(provideExtensionLeaf({ extensionId: registered.extensionId })),
    )
    if (exit._tag === "Success") return
    yield* Effect.logWarning("extension.hook.handler.failed").pipe(
      Effect.annotateLogs({
        extensionId: registered.extensionId,
        cause: Cause.pretty(exit.cause),
      }),
    )
  })

const collectTurnProjection = (
  projection: Option.Option<ExtensionTurnProjection>,
  sectionsById: Map<string, PromptSection>,
  policyFragments: ToolPolicyFragment[],
) => {
  if (Option.isNone(projection)) return
  for (const section of projection.value.promptSections) sectionsById.set(section.id, section)
  for (const fragment of projection.value.policyFragments) policyFragments.push(fragment)
}

const runTurnProjectionHook = (slot: HookTurnProjectionSlot, projection: ProjectionTurnContext) =>
  sealErasedEffect<Option.Option<ExtensionTurnProjection>, never>(
    () =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      slot
        .handler()
        .pipe(
          Effect.map((projection) => {
            const promptSections = Option.getOrElse(
              Option.fromUndefinedOr(projection.promptSections),
              () => [],
            )
            let policyFragments: ReadonlyArray<ToolPolicyFragment> = []
            if (!Predicate.isUndefined(projection.toolPolicy)) {
              policyFragments = [projection.toolPolicy]
            }
            return Option.some({ promptSections, policyFragments })
          }),
        )
        .pipe(provideExtensionLeaf({ extensionId: slot.extensionId, turn: projection.turn })),
    {
      onFailure: (error) =>
        Effect.logWarning("extension.hook.turn-projection.failed").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            error: String(error),
          }),
          Effect.as(Option.none()),
        ),
      onDefect: (defect) =>
        Effect.logWarning("extension.hook.turn-projection.defect").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            defect: String(defect),
          }),
          Effect.as(Option.none()),
        ),
    },
  )

const eraseHookEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A> =>
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Hook effects cross the extension membrane; compile-time E/R are erased and resealed by sealErasedEffect at every invocation site.
  effect as Effect.Effect<A>

const collectHookSlot = (
  ext: LoadedExtension,
  slot: AnyExtensionHook,
  slots: {
    systemPrompt: RegisteredSystemPromptRewrite[]
    turnProjection: HookTurnProjectionSlot[]
    turnAfter: RegisteredHook<TurnAfterInput>[]
  },
) => {
  switch (slot.kind) {
    case "systemPrompt":
      slots.systemPrompt.push({ extensionId: ext.manifest.id, handler: slot.hook.handler })
      return
    case "turnProjection":
      slots.turnProjection.push({
        extensionId: ext.manifest.id,
        handler: () => eraseHookEffect(slot.hook.handler()),
      })
      return
    case "turnAfter":
      slots.turnAfter.push({
        extensionId: ext.manifest.id,
        handler: slot.hook.handler,
      })
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
  const hookSlots = {
    systemPrompt: systemPromptSlots,
    turnProjection: turnProjectionSlots,
    turnAfter: turnAfterSlots,
  }

  for (const ext of sorted) {
    for (const slot of ext.contributions.hooks ?? []) {
      collectHookSlot(ext, slot, hookSlots)
    }
  }

  return {
    resolveSystemPrompt: (input) =>
      Effect.gen(function* () {
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          current = yield* sealErasedEffect(
            () =>
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              slot
                .handler({ ...input, basePrompt: current })
                .pipe(provideExtensionLeaf({ extensionId: slot.extensionId })),
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

    resolveTurnProjection: (projection) =>
      Effect.gen(function* () {
        const sectionsById = new Map<string, PromptSection>()
        const policyFragments: ToolPolicyFragment[] = []

        for (const slot of turnProjectionSlots) {
          collectTurnProjection(
            yield* runTurnProjectionHook(slot, projection),
            sectionsById,
            policyFragments,
          )
        }

        return { promptSections: [...sectionsById.values()], policyFragments }
      }),

    emitTurnAfter: (input) =>
      Effect.gen(function* () {
        for (const slot of turnAfterSlots) yield* runHook(input, slot)
      }),
  }
}
