import { Cause, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import {
  type ExtensionScope,
  isClientEntrypoint,
  isClientFile,
  SCOPE_PRECEDENCE,
} from "@gent/core/protocol"
import {
  isProjectExtensionDirectoryTrusted,
  readDisabledExtensions,
} from "@gent/core-internal/runtime/config"
import {
  type AnyExtensionClientModule,
  type AutocompleteContribution,
  type AutocompleteItem,
  type BorderLabelItem,
  type BorderLabelPosition,
  type ClientContributions,
  type ClientRuntime,
  type ClientRuntimeServices,
  type InteractionRendererComponent,
  type OverlayComponent,
  type WidgetComponent,
  type WidgetSlot,
} from "./client-facets.js"
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
      // oxlint-disable-next-line no-await-in-loop -- sequential: type determines action
      const info = yield* fs.stat(filePath).pipe(Effect.option)
      if (info._tag === "None") continue

      if (info.value.type === "File" && isClientFile(entry)) {
        results.push({ filePath, scope })
      } else if (info.value.type === "Directory") {
        // oxlint-disable-next-line no-await-in-loop -- sequential: directory scan recurses through nested scopes
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

    return results.sort((a, b) => a.filePath.localeCompare(b.filePath))
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
 * Keyed buckets (renderers by tool name, widgets and overlays by id,
 * interaction renderers by metadata type, commands by id) go through
 * `resolveKeyed`. A command's keybind and slash then go to its highest-scope
 * claimant, and `stripSuperseded` removes them from the earlier owner. Border
 * labels and autocomplete sources are collected in scope order.
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

export interface ResolvedBorderLabel {
  readonly position: BorderLabelPosition
  readonly priority: number
  readonly produce: () => ReadonlyArray<BorderLabelItem>
}

export interface ResolvedTuiExtensions {
  readonly renderers: Map<string, ToolRenderer>
  readonly widgets: ReadonlyArray<ResolvedWidget>
  readonly commands: ReadonlyArray<Command>
  readonly overlays: Map<string, OverlayComponent>
  // eslint-disable-next-line effect/noNullish -- the undefined key selects the default renderer.
  readonly interactionRenderers: Map<string | undefined, InteractionRendererComponent>
  readonly borderLabels: ReadonlyArray<ResolvedBorderLabel>
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
  ext: LoadedTuiExtension,
  label: string,
  key: string,
  failures: Array<ClientExtensionFailure>,
): boolean => {
  if (Option.isNone(held) || held.value.scope !== ext.scope) return false
  if (held.value.source === ext.filePath) return false
  failures.push({
    id: ext.id,
    reason: `${label} "${key}" is already claimed by "${held.value.source}" in scope "${ext.scope}"`,
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
  entriesOf: (contributions: ClientContributions) => ReadonlyArray<KeyedEntry<K, V>>,
): Map<K, V> => {
  const values = new Map<K, V>()
  const claims = new Map<K, Claim>()
  for (const ext of sorted) {
    for (const entry of entriesOf(ext.contributions)) {
      const held = Option.fromNullishOr(claims.get(entry.key))
      if (collides(held, ext, label, entry.name, failures)) continue
      values.set(entry.key, entry.value)
      claims.set(entry.key, { scope: ext.scope, source: ext.filePath })
    }
  }
  return values
}

type CommandAffordance = "keybind" | "slash"

interface AffordanceHolder {
  readonly commandId: string
  readonly claim: Claim
}

/**
 * Give `entry` its `field` (keybind or slash) and strip it from the command
 * that held it before. Returns false, recording a failure, when a command of
 * the same scope already holds it.
 */
const stripSuperseded = (
  field: CommandAffordance,
  entry: Command,
  ext: LoadedTuiExtension,
  kept: Map<string, Command>,
  holders: Map<string, AffordanceHolder>,
  failures: Array<ClientExtensionFailure>,
): boolean => {
  const value = Option.fromNullishOr(entry[field])
  if (Option.isNone(value)) return true
  const key = value.value.toLowerCase()
  const held = Option.fromNullishOr(holders.get(key))
  const heldClaim = Option.map(held, (holder) => holder.claim)
  if (collides(heldClaim, ext, field, value.value, failures)) return false
  if (Option.isSome(held)) {
    const previous = Option.fromNullishOr(kept.get(held.value.commandId))
    if (Option.isSome(previous)) {
      kept.set(held.value.commandId, {
        ...previous.value,
        [field]: Option.getOrUndefined(Option.none()),
      })
    }
  }
  holders.set(key, { commandId: entry.id, claim: { scope: ext.scope, source: ext.filePath } })
  return true
}

const resolveCommands = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
): ReadonlyArray<Command> => {
  const winners = resolveKeyed(sorted, failures, "command", (contributions) =>
    itemsOrEmpty(contributions.commands).map((entry) => ({
      key: entry.id,
      value: entry,
      name: entry.id,
    })),
  )
  const kept = new Map<string, Command>()
  const keybinds = new Map<string, AffordanceHolder>()
  const slashes = new Map<string, AffordanceHolder>()
  for (const ext of sorted) {
    for (const entry of itemsOrEmpty(ext.contributions.commands)) {
      if (winners.get(entry.id) !== entry) continue
      if (!stripSuperseded("keybind", entry, ext, kept, keybinds, failures)) continue
      if (!stripSuperseded("slash", entry, ext, kept, slashes, failures)) continue
      kept.set(entry.id, entry)
    }
  }
  return [...kept.values()]
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
  // Sort by scope precedence, then by id for deterministic same-scope order (matches server)
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.id.localeCompare(b.id)
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
  const widgets = resolveKeyed(sorted, failures, "widget", (contributions) =>
    itemsOrEmpty(contributions.widgets).map((contribution) => ({
      key: contribution.id,
      value: { ...contribution, priority: priorityOrDefault(contribution.priority) },
      name: contribution.id,
    })),
  )
  const commands = resolveCommands(sorted, failures)
  const overlays = resolveKeyed(sorted, failures, "overlay", (contributions) =>
    itemsOrEmpty(contributions.overlays).map((contribution) => ({
      key: contribution.id,
      value: contribution.component,
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
        name: Option.getOrElse(Option.fromNullishOr(contribution.metadataType), () => "(default)"),
      })),
  )
  return {
    renderers,
    widgets: byPriority([...widgets.values()]),
    commands,
    overlays,
    interactionRenderers,
    borderLabels: byPriority(
      collected((contributions) => contributions.borderLabels).map((contribution) => ({
        position: contribution.position,
        priority: priorityOrDefault(contribution.priority),
        produce: contribution.produce,
      })),
    ),
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

/** Run one extension's setup; any failure or defect becomes a recorded failure. */
const setupExtension = (
  ext: ImportedExtension,
): Effect.Effect<LoadedTuiExtension, ClientExtensionFailure, ClientRuntimeServices> =>
  ext.module.setup.pipe(
    Effect.map((contributions) => ({
      id: ext.module.id,
      scope: ext.scope,
      filePath: ext.filePath,
      contributions,
    })),
    Effect.catchCause((cause) =>
      Effect.logWarning("tui-ext.setup.failed").pipe(
        Effect.annotateLogs({ filePath: ext.filePath, error: Cause.pretty(cause) }),
        Effect.andThen(
          Effect.fail({ id: ext.module.id, reason: `setup failed: ${Cause.squash(cause)}` }),
        ),
      ),
    ),
  )

/** Import module and validate shape — does NOT call setup() */
function loadExtensionModule(filePath: string) {
  // gent/no-dynamic-imports: allow TUI extension modules are discovered from user/project files at runtime
  return import(filePath)
}

const importExtension = (
  entry: DiscoveredTuiExtension,
): Effect.Effect<ImportedExtension, ClientExtensionFailure> =>
  Effect.gen(function* () {
    const mod = yield* Effect.tryPromise({
      try: () => loadExtensionModule(entry.filePath),
      catch: (cause) =>
        new TuiExtensionImportError({
          message: `Failed to load ${entry.filePath}`,
          cause,
        }),
    })
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
  )

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
}): Effect.Effect<ResolvedTuiExtensions, never, ClientRuntimeServices> =>
  Effect.gen(function* () {
    const disabled = new Set(Option.getOrElse(Option.fromNullishOr(opts.disabled), () => []))
    const discovered = yield* discoverTuiExtensions(opts)
    const [importFailures, imported] = yield* Effect.partition(discovered, importExtension)
    const builtins = Option.getOrElse(Option.fromNullishOr(opts.builtins), () => []).map(
      (module): ImportedExtension => ({
        module,
        scope: "builtin",
        filePath: `builtin:${module.id}`,
      }),
    )
    const enabled = [...builtins, ...imported].filter((ext) => !disabled.has(ext.module.id))
    const [setupFailures, loaded] = yield* Effect.partition(enabled, setupExtension)
    return resolveTuiExtensions(loaded, [...importFailures, ...setupFailures])
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
