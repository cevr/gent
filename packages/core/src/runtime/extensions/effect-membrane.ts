import { Effect } from "effect"
import type { Exit } from "effect"

export interface ErasedEffectHandlers<A, E> {
  readonly onFailure: (error: unknown) => Effect.Effect<A, E>
  readonly onDefect: (defect: unknown) => Effect.Effect<A, E>
}

/**
 * Single membrane for extension-authored `Effect<A, E, R>` values whose `E`
 * and `R` channels are intentionally erased at the host boundary.
 *
 * `Effect.suspend` is load-bearing: it captures synchronous throws during
 * effect construction so hosts do not need a second `Effect.try` wrapper just
 * to seal them.
 */
export const sealErasedEffect = <A, E>(
  effect: () => Effect.Effect<A, unknown, unknown>,
  handlers: ErasedEffectHandlers<A, E>,
  // The membrane intentionally erases the extension effect's `R` channel.
  // Callers use this ONLY at host boundaries where the extension runtime has
  // already provided the required services.
): Effect.Effect<A, E> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit erased-effect membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  Effect.suspend(effect).pipe(
    Effect.catchEager(handlers.onFailure),
    Effect.catchDefect(handlers.onDefect),
  ) as Effect.Effect<A, E>

/**
 * Variant for hosts that need the raw `Exit` to apply local failure policy
 * (`continue` / `isolate` / `halt`, lifecycle finalizer behavior, etc.).
 */
export const exitErasedEffect = <A>(
  effect: () => Effect.Effect<A, unknown, unknown>,
): Effect.Effect<Exit.Exit<A, unknown>> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit erased-effect membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  Effect.exit(Effect.suspend(effect)) as Effect.Effect<Exit.Exit<A, unknown>>
