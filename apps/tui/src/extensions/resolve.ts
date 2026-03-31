/**
 * TUI extension resolution — scope-precedence merge of all extension contributions.
 *
 * Mirrors server-side resolveExtensions() from registry.ts.
 * Precedence: project > user > builtin. Same-scope collisions throw.
 */

import type { ExtensionClientSetup } from "@gent/core/domain/extension-client.js"
import type { InteractionEventTag } from "@gent/core/domain/event.js"
import { SCOPE_PRECEDENCE, type ExtensionScope } from "@gent/core/runtime/extensions/disabled"
import type { JSX } from "@opentui/solid"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"

/** Generic Solid component for widgets/overlays (no required props) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolidComponent = (props?: any) => JSX.Element

export type ExtensionKind = ExtensionScope

export interface LoadedTuiExtension {
  readonly id: string
  readonly kind: ExtensionKind
  readonly filePath: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly setup: ExtensionClientSetup<any>
}

export interface ResolvedWidget {
  readonly id: string
  readonly slot: "above-messages" | "below-messages" | "above-input" | "below-input"
  readonly priority: number
  readonly component: SolidComponent
}

export interface ResolvedBorderLabel {
  readonly position: "top-left" | "top-right"
  readonly priority: number
  readonly produce: () => ReadonlyArray<{ text: string; color: unknown }>
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ToolRenderer>
  readonly widgets: ReadonlyArray<ResolvedWidget>
  readonly commands: ReadonlyArray<Command>
  readonly overlays: Map<string, SolidComponent>
  readonly interactionRenderers: Map<InteractionEventTag, SolidComponent>
  readonly composerSurface: SolidComponent | undefined
  readonly borderLabels: ReadonlyArray<ResolvedBorderLabel>
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
        component: entry.component as SolidComponent,
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
  const slashScopes = new Map<string, ScopeEntry>()
  // Track which command id owns each keybind/slash — for stripping superseded ones
  const keybindOwner = new Map<string, string>() // keybind → command id
  const slashOwner = new Map<string, string>() // slash → command id

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

      if (entry.slash !== undefined) {
        const sl = entry.slash.toLowerCase()
        checkCollision(slashScopes.get(sl), ext, "slash", entry.slash)
        // Higher scope wins the slash — strip it from the previous owner
        const prevOwnerId = slashOwner.get(sl)
        if (prevOwnerId !== undefined) {
          const prevCmd = commandMap.get(prevOwnerId)
          if (prevCmd !== undefined) {
            commandMap.set(prevOwnerId, { ...prevCmd, slash: undefined })
          }
        }
        slashScopes.set(sl, { kind: ext.kind, source: ext.filePath })
        slashOwner.set(sl, entry.id)
      }

      commandMap.set(entry.id, {
        id: entry.id,
        title: entry.title,
        category: entry.category,
        keybind: entry.keybind,
        slash: entry.slash,
        onSelect: entry.onSelect,
      })
      idScopes.set(entry.id, { kind: ext.kind, source: ext.filePath })
    }
  }

  return [...commandMap.values()]
}

const resolveOverlays = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): Map<string, SolidComponent> => {
  const overlays = new Map<string, SolidComponent>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const entry of ext.setup.overlays ?? []) {
      checkCollision(scopes.get(entry.id), ext, "overlay", entry.id)
      overlays.set(entry.id, entry.component as SolidComponent)
      scopes.set(entry.id, { kind: ext.kind, source: ext.filePath })
    }
  }

  return overlays
}

const resolveInteractionRenderers = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): Map<InteractionEventTag, SolidComponent> => {
  const renderers = new Map<InteractionEventTag, SolidComponent>()
  const scopes = new Map<InteractionEventTag, ScopeEntry>()

  for (const ext of sorted) {
    for (const entry of ext.setup.interactionRenderers ?? []) {
      checkCollision(scopes.get(entry.eventTag), ext, "interaction renderer", entry.eventTag)
      renderers.set(entry.eventTag, entry.component as SolidComponent)
      scopes.set(entry.eventTag, { kind: ext.kind, source: ext.filePath })
    }
  }

  return renderers
}

const resolveComposerSurface = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): SolidComponent | undefined => {
  let winner: SolidComponent | undefined
  let winnerScope: ScopeEntry | undefined

  for (const ext of sorted) {
    if (ext.setup.composerSurface === undefined) continue
    if (winnerScope !== undefined) {
      checkCollision(winnerScope, ext, "composer surface", "composerSurface")
    }
    winner = ext.setup.composerSurface as SolidComponent
    winnerScope = { kind: ext.kind, source: ext.filePath }
  }

  return winner
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

  // Border labels: collect all, sort by priority
  const borderLabels: ResolvedBorderLabel[] = []
  for (const ext of sorted) {
    for (const entry of ext.setup.borderLabels ?? []) {
      borderLabels.push({
        position: entry.position,
        priority: entry.priority ?? 100,
        produce: entry.produce as () => ReadonlyArray<{ text: string; color: unknown }>,
      })
    }
  }
  borderLabels.sort((a, b) => a.priority - b.priority)

  return {
    renderers: resolveRenderers(sorted),
    widgets: resolveWidgets(sorted),
    commands: resolveCommands(sorted),
    overlays: resolveOverlays(sorted),
    interactionRenderers: resolveInteractionRenderers(sorted),
    composerSurface: resolveComposerSurface(sorted),
    borderLabels,
  }
}
