import { Database } from "bun:sqlite"
import { type Cause, Effect, Option, Schema } from "effect"
import path from "node:path" // eslint-disable-line effect/noNodeBuiltinImport -- the Bun edge resolves the build record's paths as Bun wrote them.

/*
 * The TUI's whole Bun edge: the only TUI file that reads `Bun.*` or a `bun:`
 * module.
 */

// ── text width ──────────────────────────────────────────────────────────────

/** The terminal cells `text` takes. */
export const textWidth = (text: string): number => Bun.stringWidth(text)

// ── read-only sqlite ────────────────────────────────────────────────────────

/**
 * The database at `dbPath`, open read-only for the scope: each call runs one
 * query and gives its rows, undecoded. Opening a missing or corrupt file, or
 * a query that throws, fails.
 */
export const readonlySqlite = (dbPath: string) =>
  Effect.acquireRelease(
    Effect.try(() => new Database(dbPath, { readonly: true })),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.map(
      (db) =>
        (sql: string): Effect.Effect<ReadonlyArray<unknown>, Cause.UnknownError> =>
          Effect.try(() => db.query(sql).all()),
    ),
  )

// ── client extension build ──────────────────────────────────────────────────

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
 * OpenTUI's Solid plugin, loaded on the first client build: it loads Babel,
 * which a launch with no client extension file never needs. Each build
 * imports it; the module registry keeps the loaded module, and an
 * interrupted build leaves nothing behind for the next one to read.
 */
const loadSolidPlugin = Effect.tryPromise({
  // oxlint-disable-next-line effect/noDynamicImports -- Babel loads only when a client extension file compiles
  try: () => import("@opentui/solid/bun-plugin"),
  catch: (cause) => new ClientExtensionBuildError({ cause }),
})

/**
 * One client file built: the module text, its version (the text's sha256, so
 * two builds of the same code share one), and the files the build read, as
 * absolute paths.
 */
interface ClientBuild {
  readonly code: string
  readonly version: string
  readonly inputs: ReadonlyArray<string>
}

/**
 * Compile a client file and the relative modules it imports as the build
 * compiles the shipped ones (Solid JSX). Each client-only import is renamed
 * and kept external; a name in `external` stays an import too. The result is
 * one ES module. Bun's build record (`metafile`) names each file it read
 * relative to the process's directory; the output names them relative to the
 * file's own directory, so the same files build the same text.
 */
export const buildClientExtension = (
  filePath: string,
  names: ClientBuildNames,
): Effect.Effect<ClientBuild, ClientExtensionBuildError> =>
  Effect.flatMap(loadSolidPlugin, ({ createSolidTransformPlugin }) =>
    Effect.tryPromise({
      try: () =>
        Bun.build({
          entrypoints: [filePath],
          target: "bun",
          format: "esm",
          metafile: true,
          root: path.dirname(filePath),
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
    }),
  ).pipe(
    Effect.flatMap((result) =>
      Option.match(
        Option.filter(Option.fromNullishOr(result.outputs[0]), () => result.success),
        {
          onNone: () => Effect.fail(new ClientExtensionBuildError({ cause: result.logs })),
          onSome: (output) =>
            Effect.tryPromise({
              try: () => output.text(),
              catch: (cause) => new ClientExtensionBuildError({ cause }),
            }).pipe(
              Effect.map((code): ClientBuild => ({
                code,
                version: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
                inputs: Object.keys(result.metafile?.inputs ?? {}).map((input) =>
                  path.resolve(process.cwd(), input),
                ),
              })),
            ),
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
