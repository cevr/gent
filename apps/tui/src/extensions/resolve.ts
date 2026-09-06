/**
 * TUI extension resolution — scope-precedence merge of all client contributions.
 *
 * Mirrors server-side resolveExtensions() from registry.ts.
 * Precedence: project > user > builtin. Same-scope collisions throw.
 *
 * Per-tag conflict rules are NOT uniform — see the per-tag resolvers below.
 */

import { Option, Schema } from "effect"
import type {
  AutocompleteContribution,
  BorderLabelItem,
  ClientContributions,
  ComposerSurfaceComponent,
  InteractionRendererComponent,
  OverlayComponent,
  WidgetComponent,
} from "./client-facets.js"

const SCOPE_PRECEDENCE = { builtin: 0, user: 1, project: 2 } satisfies Record<string, number>
type CoreExtensionScope = keyof typeof SCOPE_PRECEDENCE

/**
 * Surfaces invariant violations in the TUI extension resolver: a same-scope
 * contribution collision (two extensions claim the same key). This is a
 * programmer-misuse-only signal.
 */
export class TuiExtensionResolveError extends Schema.TaggedError<TuiExtensionResolveError>()(
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
  // eslint-disable-next-line effect/noNullish -- the undefined key selects the default renderer.
  readonly interactionRenderers: Map<string | undefined, InteractionRendererComponent>
  // eslint-disable-next-line effect/noNullish -- no composer contribution is a valid resolved result.
  readonly composerSurface: ComposerSurfaceComponent | undefined
  readonly borderLabels: ReadonlyArray<ResolvedBorderLabel>
  readonly autocompleteItems: ReadonlyArray<AutocompleteContribution>
}

interface ScopeEntry {
  readonly scope: ExtensionScope
  readonly source: string
}

// eslint-disable-next-line effect/noNullish -- extension contribution buckets may be omitted.
const itemsOrEmpty = <A>(items: ReadonlyArray<A> | undefined): ReadonlyArray<A> =>
  Option.getOrElse(Option.fromNullishOr(items), () => [])

const scopeEntryFor = <K>(scopes: Map<K, ScopeEntry>, key: K): Option.Option<ScopeEntry> =>
  Option.fromNullishOr(scopes.get(key))

/** Check for same-scope collision and throw with context */
const checkCollision = (
  prev: Option.Option<ScopeEntry>,
  ext: LoadedTuiExtension,
  label: string,
  key: string,
): void => {
  if (Option.isSome(prev) && prev.value.scope === ext.scope && prev.value.source !== ext.filePath) {
    // eslint-disable-next-line effect/noThrowStatement -- same-scope collisions are programmer misuse in this synchronous resolver.
    throw new TuiExtensionResolveError({
      reason: "same-scope-collision",
      detail: `Same-scope TUI ${label} collision: "${key}" from "${prev.value.source}" and "${ext.filePath}" in scope "${ext.scope}"`,
    })
  }
}

// ── Per-bucket resolvers ──

const resolveRenderers = (sorted: ReadonlyArray<LoadedTuiExtension>): Map<string, ToolRenderer> => {
  const renderers = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of itemsOrEmpty(ext.contributions.renderers)) {
      for (const name of contribution.toolNames) {
        const key = name.toLowerCase()
        checkCollision(scopeEntryFor(scopes, key), ext, "renderer", name)
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
    for (const contribution of itemsOrEmpty(ext.contributions.renderers)) {
      const headless = Option.fromNullishOr(contribution.headless)
      if (Option.isNone(headless)) continue
      for (const name of contribution.toolNames) {
        const key = name.toLowerCase()
        checkCollision(scopeEntryFor(scopes, key), ext, "headless renderer", name)
        renderers.set(key, headless.value)
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
    for (const contribution of itemsOrEmpty(ext.contributions.widgets)) {
      checkCollision(scopeEntryFor(scopes, contribution.id), ext, "widget", contribution.id)
      widgetMap.set(contribution.id, {
        id: contribution.id,
        slot: contribution.slot,
        priority: Option.getOrElse(Option.fromNullishOr(contribution.priority), () => 100),
        component: contribution.component,
      })
      scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
    }
  }

  return [...widgetMap.values()].sort((a, b) => a.priority - b.priority)
}

interface CommandResolutionState {
  readonly commandMap: Map<string, Command>
  readonly keybindScopes: Map<string, ScopeEntry>
  readonly slashScopes: Map<string, ScopeEntry>
  readonly keybindOwner: Map<string, string>
  readonly slashOwner: Map<string, string>
}

const resolveCommandKeybind = (
  entry: Command,
  ext: LoadedTuiExtension,
  state: CommandResolutionState,
): void => {
  const keybind = Option.fromNullishOr(entry.keybind)
  if (Option.isNone(keybind)) return
  const key = keybind.value.toLowerCase()
  checkCollision(scopeEntryFor(state.keybindScopes, key), ext, "keybind", keybind.value)
  const previousOwner = Option.fromNullishOr(state.keybindOwner.get(key))
  if (Option.isSome(previousOwner)) {
    const previousCommand = Option.fromNullishOr(state.commandMap.get(previousOwner.value))
    if (Option.isSome(previousCommand)) {
      state.commandMap.set(previousOwner.value, {
        ...previousCommand.value,
        keybind: Option.getOrUndefined(Option.none()),
      })
    }
  }
  state.keybindScopes.set(key, { scope: ext.scope, source: ext.filePath })
  state.keybindOwner.set(key, entry.id)
}

const resolveCommandSlash = (
  entry: Command,
  ext: LoadedTuiExtension,
  state: CommandResolutionState,
): void => {
  const slash = Option.fromNullishOr(entry.slash)
  if (Option.isNone(slash)) return
  const key = slash.value.toLowerCase()
  checkCollision(scopeEntryFor(state.slashScopes, key), ext, "slash", slash.value)
  const previousOwner = Option.fromNullishOr(state.slashOwner.get(key))
  if (Option.isSome(previousOwner)) {
    const previousCommand = Option.fromNullishOr(state.commandMap.get(previousOwner.value))
    if (Option.isSome(previousCommand)) {
      state.commandMap.set(previousOwner.value, {
        ...previousCommand.value,
        slash: Option.getOrUndefined(Option.none()),
      })
    }
  }
  state.slashScopes.set(key, { scope: ext.scope, source: ext.filePath })
  state.slashOwner.set(key, entry.id)
}

const resolveCommandEntry = (
  entry: Command,
  ext: LoadedTuiExtension,
  idScopes: Map<string, ScopeEntry>,
  state: CommandResolutionState,
): void => {
  checkCollision(scopeEntryFor(idScopes, entry.id), ext, "command", entry.id)
  resolveCommandKeybind(entry, ext, state)
  resolveCommandSlash(entry, ext, state)
  state.commandMap.set(entry.id, entry)
  idScopes.set(entry.id, { scope: ext.scope, source: ext.filePath })
}

const resolveCommands = (sorted: ReadonlyArray<LoadedTuiExtension>): ReadonlyArray<Command> => {
  const commandMap = new Map<string, Command>()
  const idScopes = new Map<string, ScopeEntry>()
  const keybindScopes = new Map<string, ScopeEntry>()
  const slashScopes = new Map<string, ScopeEntry>()
  const state: CommandResolutionState = {
    commandMap,
    keybindScopes,
    slashScopes,
    keybindOwner: new Map<string, string>(),
    slashOwner: new Map<string, string>(),
  }

  for (const ext of sorted) {
    for (const entry of itemsOrEmpty(ext.contributions.commands)) {
      resolveCommandEntry(entry, ext, idScopes, state)
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
    for (const contribution of itemsOrEmpty(ext.contributions.overlays)) {
      checkCollision(scopeEntryFor(scopes, contribution.id), ext, "overlay", contribution.id)
      overlays.set(contribution.id, contribution.component)
      scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
    }
  }

  return overlays
}

const resolveInteractionRenderers = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  // eslint-disable-next-line effect/noNullish -- the default renderer uses an undefined map key.
): Map<string | undefined, InteractionRendererComponent> => {
  // eslint-disable-next-line effect/noNullish -- the default renderer uses an undefined map key.
  const renderers = new Map<string | undefined, InteractionRendererComponent>()
  // eslint-disable-next-line effect/noNullish -- the default renderer uses an undefined map key.
  const scopes = new Map<string | undefined, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of itemsOrEmpty(ext.contributions.interactionRenderers)) {
      const key = Option.fromNullishOr(contribution.metadataType)
      const label = Option.getOrElse(key, () => "(default)")
      const mapKey = Option.getOrUndefined(key)
      checkCollision(scopeEntryFor(scopes, mapKey), ext, "interaction renderer", label)
      renderers.set(mapKey, contribution.component)
      scopes.set(mapKey, { scope: ext.scope, source: ext.filePath })
    }
  }

  return renderers
}

const resolveComposerSurface = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  // eslint-disable-next-line effect/noNullish -- no composer contribution is a valid result.
): ComposerSurfaceComponent | undefined => {
  let winner = Option.none<ComposerSurfaceComponent>()
  let winnerScope = Option.none<ScopeEntry>()

  for (const ext of sorted) {
    const contribution = Option.fromNullishOr(ext.contributions.composerSurface)
    if (Option.isNone(contribution)) continue
    if (Option.isSome(winnerScope)) {
      checkCollision(winnerScope, ext, "composer surface", "composerSurface")
    }
    winner = Option.some(contribution.value.component)
    winnerScope = Option.some({ scope: ext.scope, source: ext.filePath })
  }

  return Option.getOrUndefined(winner)
}

const resolveBorderLabels = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
): ReadonlyArray<ResolvedBorderLabel> => {
  const out: ResolvedBorderLabel[] = []
  for (const ext of sorted) {
    for (const contribution of itemsOrEmpty(ext.contributions.borderLabels)) {
      out.push({
        position: contribution.position,
        priority: Option.getOrElse(Option.fromNullishOr(contribution.priority), () => 100),
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
    out.push(...itemsOrEmpty(ext.contributions.autocomplete))
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
