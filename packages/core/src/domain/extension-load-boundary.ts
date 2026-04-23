import { Effect, Schema } from "effect"
import { ExtensionLoadError } from "./extension.js"

const toExtensionLoadError = (opts: {
  readonly extensionId: string
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

export const sealRuntimeLoadedEffect = <A>(opts: {
  readonly extensionId: string
  readonly effect: () => Effect.Effect<A, unknown, unknown>
  readonly failureMessage: (cause: unknown) => string
  readonly defectMessage: (cause: unknown) => string
}): Effect.Effect<A, ExtensionLoadError> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — runtime-loaded JS membrane; E/R are intentionally erased here and re-sealed to ExtensionLoadError
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  Effect.suspend(opts.effect).pipe(
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
  ) as Effect.Effect<A, ExtensionLoadError>
