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

import { Effect, type FileSystem, type ManagedRuntime, type Path } from "effect"
import type { ExtensionClientModule, ClientContribution } from "./client-facets.js"
import { discoverTuiExtensions, type DiscoveredTuiExtension } from "./discovery"
import {
  resolveTuiExtensions,
  type LoadedTuiExtension,
  type ResolvedTuiExtensions,
} from "./resolve"

/**
 * Run an extension's Effect-typed setup against the per-provider runtime.
 * The runtime carries every TUI service the setup may yield (FileSystem,
 * Path, ClientTransport, ClientWorkspace, ClientShell, ClientComposer);
 * `runtime.runPromise` enforces dependency satisfaction dynamically.
 */
const invokeSetup = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ext: ExtensionClientModule<unknown, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime: ManagedRuntime.ManagedRuntime<any, never>,
): Promise<ReadonlyArray<ClientContribution>> => {
  // The module's R is asserted at this boundary because the type system
  // can't prove runtime-vs-module union compatibility across discovery +
  // cast; runtime.runPromise enforces it dynamically.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — runtime-loaded JS module: E and R erased; runtime.runPromise enforces dependency satisfaction
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const erased = ext.setup as Effect.Effect<ReadonlyArray<ClientContribution>, unknown, unknown>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — same erasure as above; runPromise dynamically enforces all required services exist on the runtime
  return runtime.runPromise(erased)
}

interface ImportedExtension {
  readonly module: ExtensionClientModule
  readonly kind: DiscoveredTuiExtension["kind"]
  readonly filePath: string
}

/** Import module and validate shape — does NOT call setup() */
const importExtension = async (
  entry: DiscoveredTuiExtension,
): Promise<ImportedExtension | undefined> => {
  try {
    const mod = await import(entry.filePath)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const clientModule = (mod.default ?? mod) as ExtensionClientModule

    if (typeof clientModule.id !== "string") {
      console.log(`[tui-ext] Skipping ${entry.filePath}: missing id`)
      return undefined
    }
    if (!Effect.isEffect(clientModule.setup)) {
      console.log(`[tui-ext] Skipping ${entry.filePath}: setup must be an Effect value`)
      return undefined
    }

    return { module: clientModule, kind: entry.kind, filePath: entry.filePath }
  } catch (err) {
    console.log(`[tui-ext] Failed to load ${entry.filePath}: ${err}`)
    return undefined
  }
}

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
export const loadTuiExtensions = async (opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly builtins?: ReadonlyArray<ExtensionClientModule<unknown, any>>
  readonly userDir: string
  readonly projectDir: string
  readonly disabled?: ReadonlyArray<string>
  /** ManagedRuntime that satisfies the union of services any Effect-typed
   *  setup may yield, plus `FileSystem | Path` for discovery. The TUI
   *  shell builds this with the full client-services Layer. */
  readonly runtime: ManagedRuntime.ManagedRuntime<FileSystem.FileSystem | Path.Path, never>
}): Promise<ResolvedTuiExtensions> => {
  const disabledSet = new Set(opts.disabled ?? [])

  // Discovery runs through the runtime so `FileSystem`/`Path` come from the
  // same Layer that powers Effect-typed extension setups. This is the only
  // place outside `invokeSetup` that crosses the runtime boundary.
  const discovered = await opts.runtime.runPromise(
    discoverTuiExtensions({ userDir: opts.userDir, projectDir: opts.projectDir }),
  )

  // Import user/project modules, then filter by disabled before calling setup()
  const imported = await Promise.all(discovered.map((entry) => importExtension(entry)))
  const enabled = imported
    .filter((r): r is ImportedExtension => r !== undefined)
    .filter((r) => !disabledSet.has(r.module.id))

  // Builtins: pre-imported, just filter disabled and call setup()
  const builtinLoaded: LoadedTuiExtension[] = await Promise.all(
    (opts.builtins ?? [])
      .filter((ext) => !disabledSet.has(ext.id))
      .map(async (ext) => ({
        id: ext.id,
        kind: "builtin" as const,
        filePath: `builtin:${ext.id}`,
        contributions: await invokeSetup(ext, opts.runtime),
      })),
  )

  const externalLoaded: LoadedTuiExtension[] = await Promise.all(
    enabled.map(async (ext) => ({
      id: ext.module.id,
      kind: ext.kind,
      filePath: ext.filePath,
      contributions: await invokeSetup(ext.module, opts.runtime),
    })),
  )

  const resolved = resolveTuiExtensions([...builtinLoaded, ...externalLoaded])

  if (resolved.autocompleteItems.length > 0) {
    const prefixes = resolved.autocompleteItems.map((c) => c.prefix).join(", ")
    console.log(`[tui-ext] autocomplete contributions: ${prefixes}`)
  }

  return resolved
}
