import { Effect, Schema } from "effect"
import type { ExtensionId } from "./ids.js"
import { ExtensionLoadError } from "./extension.js"

const toExtensionLoadError = (opts: {
  readonly extensionId: ExtensionId
  readonly message: string
  readonly cause: unknown
}): ExtensionLoadError =>
  Schema.is(ExtensionLoadError)(opts.cause)
    ? opts.cause
    : new ExtensionLoadError({
        extensionId: opts.extensionId,
        message: opts.message,
        cause: opts.cause,
      })

export const sealRuntimeLoadedEffect = <A, R = never>(opts: {
  readonly extensionId: ExtensionId
  readonly effect: () => Effect.Effect<A, unknown, R>
  readonly failureMessage: (cause: unknown) => string
  readonly defectMessage: (cause: unknown) => string
}): Effect.Effect<A, ExtensionLoadError, R> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const sealed = Effect.suspend(opts.effect).pipe(
    Effect.catchEager((cause) =>
      Effect.fail(
        toExtensionLoadError({
          extensionId: opts.extensionId,
          message: opts.failureMessage(cause),
          cause,
        }),
      ),
    ),
    Effect.catchDefect((cause) =>
      Effect.fail(
        toExtensionLoadError({
          extensionId: opts.extensionId,
          message: opts.defectMessage(cause),
          cause,
        }),
      ),
    ),
  )
  return sealed as Effect.Effect<A, ExtensionLoadError, R> // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
}
