/**
 * TUI extension resolution — scope-precedence merge of all client contributions.
 *
 * Mirrors server-side resolveExtensions() from registry.ts.
 * Precedence: project > user > builtin. Same-scope collisions throw.
 *
 * Per-tag conflict rules are NOT uniform — see the per-tag resolvers below.
 */

import { Schema } from "effect"
import type {
  AutocompleteContribution,
  BorderLabelItem,
  ClientContributions,
  ComposerSurfaceComponent,
  InteractionRendererComponent,
  OverlayComponent,
  WidgetComponent,
} from "./client-facets.js"

const SCOPE_PRECEDENCE = { builtin: 0, user: 1, project: 2 } as const
type CoreExtensionScope = keyof typeof SCOPE_PRECEDENCE

/**
 * Surfaces invariant violations in the TUI extension resolver: a same-scope
 * contribution collision (two extensions claim the same key). This is a
 * programmer-misuse-only signal.
 */
export class TuiExtensionResolveError extends Schema.TaggedErrorClass<TuiExtensionResolveError>()(
  "TuiExtensionResolveError",
  {
    reason: Schema.Literals(["same-scope-collision"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail
  }
}
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { HeadlessToolRenderer } from "../headless-tool-renderers"
import type { Command } from "../command/types"

export type ExtensionScope = CoreExtensionScope

export interface LoadedTuiExtension {
  readonly id: string
  readonly scope: ExtensionScope
  readonly filePath: string
  readonly contributions: ClientContributions
}

export interface ResolvedWidget {
  readonly id: string
  readonly slot: "below-messages" | "above-input" | "below-input"
  readonly priority: number
  readonly component: WidgetComponent
}

export interface ResolvedBorderLabel {
  readonly position: "top-left" | "top-right" | "bottom-left" | "bottom-right"
  readonly priority: number
  readonly produce: () => ReadonlyArray<BorderLabelItem>
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ToolRenderer>
  readonly headlessRenderers: Map<string, HeadlessToolRenderer>
  readonly widgets: ReadonlyArray<ResolvedWidget>
  readonly commands: ReadonlyArray<Command>
  readonly overlays: Map<string, OverlayComponent>
  readonly interactionRenderers: Map<string | undefined, InteractionRendererComponent>
  readonly composerSurface: ComposerSurfaceComponent | undefined
  readonly borderLabels: ReadonlyArray<ResolvedBorderLabel>
  readonly autocompleteItems: ReadonlyArray<AutocompleteContribution>
}

interface ScopeEntry {
  readonly scope: ExtensionScope
  readonly source: string
}

/** Check for same-scope collision and throw with context */
const checkCollision = (
  prev: ScopeEntry | undefined,
  ext: LoadedTuiExtension,
  label: string,
  key: string,
): void => {
  if (prev !== undefined && prev.scope === ext.scope && prev.source !== ext.filePath) {
    throw new TuiExtensionResolveError({
      reason: "same-scope-collision",
      detail: `Same-scope TUI ${label} collision: "${key}" from "${prev.source}" and "${ext.filePath}" in scope "${ext.scope}"`,
    })
  }
}

// ── Per-bucket resolvers ──

const resolveRenderers = (sorted: ReadonlyArray<LoadedTuiExtension>): Map<string, ToolRenderer> => {
  const renderers = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of ext.contributions.renderers ?? []) {
      for (const name of contribution.toolNames) {
        const key = name.toLowerCase()
        checkCollision(scopes.get(key), ext, "renderer", name)
        renderers.set(key, contribution.component)
        scopes.set(key, { scope: ext.scope, source: ext.filePath })
      }
    }
  }

  return renderers
}

const resolveHeadlessRenderers = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): Map<string, HeadlessToolRenderer> => {
  const renderers = new Map<string, HeadlessToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of ext.contributions.renderers ?? []) {
      if (contribution.headless === undefined) continue
      for (const name of contribution.toolNames) {
        const key = name.toLowerCase()
        checkCollision(scopes.get(key), ext, "headless renderer", name)
        renderers.set(key, contribution.headless)
        scopes.set(key, { scope: ext.scope, source: ext.filePath })
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
    for (const contribution of ext.contributions.widgets ?? []) {
      checkCollision(scopes.get(contribution.id), ext, "widget", contribution.id)
      widgetMap.set(contribution.id, {
        id: contribution.id,
        slot: contribution.slot,
        priority: contribution.priority ?? 100,
        component: contribution.component,
      })
      scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
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
    for (const entry of ext.contributions.commands ?? []) {
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
        keybindScopes.set(kb, { scope: ext.scope, source: ext.filePath })
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
        slashScopes.set(sl, { scope: ext.scope, source: ext.filePath })
        slashOwner.set(sl, entry.id)
      }

      commandMap.set(entry.id, {
        id: entry.id,
        title: entry.title,
        description: entry.description,
        category: entry.category,
        keybind: entry.keybind,
        slash: entry.slash,
        aliases: entry.aliases,
        slashPriority: entry.slashPriority,
        onSelect: entry.onSelect,
        onSlash: entry.onSlash,
        paletteLevel: entry.paletteLevel,
      })
      idScopes.set(entry.id, { scope: ext.scope, source: ext.filePath })
    }
  }

  return [...commandMap.values()]
}

const resolveOverlays = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): Map<string, OverlayComponent> => {
  const overlays = new Map<string, OverlayComponent>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of ext.contributions.overlays ?? []) {
      checkCollision(scopes.get(contribution.id), ext, "overlay", contribution.id)
      overlays.set(contribution.id, contribution.component)
      scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
    }
  }

  return overlays
}

const resolveInteractionRenderers = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): Map<string | undefined, InteractionRendererComponent> => {
  const renderers = new Map<string | undefined, InteractionRendererComponent>()
  const scopes = new Map<string | undefined, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of ext.contributions.interactionRenderers ?? []) {
      const key = contribution.metadataType
      const label = key ?? "(default)"
      checkCollision(scopes.get(key), ext, "interaction renderer", label)
      renderers.set(key, contribution.component)
      scopes.set(key, { scope: ext.scope, source: ext.filePath })
    }
  }

  return renderers
}

const resolveComposerSurface = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): ComposerSurfaceComponent | undefined => {
  let winner: ComposerSurfaceComponent | undefined
  let winnerScope: ScopeEntry | undefined

  for (const ext of sorted) {
    const contribution = ext.contributions.composerSurface
    if (contribution === undefined) continue
    if (winnerScope !== undefined) {
      checkCollision(winnerScope, ext, "composer surface", "composerSurface")
    }
    winner = contribution.component
    winnerScope = { scope: ext.scope, source: ext.filePath }
  }

  return winner
}

const resolveBorderLabels = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): ReadonlyArray<ResolvedBorderLabel> => {
  const out: ResolvedBorderLabel[] = []
  for (const ext of sorted) {
    for (const contribution of ext.contributions.borderLabels ?? []) {
      out.push({
        position: contribution.position,
        priority: contribution.priority ?? 100,
        produce: contribution.produce,
      })
    }
  }
  out.sort((a, b) => a.priority - b.priority)
  return out
}

const resolveAutocomplete = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): ReadonlyArray<AutocompleteContribution> => {
  const out: AutocompleteContribution[] = []
  for (const ext of sorted) {
    out.push(...(ext.contributions.autocomplete ?? []))
  }
  return out
}

/**
 * Resolve all TUI extension contributions with scope precedence.
 * Higher scope wins for same key. Same-scope collisions throw.
 *
 */
export const resolveTuiExtensions = (
  extensions: ReadonlyArray<LoadedTuiExtension>,
): ResolvedTuiExtensions => {
  // Sort by scope precedence, then by id for deterministic same-scope order (matches server)
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.id.localeCompare(b.id)
  })
  return {
    renderers: resolveRenderers(sorted),
    headlessRenderers: resolveHeadlessRenderers(sorted),
    widgets: resolveWidgets(sorted),
    commands: resolveCommands(sorted),
    overlays: resolveOverlays(sorted),
    interactionRenderers: resolveInteractionRenderers(sorted),
    composerSurface: resolveComposerSurface(sorted),
    borderLabels: resolveBorderLabels(sorted),
    autocompleteItems: resolveAutocomplete(sorted),
  }
}
