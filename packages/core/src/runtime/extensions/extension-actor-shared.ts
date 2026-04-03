/**
 * Shared logic for fromMachine and fromReducer extension actors.
 *
 * Extracts buildProjectionConfig and interpretEffects — the two
 * largest shared pieces between the two actor constructors.
 */

import { Effect, Schema, ServiceMap } from "effect"
import type {
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { ExtensionTurnControlService } from "./turn-control.js"

export class CurrentExtensionSession extends ServiceMap.Service<
  CurrentExtensionSession,
  { readonly sessionId: SessionId }
>()("@gent/core/src/runtime/extensions/CurrentExtensionSession") {}

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
 * Build ExtensionProjectionConfig from a derive function.
 * Identical between fromMachine and fromReducer — extracted to avoid duplication.
 */
export const buildProjectionConfig = <State>(config: {
  derive?: (state: State, ctx?: ExtensionDeriveContext) => ExtensionProjection
  uiModelSchema?: Schema.Schema<unknown>
}): ExtensionProjectionConfig | undefined => {
  const deriveFn = config.derive
  if (deriveFn === undefined) return undefined

  return {
    derive: (state: unknown, ctx?: ExtensionDeriveContext) => deriveFn(state as State, ctx),
    uiModelSchema: config.uiModelSchema,
  }
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
