import { Effect, Layer } from "effect"
import type { Exit, FileSystem, Path, Schema } from "effect"
import type { ExtensionId, ToolCallId } from "../../domain/ids.js"
import type { ExtensionTurnContext } from "../../domain/extension.js"
import { type ExtensionContext, provideExtensionServices } from "../../domain/extension-services.js"
import { CurrentExtensionHostContext } from "../agent/current-extension-host-context.js"
import { provideExtensionCapabilityContext } from "./extension-capability-context.js"

type ErasedValue = Schema.Schema.Type<typeof Schema.Unknown>

export interface ErasedEffectHandlers<A, E> {
  // This alias marks the intentional unknown channel at the single host
  // membrane. The extension effect is parsed or handled after this point.
  readonly onFailure: (error: ErasedValue) => Effect.Effect<A, E>
  readonly onDefect: (defect: ErasedValue) => Effect.Effect<A, E>
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
): Effect.Effect<A, E> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const sealed = Effect.suspend(effect).pipe(
    Effect.catchEager(handlers.onFailure),
    Effect.catchDefect(handlers.onDefect),
  )
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  return sealed as Effect.Effect<A, E> // oxlint-disable-line effect/noAs, typescript/no-unsafe-type-assertion -- The membrane re-seals the extension effect after erasing its runtime channels. // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
}

/**
 * Variant for hosts that need the raw `Exit` to apply local failure policy
 * (`continue` / `isolate` / `halt`, lifecycle finalizer behavior, etc.).
 */
export const exitErasedEffect = <A>(
  effect: () => Effect.Effect<A, unknown, unknown>,
): Effect.Effect<Exit.Exit<A, unknown>> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const exit = Effect.exit(Effect.suspend(effect))
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  return exit as Effect.Effect<Exit.Exit<A, unknown>> // oxlint-disable-line effect/noAs, typescript/no-unsafe-type-assertion -- The membrane exposes the raw exit after erasing the extension effect channels. // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedResourceLayer = Layer.Layer<any, never, never>

/**
 * Resource-host call sites keep the old narrower return type (`Layer.Layer<any>`)
 * so resource layers do not leak their heterogeneous error or requirement
 * channels into tests.
 */
export const eraseResourceLayer = <A, E, R>(layer: Layer.Layer<A, E, R>): ErasedResourceLayer => {
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The resource membrane intentionally erases heterogeneous service output and requirements.
  const erased = layer as unknown as ErasedResourceLayer // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  return erased
}

// oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The empty layer is the erased identity for heterogeneous resource composition.
export const emptyErasedResourceLayer: ErasedResourceLayer = Layer.empty as ErasedResourceLayer

/** Per-leaf facts layered over the current run's host context. */
export interface ExtensionLeafFrame {
  readonly extensionId?: ExtensionId
  readonly toolCallId?: ToolCallId
  readonly turn?: ExtensionTurnContext
}

/**
 * The one boundary every extension leaf crosses: tools, requests, and hooks
 * all read the current run's host context here, receive the `ExtensionContext`
 * facets built from it plus the leaf frame, and see the run's capability
 * context. Error and requirement sealing stays with the caller because each
 * leaf kind reports failures differently.
 */
export const provideExtensionLeaf =
  (frame: ExtensionLeafFrame) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E,
    Exclude<R, ExtensionContext> | CurrentExtensionHostContext | FileSystem.FileSystem | Path.Path
  > =>
    Effect.gen(function* () {
      const host = yield* CurrentExtensionHostContext
      return yield* provideExtensionServices({ ...host, ...frame }, effect).pipe(
        provideExtensionCapabilityContext,
      )
    })
