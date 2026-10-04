import {
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Order,
  Path,
  Predicate,
  Random,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import {
  type ExtensionScope,
  isClientEntrypoint,
  isClientFile,
  SCOPE_PRECEDENCE,
} from "@gent/core/protocol"
import {
  bindBunModules,
  buildExtensionModule,
  extensionEntryModules,
  extensionModuleChanged,
  hasProjectScope,
  isProjectExtensionDirectoryTrusted,
  makeModuleGraphs,
  type ModuleGraphs,
  readDisabledExtensions,
  type RuntimeModuleSource,
} from "@gent/core/host"
import * as ProtocolEntry from "@gent/core/protocol"
import * as ClientExtensionEntry from "@gent/tui/extensions"
import * as ShippedExtensionsClientEntry from "@gent/extensions/client"
import * as OpenTuiSolidEntry from "@opentui/solid"
import * as SolidEntry from "solid-js"
import * as SolidStoreEntry from "solid-js/store"
import {
  type ActiveExtensionSession,
  type AnyExtensionClientModule,
  type AutocompleteContribution,
  type AutocompleteItem,
  type StatusLabelAnchor,
  type StatusLabelItem,
  type ClientContributions,
  ClientContext,
  type ClientLifecycle,
  type ClientRuntime,
  type ClientRuntimeServices,
  type InteractionRendererComponent,
  type MessageRendererEntry,
  type NoticeRow,
  type WidgetComponent,
  type WidgetSlot,
  decodeContributions,
} from "./client-facets.js"
import {
  bindModuleSource,
  buildClientExtension,
  type ClientBuildNames,
  sha256Hex,
} from "../bun-adapter"
import type { ToolRenderer } from "../tool-renderers"
import type { Command } from "../commands"

// ── extension discovery ─────────────────────────────────────────────────────

/**
 * TUI extension discovery — scan extension directories for *.client.* files.
 *
 * Mirrors the server's discoverDir() but for client-side modules only.
 * Files are tagged with "user" or "project" scope based on their source directory.
 *
 * Takes Effect's `FileSystem.FileSystem` directly so discovery shares the
 * runtime's scoped filesystem services.
 */

interface DiscoveredTuiExtension {
  readonly filePath: string
  readonly scope: "user" | "project"
}

const discoverDir = (
  dir: string,
  scope: DiscoveredTuiExtension["scope"],
): Effect.Effect<DiscoveredTuiExtension[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return []

    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))

    const results: DiscoveredTuiExtension[] = []

    for (const entry of entries) {
      if (entry.startsWith(".") || entry.startsWith("_") || entry === "node_modules") continue

      const filePath = path.join(dir, entry)
      const info = yield* fs.stat(filePath).pipe(Effect.option)
      if (info._tag === "None") continue

      if (info.value.type === "File" && isClientFile(entry)) {
        results.push({ filePath, scope })
      } else if (info.value.type === "Directory") {
        const subEntries = yield* fs.readDirectory(filePath).pipe(Effect.orElseSucceed(() => []))
        const clientFiles = subEntries
          .filter((e) => isClientEntrypoint(e))
          .slice()
          .sort()
        if (clientFiles.length > 1) {
          yield* Effect.logWarning("tui-ext.discovery.multiple-entrypoints").pipe(
            Effect.annotateLogs({
              dir: filePath,
              candidates: clientFiles.join(", "),
              picked: clientFiles[0],
            }),
          )
        }
        const firstClient = Option.fromNullishOr(clientFiles[0])
        if (Option.isSome(firstClient)) {
          results.push({ filePath: path.join(filePath, firstClient.value), scope })
        }
      }
    }

    // Code-unit order, not the locale's, as the server discovers.
    return results.sort((a, b) => Order.String(a.filePath, b.filePath))
  })

/** Discover TUI extension files from user and project directories. */
const discoverTuiExtensions = (opts: {
  readonly userDir: string
  readonly projectDir: string
}): Effect.Effect<
  ReadonlyArray<DiscoveredTuiExtension>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const user = yield* discoverDir(opts.userDir, "user")
    // Launched from home, the project directory is the user's: one scope, read once.
    if (!(yield* hasProjectScope({ user: opts.userDir, project: opts.projectDir }))) return user
    if (!(yield* isProjectExtensionDirectoryTrusted(opts))) return user
    const project = yield* discoverDir(opts.projectDir, "project")
    return [...user, ...project]
  })

// ── contribution resolution ─────────────────────────────────────────────────

/**
 * TUI extension resolution — scope-precedence merge of all client contributions.
 *
 * Precedence: project > user > builtin. Inside one scope, extensions resolve in
 * id order; when two claim one key, the first keeps it and the later
 * contribution is dropped and recorded in `failures`. Nothing else is lost.
 *
 * Keyed buckets (renderers by tool name, message renderers by custom type,
 * widgets by id, interaction renderers by metadata type) go through `resolveKeyed`. Commands
 * are passed on as sources: the host adds the session's and the server's and
 * resolves them all under `resolveCommands`. Status labels and autocomplete
 * sources are collected in scope order.
 */

/** A client extension, or one of its contributions, that did not load. */
export interface ClientExtensionFailure {
  /** The extension id, or the file path when the module never gave one. */
  readonly id: string
  readonly reason: string
}

export interface LoadedTuiExtension {
  readonly id: string
  readonly scope: ExtensionScope
  readonly filePath: string
  readonly contributions: ClientContributions
}

export interface ResolvedWidget {
  /** The extension that contributed it, named when its render fails. */
  readonly extensionId: string
  readonly id: string
  readonly slot: WidgetSlot
  readonly priority: number
  readonly component: WidgetComponent
}

interface ResolvedStatusLabel {
  /** The extension that contributed it, named when it fails. */
  readonly extensionId: string
  readonly priority: number
  readonly anchor: StatusLabelAnchor
  readonly produce: () => ReadonlyArray<StatusLabelItem>
}

/** One extension's transcript rows, under the notice id it won. */
export interface ResolvedNoticeRows {
  readonly id: string
  /** The extension that contributed them, named when they fail. */
  readonly extensionId: string
  readonly rows: (session: ActiveExtensionSession) => Option.Option<ReadonlyArray<NoticeRow>>
}

/** A pending thing Esc stops, under the id it won, with the extension that contributed it. */
interface ResolvedStoppable {
  readonly id: string
  readonly extensionId: string
  readonly active: () => boolean
  readonly stop: () => void
}

/** A tool renderer, with the extension that contributed it, named when its render fails. */
interface ResolvedToolRenderer {
  readonly extensionId: string
  readonly component: ToolRenderer
}

/** A message row renderer, with the extension that contributed it, named when its render fails. */
type ResolvedMessageRenderer = MessageRendererEntry & { readonly extensionId: string }

/** An interaction renderer, with the extension that contributed it, named when its render fails. */
interface ResolvedInteractionRenderer {
  readonly extensionId: string
  readonly component: InteractionRendererComponent
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ResolvedToolRenderer>
  /** Keyed by `metadata.customType`, matched exactly. */
  readonly messageRenderers: Map<string, ResolvedMessageRenderer>
  readonly widgets: ReadonlyArray<ResolvedWidget>
  /** Each extension's commands, in scope order; `resolveCommands` decides the owners. */
  readonly commandSources: ReadonlyArray<CommandSource>
  readonly interactionRenderers: Map<string, ResolvedInteractionRenderer>
  readonly statusLabels: ReadonlyArray<ResolvedStatusLabel>
  readonly noticeRows: ReadonlyArray<ResolvedNoticeRows>
  readonly autocompleteItems: ReadonlyArray<ResolvedAutocomplete>
  /** Highest scope first: Esc stops the first active one. */
  readonly stoppables: ReadonlyArray<ResolvedStoppable>
  readonly failures: ReadonlyArray<ClientExtensionFailure>
}

/**
 * An autocomplete source, with the extension that contributed it, named when
 * its code throws.
 */
export type ResolvedAutocomplete = AutocompleteContribution & { readonly extensionId: string }

/** Who holds a key: the extension scope and file that claimed it. */
interface Claim {
  readonly scope: ExtensionScope
  readonly source: string
}

// eslint-disable-next-line effect/noNullish -- extension contribution buckets may be omitted.
const itemsOrEmpty = <A>(items: ReadonlyArray<A> | undefined): ReadonlyArray<A> =>
  Option.getOrElse(Option.fromNullishOr(items), () => [])

/**
 * Whether `ext` claims a key another extension already holds in the same
 * scope. A collision is recorded against the later extension.
 */
const collides = (
  held: Option.Option<Claim>,
  claimant: { readonly id: string; readonly scope: ExtensionScope; readonly source: string },
  label: string,
  key: string,
  failures: Array<ClientExtensionFailure>,
): boolean => {
  if (Option.isNone(held) || held.value.scope !== claimant.scope) return false
  if (held.value.source === claimant.source) return false
  failures.push({
    id: claimant.id,
    reason: `${label} "${key}" is already claimed by "${held.value.source}" in scope "${claimant.scope}"`,
  })
  return true
}

/** One key an extension claims: the map key, the value, and the name to report. */
interface KeyedEntry<K, V> {
  readonly key: K
  readonly value: V
  readonly name: string
}

/**
 * Resolve one keyed bucket. A higher scope replaces the holder of a key; a
 * same-scope claim is dropped and recorded.
 */
const resolveKeyed = <K, V>(
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
  label: string,
  entriesOf: (
    contributions: ClientContributions,
    extensionId: string,
  ) => ReadonlyArray<KeyedEntry<K, V>>,
): Map<K, V> => {
  const values = new Map<K, V>()
  const claims = new Map<K, Claim>()
  for (const ext of sorted) {
    for (const entry of entriesOf(ext.contributions, ext.id)) {
      const held = Option.fromNullishOr(claims.get(entry.key))
      const claimant = { id: ext.id, scope: ext.scope, source: ext.filePath }
      if (collides(held, claimant, label, entry.name, failures)) continue
      values.set(entry.key, entry.value)
      claims.set(entry.key, { scope: ext.scope, source: ext.filePath })
    }
  }
  return values
}

/**
 * Entries by their extension's scope, highest first: a key a higher scope
 * took over keeps the place the lower scope gave it in `resolveKeyed`.
 */
const highestScopeFirst = <V extends { readonly extensionId: string }>(
  sorted: ReadonlyArray<LoadedTuiExtension>,
  entries: ReadonlyArray<V>,
): ReadonlyArray<V> => {
  const precedence = new Map(sorted.map((ext) => [ext.id, SCOPE_PRECEDENCE[ext.scope]]))
  const of = (entry: V) =>
    Option.getOrElse(Option.fromUndefinedOr(precedence.get(entry.extensionId)), () => 0)
  return entries.toSorted((a, b) => of(b) - of(a))
}

// ── command resolution ──

/**
 * One owner of commands: the session's own commands, each client extension,
 * and each server extension's slash commands. The session's commands and the
 * server's sit at builtin scope.
 */
export interface CommandSource {
  readonly id: string
  readonly scope: ExtensionScope
  /** Where the commands come from, named in a collision report. */
  readonly source: string
  readonly commands: ReadonlyArray<Command>
}

interface ResolvedCommands {
  readonly commands: ReadonlyArray<Command>
  readonly failures: ReadonlyArray<ClientExtensionFailure>
}

export interface Keybind {
  key: string
  ctrl: boolean
  shift: boolean
  meta: boolean
}

export function parseKeybind(config: string): Option.Option<Keybind> {
  if (config.length === 0) return Option.none()

  const parts = config.toLowerCase().split("+")
  const keybind: Keybind = {
    key: "",
    ctrl: false,
    shift: false,
    meta: false,
  }

  for (const part of parts) {
    switch (part) {
      case "ctrl":
      case "control":
        keybind.ctrl = true
        break
      case "shift":
        keybind.shift = true
        break
      case "meta":
      case "cmd":
      case "command":
        keybind.meta = true
        break
      default:
        keybind.key = part
        break
    }
  }

  return Option.some(keybind)
}

// Grapheme breaks do not depend on the locale.
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })

/**
 * Whether `key` is one glyph (`j`, `é`, `🙂`). A named key (`left`, `f1`,
 * `tab`) is several; a glyph counts as one whatever its UTF-16 length.
 */
const isOneGlyph = (key: string): boolean => [...graphemes.segment(key)].length === 1

/**
 * A keybind with no ctrl or meta whose key types a character (`j`, `?`, `é`,
 * `🙂`, `shift+j`, `space`). It would take that character as the first one of
 * every message, so no command may hold it.
 */
const typesACharacter = (keybind: Keybind): boolean =>
  !keybind.ctrl && !keybind.meta && (isOneGlyph(keybind.key) || keybind.key === "space")

/**
 * The keys no command may hold, each with why. Keybinds run before the
 * session's Esc and ctrl+c ladders, so a keybind on either key would take the
 * pane close, the turn cancel and the quit away from it. Shift does not
 * change the key: the ladders read Esc and ctrl+c with or without it.
 */
const REFUSED_KEYBINDS: ReadonlyArray<{
  readonly holds: (keybind: Keybind) => boolean
  readonly reason: string
}> = [
  {
    holds: typesACharacter,
    reason:
      "types a character; a bare keybind needs a key that types nothing (an arrow, a function key) or ctrl/meta",
  },
  {
    holds: (keybind) => !keybind.ctrl && !keybind.meta && keybind.key === "escape",
    reason: "takes Esc, which cancels a turn and quits; add ctrl or meta",
  },
  {
    holds: (keybind) => keybind.ctrl && !keybind.meta && keybind.key === "c",
    reason: "takes ctrl+c, which closes a pane, cancels a turn and quits",
  },
]

/** Why a command may not hold `keybind`, or `None` when it may. */
const refusedKeybind = (keybind: Keybind): Option.Option<string> =>
  Option.map(
    Option.fromNullishOr(REFUSED_KEYBINDS.find((refused) => refused.holds(keybind))),
    (refused) => refused.reason,
  )

/** Strip every keybind a command may not hold, and list each with the failures. */
const withoutRefusedKeybinds = (
  source: CommandSource,
  failures: Array<ClientExtensionFailure>,
): CommandSource => ({
  ...source,
  commands: source.commands.map((entry) => {
    const keybind = Option.fromNullishOr(entry.keybind)
    const refusal = Option.flatMap(Option.flatMap(keybind, parseKeybind), refusedKeybind)
    if (Option.isNone(refusal)) return entry
    failures.push({
      id: source.id,
      reason: `keybind "${Option.getOrElse(keybind, () => "")}" of command "${entry.id}" ${refusal.value}`,
    })
    const { keybind: _refused, ...rest } = entry
    return rest
  }),
})

type CommandAffordance = "keybind" | "slash"

interface AffordanceHolder {
  readonly commandId: string
  readonly claim: Claim
}

/**
 * The key a holder is filed under. A keybind files by what it parses to, so
 * `shift+ctrl+k` and `ctrl+shift+k`, or `control+k` and `ctrl+k`, are one key.
 */
const affordanceKey = (field: CommandAffordance, value: string): string => {
  const spelled = value.toLowerCase()
  if (field !== "keybind") return spelled
  return Option.match(parseKeybind(value), {
    onNone: () => spelled,
    onSome: (keybind) =>
      [keybind.ctrl && "ctrl", keybind.shift && "shift", keybind.meta && "meta", keybind.key]
        .filter((part) => part !== false)
        .join("+"),
  })
}

/**
 * Whether a command of the same scope already holds `entry`'s `field`
 * (keybind or slash). A collision is recorded as a failure.
 */
const affordanceCollides = (
  field: CommandAffordance,
  entry: Command,
  source: CommandSource,
  holders: Map<string, AffordanceHolder>,
  failures: Array<ClientExtensionFailure>,
): boolean => {
  const value = Option.fromNullishOr(entry[field])
  if (Option.isNone(value)) return false
  const held = Option.fromNullishOr(holders.get(affordanceKey(field, value.value)))
  const heldClaim = Option.map(held, (holder) => holder.claim)
  return collides(heldClaim, source, field, value.value, failures)
}

/** Give `entry` its `field` and strip it from the command that held it before. */
const takeAffordance = (
  field: CommandAffordance,
  entry: Command,
  source: CommandSource,
  kept: Map<string, Command>,
  holders: Map<string, AffordanceHolder>,
): void => {
  const value = Option.fromNullishOr(entry[field])
  if (Option.isNone(value)) return
  const key = affordanceKey(field, value.value)
  const held = Option.fromNullishOr(holders.get(key))
  if (Option.isSome(held)) {
    const previous = Option.fromNullishOr(kept.get(held.value.commandId))
    if (Option.isSome(previous)) {
      const { [field]: _released, ...rest } = previous.value
      kept.set(held.value.commandId, rest)
    }
  }
  holders.set(key, { commandId: entry.id, claim: { scope: source.scope, source: source.source } })
}

/**
 * The one command rule. Sources resolve by scope (builtin, then user, then
 * project), in the given order inside a scope. A higher scope replaces a
 * command id and takes its keybind or slash from the earlier owner; a
 * same-scope claim of a held id, keybind or slash drops the later command.
 * A command is all-or-nothing: every collision it has is checked before it
 * takes any keybind or slash, so a dropped command strips nothing.
 * A keybind that types a character, takes a bare Esc or takes ctrl+c is refused first, in every scope: the
 * command keeps its slash and palette row, and the keybind is listed with the
 * failures.
 */
export const resolveCommands = (sources: ReadonlyArray<CommandSource>): ResolvedCommands => {
  const failures: Array<ClientExtensionFailure> = []
  const ordered = sources
    .map((source) => withoutRefusedKeybinds(source, failures))
    .sort((a, b) => SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope])
  const winners = new Map<string, Command>()
  const idClaims = new Map<string, Claim>()
  for (const source of ordered) {
    for (const entry of source.commands) {
      const held = Option.fromNullishOr(idClaims.get(entry.id))
      if (collides(held, source, "command", entry.id, failures)) continue
      winners.set(entry.id, entry)
      idClaims.set(entry.id, { scope: source.scope, source: source.source })
    }
  }
  const kept = new Map<string, Command>()
  const keybinds = new Map<string, AffordanceHolder>()
  const slashes = new Map<string, AffordanceHolder>()
  for (const source of ordered) {
    for (const entry of source.commands) {
      if (winners.get(entry.id) !== entry) continue
      const keybindCollides = affordanceCollides("keybind", entry, source, keybinds, failures)
      const slashCollides = affordanceCollides("slash", entry, source, slashes, failures)
      if (keybindCollides || slashCollides) continue
      takeAffordance("keybind", entry, source, kept, keybinds)
      takeAffordance("slash", entry, source, kept, slashes)
      kept.set(entry.id, entry)
    }
  }
  return { commands: [...kept.values()], failures }
}

const byPriority = <A extends { readonly priority: number }>(items: ReadonlyArray<A>) =>
  [...items].sort((a, b) => a.priority - b.priority)

// eslint-disable-next-line effect/noNullish -- contribution priority is optional.
const priorityOrDefault = (priority: number | undefined) =>
  Option.getOrElse(Option.fromNullishOr(priority), () => 100)

/**
 * Resolve all TUI extension contributions with scope precedence. Higher scope
 * wins for one key; a same-scope collision drops the later contribution and
 * joins `failures` after the load failures passed in.
 */
export const resolveTuiExtensions = (
  extensions: ReadonlyArray<LoadedTuiExtension>,
  loadFailures: ReadonlyArray<ClientExtensionFailure> = [],
): ResolvedTuiExtensions => {
  const failures = [...loadFailures]
  // Scope precedence, then id in code-unit order, as the server sorts: the
  // order picks the winner of a same-scope collision.
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return Order.String(a.id, b.id)
  })

  const renderers = resolveKeyed(sorted, failures, "renderer", (contributions, extensionId) =>
    itemsOrEmpty(contributions.renderers).flatMap((contribution) =>
      contribution.toolNames.map((name) => ({
        key: name.toLowerCase(),
        value: { extensionId, component: contribution.component },
        name,
      })),
    ),
  )
  const messageRenderers = resolveKeyed(
    sorted,
    failures,
    "message renderer",
    (contributions, extensionId) =>
      itemsOrEmpty(contributions.messageRenderers).map((contribution) => ({
        key: contribution.customType,
        value: { ...contribution, extensionId },
        name: contribution.customType,
      })),
  )
  const widgets = resolveKeyed(sorted, failures, "widget", (contributions, extensionId) =>
    itemsOrEmpty(contributions.widgets).map((contribution) => ({
      key: contribution.id,
      value: { ...contribution, extensionId, priority: priorityOrDefault(contribution.priority) },
      name: contribution.id,
    })),
  )
  const noticeRows = resolveKeyed(sorted, failures, "notice row", (contributions, extensionId) =>
    itemsOrEmpty(contributions.noticeRows).map((contribution) => ({
      key: contribution.id,
      value: { id: contribution.id, extensionId, rows: contribution.rows },
      name: contribution.id,
    })),
  )
  const stoppables = resolveKeyed(sorted, failures, "stoppable", (contributions, extensionId) =>
    itemsOrEmpty(contributions.stoppables).map((contribution) => ({
      key: contribution.id,
      value: { ...contribution, extensionId },
      name: contribution.id,
    })),
  )
  const interactionRenderers = resolveKeyed(
    sorted,
    failures,
    "interaction renderer",
    (contributions, extensionId) =>
      itemsOrEmpty(contributions.interactionRenderers).map((contribution) => ({
        key: contribution.metadataType,
        value: { extensionId, component: contribution.component },
        name: contribution.metadataType,
      })),
  )
  return {
    renderers,
    messageRenderers,
    widgets: byPriority([...widgets.values()]),
    commandSources: sorted.map((ext) => ({
      id: ext.id,
      scope: ext.scope,
      source: ext.filePath,
      commands: itemsOrEmpty(ext.contributions.commands),
    })),
    interactionRenderers,
    statusLabels: byPriority(
      sorted.flatMap((ext) =>
        itemsOrEmpty(ext.contributions.statusLabels).map((contribution) => ({
          extensionId: ext.id,
          priority: priorityOrDefault(contribution.priority),
          anchor: contribution.anchor ?? "left",
          produce: contribution.produce,
        })),
      ),
    ),
    noticeRows: [...noticeRows.values()],
    autocompleteItems: sorted.flatMap((ext) =>
      itemsOrEmpty(ext.contributions.autocomplete).map((contribution) => ({
        ...contribution,
        extensionId: ext.id,
      })),
    ),
    stoppables: highestScopeFirst(sorted, [...stoppables.values()]),
    failures,
  }
}

// ── extension loading ───────────────────────────────────────────────────────

/**
 * TUI extension loader — discover → build → import → set up → resolve, as
 * one Effect over the client runtime's services, and again on each reload.
 *
 * Builtins are passed as pre-imported modules (static imports at the call site)
 * so Bun's bundler includes them in compiled binaries. User/project extensions
 * are discovered via filesystem scan, built, and dynamically imported. A module
 * that does not build or import, has the wrong shape, or whose setup fails
 * becomes a failure; the rest still load.
 *
 * Each extension sets up in its own lifetime (`ClientLifecycle`). A reload
 * keeps an extension whose file and imports are unchanged (by stat, then by
 * the built code's hash), sets up a changed one from its new version and ends
 * the old one's lifetime, and ends the lifetime of a removed or disabled one.
 * A new version that fails to build, import or set up keeps the last good one,
 * and the failure is reported.
 */

/** The shape problem with a dynamically imported module, if any. */
// eslint-disable-next-line effect/noUnknownParameters -- dynamic imports are parsed at this module boundary.
const clientModuleProblem = (value: unknown): Option.Option<string> => {
  if (!Predicate.isObject(value)) return Option.some("module must export an object")
  if (!Predicate.hasProperty(value, "id") || !Predicate.isString(value.id)) {
    return Option.some("missing id")
  }
  if (!Predicate.hasProperty(value, "setup") || !Effect.isEffect(value.setup)) {
    return Option.some("setup must be an Effect value")
  }
  return Option.none()
}

const isExtensionClientModule = (value: unknown): value is AnyExtensionClientModule =>
  Option.isNone(clientModuleProblem(value))

class TuiExtensionImportError extends Schema.TaggedError<TuiExtensionImportError>()(
  "TuiExtensionImportError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

interface ImportedExtension {
  readonly module: AnyExtensionClientModule
  readonly scope: ExtensionScope
  readonly filePath: string
  /** The built code's hash; `builtin` for a builtin, which never changes in a process. */
  readonly version: string
}

/**
 * How long one extension may take to import, and again to set up. The host
 * holds pending interactions and native history until every extension has
 * settled, so a load that never ends must become a failure.
 */
const EXTENSION_LOAD_TIMEOUT: Duration.Input = "10 seconds"

/**
 * How many discovered files build and import at once. One at a time, N slow
 * files hold the host for the sum of their imports; the bound keeps a large
 * extension directory from starting every `Bun.build` together. Setups still
 * run one at a time.
 */
const EXTENSION_IMPORT_CONCURRENCY = 4

/** A load step that outlives `timeout` fails with a recorded reason. */
const withinLoadTimeout =
  (id: string, step: "import" | "setup", timeout: Duration.Input) =>
  <A, R>(
    self: Effect.Effect<A, ClientExtensionFailure, R>,
  ): Effect.Effect<A, ClientExtensionFailure, R> =>
    self.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => {
          const reason = `${step} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`
          return Effect.logWarning(`tui-ext.${step}.timeout`).pipe(
            Effect.annotateLogs({ id, error: reason }),
            Effect.andThen(Effect.fail({ id, reason })),
          )
        },
      }),
    )

/**
 * A setup's result as plain contributions (`decodeContributions`), inside this
 * extension's own failure. Anything that throws on the way (a getter, a
 * proxy, a field the decode reads again) fails only this extension.
 */
const readContributions = (
  id: string,
  // eslint-disable-next-line effect/noUnknownParameters -- a user setup's result is parsed at this module boundary.
  value: unknown,
): Effect.Effect<ClientContributions, ClientExtensionFailure> =>
  Effect.suspend(() => decodeContributions(value)).pipe(
    Effect.mapError((reason) => ({ id, reason })),
    Effect.catchDefect((defect) =>
      Effect.fail({ id, reason: `reading contributions failed: ${String(defect)}` }),
    ),
  )

/**
 * One extension's lifecycle over its own scope. `scoped` allocates in a child
 * scope forked before the cleanups' finalizer is added, so the scope's close
 * runs the cleanups first, in registration order, then releases what
 * `scoped` allocated.
 */
const runCleanup = (fn: () => void) => Effect.ignore(Effect.try(fn))

/** A cleanup registered after its lifetime ended runs at once, from the caller's sync code. */
const runLateCleanup = (fn: () => void): void => Effect.runSync(runCleanup(fn))

const extensionLifecycle = (scope: Scope.Closeable): Effect.Effect<ClientLifecycle> =>
  Effect.gen(function* () {
    const allocations = yield* Scope.fork(scope)
    const cleanups: Array<() => void> = []
    let ended = false
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() => {
        ended = true
        return Effect.forEach(cleanups.splice(0), runCleanup, { discard: true })
      }),
    )
    return {
      addCleanup: (fn) => {
        if (ended) runLateCleanup(fn)
        else cleanups.push(fn)
      },
      scoped: (effect) => Scope.provide(allocations)(effect),
    }
  })

/** A client extension the loader set up, with the lifetime a later load keeps or ends. */
interface LiveExtension {
  readonly loaded: LoadedTuiExtension
  readonly module: AnyExtensionClientModule
  readonly version: string
  readonly lifetime: Scope.Closeable
}

/**
 * Run one extension's setup in a new lifetime forked from the client
 * runtime's scope; any failure, defect or timeout becomes a recorded failure
 * and ends that lifetime at once.
 */
const setupExtension = (
  ext: ImportedExtension,
  timeout: Duration.Input,
): Effect.Effect<LiveExtension, ClientExtensionFailure, ClientRuntimeServices> =>
  Effect.gen(function* () {
    const context = yield* ClientContext
    const lifetime = yield* context.lifecycle.scoped(
      Effect.gen(function* () {
        return yield* Scope.fork(yield* Scope.Scope)
      }),
    )
    const lifecycle = yield* extensionLifecycle(lifetime)
    return yield* ext.module.setup.pipe(
      Effect.provideService(ClientContext, ClientContext.of({ ...context, lifecycle })),
      Effect.catchCause((cause) =>
        Effect.logWarning("tui-ext.setup.failed").pipe(
          Effect.annotateLogs({ filePath: ext.filePath, error: Cause.pretty(cause) }),
          Effect.andThen(
            Effect.fail({ id: ext.module.id, reason: `setup failed: ${Cause.squash(cause)}` }),
          ),
        ),
      ),
      Effect.flatMap((value) => readContributions(ext.module.id, value)),
      Effect.map((contributions): LiveExtension => ({
        loaded: {
          id: ext.module.id,
          scope: ext.scope,
          filePath: ext.filePath,
          contributions,
        },
        module: ext.module,
        version: ext.version,
        lifetime,
      })),
      withinLoadTimeout(ext.module.id, "setup", timeout),
      Effect.onError(() => Scope.close(lifetime, Exit.void)),
    )
  })

/**
 * The names a client extension file imports and a server extension file does
 * not: the client protocol entry, the client authoring entry, the shipped
 * extensions' client entry (their RPCs, ids and message types), and Solid.
 * A shipped client extension imports nothing a user one cannot. The
 * compiled binary has no node_modules, so a file outside the repository
 * reaches them only through these bindings, and it gets the TUI's own
 * instances: one Solid runtime, one ClientContext.
 *
 * Bun resolves a bare import from a runtime plugin without the importer, so a
 * global binding would also reach a server extension in the same process.
 * The names are bound under a prefix drawn for each loader instead, and only
 * the client build below rewrites a client file's imports to that prefix.
 */
const clientOnlyModules: ReadonlyMap<string, RuntimeModuleSource> = new Map<
  string,
  RuntimeModuleSource
>([
  ["@gent/core/protocol", () => ProtocolEntry],
  ["@gent/tui/extensions", () => ClientExtensionEntry],
  ["@gent/extensions/client", () => ShippedExtensionsClientEntry],
  ["@opentui/solid", () => OpenTuiSolidEntry],
  ["solid-js", () => SolidEntry],
  ["solid-js/store", () => SolidStoreEntry],
])

/** Import a built client file under the name its source was bound to. */
// oxlint-disable-next-line effect/noDynamicImports -- TUI extension modules are discovered from user/project files at runtime
const importBoundClientModule = (moduleId: string) => import(moduleId)

/**
 * Bind the names every extension file reads (the two authoring entries and
 * `effect`) under their own names, and the client names under a prefix drawn
 * once per loader, so every build of the same files gives the same code and
 * the same version. Return the two steps for a client file: `module` compiles
 * it and the relative modules it imports as the build compiles the shipped
 * ones (Solid JSX), rewriting each client name to its prefixed binding, within
 * the load timeout (the server's coherent build, `buildExtensionModule`, runs
 * it); `importBuild` binds the output under a fresh prefixed name and imports
 * it. A bound name stays an import of the running module. The server root
 * binds the other `effect` modules the shipped extensions read.
 */
const provideClientExtensionModules = (timeout: Duration.Input) =>
  Effect.gen(function* () {
    const prefix = `gent-client-${(yield* Random.nextInt).toString(36)}${(yield* Random.nextInt).toString(36)}:`
    const clientModuleId = (specifier: string) => `${prefix}${specifier}`
    yield* bindBunModules(
      new Map<string, RuntimeModuleSource>([
        ...extensionEntryModules,
        ...[...clientOnlyModules].map(([specifier, source]): [string, RuntimeModuleSource] => [
          clientModuleId(specifier),
          source,
        ]),
      ]),
    )
    const names: ClientBuildNames = {
      external: [...extensionEntryModules.keys(), `${prefix}*`],
      rename: (specifier) =>
        Option.map(
          Option.liftPredicate(specifier, (name: string) => clientOnlyModules.has(name)),
          clientModuleId,
        ),
      solidRuntime: clientModuleId("@opentui/solid"),
    }
    const imports = yield* Ref.make(0)
    return {
      module: {
        bundle: (filePath: string) =>
          buildClientExtension(filePath, names).pipe(
            Effect.mapError((error) => ({ message: String(error.cause) })),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail({
                  message: `timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
                }),
            }),
          ),
        hash: sha256Hex,
      },
      importBuild: (filePath: string, code: string) =>
        Effect.gen(function* () {
          const name = clientModuleId(
            `file:${filePath}#${yield* Ref.updateAndGet(imports, (n) => n + 1)}`,
          )
          yield* bindModuleSource(name, code)
          return yield* Effect.tryPromise({
            try: () => importBoundClientModule(name),
            catch: (cause) =>
              new TuiExtensionImportError({ message: `Failed to load ${filePath}`, cause }),
          })
        }),
    }
  })

type ClientModuleBuilder = Effect.Success<ReturnType<typeof provideClientExtensionModules>>

const LiveHandle = Schema.declare<LiveExtension>((value): value is LiveExtension =>
  Predicate.hasProperty(value, "lifetime"),
)
const ImportedHandle = Schema.declare<ImportedExtension>((value): value is ImportedExtension =>
  Predicate.hasProperty(value, "module"),
)

/**
 * What a load found for one discovered file: the extension it keeps (with
 * the failure of a new version that did not load, if one did not: the load
 * reports it over the kept one, or alone when the kept one does not stay), or
 * the new version to set up.
 */
const FileOutcome = Schema.TaggedUnion({
  Keep: {
    live: LiveHandle,
    failure: Schema.Option(Schema.Struct({ id: Schema.String, reason: Schema.String })),
  },
  Fresh: { imported: ImportedHandle },
})
type FileOutcome = typeof FileOutcome.Type

/** The live extension a load keeps as it is. */
const keep = (live: LiveExtension): FileOutcome =>
  FileOutcome.cases.Keep.make({ live, failure: Option.none() })

/** One discovered file's outcome. */
interface FileResult {
  readonly filePath: string
  readonly outcome: Result.Result<FileOutcome, ClientExtensionFailure>
}

/**
 * A version of a file that failed to import or to set up, and why. The
 * failure stands while the file builds to that version: a load does not
 * import or set it up again, and reports the failure again, until the file
 * builds to another version, is removed or its extension is disabled.
 */
interface FailedAttempt {
  readonly version: string
  readonly failure: ClientExtensionFailure
}

/** The failure of a new version, while the last good version runs on. */
const keptOver = (
  live: LiveExtension,
  failure: ClientExtensionFailure,
): ClientExtensionFailure => ({
  id: live.loaded.id,
  reason: `${failure.reason}; version ${live.version.slice(0, 12)} still runs`,
})

/**
 * The failures of the new versions behind kept extensions: each over the
 * kept one when it stays, or alone when the kept one is disabled or lost its
 * id to another file. A disabled id's failure is not reported.
 */
const keptFailures = (
  outcomes: ReadonlyArray<FileOutcome>,
  staying: ReadonlySet<FileOutcome>,
  disabled: ReadonlySet<string>,
): ReadonlyArray<ClientExtensionFailure> =>
  outcomes.flatMap((outcome) => {
    if (outcome._tag !== "Keep" || Option.isNone(outcome.failure)) return []
    if (staying.has(outcome)) return [keptOver(outcome.live, outcome.failure.value)]
    if (disabled.has(outcome.failure.value.id)) return []
    return [outcome.failure.value]
  })

/**
 * Whether the last good version of a file may run on after its new version
 * failed setup. The load chose the new version by its own id, so the last
 * one's id is checked here: it runs on only while it is not disabled and no
 * other extension of the load holds its id in its scope.
 */
const mayRunOn = (
  prior: LiveExtension,
  replacement: FileOutcome,
  chosen: ReadonlyArray<{
    readonly outcome: FileOutcome
    readonly module: AnyExtensionClientModule
    readonly scope: ExtensionScope
  }>,
  disabled: ReadonlySet<string>,
) =>
  !disabled.has(prior.loaded.id) &&
  !chosen.some(
    (other) =>
      other.outcome !== replacement &&
      other.module.id === prior.loaded.id &&
      other.scope === prior.loaded.scope,
  )

/** A failed version's failure ends with its file, and with its disabled id. */
const forgetEndedAttempts = (
  attempts: Map<string, FailedAttempt>,
  seen: ReadonlySet<string>,
  disabled: ReadonlySet<string>,
) => {
  for (const [filePath, attempt] of attempts) {
    if (!seen.has(filePath) || disabled.has(attempt.failure.id)) attempts.delete(filePath)
  }
}

/**
 * Build and import one discovered file, or keep its live extension. The
 * build is the server's coherent build (`buildExtensionModule`): a file whose
 * inputs' stats are unchanged is not read, and one that builds to the
 * running version is not imported again. A version that failed before is not
 * imported again either: its failure stands (`FailedAttempt`). A build or
 * import that fails keeps the live extension of the same file.
 */
const loadFile = (
  builder: ClientModuleBuilder,
  graphs: ModuleGraphs,
  attempts: Map<string, FailedAttempt>,
  entry: DiscoveredTuiExtension,
  previous: Option.Option<LiveExtension>,
  timeout: Duration.Input,
): Effect.Effect<FileResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const built = yield* buildExtensionModule(entry.filePath, graphs, builder.module)
    const outcome = yield* Effect.gen(function* () {
      const code = yield* Effect.fromResult(built.build).pipe(
        Effect.mapError((error) => ({ id: entry.filePath, reason: `import failed: ${error}` })),
      )
      if (Option.isSome(previous) && previous.value.version === built.version) {
        attempts.delete(entry.filePath)
        return keep(previous.value)
      }
      const attempt = Option.filter(
        Option.fromUndefinedOr(attempts.get(entry.filePath)),
        (failed) => failed.version === built.version,
      )
      if (Option.isSome(attempt)) return yield* Effect.fail(attempt.value.failure)
      const mod = yield* builder.importBuild(entry.filePath, code).pipe(
        Effect.mapError((err) => ({
          id: entry.filePath,
          reason: `import failed: ${String(err.cause)}`,
        })),
        withinLoadTimeout(entry.filePath, "import", timeout),
        Effect.tapError((failure) =>
          Effect.sync(() => attempts.set(entry.filePath, { version: built.version, failure })),
        ),
      )
      const candidate = Option.getOrElse(Option.fromNullishOr(mod.default), () => mod)
      if (!isExtensionClientModule(candidate)) {
        const failure = {
          id: entry.filePath,
          reason: Option.getOrElse(clientModuleProblem(candidate), () => "invalid module shape"),
        }
        attempts.set(entry.filePath, { version: built.version, failure })
        return yield* Effect.fail(failure)
      }
      return FileOutcome.cases.Fresh.make({
        imported: {
          module: candidate,
          scope: entry.scope,
          filePath: entry.filePath,
          version: built.version,
        },
      })
    }).pipe(
      Effect.tapError((failure) =>
        Effect.logWarning("tui-ext.import.failed").pipe(
          Effect.annotateLogs({ filePath: entry.filePath, error: failure.reason }),
        ),
      ),
      Effect.catch((failure) =>
        Option.match(previous, {
          onNone: () => Effect.fail(failure),
          onSome: (live) =>
            Effect.succeed(FileOutcome.cases.Keep.make({ live, failure: Option.some(failure) })),
        }),
      ),
      Effect.result,
    )
    return { filePath: entry.filePath, outcome } satisfies FileResult
  })

/**
 * The server's duplicate-id rule: every extension that shares its id with
 * another in the same scope fails, so neither half of a duplicate loads.
 */
const rejectDuplicateIds = <
  A extends { readonly module: AnyExtensionClientModule; readonly scope: ExtensionScope },
>(
  extensions: ReadonlyArray<A>,
) => {
  const keyOf = (ext: A) => `${ext.scope}:${ext.module.id}`
  const counts = new Map<string, number>()
  for (const ext of extensions) {
    const key = keyOf(ext)
    counts.set(key, Option.getOrElse(Option.fromUndefinedOr(counts.get(key)), () => 0) + 1)
  }
  const unique: Array<A> = []
  const failures: Array<ClientExtensionFailure> = []
  for (const ext of extensions) {
    if (Option.getOrElse(Option.fromUndefinedOr(counts.get(keyOf(ext))), () => 0) > 1) {
      failures.push({
        id: ext.module.id,
        reason: `Duplicate extension id "${ext.module.id}" in scope "${ext.scope}"`,
      })
    } else unique.push(ext)
  }
  return { unique, failures }
}

/** One load's result: what to show, and the lifetimes the load ended. */
export interface TuiExtensionLoad {
  readonly resolved: ResolvedTuiExtensions
  /** The ids this load set up: a render failure of an earlier instance no longer stands. */
  readonly setUp: ReadonlySet<string>
  /**
   * End the lifetime of each extension this load replaced or removed. Run it
   * once the new set is in view, so nothing on screen draws from a closed one.
   */
  readonly retire: Effect.Effect<void>
}

interface TuiExtensionLoader {
  /** Load the extensions, or load them again over the last load. One load runs at a time. */
  readonly load: Effect.Effect<TuiExtensionLoad, never, ClientRuntimeServices>
  /**
   * Whether a load would change something: a client file came or went, a
   * file a build read has another stat, or the disabled list changed. Reads
   * stats and configs only.
   */
  readonly stale: Effect.Effect<boolean, never, ClientRuntimeServices>
}

/** Where a builtin sits in the live set: its id names it, as a path names a file. */
const builtinKey = (module: AnyExtensionClientModule) => `builtin:${module.id}`

/**
 * The client extension loader of one client runtime. It keeps the live set
 * between loads: `load` keeps what did not change, sets up what did, and
 * says which lifetimes to end.
 *
 * @param opts.builtins — pre-imported builtin modules (static imports for bundler reachability)
 * @param opts.readDisabled — the extension ids to skip, read again on each load (builtins and
 *   discovered alike). A discovered extension is imported to read its id, but its setup is skipped.
 */
export const makeTuiExtensionLoader = (opts: {
  readonly builtins?: ReadonlyArray<AnyExtensionClientModule>
  readonly userDir: string
  readonly projectDir: string
  readonly readDisabled: Effect.Effect<ReadonlyArray<string>, never, ClientRuntimeServices>
  /** Bound on each import and each setup; a test shortens it. */
  readonly loadTimeout?: Duration.Input
}): Effect.Effect<TuiExtensionLoader, never, ClientRuntimeServices> =>
  Effect.gen(function* () {
    const timeout = Option.getOrElse(
      Option.fromNullishOr(opts.loadTimeout),
      () => EXTENSION_LOAD_TIMEOUT,
    )
    const builtins = Option.getOrElse(Option.fromNullishOr(opts.builtins), () => [])
    const builder = yield* provideClientExtensionModules(timeout)
    const permit = yield* Semaphore.make(1)
    let live = new Map<string, LiveExtension>()
    /** Each discovered file's build, as the server keeps its own (`buildExtensionModule`). */
    const graphs = makeModuleGraphs()
    /** The version of each file that failed to import or set up, while it stands. */
    const attempts = new Map<string, FailedAttempt>()
    /** Each discovered file of the last load, loaded or failed. */
    let seen: ReadonlySet<string> = new Set()
    let lastDisabled: ReadonlySet<string> = new Set()

    const load = Effect.gen(function* () {
      const disabled = new Set(yield* opts.readDisabled)
      const discovered = yield* discoverTuiExtensions(opts)
      // Results, failures included, keep discovery order whatever order the imports finish in.
      const files = yield* Effect.forEach(
        discovered,
        (entry) =>
          loadFile(
            builder,
            graphs,
            attempts,
            entry,
            Option.fromUndefinedOr(live.get(entry.filePath)),
            timeout,
          ),
        { concurrency: EXTENSION_IMPORT_CONCURRENCY },
      )
      const importFailures: Array<ClientExtensionFailure> = []
      const outcomes: Array<FileOutcome> = []
      for (const file of files) {
        if (Result.isFailure(file.outcome)) importFailures.push(file.outcome.failure)
        else outcomes.push(file.outcome.success)
      }
      const builtinOutcomes = builtins.map((module): FileOutcome => {
        const previous = Option.fromUndefinedOr(live.get(builtinKey(module)))
        if (Option.isSome(previous) && previous.value.module === module) return keep(previous.value)
        return FileOutcome.cases.Fresh.make({
          imported: { module, scope: "builtin", filePath: builtinKey(module), version: "builtin" },
        })
      })
      const candidates = [...builtinOutcomes, ...outcomes].map((outcome) => {
        if (outcome._tag === "Keep") {
          return { outcome, module: outcome.live.module, scope: outcome.live.loaded.scope }
        }
        return { outcome, module: outcome.imported.module, scope: outcome.imported.scope }
      })
      const enabled = rejectDuplicateIds(
        candidates.filter((candidate) => !disabled.has(candidate.module.id)),
      )
      const next = new Map<string, LiveExtension>()
      const setUp = new Set<string>()
      const setupFailures: Array<ClientExtensionFailure> = []
      importFailures.push(
        ...keptFailures(
          candidates.map(({ outcome }) => outcome),
          new Set(enabled.unique.map(({ outcome }) => outcome)),
          disabled,
        ),
      )
      for (const { outcome } of enabled.unique) {
        if (outcome._tag === "Keep") {
          next.set(outcome.live.loaded.filePath, outcome.live)
          continue
        }
        const previous = Option.fromUndefinedOr(live.get(outcome.imported.filePath))
        const set = yield* setupExtension(outcome.imported, timeout).pipe(Effect.result)
        if (Result.isSuccess(set)) {
          next.set(outcome.imported.filePath, set.success)
          setUp.add(set.success.loaded.id)
          attempts.delete(outcome.imported.filePath)
          continue
        }
        attempts.set(outcome.imported.filePath, {
          version: outcome.imported.version,
          failure: set.failure,
        })
        const fallback = Option.filter(previous, (prior) =>
          mayRunOn(prior, outcome, enabled.unique, disabled),
        )
        if (Option.isSome(fallback)) {
          next.set(outcome.imported.filePath, fallback.value)
          setupFailures.push(keptOver(fallback.value, set.failure))
        } else setupFailures.push(set.failure)
      }
      const kept = new Set(next.values())
      const retired = [...live.values()].filter((ext) => !kept.has(ext))
      live = next
      seen = new Set(files.map((file) => file.filePath))
      forgetEndedAttempts(attempts, seen, disabled)
      lastDisabled = disabled
      return {
        resolved: resolveTuiExtensions(
          [...next.values()].map((ext) => ext.loaded),
          [...importFailures, ...enabled.failures, ...setupFailures],
        ),
        setUp,
        retire: Effect.forEach(retired, (ext) => Scope.close(ext.lifetime, Exit.void), {
          discard: true,
        }),
      } satisfies TuiExtensionLoad
    }).pipe(permit.withPermits(1))

    const stale = Effect.gen(function* () {
      const disabled = new Set(yield* opts.readDisabled)
      if (disabled.size !== lastDisabled.size || [...disabled].some((id) => !lastDisabled.has(id)))
        return true
      const discovered = yield* discoverTuiExtensions(opts)
      if (discovered.length !== seen.size) return true
      for (const entry of discovered) {
        if (!seen.has(entry.filePath)) return true
        if (yield* extensionModuleChanged(entry.filePath, graphs)) return true
      }
      return false
    })

    return { load, stale } satisfies TuiExtensionLoader
  })

/**
 * Load all TUI extensions once: discover files, import modules, run setups,
 * resolve with scope precedence. Each lifetime ends with the client runtime.
 *
 * @param opts.disabled — extension ids to skip (applies to builtins and discovered alike).
 */
export const loadTuiExtensions = (opts: {
  readonly builtins?: ReadonlyArray<AnyExtensionClientModule>
  readonly userDir: string
  readonly projectDir: string
  readonly disabled?: ReadonlyArray<string>
  /** Bound on each import and each setup; a test shortens it. */
  readonly loadTimeout?: Duration.Input
}): Effect.Effect<ResolvedTuiExtensions, never, ClientRuntimeServices> =>
  Effect.gen(function* () {
    const loader = yield* makeTuiExtensionLoader({
      ...opts,
      readDisabled: Effect.succeed(Option.getOrElse(Option.fromNullishOr(opts.disabled), () => [])),
    })
    return (yield* loader.load).resolved
  })

// ── extension context ───────────────────────────────────────────────────────

/** The Promise edge of a client runtime's loader, for `ExtensionUIProvider`. */
interface ExtensionUiLoader {
  /** Load, or load again; `retire` ends the lifetimes the load replaced. */
  readonly load: () => Promise<{
    readonly resolved: ResolvedTuiExtensions
    readonly setUp: ReadonlySet<string>
    readonly retire: () => Promise<void>
  }>
  readonly stale: () => Promise<boolean>
}

/**
 * The one boundary where extension loading leaves Effect: `ExtensionUIProvider`
 * awaits each load and each staleness check. The loader reads the disabled
 * list on each load and runs every setup on the provider's client runtime.
 */
export const extensionUiLoader = (
  clientRuntime: ClientRuntime,
  params: {
    readonly builtins: ReadonlyArray<AnyExtensionClientModule>
    readonly home: string
    readonly cwd: string
  },
): ExtensionUiLoader => {
  // Made on the first load: the bindings and the build prefix last as long as the runtime.
  let made = Option.none<Promise<TuiExtensionLoader>>()
  const loader = (): Promise<TuiExtensionLoader> => {
    if (Option.isSome(made)) return made.value
    const making = clientRuntime.runPromise(
      makeTuiExtensionLoader({
        builtins: params.builtins,
        userDir: `${params.home}/.gent/extensions`,
        projectDir: `${params.cwd}/.gent/extensions`,
        readDisabled: readDisabledExtensions({ home: params.home, cwd: params.cwd }).pipe(
          Effect.map((disabled) => [...disabled]),
        ),
      }),
    )
    made = Option.some(making)
    return making
  }
  return {
    load: () =>
      loader().then((current) =>
        clientRuntime.runPromise(
          current.load.pipe(
            Effect.map((result) => ({
              resolved: result.resolved,
              setUp: result.setUp,
              retire: () => clientRuntime.runPromise(result.retire),
            })),
          ),
        ),
      ),
    stale: () => loader().then((current) => clientRuntime.runPromise(current.stale)),
  }
}

// ── autocomplete popup edge ─────────────────────────────────────────────────

/**
 * Boundary helper for {@link AutocompletePopup}.
 *
 * The popup's `createResource` callback consumes `Promise<readonly
 * AutocompleteItem[]>` (Solid's signal lane). When a contribution returns an
 * `Effect`, we exit Effect-land via `clientRuntime.runPromise(...)` — the only
 * sanctioned form is from a `*-boundary.ts` module per
 * `effect/noRunPromise`.
 */

const toAutocompleteEffect = (
  items:
    | ReadonlyArray<AutocompleteItem>
    | Effect.Effect<ReadonlyArray<AutocompleteItem>, Error, ClientRuntimeServices>,
): Effect.Effect<ReadonlyArray<AutocompleteItem>, string, ClientRuntimeServices> => {
  if (Effect.isEffect(items)) return items.pipe(Effect.mapError(String))
  return Effect.succeed(items)
}

/**
 * A merged row and the contribution that offered it. Several contributions
 * may share a prefix; a pick inserts and records through its own source, and
 * the popup drops the row once that source's extension fails.
 */
export interface SourcedAutocompleteItem<
  C extends AutocompleteContribution = ResolvedAutocomplete,
> {
  readonly item: AutocompleteItem
  readonly source: C
}

/** What one fetch of a prefix's sources asks for. */
interface AutocompleteQuery {
  readonly filter: string
  /** The popup opens on the prefix: each source's `onOpen` runs before its `items`. */
  readonly opening: boolean
}

/**
 * How a source that gave no rows is reported. Either way it gives no rows
 * this time, and the other sources' rows still show.
 */
interface AutocompleteReport<C extends AutocompleteContribution> {
  /** Its `items` Effect failed (a request that failed); it stays offered. */
  readonly failed: (contribution: C, reason: string) => void
  /** Its code threw or died (`items`, `onOpen`, a bad reply): a bug in its extension. */
  readonly broke: (contribution: C, reason: string) => void
}

export const runAutocompleteContributions = <C extends AutocompleteContribution>(
  contributions: ReadonlyArray<C>,
  query: AutocompleteQuery,
  clientRuntime: ClientRuntime,
  report: AutocompleteReport<C>,
): Promise<SourcedAutocompleteItem<C>[]> =>
  clientRuntime.runPromise(
    Effect.forEach(
      contributions,
      (contribution) =>
        Effect.suspend(() => {
          if (query.opening) contribution.onOpen?.()
          return toAutocompleteEffect(contribution.items(query.filter))
        }).pipe(
          Effect.map((items) => items.map((item) => ({ item, source: contribution }))),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.sync(() => {
                const reason = String(Cause.squash(cause))
                if (Cause.hasDies(cause)) report.broke(contribution, reason)
                else report.failed(contribution, reason)
                return [] satisfies SourcedAutocompleteItem<C>[]
              }),
          ),
        ),
      { concurrency: 16 },
    ).pipe(
      Effect.map((results) => {
        const seen = new Set<string>()
        const deduped: SourcedAutocompleteItem<C>[] = []
        for (const batch of results) {
          for (const entry of batch) {
            if (seen.has(entry.item.id)) continue
            seen.add(entry.item.id)
            deduped.push(entry)
          }
        }
        return deduped
      }),
    ),
  )
