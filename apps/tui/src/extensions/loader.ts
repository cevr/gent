/**
 * TUI extension loader — discover → import → resolve pipeline.
 *
 * Builtins are passed as pre-imported modules (static imports at the call site)
 * so Bun's bundler includes them in compiled binaries. User/project extensions
 * are discovered via filesystem scan and dynamic import().
 */

import type {
  ExtensionClientModule,
  ExtensionClientContext,
} from "@gent/core/domain/extension-client.js"
import { discoverTuiExtensions, type DiscoveredTuiExtension } from "./discovery"
import {
  resolveTuiExtensions,
  type LoadedTuiExtension,
  type ResolvedTuiExtensions,
} from "./resolve"

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

    if (typeof clientModule.setup !== "function" || typeof clientModule.id !== "string") {
      console.log(`[tui-ext] Skipping ${entry.filePath}: missing id or setup function`)
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
 */
export const loadTuiExtensions = async (
  opts: {
    readonly builtins?: ReadonlyArray<ExtensionClientModule>
    readonly userDir: string
    readonly projectDir: string
    readonly disabled?: ReadonlyArray<string>
  },
  ctx: ExtensionClientContext,
): Promise<ResolvedTuiExtensions> => {
  const disabledSet = new Set(opts.disabled ?? [])
  const discovered = await discoverTuiExtensions(opts, ctx.fs, ctx.path)

  // Import user/project modules, then filter by disabled before calling setup()
  const imported = await Promise.all(discovered.map((entry) => importExtension(entry)))
  const enabled = imported
    .filter((r): r is ImportedExtension => r !== undefined)
    .filter((r) => !disabledSet.has(r.module.id))

  // Builtins: pre-imported, just filter disabled and call setup()
  const builtinLoaded: LoadedTuiExtension[] = (opts.builtins ?? [])
    .filter((ext) => !disabledSet.has(ext.id))
    .map((ext) => ({
      id: ext.id,
      kind: "builtin" as const,
      filePath: `builtin:${ext.id}`,
      contributions: ext.setup(ctx),
    }))

  const externalLoaded: LoadedTuiExtension[] = enabled.map((ext) => ({
    id: ext.module.id,
    kind: ext.kind,
    filePath: ext.filePath,
    contributions: ext.module.setup(ctx),
  }))

  const resolved = resolveTuiExtensions([...builtinLoaded, ...externalLoaded])

  if (resolved.autocompleteItems.length > 0) {
    const prefixes = resolved.autocompleteItems.map((c) => c.prefix).join(", ")
    console.log(`[tui-ext] autocomplete contributions: ${prefixes}`)
  }

  return resolved
}
