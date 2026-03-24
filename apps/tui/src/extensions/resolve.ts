/**
 * TUI extension resolution — scope-precedence merge of all extension contributions.
 *
 * Mirrors server-side resolveExtensions() from registry.ts.
 * Precedence: project > user > builtin. Same-scope collisions throw.
 */

import type { ExtensionClientSetup } from "@gent/core/domain/extension-client.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"

export type ExtensionKind = "builtin" | "user" | "project"

const SCOPE_PRECEDENCE: Record<ExtensionKind, number> = {
  builtin: 0,
  user: 1,
  project: 2,
}

export interface LoadedTuiExtension {
  readonly id: string
  readonly kind: ExtensionKind
  readonly filePath: string
  readonly setup: ExtensionClientSetup<ToolRenderer>
}

export interface ResolvedWidget {
  readonly id: string
  readonly slot: "above-messages" | "below-messages" | "above-input" | "below-input"
  readonly priority: number
  readonly component: ToolRenderer
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ToolRenderer>
  readonly widgets: ReadonlyArray<ResolvedWidget>
  readonly commands: ReadonlyArray<Command>
  readonly overlays: Map<string, ToolRenderer>
}

interface ScopeEntry {
  readonly kind: ExtensionKind
  readonly source: string
}

/** Check for same-scope collision and throw with context */
const checkCollision = (
  prev: ScopeEntry | undefined,
  ext: LoadedTuiExtension,
  label: string,
  key: string,
): void => {
  if (prev !== undefined && prev.kind === ext.kind && prev.source !== ext.filePath) {
    throw new Error(
      `Same-scope TUI ${label} collision: "${key}" from "${prev.source}" and "${ext.filePath}" in scope "${ext.kind}"`,
    )
  }
}

const resolveRenderers = (sorted: ReadonlyArray<LoadedTuiExtension>): Map<string, ToolRenderer> => {
  const renderers = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const entry of ext.setup.tools ?? []) {
      for (const name of entry.toolNames) {
        const key = name.toLowerCase()
        checkCollision(scopes.get(key), ext, "renderer", name)
        renderers.set(key, entry.component)
        scopes.set(key, { kind: ext.kind, source: ext.filePath })
      }
    }
  }

  return renderers
}

const resolveWidgets = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): ReadonlyArray<ResolvedWidget> => {
  const widgetMap = new Map<string, ResolvedWidget>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const entry of ext.setup.widgets ?? []) {
      checkCollision(scopes.get(entry.id), ext, "widget", entry.id)
      widgetMap.set(entry.id, {
        id: entry.id,
        slot: entry.slot,
        priority: entry.priority ?? 100,
        component: entry.component,
      })
      scopes.set(entry.id, { kind: ext.kind, source: ext.filePath })
    }
  }

  return [...widgetMap.values()].sort((a, b) => a.priority - b.priority)
}

const resolveCommands = (sorted: ReadonlyArray<LoadedTuiExtension>): ReadonlyArray<Command> => {
  const commandMap = new Map<string, Command>()
  const idScopes = new Map<string, ScopeEntry>()
  const keybindScopes = new Map<string, ScopeEntry>()
  // Track which command id owns each keybind — for stripping superseded keybinds
  const keybindOwner = new Map<string, string>() // keybind → command id

  for (const ext of sorted) {
    for (const entry of ext.setup.commands ?? []) {
      checkCollision(idScopes.get(entry.id), ext, "command", entry.id)

      if (entry.keybind !== undefined) {
        const kb = entry.keybind.toLowerCase()
        checkCollision(keybindScopes.get(kb), ext, "keybind", entry.keybind)
        // Higher scope wins the keybind — strip it from the previous owner
        const prevOwnerId = keybindOwner.get(kb)
        if (prevOwnerId !== undefined) {
          const prevCmd = commandMap.get(prevOwnerId)
          if (prevCmd !== undefined) {
            commandMap.set(prevOwnerId, { ...prevCmd, keybind: undefined })
          }
        }
        keybindScopes.set(kb, { kind: ext.kind, source: ext.filePath })
        keybindOwner.set(kb, entry.id)
      }

      commandMap.set(entry.id, {
        id: entry.id,
        title: entry.title,
        category: entry.category,
        keybind: entry.keybind,
        onSelect: entry.onSelect,
      })
      idScopes.set(entry.id, { kind: ext.kind, source: ext.filePath })
    }
  }

  return [...commandMap.values()]
}

const resolveOverlays = (sorted: ReadonlyArray<LoadedTuiExtension>): Map<string, ToolRenderer> => {
  const overlays = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const entry of ext.setup.overlays ?? []) {
      checkCollision(scopes.get(entry.id), ext, "overlay", entry.id)
      overlays.set(entry.id, entry.component)
      scopes.set(entry.id, { kind: ext.kind, source: ext.filePath })
    }
  }

  return overlays
}

/**
 * Resolve all TUI extension contributions with scope precedence.
 * Higher scope wins for same key. Same-scope collisions throw.
 */
export const resolveTuiExtensions = (
  extensions: ReadonlyArray<LoadedTuiExtension>,
): ResolvedTuiExtensions => {
  // Sort by scope precedence, then by id for deterministic same-scope order (matches server)
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.id.localeCompare(b.id)
  })

  return {
    renderers: resolveRenderers(sorted),
    widgets: resolveWidgets(sorted),
    commands: resolveCommands(sorted),
    overlays: resolveOverlays(sorted),
  }
}
