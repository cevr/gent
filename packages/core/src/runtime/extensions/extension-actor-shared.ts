/**
 * Shared logic for fromMachine and fromReducer extension actors.
 *
 * Extracts buildProjectionConfig and interpretEffects — the two
 * largest shared pieces between the two actor constructors.
 */

import { Effect, Schema } from "effect"
import type {
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { ExtensionTurnControlService } from "./turn-control.js"

/**
 * Typed persistence codec — wraps Schema.fromJsonString preserving the State type.
 * Eliminates `as Schema.Any` + `as State` cast pairs in from-machine and from-reducer.
 */
export const makePersistCodec = <S>(schema: Schema.Schema<S>) => {
  const jsonCodec = Schema.fromJsonString(schema as Schema.Any)
  return {
    decode: (json: string) =>
      Schema.decodeUnknownEffect(jsonCodec)(json) as Effect.Effect<S, Schema.SchemaError>,
    encode: (state: S) => Schema.encodeSync(jsonCodec)(state) as string,
  }
}

/**
 * Build ExtensionProjectionConfig from derive/deriveUi config.
 * Identical between fromMachine and fromReducer — extracted to avoid duplication.
 *
 * Merges the author-facing `derive` and `deriveUi` into a single
 * `derive(state, ctx?)` function on the runtime-facing config.
 */
export const buildProjectionConfig = <State>(config: {
  derive?: (state: State, ctx?: ExtensionDeriveContext) => ExtensionProjection
  deriveUi?: (state: State) => unknown
  uiModelSchema?: Schema.Schema<unknown>
}): ExtensionProjectionConfig | undefined => {
  const deriveFn = config.derive
  const deriveUiFn = config.deriveUi
  if (deriveFn === undefined && deriveUiFn === undefined) return undefined

  let derive: ExtensionProjectionConfig["derive"]

  if (deriveFn !== undefined && deriveUiFn !== undefined) {
    // Both provided: use derive for turn-time, deriveUi for UI-only
    derive = (state: unknown, ctx?: ExtensionDeriveContext) => {
      if (ctx !== undefined) {
        const { uiModel: _, ...turn } = deriveFn(state as State, ctx)
        return turn
      }
      return { uiModel: deriveUiFn(state as State) }
    }
  } else if (deriveFn !== undefined) {
    // Only derive — used for both turn and UI. If derive reads ctx.agent
    // and ctx is undefined, catchDefect in state-runtime handles it.
    derive = (state: unknown, ctx?: ExtensionDeriveContext) => deriveFn(state as State, ctx)
  } else if (deriveUiFn !== undefined) {
    // Only deriveUi — UI-only projection (e.g. handoff extension)
    derive = (state: unknown) => ({ uiModel: deriveUiFn(state as State) })
  }

  return { derive, uiModelSchema: config.uiModelSchema }
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
  Effect.withSpan("interpretEffects")(
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
    }),
  )
