/**
 * TUI extension loader — discover → import → resolve pipeline.
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
import { BUILTIN_CLIENT_EXTENSIONS } from "./builtins/index"

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
 * @param opts.disabled — extension ids to skip (applies to builtins and discovered alike).
 *   Disabled extensions are not imported or setup() is not called.
 */
export const loadTuiExtensions = async (
  opts: {
    readonly userDir: string
    readonly projectDir: string
    readonly disabled?: ReadonlyArray<string>
  },
  ctx: ExtensionClientContext,
): Promise<ResolvedTuiExtensions> => {
  const disabledSet = new Set(opts.disabled ?? [])
  const discovered = discoverTuiExtensions(opts)

  // Import modules first, then filter by disabled before calling setup()
  const imported = await Promise.all(discovered.map((entry) => importExtension(entry)))
  const enabled = imported
    .filter((r): r is ImportedExtension => r !== undefined)
    .filter((r) => !disabledSet.has(r.module.id))

  const builtins: LoadedTuiExtension[] = BUILTIN_CLIENT_EXTENSIONS.filter(
    (ext) => !disabledSet.has(ext.id),
  ).map((ext) => ({
    id: ext.id,
    kind: "builtin" as const,
    filePath: `builtin:${ext.id}`,
    setup: ext.setup(ctx),
  }))

  const external: LoadedTuiExtension[] = enabled.map((ext) => ({
    id: ext.module.id,
    kind: ext.kind,
    filePath: ext.filePath,
    setup: ext.module.setup(ctx),
  }))

  return resolveTuiExtensions([...builtins, ...external])
}
