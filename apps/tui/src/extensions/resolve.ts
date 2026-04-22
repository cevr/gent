/**
 * TUI extension resolution — scope-precedence merge of all client contributions.
 *
 * Mirrors server-side resolveExtensions() from registry.ts.
 * Precedence: project > user > builtin. Same-scope collisions throw.
 *
 * Per-kind conflict rules are NOT uniform — see the per-kind resolvers below.
 */

import type {
  AutocompleteContribution,
  ClientContribution,
  ClientContributionKind,
} from "./client-facets.js"
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
  readonly contributions: ReadonlyArray<ClientContribution<any>>
}

export interface ResolvedWidget {
  readonly id: string
  readonly slot: "below-messages" | "above-input" | "below-input"
  readonly priority: number
  readonly component: SolidComponent
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
  readonly overlays: Map<string, SolidComponent>
  readonly interactionRenderers: Map<string | undefined, SolidComponent>
  readonly composerSurface: SolidComponent | undefined
  readonly borderLabels: ReadonlyArray<ResolvedBorderLabel>
  readonly autocompleteItems: ReadonlyArray<AutocompleteContribution>
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

// ── Per-kind extraction ──

interface SortedExtension {
  readonly ext: LoadedTuiExtension
  readonly contribution: ClientContribution<unknown>
}

const flatten = (sorted: ReadonlyArray<LoadedTuiExtension>): ReadonlyArray<SortedExtension> => {
  const out: SortedExtension[] = []
  for (const ext of sorted) {
    for (const contribution of ext.contributions) out.push({ ext, contribution })
  }
  return out
}

// ── Per-kind resolvers ──

const resolveRenderers = (flat: ReadonlyArray<SortedExtension>): Map<string, ToolRenderer> => {
  const renderers = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._kind !== "renderer") continue
    for (const name of contribution.toolNames) {
      const key = name.toLowerCase()
      checkCollision(scopes.get(key), ext, "renderer", name)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      renderers.set(key, contribution.component as ToolRenderer)
      scopes.set(key, { kind: ext.kind, source: ext.filePath })
    }
  }

  return renderers
}

const resolveWidgets = (flat: ReadonlyArray<SortedExtension>): ReadonlyArray<ResolvedWidget> => {
  const widgetMap = new Map<string, ResolvedWidget>()
  const scopes = new Map<string, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._kind !== "widget") continue
    checkCollision(scopes.get(contribution.id), ext, "widget", contribution.id)
    widgetMap.set(contribution.id, {
      id: contribution.id,
      slot: contribution.slot,
      priority: contribution.priority ?? 100,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      component: contribution.component as SolidComponent,
    })
    scopes.set(contribution.id, { kind: ext.kind, source: ext.filePath })
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
    if (contribution._kind !== "command") continue
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
    idScopes.set(entry.id, { kind: ext.kind, source: ext.filePath })
  }

  return [...commandMap.values()]
}

const resolveOverlays = (flat: ReadonlyArray<SortedExtension>): Map<string, SolidComponent> => {
  const overlays = new Map<string, SolidComponent>()
  const scopes = new Map<string, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._kind !== "overlay") continue
    checkCollision(scopes.get(contribution.id), ext, "overlay", contribution.id)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    overlays.set(contribution.id, contribution.component as SolidComponent)
    scopes.set(contribution.id, { kind: ext.kind, source: ext.filePath })
  }

  return overlays
}

const resolveInteractionRenderers = (
  flat: ReadonlyArray<SortedExtension>,
): Map<string | undefined, SolidComponent> => {
  const renderers = new Map<string | undefined, SolidComponent>()
  const scopes = new Map<string | undefined, ScopeEntry>()

  for (const { ext, contribution } of flat) {
    if (contribution._kind !== "interaction-renderer") continue
    const key = contribution.metadataType
    const label = key ?? "(default)"
    checkCollision(scopes.get(key), ext, "interaction renderer", label)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    renderers.set(key, contribution.component as SolidComponent)
    scopes.set(key, { kind: ext.kind, source: ext.filePath })
  }

  return renderers
}

const resolveComposerSurface = (
  flat: ReadonlyArray<SortedExtension>,
): SolidComponent | undefined => {
  let winner: SolidComponent | undefined
  let winnerScope: ScopeEntry | undefined

  for (const { ext, contribution } of flat) {
    if (contribution._kind !== "composer-surface") continue
    if (winnerScope !== undefined) {
      checkCollision(winnerScope, ext, "composer surface", "composerSurface")
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    winner = contribution.component as SolidComponent
    winnerScope = { kind: ext.kind, source: ext.filePath }
  }

  return winner
}

const resolveBorderLabels = (
  flat: ReadonlyArray<SortedExtension>,
): ReadonlyArray<ResolvedBorderLabel> => {
  const out: ResolvedBorderLabel[] = []
  for (const { contribution } of flat) {
    if (contribution._kind !== "border-label") continue
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
    if (contribution._kind !== "autocomplete") continue
    out.push(contribution)
  }
  return out
}

/**
 * Every kind the resolver knows how to dispatch on. If a new `_kind` is added
 * to `ClientContribution` without a corresponding case here, the type assertion
 * below fails at compile time AND the runtime check below throws — preventing
 * silent drop-on-the-floor handling of new contribution kinds.
 */
const HANDLED_KINDS: ReadonlySet<ClientContributionKind> = new Set<ClientContributionKind>([
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
 * Adding a new `ClientContribution` kind: register it in HANDLED_KINDS AND add
 * a per-kind resolver below — otherwise this function throws at the entry guard.
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

  const flat = flatten(sorted)

  // Exhaustiveness gate — fail loud if a contribution carries an unknown _kind.
  for (const { ext, contribution } of flat) {
    if (!HANDLED_KINDS.has(contribution._kind)) {
      throw new Error(
        `Unknown TUI client contribution kind "${contribution._kind}" from "${ext.id}" (${ext.filePath}). ` +
          `Add it to HANDLED_KINDS and register a per-kind resolver in apps/tui/src/extensions/resolve.ts.`,
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
