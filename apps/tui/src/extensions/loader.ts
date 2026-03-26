/**
 * TUI extension loader — discover → import → resolve pipeline.
 */

import type {
  ExtensionClientModule,
  ExtensionClientContext,
} from "@gent/core/domain/extension-client.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import { discoverTuiExtensions, type DiscoveredTuiExtension } from "./discovery"
import {
  resolveTuiExtensions,
  type LoadedTuiExtension,
  type ResolvedTuiExtensions,
} from "./resolve"
import { BUILTIN_CLIENT_EXTENSIONS } from "./builtins/index"

const importExtension = async (
  entry: DiscoveredTuiExtension,
  ctx: ExtensionClientContext,
): Promise<LoadedTuiExtension | undefined> => {
  try {
    const mod = await import(entry.filePath)
    const clientModule = (mod.default ?? mod) as ExtensionClientModule<ToolRenderer>

    if (typeof clientModule.setup !== "function" || typeof clientModule.id !== "string") {
      console.log(`[tui-ext] Skipping ${entry.filePath}: missing id or setup function`)
      return undefined
    }

    return {
      id: clientModule.id,
      kind: entry.kind,
      filePath: entry.filePath,
      setup: clientModule.setup(ctx),
    }
  } catch (err) {
    console.log(`[tui-ext] Failed to load ${entry.filePath}: ${err}`)
    return undefined
  }
}

/**
 * Load all TUI extensions: discover files, import modules, resolve with scope precedence.
 *
 * @param opts.disabled — extension ids to skip (applies to builtins and discovered alike)
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

  const results = await Promise.all(discovered.map((entry) => importExtension(entry, ctx)))

  const builtins: LoadedTuiExtension[] = BUILTIN_CLIENT_EXTENSIONS.filter(
    (ext) => !disabledSet.has(ext.id),
  ).map((ext) => ({
    id: ext.id,
    kind: "builtin" as const,
    filePath: `builtin:${ext.id}`,
    setup: ext.setup(ctx),
  }))

  const external = results
    .filter((r): r is LoadedTuiExtension => r !== undefined)
    .filter((r) => !disabledSet.has(r.id))

  return resolveTuiExtensions([...builtins, ...external])
}
