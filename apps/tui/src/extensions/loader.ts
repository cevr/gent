/**
 * TUI extension loader — discover → import → resolve pipeline.
 *
 * Builtins are passed as pre-imported modules (static imports at the call site)
 * so Bun's bundler includes them in compiled binaries. User/project extensions
 * are discovered via filesystem scan and dynamic import().
 */

import { Effect, type ManagedRuntime } from "effect"
import type {
  ExtensionClientModule,
  ExtensionClientContext,
  ClientContribution,
} from "@gent/core/domain/extension-client.js"
import type { ClientDeps } from "@gent/core/domain/client-effect.js"
import { discoverTuiExtensions, type DiscoveredTuiExtension } from "./discovery"
import {
  resolveTuiExtensions,
  type LoadedTuiExtension,
  type ResolvedTuiExtensions,
} from "./resolve"

/**
 * Bridge legacy and Effect-typed `setup` shapes (C9.1). Detects whether the
 * module's `setup` is a sync function (legacy: takes `ctx`, returns array)
 * or an Effect value (new: reads `ClientDeps`, returns array). Both shapes
 * produce `ReadonlyArray<ClientContribution>` — only the dependency channel
 * differs.
 */
const invokeSetup = async (
  ext: ExtensionClientModule,
  ctx: ExtensionClientContext,
  runtime: ManagedRuntime.ManagedRuntime<ClientDeps, never>,
): Promise<ReadonlyArray<ClientContribution>> => {
  const { setup } = ext
  if (Effect.isEffect(setup)) {
    return runtime.runPromise(setup)
  }
  return setup(ctx)
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
    // C9.1: `setup` may be either a sync `(ctx) => Array` (legacy) or an
    // Effect value (`ClientEffect<Array>` — the new shape). The bridge in
    // `invokeSetup` dispatches via `Effect.isEffect`, so we accept both
    // forms here. Rejecting only-functions would silently drop discovered
    // user/project modules using the new shape (codex C9.1 BLOCK 1).
    if (typeof clientModule.setup !== "function" && !Effect.isEffect(clientModule.setup)) {
      console.log(
        `[tui-ext] Skipping ${entry.filePath}: setup must be a function or an Effect value`,
      )
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
 * `makeCtx(id)` returns a fresh `ExtensionClientContext` whose `getSnapshotRaw`
 * reads the cache slot for that specific extension id (so paired packages
 * narrow correctly to their own snapshot shape).
 */
export const loadTuiExtensions = async (
  opts: {
    readonly builtins?: ReadonlyArray<ExtensionClientModule>
    readonly userDir: string
    readonly projectDir: string
    readonly disabled?: ReadonlyArray<string>
    /** Called once per discovered module (builtin or external) before setup runs.
     *  Lets the caller register snapshot sources, etc., before contributions execute. */
    readonly onModuleLoaded?: (module: ExtensionClientModule) => void
    /** ManagedRuntime that satisfies `ClientDeps` — required for any extension
     *  whose `setup` is an Effect (the new C9 shape). Legacy sync-function
     *  setups don't touch the runtime. */
    readonly runtime: ManagedRuntime.ManagedRuntime<ClientDeps, never>
  },
  makeCtx: (extensionId: string) => ExtensionClientContext,
  fs: ExtensionClientContext["fs"],
  path: ExtensionClientContext["path"],
): Promise<ResolvedTuiExtensions> => {
  const disabledSet = new Set(opts.disabled ?? [])
  const discovered = await discoverTuiExtensions(opts, fs, path)

  // Import user/project modules, then filter by disabled before calling setup()
  const imported = await Promise.all(discovered.map((entry) => importExtension(entry)))
  const enabled = imported
    .filter((r): r is ImportedExtension => r !== undefined)
    .filter((r) => !disabledSet.has(r.module.id))

  // Notify caller of every enabled discovered module before setup runs.
  for (const r of enabled) {
    opts.onModuleLoaded?.(r.module)
  }

  // Builtins: pre-imported, just filter disabled and call setup()
  const builtinLoaded: LoadedTuiExtension[] = await Promise.all(
    (opts.builtins ?? [])
      .filter((ext) => !disabledSet.has(ext.id))
      .map(async (ext) => ({
        id: ext.id,
        kind: "builtin" as const,
        filePath: `builtin:${ext.id}`,
        contributions: await invokeSetup(ext, makeCtx(ext.id), opts.runtime),
      })),
  )

  const externalLoaded: LoadedTuiExtension[] = await Promise.all(
    enabled.map(async (ext) => ({
      id: ext.module.id,
      kind: ext.kind,
      filePath: ext.filePath,
      contributions: await invokeSetup(ext.module, makeCtx(ext.module.id), opts.runtime),
    })),
  )

  const resolved = resolveTuiExtensions([...builtinLoaded, ...externalLoaded])

  if (resolved.autocompleteItems.length > 0) {
    const prefixes = resolved.autocompleteItems.map((c) => c.prefix).join(", ")
    console.log(`[tui-ext] autocomplete contributions: ${prefixes}`)
  }

  return resolved
}
