/**
 * TUI extension loader — discover → import → resolve pipeline.
 *
 * Builtins are passed as pre-imported modules (static imports at the call site)
 * so Bun's bundler includes them in compiled binaries. User/project extensions
 * are discovered via filesystem scan and dynamic import().
 *
 * `*-boundary.ts` per the `no-runpromise-outside-boundary` lint rule:
 * `runtime.runPromise` calls live inside this file because the loader runs
 * each extension's Effect-typed setup at the boundary between the JS module
 * world and the Effect runtime.
 */

import { Effect, Schema } from "effect"
import type {
  AnyExtensionClientModule,
  ClientContributions,
  ClientRuntime,
} from "./client-facets.js"
import { ClientSetupError } from "./client-effect.js"
import { discoverTuiExtensions, type DiscoveredTuiExtension } from "./discovery"
import {
  resolveTuiExtensions,
  type LoadedTuiExtension,
  type ResolvedTuiExtensions,
} from "./resolve"

const getClientModuleError = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return "module must export an object"
  const id = Reflect.get(value, "id")
  if (typeof id !== "string") return "missing id"
  const setup = Reflect.get(value, "setup")
  if (!Effect.isEffect(setup)) return "setup must be an Effect value"
  return undefined
}

const isExtensionClientModule = (value: unknown): value is AnyExtensionClientModule =>
  getClientModuleError(value) === undefined

class TuiExtensionImportError extends Schema.TaggedErrorClass<TuiExtensionImportError>()(
  "TuiExtensionImportError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * Run an extension's Effect-typed setup against the per-provider runtime.
 * The runtime carries every TUI service the setup may yield (FileSystem,
 * Path, ClientTransport, ClientWorkspace, ClientShell, ClientComposer);
 * `runtime.runPromise` enforces dependency satisfaction dynamically.
 */
const invokeSetup = (
  ext: AnyExtensionClientModule,
  runtime: ClientRuntime,
): Promise<ClientContributions> => runtime.runPromise(ext.setup)

const discoverExtensionsWithRuntime = (
  runtime: ClientRuntime,
  params: { userDir: string; projectDir: string },
): Promise<ReadonlyArray<DiscoveredTuiExtension>> =>
  runtime.runPromise(
    discoverTuiExtensions({ userDir: params.userDir, projectDir: params.projectDir }),
  )

interface ImportedExtension {
  readonly module: AnyExtensionClientModule
  readonly scope: DiscoveredTuiExtension["scope"]
  readonly filePath: string
}

const setupLoadedExtension = (params: {
  readonly module: AnyExtensionClientModule
  readonly scope: LoadedTuiExtension["scope"]
  readonly filePath: string
  readonly runtime: ClientRuntime
}): Effect.Effect<LoadedTuiExtension | undefined> =>
  Effect.tryPromise({
    try: () =>
      invokeSetup(params.module, params.runtime).then((contributions) => ({
        id: params.module.id,
        scope: params.scope,
        filePath: params.filePath,
        contributions,
      })),
    catch: (cause) =>
      new ClientSetupError({
        extensionId: params.module.id,
        message: `Setup failed for ${params.module.id}`,
        cause,
      }),
  }).pipe(
    Effect.catch((cause: ClientSetupError) =>
      Effect.log(`[tui-ext] Setup failed for ${params.filePath}: ${cause.message}`).pipe(
        Effect.as(undefined),
      ),
    ),
  )

/** Import module and validate shape — does NOT call setup() */
const importExtension = (
  entry: DiscoveredTuiExtension,
): Effect.Effect<ImportedExtension | undefined> =>
  Effect.gen(function* () {
    const mod = yield* Effect.tryPromise({
      // gent/no-dynamic-imports: allow TUI extension modules are discovered from user/project files at runtime
      try: () => import(entry.filePath),
      catch: (cause) =>
        new TuiExtensionImportError({
          message: `Failed to load ${entry.filePath}`,
          cause,
        }),
    })
    const candidate = mod.default ?? mod

    const error = getClientModuleError(candidate)
    if (error !== undefined || !isExtensionClientModule(candidate)) {
      yield* Effect.log(`[tui-ext] Skipping ${entry.filePath}: ${error ?? "invalid module shape"}`)
      return undefined
    }

    return { module: candidate, scope: entry.scope, filePath: entry.filePath }
  }).pipe(
    Effect.catch((err: TuiExtensionImportError) =>
      Effect.log(`[tui-ext] Failed to load ${entry.filePath}: ${err}`).pipe(Effect.as(undefined)),
    ),
  )

/**
 * Load all TUI extensions: discover files, import modules, resolve with scope precedence.
 *
 * @param opts.builtins — pre-imported builtin modules (static imports for bundler reachability)
 * @param opts.disabled — extension ids to skip (applies to builtins and discovered alike).
 *   Discovered extensions are imported to read their id, but setup() is skipped when disabled.
 *
 * Discovery uses `FileSystem` and `Path` from the runtime — the loader does
 * NOT take `fs`/`path` parameters. Any runtime that satisfies
 * `FileSystem | Path | <other services>` works.
 */
export const loadTuiExtensions = (opts: {
  readonly builtins?: ReadonlyArray<AnyExtensionClientModule>
  readonly userDir: string
  readonly projectDir: string
  readonly disabled?: ReadonlyArray<string>
  /** ManagedRuntime that satisfies the union of services any Effect-typed
   *  setup may yield, plus `FileSystem | Path` for discovery. The TUI
   *  shell builds this with the full client-services Layer. */
  readonly runtime: ClientRuntime
}): Promise<ResolvedTuiExtensions> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const disabledSet = new Set(opts.disabled ?? [])

      // Discovery runs through the runtime so `FileSystem`/`Path` come from the
      // same Layer that powers Effect-typed extension setups. This is the only
      // place outside `invokeSetup` that crosses the runtime boundary.
      const discovered = yield* Effect.promise(() =>
        discoverExtensionsWithRuntime(opts.runtime, {
          userDir: opts.userDir,
          projectDir: opts.projectDir,
        }),
      )

      // Import user/project modules, then filter by disabled before calling setup()
      const imported = yield* Effect.all(discovered.map((entry) => importExtension(entry)))
      const enabled = imported
        .filter((r): r is ImportedExtension => r !== undefined)
        .filter((r) => !disabledSet.has(r.module.id))

      // Builtins: pre-imported, just filter disabled and call setup()
      const builtinLoaded: LoadedTuiExtension[] = yield* Effect.all(
        (opts.builtins ?? [])
          .filter((ext) => !disabledSet.has(ext.id))
          .map((ext) =>
            setupLoadedExtension({
              module: ext,
              scope: "builtin",
              filePath: `builtin:${ext.id}`,
              runtime: opts.runtime,
            }),
          ),
      ).pipe(Effect.map((loaded) => loaded.filter((ext) => ext !== undefined)))

      const externalLoaded: LoadedTuiExtension[] = yield* Effect.all(
        enabled.map((ext) =>
          setupLoadedExtension({
            module: ext.module,
            scope: ext.scope,
            filePath: ext.filePath,
            runtime: opts.runtime,
          }),
        ),
      ).pipe(Effect.map((loaded) => loaded.filter((ext) => ext !== undefined)))

      const resolved = resolveTuiExtensions([...builtinLoaded, ...externalLoaded])

      if (resolved.autocompleteItems.length > 0) {
        const prefixes = resolved.autocompleteItems.map((c) => c.prefix).join(", ")
        yield* Effect.log(`[tui-ext] autocomplete contributions: ${prefixes}`)
      }

      return resolved
    }),
  )
