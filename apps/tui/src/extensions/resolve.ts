/**
 * TUI extension resolution — scope-precedence merge of all client contributions.
 *
 * Mirrors server-side resolveExtensions() from registry.ts.
 * Precedence: project > user > builtin. Same-scope collisions throw.
 *
 * Per-tag conflict rules are NOT uniform — see the per-tag resolvers below.
 */

import type {
  AutocompleteContribution,
  ClientContribution,
  ClientContributionTag,
  ComposerSurfaceComponent,
  InteractionRendererComponent,
  OverlayComponent,
  WidgetComponent,
} from "./client-facets.js"
import {
  SCOPE_PRECEDENCE,
  type ExtensionScope as CoreExtensionScope,
} from "@gent/core/runtime/extensions/disabled"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"

export type ExtensionScope = CoreExtensionScope

export interface LoadedTuiExtension {
  readonly id: string
  readonly scope: ExtensionScope
  readonly filePath: string
  readonly contributions: ReadonlyArray<ClientContribution>
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
  readonly produce: () => ReadonlyArray<{ text: string; color: unknown }>
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ToolRenderer>
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
    throw new Error(
      `Same-scope TUI ${label} collision: "${key}" from "${prev.source}" and "${ext.filePath}" in scope "${ext.scope}"`,
    )
  }
}

// ── Per-tag extraction ──

interface SortedExtension {
  readonly ext: LoadedTuiExtension
  readonly contribution: ClientContribution
}

const flatten = (sorted: ReadonlyArray<LoadedTuiExtension>): ReadonlyArray<SortedExtension> => {
  const out: SortedExtension[] = []
  for (const ext of sorted) {
    for (const contribution of ext.contributions) out.push({ ext, contribution })
  }
  return out
}

// ── Per-tag resolvers ──

const resolveRenderers = (flat: ReadonlyArray<SortedExtension>): Map<string, ToolRenderer> => {
  const renderers = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._tag !== "renderer") continue
    for (const name of contribution.toolNames) {
      const key = name.toLowerCase()
      checkCollision(scopes.get(key), ext, "renderer", name)
      renderers.set(key, contribution.component)
      scopes.set(key, { scope: ext.scope, source: ext.filePath })
    }
  }

  return renderers
}

const resolveWidgets = (flat: ReadonlyArray<SortedExtension>): ReadonlyArray<ResolvedWidget> => {
  const widgetMap = new Map<string, ResolvedWidget>()
  const scopes = new Map<string, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._tag !== "widget") continue
    checkCollision(scopes.get(contribution.id), ext, "widget", contribution.id)
    widgetMap.set(contribution.id, {
      id: contribution.id,
      slot: contribution.slot,
      priority: contribution.priority ?? 100,
      component: contribution.component,
    })
    scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
  }

  return [...widgetMap.values()].sort((a, b) => a.priority - b.priority)
}

const resolveCommands = (flat: ReadonlyArray<SortedExtension>): ReadonlyArray<Command> => {
  const commandMap = new Map<string, Command>()
  const idScopes = new Map<string, ScopeEntry>()
  const keybindScopes = new Map<string, ScopeEntry>()
  const slashScopes = new Map<string, ScopeEntry>()
  // Track which command id owns each keybind/slash — for stripping superseded ones
  const keybindOwner = new Map<string, string>() // keybind → command id
  const slashOwner = new Map<string, string>() // slash → command id

  for (const { ext, contribution } of flat) {
    if (contribution._tag !== "command") continue
    const entry = contribution
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

  return [...commandMap.values()]
}

const resolveOverlays = (flat: ReadonlyArray<SortedExtension>): Map<string, OverlayComponent> => {
  const overlays = new Map<string, OverlayComponent>()
  const scopes = new Map<string, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._tag !== "overlay") continue
    checkCollision(scopes.get(contribution.id), ext, "overlay", contribution.id)
    overlays.set(contribution.id, contribution.component)
    scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
  }

  return overlays
}

const resolveInteractionRenderers = (
  flat: ReadonlyArray<SortedExtension>,
): Map<string | undefined, InteractionRendererComponent> => {
  const renderers = new Map<string | undefined, InteractionRendererComponent>()
  const scopes = new Map<string | undefined, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._tag !== "interaction-renderer") continue
    const key = contribution.metadataType
    const label = key ?? "(default)"
    checkCollision(scopes.get(key), ext, "interaction renderer", label)
    renderers.set(key, contribution.component)
    scopes.set(key, { scope: ext.scope, source: ext.filePath })
  }

  return renderers
}

const resolveComposerSurface = (
  flat: ReadonlyArray<SortedExtension>,
): ComposerSurfaceComponent | undefined => {
  let winner: ComposerSurfaceComponent | undefined
  let winnerScope: ScopeEntry | undefined

  for (const { ext, contribution } of flat) {
    if (contribution._tag !== "composer-surface") continue
    if (winnerScope !== undefined) {
      checkCollision(winnerScope, ext, "composer surface", "composerSurface")
    }
    winner = contribution.component
    winnerScope = { scope: ext.scope, source: ext.filePath }
  }

  return winner
}

const resolveBorderLabels = (
  flat: ReadonlyArray<SortedExtension>,
): ReadonlyArray<ResolvedBorderLabel> => {
  const out: ResolvedBorderLabel[] = []
  for (const { contribution } of flat) {
    if (contribution._tag !== "border-label") continue
    out.push({
      position: contribution.position,
      priority: contribution.priority ?? 100,
      produce: contribution.produce,
    })
  }
  out.sort((a, b) => a.priority - b.priority)
  return out
}

const resolveAutocomplete = (
  flat: ReadonlyArray<SortedExtension>,
): ReadonlyArray<AutocompleteContribution> => {
  const out: AutocompleteContribution[] = []
  for (const { contribution } of flat) {
    if (contribution._tag !== "autocomplete") continue
    out.push(contribution)
  }
  return out
}

/**
 * Every tag the resolver knows how to dispatch on. If a new `_tag` is added
 * to `ClientContribution` without a corresponding case here, the type assertion
 * below fails at compile time AND the runtime check below throws — preventing
 * silent drop-on-the-floor handling of new contribution tags.
 */
const HANDLED_TAGS: ReadonlySet<ClientContributionTag> = new Set<ClientContributionTag>([
  "renderer",
  "widget",
  "command",
  "overlay",
  "interaction-renderer",
  "composer-surface",
  "border-label",
  "autocomplete",
])

/**
 * Resolve all TUI extension contributions with scope precedence.
 * Higher scope wins for same key. Same-scope collisions throw.
 *
 * Adding a new `ClientContribution` tag: register it in HANDLED_TAGS AND add
 * a per-tag resolver below — otherwise this function throws at the entry guard.
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

  const flat = flatten(sorted)

  // Exhaustiveness gate — fail loud if a contribution carries an unknown _tag.
  for (const { ext, contribution } of flat) {
    if (!HANDLED_TAGS.has(contribution._tag)) {
      throw new Error(
        `Unknown TUI client contribution tag "${contribution._tag}" from "${ext.id}" (${ext.filePath}). ` +
          `Add it to HANDLED_TAGS and register a per-tag resolver in apps/tui/src/extensions/resolve.ts.`,
      )
    }
  }

  return {
    renderers: resolveRenderers(flat),
    widgets: resolveWidgets(flat),
    commands: resolveCommands(flat),
    overlays: resolveOverlays(flat),
    interactionRenderers: resolveInteractionRenderers(flat),
    composerSurface: resolveComposerSurface(flat),
    borderLabels: resolveBorderLabels(flat),
    autocompleteItems: resolveAutocomplete(flat),
  }
}
