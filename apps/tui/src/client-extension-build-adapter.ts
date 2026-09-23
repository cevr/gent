import { Effect, Option, Schema } from "effect"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

/**
 * Bun's side of loading a client extension file: compile it, and bind the
 * output as a module. The loader in `extensions/loader-boundary.ts` owns which
 * names a client file reads.
 */

/** Bun could not compile a client file; `cause` is its error or its build logs. */
class ClientExtensionBuildError extends Schema.TaggedError<ClientExtensionBuildError>()(
  "ClientExtensionBuildError",
  { cause: Schema.Unknown },
) {}

/** How a client build treats the bare names its files import. */
export interface ClientBuildNames {
  /** Names left as imports of the running modules. */
  readonly external: ReadonlyArray<string>
  /** The bound name a client-only import becomes, if the name is one. */
  readonly rename: (specifier: string) => Option.Option<string>
  /** The module the Solid JSX transform imports its runtime from. */
  readonly solidRuntime: string
}

/**
 * Compile a client file and the relative modules it imports as the build
 * compiles the shipped ones (Solid JSX). Each client-only import is renamed
 * and kept external; a name in `external` stays an import too. The result is
 * one ES module as text.
 */
export const buildClientExtension = (
  filePath: string,
  names: ClientBuildNames,
): Effect.Effect<string, ClientExtensionBuildError> =>
  Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [filePath],
        target: "bun",
        format: "esm",
        external: [...names.external],
        plugins: [
          {
            name: "gent-client-modules",
            setup: (build) => {
              build.onResolve({ filter: /^[^./]/ }, (args) =>
                Option.getOrUndefined(
                  Option.map(names.rename(args.path), (path) => ({ path, external: true })),
                ),
              )
            },
          },
          createSolidTransformPlugin({
            moduleName: names.solidRuntime,
            resolvePath: (specifier) => Option.getOrNull(names.rename(specifier)),
          }),
        ],
      }),
    catch: (cause) => new ClientExtensionBuildError({ cause }),
  }).pipe(
    Effect.flatMap((result) =>
      Option.match(
        Option.filter(Option.fromNullishOr(result.outputs[0]), () => result.success),
        {
          onNone: () => Effect.fail(new ClientExtensionBuildError({ cause: result.logs })),
          onSome: (output) =>
            Effect.tryPromise({
              try: () => output.text(),
              catch: (cause) => new ClientExtensionBuildError({ cause }),
            }),
        },
      ),
    ),
  )

/** Bind module source under a bare name, so `import(name)` evaluates it. */
export const bindModuleSource = (name: string, contents: string): Effect.Effect<void> =>
  Effect.sync(() => {
    Bun.plugin({
      name: "gent-client-extension",
      setup: (build) => {
        build.module(name, () => ({ contents, loader: "js" }))
      },
    })
  })
