/** Shared logic for extension actors. */

import { Effect, Schema, Context } from "effect"
import type { RuntimeExtensionEffect } from "./runtime-effect.js"
import type { AnyExtensionCommandMessage } from "../../domain/extension-protocol.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { ExtensionTurnControlService } from "./turn-control.js"

export class CurrentExtensionSession extends Context.Service<
  CurrentExtensionSession,
  { readonly sessionId: SessionId }
>()("@gent/core/src/runtime/extensions/extension-actor-shared/CurrentExtensionSession") {}

/**
 * Typed persistence codec — wraps Schema.fromJsonString preserving the State type.
 * Eliminates `as Schema.Any` + `as State` cast pairs in from-machine and from-reducer.
 */
export const makePersistCodec = <S>(schema: Schema.Schema<S>) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
  const jsonCodec = Schema.fromJsonString(schema as Schema.Any)
  return {
    decode: (json: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
      Schema.decodeUnknownEffect(jsonCodec)(json) as Effect.Effect<S, Schema.SchemaError>,
    encode: (state: S) => Schema.encodeSync(jsonCodec)(state) as string,
  }
}

/**
 * Interpret extension effects.
 * Each effect is wrapped in catchDefect to prevent one bad effect from
 * crashing the actor.
 */
export interface InterpretEffectsServices {
  readonly turnControl: ExtensionTurnControlService
  readonly busEmit?: (channel: string, payload: unknown) => Effect.Effect<void>
  readonly send?: (sessionId: SessionId, message: AnyExtensionCommandMessage) => Effect.Effect<void>
}

export const interpretEffects = (
  effects: ReadonlyArray<RuntimeExtensionEffect>,
  sessionId: SessionId,
  branchId: BranchId | undefined,
  services: InterpretEffectsServices,
): Effect.Effect<void> =>
  Effect.withSpan("interpretEffects")(
    Effect.gen(function* () {
      for (const effect of effects) {
        switch (effect._tag) {
          case "QueueFollowUp":
            if (branchId !== undefined) {
              yield* services.turnControl
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
              yield* services.turnControl
                .interject({ sessionId, branchId, content: effect.content })
                .pipe(Effect.catchDefect(() => Effect.void))
            }
            break
          case "BusEmit":
            if (services.busEmit !== undefined) {
              yield* services
                .busEmit(effect.channel, effect.payload)
                .pipe(Effect.catchDefect(() => Effect.void))
            }
            break
          case "Send":
            if (services.send !== undefined) {
              yield* services
                .send(sessionId, effect.message)
                .pipe(Effect.catchDefect(() => Effect.void))
            }
            break
        }
      }
    }),
  )
