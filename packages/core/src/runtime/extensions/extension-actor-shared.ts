/**
 * Shared logic for fromMachine and fromReducer extension actors.
 *
 * Extracts buildProjectionConfig and interpretEffects — the two
 * largest shared pieces between the two actor constructors.
 */

import { Effect, type Schema } from "effect"
import type {
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import { AgentDefinition, type AgentName as AgentNameType } from "../../domain/agent.js"
import type { ExtensionTurnControlService } from "./turn-control.js"

/**
 * Build ExtensionProjectionConfig from derive/deriveUi config.
 * Identical between fromMachine and fromReducer — extracted to avoid
 * maintaining two copies of the sentinel + fallback logic.
 */
export const buildProjectionConfig = <State>(config: {
  derive?: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  deriveUi?: (state: State) => unknown
  uiModelSchema?: Schema.Any
}): ExtensionProjectionConfig | undefined => {
  const deriveFn = config.derive
  const deriveUiFn = config.deriveUi
  if (deriveFn === undefined && deriveUiFn === undefined) return undefined

  let deriveTurn: ExtensionProjectionConfig["deriveTurn"]
  if (deriveFn !== undefined) {
    deriveTurn = (state: unknown, deriveCtx: ExtensionDeriveContext) => {
      const { uiModel: _, ...turn } = deriveFn(state as State, deriveCtx)
      return turn
    }
  }

  let deriveUi: ExtensionProjectionConfig["deriveUi"]
  if (deriveUiFn !== undefined) {
    deriveUi = (state: unknown) => deriveUiFn(state as State)
  } else if (deriveFn !== undefined) {
    const sentinel = new AgentDefinition({
      name: "__derive_ui__" as AgentNameType,
      kind: "system",
    })
    deriveUi = (state: unknown) =>
      deriveFn(state as State, { agent: sentinel, allTools: [] }).uiModel
  }

  return { deriveTurn, deriveUi, uiModelSchema: config.uiModelSchema }
}

/**
 * Interpret extension effects — shared by fromReducer and fromMachine.
 * Each effect is wrapped in catchDefect to prevent one bad effect from
 * crashing the actor.
 */
export const interpretEffects = (
  effects: ReadonlyArray<ExtensionEffect>,
  sessionId: SessionId,
  branchId: BranchId | undefined,
  turnControl: ExtensionTurnControlService,
  persistFn?: () => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const effect of effects) {
      switch (effect._tag) {
        case "QueueFollowUp":
          if (branchId !== undefined) {
            yield* turnControl
              .queueFollowUp({
                sessionId,
                branchId,
                content: effect.content,
                metadata: effect.metadata,
              })
              .pipe(Effect.catchDefect(() => Effect.void))
          }
          break
        case "Interject":
          if (branchId !== undefined) {
            yield* turnControl
              .interject({ sessionId, branchId, content: effect.content })
              .pipe(Effect.catchDefect(() => Effect.void))
          }
          break
        case "Persist":
          if (persistFn !== undefined) {
            yield* persistFn().pipe(Effect.catchDefect(() => Effect.void))
          }
          break
      }
    }
  })
