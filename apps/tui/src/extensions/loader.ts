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
import { BUILTIN_CLIENT_EXTENSION } from "./builtin"

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
 */
export const loadTuiExtensions = async (
  opts: {
    readonly userDir: string
    readonly projectDir: string
  },
  ctx: ExtensionClientContext,
): Promise<ResolvedTuiExtensions> => {
  const discovered = discoverTuiExtensions(opts)

  const results = await Promise.all(discovered.map((entry) => importExtension(entry, ctx)))

  const loaded: LoadedTuiExtension[] = [
    {
      id: BUILTIN_CLIENT_EXTENSION.id,
      kind: "builtin",
      filePath: "builtin",
      setup: BUILTIN_CLIENT_EXTENSION.setup(ctx),
    },
    ...results.filter((r): r is LoadedTuiExtension => r !== undefined),
  ]

  return resolveTuiExtensions(loaded)
}
