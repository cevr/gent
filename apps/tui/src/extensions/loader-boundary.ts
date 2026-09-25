import {
  Cause,
  Duration,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Predicate,
  Random,
  Ref,
  Schema,
} from "effect"
import {
  type ExtensionScope,
  isClientEntrypoint,
  isClientFile,
  SCOPE_PRECEDENCE,
} from "@gent/core/protocol"
import {
  bindBunModules,
  extensionEntryModules,
  hasProjectScope,
  isProjectExtensionDirectoryTrusted,
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
  type StatusLabelItem,
  type ClientContributions,
  type ClientRuntime,
  type ClientRuntimeServices,
  type InteractionRendererComponent,
  type MessageRendererEntry,
  type NoticeRow,
  type WidgetComponent,
  type WidgetSlot,
  unknownContributionKey,
} from "./client-facets.js"
import {
  bindModuleSource,
  buildClientExtension,
  type ClientBuildNames,
} from "../client-extension-build-adapter"
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
      if (
        entry.startsWith(".") ||
        entry.startsWith("_") ||
        entry === "__tests__" ||
        entry === "node_modules"
      )
        continue

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
  readonly id: string
  readonly slot: WidgetSlot
  readonly priority: number
  readonly component: WidgetComponent
}

export interface ResolvedStatusLabel {
  readonly priority: number
  readonly produce: () => ReadonlyArray<StatusLabelItem>
}

/** One extension's transcript rows, under the notice id it won. */
export interface ResolvedNoticeRows {
  readonly id: string
  /** The extension that contributed them, named when they fail. */
  readonly extensionId: string
  readonly rows: (session: ActiveExtensionSession) => Option.Option<ReadonlyArray<NoticeRow>>
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ToolRenderer>
  /** Keyed by `metadata.customType`, matched exactly. */
  readonly messageRenderers: Map<string, MessageRendererEntry>
  readonly widgets: ReadonlyArray<ResolvedWidget>
  /** Each extension's commands, in scope order; `resolveCommands` decides the owners. */
  readonly commandSources: ReadonlyArray<CommandSource>
  readonly interactionRenderers: Map<string, InteractionRendererComponent>
  readonly statusLabels: ReadonlyArray<ResolvedStatusLabel>
  readonly noticeRows: ReadonlyArray<ResolvedNoticeRows>
  readonly autocompleteItems: ReadonlyArray<AutocompleteContribution>
  readonly failures: ReadonlyArray<ClientExtensionFailure>
}

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
 * A keybind with no ctrl or meta on Esc. Keybinds run before the Esc ladder,
 * so it would take the turn cancel and the quit away from Esc.
 */
const holdsEscape = (keybind: Keybind): boolean =>
  !keybind.ctrl && !keybind.meta && keybind.key === "escape"

/** Why a command may not hold `keybind`, or `None` when it may. */
const refusedKeybind = (keybind: Keybind): Option.Option<string> => {
  if (typesACharacter(keybind))
    return Option.some(
      "types a character; a bare keybind needs a key that types nothing (an arrow, a function key) or ctrl/meta",
    )
  if (holdsEscape(keybind))
    return Option.some("takes Esc, which cancels a turn and quits; add ctrl or meta")
  return Option.none()
}

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
    return { ...entry, keybind: Option.getOrUndefined(Option.none<string>()) }
  }),
})

type CommandAffordance = "keybind" | "slash"

interface AffordanceHolder {
  readonly commandId: string
  readonly claim: Claim
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
  const held = Option.fromNullishOr(holders.get(value.value.toLowerCase()))
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
  const key = value.value.toLowerCase()
  const held = Option.fromNullishOr(holders.get(key))
  if (Option.isSome(held)) {
    const previous = Option.fromNullishOr(kept.get(held.value.commandId))
    if (Option.isSome(previous)) {
      kept.set(held.value.commandId, {
        ...previous.value,
        [field]: Option.getOrUndefined(Option.none()),
      })
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
 * A keybind that types a character or takes a bare Esc is refused first, in every scope: the
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
  const collected = <A>(
    // eslint-disable-next-line effect/noNullish -- extension contribution buckets may be omitted.
    bucket: (contributions: ClientContributions) => ReadonlyArray<A> | undefined,
  ) => sorted.flatMap((ext) => itemsOrEmpty(bucket(ext.contributions)))

  const renderers = resolveKeyed(sorted, failures, "renderer", (contributions) =>
    itemsOrEmpty(contributions.renderers).flatMap((contribution) =>
      contribution.toolNames.map((name) => ({
        key: name.toLowerCase(),
        value: contribution.component,
        name,
      })),
    ),
  )
  const messageRenderers = resolveKeyed(sorted, failures, "message renderer", (contributions) =>
    itemsOrEmpty(contributions.messageRenderers).map((contribution) => ({
      key: contribution.customType,
      value: contribution,
      name: contribution.customType,
    })),
  )
  const widgets = resolveKeyed(sorted, failures, "widget", (contributions) =>
    itemsOrEmpty(contributions.widgets).map((contribution) => ({
      key: contribution.id,
      value: { ...contribution, priority: priorityOrDefault(contribution.priority) },
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
  const interactionRenderers = resolveKeyed(
    sorted,
    failures,
    "interaction renderer",
    (contributions) =>
      itemsOrEmpty(contributions.interactionRenderers).map((contribution) => ({
        key: contribution.metadataType,
        value: contribution.component,
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
      collected((contributions) => contributions.statusLabels).map((contribution) => ({
        priority: priorityOrDefault(contribution.priority),
        produce: contribution.produce,
      })),
    ),
    noticeRows: [...noticeRows.values()],
    autocompleteItems: collected((contributions) => contributions.autocomplete),
    failures,
  }
}

// ── extension loading ───────────────────────────────────────────────────────

/**
 * TUI extension loader — discover → import → set up → resolve, as one Effect
 * over the client runtime's services.
 *
 * Builtins are passed as pre-imported modules (static imports at the call site)
 * so Bun's bundler includes them in compiled binaries. User/project extensions
 * are discovered via filesystem scan and dynamic import(). A module that does
 * not import, has the wrong shape, or whose setup fails becomes a failure;
 * the rest still load.
 */

/** The shape problem with a dynamically imported module, if any. */
// eslint-disable-next-line effect/noUnknownParameters -- dynamic imports are parsed at this module boundary.
const clientModuleProblem = (value: unknown): Option.Option<string> => {
  if (!Predicate.isObject(value)) return Option.some("module must export an object")
  const id = Reflect.get(value, "id")
  if (!Predicate.isString(id)) return Option.some("missing id")
  const setup = Reflect.get(value, "setup")
  if (!Effect.isEffect(setup)) return Option.some("setup must be an Effect value")
  return Option.none()
}

// eslint-disable-next-line effect/noUnknownParameters -- dynamic imports are parsed at this module boundary.
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
}

/**
 * How long one extension may take to import, and again to set up. The host
 * holds pending interactions and native history until every extension has
 * settled, so a load that never ends must become a failure.
 */
const EXTENSION_LOAD_TIMEOUT: Duration.Input = "10 seconds"

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
 * What is wrong with a setup's result, if anything. A key outside the known
 * buckets fails by name, so a renamed bucket never drops its items silently.
 */
// eslint-disable-next-line effect/noUnknownParameters -- a user setup's result is parsed at this module boundary.
const contributionsProblem = (value: unknown): Option.Option<string> => {
  if (!Predicate.isObject(value)) return Option.some("setup must return contributions")
  return Option.map(
    unknownContributionKey(Object.keys(value)),
    (key) => `unknown contribution "${key}"`,
  )
}

/** Run one extension's setup; any failure, defect or timeout becomes a recorded failure. */
const setupExtension = (
  ext: ImportedExtension,
  timeout: Duration.Input,
): Effect.Effect<LoadedTuiExtension, ClientExtensionFailure, ClientRuntimeServices> =>
  ext.module.setup.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("tui-ext.setup.failed").pipe(
        Effect.annotateLogs({ filePath: ext.filePath, error: Cause.pretty(cause) }),
        Effect.andThen(
          Effect.fail({ id: ext.module.id, reason: `setup failed: ${Cause.squash(cause)}` }),
        ),
      ),
    ),
    Effect.flatMap((contributions) =>
      Option.match(contributionsProblem(contributions), {
        onSome: (reason) => Effect.fail({ id: ext.module.id, reason }),
        onNone: () =>
          Effect.succeed({
            id: ext.module.id,
            scope: ext.scope,
            filePath: ext.filePath,
            contributions,
          }),
      }),
    ),
    withinLoadTimeout(ext.module.id, "setup", timeout),
  )

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
 * The names are bound under a prefix drawn for each load instead, and only the
 * client build below rewrites a client file's imports to that prefix.
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

/**
 * Bind the names every extension file reads (the two authoring entries and
 * `effect`) under their own names, and the client names under a prefix drawn
 * for this load. Return the loader for client files: it compiles a file and
 * the relative modules it imports as the build compiles the shipped ones
 * (Solid JSX), rewrites each client name to its prefixed binding, binds the
 * output under a fresh prefixed name, and imports it. A bound name stays an
 * import of the running module. The server root binds the other `effect`
 * modules the shipped extensions read.
 */
const provideClientExtensionModules = Effect.gen(function* () {
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
  const builds = yield* Ref.make(0)
  return (filePath: string) =>
    Effect.gen(function* () {
      const contents = yield* buildClientExtension(filePath, names).pipe(
        Effect.mapError(
          (error) =>
            new TuiExtensionImportError({
              message: `Failed to build ${filePath}`,
              cause: error.cause,
            }),
        ),
      )
      const name = clientModuleId(
        `file:${filePath}#${yield* Ref.updateAndGet(builds, (n) => n + 1)}`,
      )
      yield* bindModuleSource(name, contents)
      return yield* Effect.tryPromise({
        // gent/no-dynamic-imports: allow TUI extension modules are discovered from user/project files at runtime
        try: () => import(name),
        catch: (cause) =>
          new TuiExtensionImportError({ message: `Failed to load ${filePath}`, cause }),
      })
    })
})

type ClientExtensionLoader = Effect.Success<typeof provideClientExtensionModules>

const importExtension = (
  load: ClientExtensionLoader,
  entry: DiscoveredTuiExtension,
  timeout: Duration.Input,
): Effect.Effect<ImportedExtension, ClientExtensionFailure> =>
  Effect.gen(function* () {
    const mod = yield* load(entry.filePath)
    const candidate = Option.getOrElse(Option.fromNullishOr(mod.default), () => mod)
    if (!isExtensionClientModule(candidate)) {
      return yield* Effect.fail({
        id: entry.filePath,
        reason: Option.getOrElse(clientModuleProblem(candidate), () => "invalid module shape"),
      })
    }
    return { module: candidate, scope: entry.scope, filePath: entry.filePath }
  }).pipe(
    Effect.catchTag("TuiExtensionImportError", (err) =>
      Effect.fail({ id: entry.filePath, reason: `import failed: ${String(err.cause)}` }),
    ),
    Effect.tapError((failure) =>
      Effect.logWarning("tui-ext.import.failed").pipe(
        Effect.annotateLogs({ filePath: entry.filePath, error: failure.reason }),
      ),
    ),
    withinLoadTimeout(entry.filePath, "import", timeout),
  )

/**
 * The server's duplicate-id rule: every extension that shares its id with
 * another in the same scope fails, so neither half of a duplicate loads.
 */
const rejectDuplicateIds = (extensions: ReadonlyArray<ImportedExtension>) => {
  const keyOf = (ext: ImportedExtension) => `${ext.scope}:${ext.module.id}`
  const counts = new Map<string, number>()
  for (const ext of extensions) {
    const key = keyOf(ext)
    counts.set(key, Option.getOrElse(Option.fromUndefinedOr(counts.get(key)), () => 0) + 1)
  }
  const unique: Array<ImportedExtension> = []
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

/**
 * Load all TUI extensions: discover files, import modules, run setups, resolve
 * with scope precedence.
 *
 * @param opts.builtins — pre-imported builtin modules (static imports for bundler reachability)
 * @param opts.disabled — extension ids to skip (applies to builtins and discovered alike).
 *   Discovered extensions are imported to read their id, but setup is skipped when disabled.
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
    const disabled = new Set(Option.getOrElse(Option.fromNullishOr(opts.disabled), () => []))
    const timeout = Option.getOrElse(
      Option.fromNullishOr(opts.loadTimeout),
      () => EXTENSION_LOAD_TIMEOUT,
    )
    const discovered = yield* discoverTuiExtensions(opts)
    const load = yield* provideClientExtensionModules
    const [importFailures, imported] = yield* Effect.partition(discovered, (entry) =>
      importExtension(load, entry, timeout),
    )
    const builtins = Option.getOrElse(Option.fromNullishOr(opts.builtins), () => []).map(
      (module): ImportedExtension => ({
        module,
        scope: "builtin",
        filePath: `builtin:${module.id}`,
      }),
    )
    const enabled = rejectDuplicateIds(
      [...builtins, ...imported].filter((ext) => !disabled.has(ext.module.id)),
    )
    const [setupFailures, loaded] = yield* Effect.partition(enabled.unique, (ext) =>
      setupExtension(ext, timeout),
    )
    return resolveTuiExtensions(loaded, [...importFailures, ...enabled.failures, ...setupFailures])
  })

// ── extension context ───────────────────────────────────────────────────────

/**
 * The one boundary where extension loading leaves Effect: `onMount` in
 * `ExtensionUIProvider` awaits it. It reads the disabled list and runs
 * `loadTuiExtensions` on the provider's client runtime.
 */
export const loadExtensionUi = (
  clientRuntime: ClientRuntime,
  params: {
    readonly builtins: ReadonlyArray<AnyExtensionClientModule>
    readonly home: string
    readonly cwd: string
  },
): Promise<ResolvedTuiExtensions> =>
  clientRuntime.runPromise(
    Effect.gen(function* () {
      const disabled = yield* readDisabledExtensions({ home: params.home, cwd: params.cwd })
      return yield* loadTuiExtensions({
        builtins: params.builtins,
        userDir: `${params.home}/.gent/extensions`,
        projectDir: `${params.cwd}/.gent/extensions`,
        disabled: [...disabled],
      })
    }),
  )

// ── autocomplete popup edge ─────────────────────────────────────────────────

/**
 * Boundary helper for {@link AutocompletePopup}.
 *
 * The popup's `createResource` callback consumes `Promise<readonly
 * AutocompleteItem[]>` (Solid's signal lane). When a contribution returns an
 * `Effect`, we exit Effect-land via `clientRuntime.runPromise(...)` — the only
 * sanctioned form is from a `*-boundary.ts` module per
 * `gent/no-runpromise-outside-boundary`.
 */

const toAutocompleteEffect = (
  items:
    | ReadonlyArray<AutocompleteItem>
    | Effect.Effect<ReadonlyArray<AutocompleteItem>, Error, ClientRuntimeServices>,
): Effect.Effect<ReadonlyArray<AutocompleteItem>, string, ClientRuntimeServices> => {
  if (Effect.isEffect(items)) return items.pipe(Effect.mapError(String))
  return Effect.succeed(items)
}

export const runAutocompleteContributions = (
  contributions: ReadonlyArray<AutocompleteContribution>,
  filter: string,
  clientRuntime: ClientRuntime,
  onFailure: (prefix: string, reason: string) => void,
): Promise<AutocompleteItem[]> =>
  clientRuntime.runPromise(
    Effect.forEach(
      contributions,
      (contribution) =>
        Effect.try({
          try: () => contribution.items(filter),
          catch: String,
        }).pipe(
          Effect.flatMap(toAutocompleteEffect),
          Effect.catch((reason) =>
            Effect.sync(() => {
              onFailure(contribution.prefix, reason)
              return [] satisfies AutocompleteItem[]
            }),
          ),
        ),
      { concurrency: 16 },
    ).pipe(
      Effect.map((results) => {
        const seen = new Set<string>()
        const deduped: AutocompleteItem[] = []
        for (const batch of results) {
          for (const item of batch) {
            if (seen.has(item.id)) continue
            seen.add(item.id)
            deduped.push(item)
          }
        }
        return deduped
      }),
    ),
  )
