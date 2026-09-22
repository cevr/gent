import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
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
  type ClientContributions,
  type ClientRuntime,
  type ClientRuntimeServices,
  ClientSetupError,
  type InteractionRendererComponent,
  type OverlayComponent,
  type WidgetComponent,
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
 */

/** A client extension, or one of its contributions, that did not load. */
export interface ClientExtensionFailure {
  /** The extension id, or the file path when the module never gave one. */
  readonly id: string
  readonly reason: string
}

export type { ExtensionScope }

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
  readonly widgets: ReadonlyArray<ResolvedWidget>
  readonly commands: ReadonlyArray<Command>
  readonly overlays: Map<string, OverlayComponent>
  // eslint-disable-next-line effect/noNullish -- the undefined key selects the default renderer.
  readonly interactionRenderers: Map<string | undefined, InteractionRendererComponent>
  readonly borderLabels: ReadonlyArray<ResolvedBorderLabel>
  readonly autocompleteItems: ReadonlyArray<AutocompleteContribution>
  readonly failures: ReadonlyArray<ClientExtensionFailure>
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

/**
 * Whether `ext` claims a key another extension already holds in the same
 * scope. A collision is recorded against the later extension.
 */
const collides = (
  prev: Option.Option<ScopeEntry>,
  ext: LoadedTuiExtension,
  label: string,
  key: string,
  failures: Array<ClientExtensionFailure>,
): boolean => {
  if (Option.isNone(prev) || prev.value.scope !== ext.scope) return false
  if (prev.value.source === ext.filePath) return false
  failures.push({
    id: ext.id,
    reason: `${label} "${key}" is already claimed by "${prev.value.source}" in scope "${ext.scope}"`,
  })
  return true
}

// ── Per-bucket resolvers ──

const resolveRenderers = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
): Map<string, ToolRenderer> => {
  const renderers = new Map<string, ToolRenderer>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of itemsOrEmpty(ext.contributions.renderers)) {
      for (const name of contribution.toolNames) {
        const key = name.toLowerCase()
        if (collides(scopeEntryFor(scopes, key), ext, "renderer", name, failures)) continue
        renderers.set(key, contribution.component)
        scopes.set(key, { scope: ext.scope, source: ext.filePath })
      }
    }
  }

  return renderers
}

const resolveWidgets = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
): ReadonlyArray<ResolvedWidget> => {
  const widgetMap = new Map<string, ResolvedWidget>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of itemsOrEmpty(ext.contributions.widgets)) {
      if (
        collides(scopeEntryFor(scopes, contribution.id), ext, "widget", contribution.id, failures)
      )
        continue
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
  readonly idScopes: Map<string, ScopeEntry>
  readonly keybindScopes: Map<string, ScopeEntry>
  readonly slashScopes: Map<string, ScopeEntry>
  readonly keybindOwner: Map<string, string>
  readonly slashOwner: Map<string, string>
  readonly failures: Array<ClientExtensionFailure>
}

const claimCommandKeybind = (
  entry: Command,
  ext: LoadedTuiExtension,
  state: CommandResolutionState,
): void => {
  const keybind = Option.fromNullishOr(entry.keybind)
  if (Option.isNone(keybind)) return
  const key = keybind.value.toLowerCase()
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

const claimCommandSlash = (
  entry: Command,
  ext: LoadedTuiExtension,
  state: CommandResolutionState,
): void => {
  const slash = Option.fromNullishOr(entry.slash)
  if (Option.isNone(slash)) return
  const key = slash.value.toLowerCase()
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

/** A command that collides on its id, keybind or slash is dropped whole. */
const commandCollides = (
  entry: Command,
  ext: LoadedTuiExtension,
  state: CommandResolutionState,
): boolean => {
  if (collides(scopeEntryFor(state.idScopes, entry.id), ext, "command", entry.id, state.failures))
    return true
  const keybind = Option.fromNullishOr(entry.keybind)
  if (
    Option.isSome(keybind) &&
    collides(
      scopeEntryFor(state.keybindScopes, keybind.value.toLowerCase()),
      ext,
      "keybind",
      keybind.value,
      state.failures,
    )
  )
    return true
  const slash = Option.fromNullishOr(entry.slash)
  return (
    Option.isSome(slash) &&
    collides(
      scopeEntryFor(state.slashScopes, slash.value.toLowerCase()),
      ext,
      "slash",
      slash.value,
      state.failures,
    )
  )
}

const resolveCommands = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
): ReadonlyArray<Command> => {
  const state: CommandResolutionState = {
    commandMap: new Map<string, Command>(),
    idScopes: new Map<string, ScopeEntry>(),
    keybindScopes: new Map<string, ScopeEntry>(),
    slashScopes: new Map<string, ScopeEntry>(),
    keybindOwner: new Map<string, string>(),
    slashOwner: new Map<string, string>(),
    failures,
  }

  for (const ext of sorted) {
    for (const entry of itemsOrEmpty(ext.contributions.commands)) {
      if (commandCollides(entry, ext, state)) continue
      claimCommandKeybind(entry, ext, state)
      claimCommandSlash(entry, ext, state)
      state.commandMap.set(entry.id, entry)
      state.idScopes.set(entry.id, { scope: ext.scope, source: ext.filePath })
    }
  }

  return [...state.commandMap.values()]
}

const resolveOverlays = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
): Map<string, OverlayComponent> => {
  const overlays = new Map<string, OverlayComponent>()
  const scopes = new Map<string, ScopeEntry>()

  for (const ext of sorted) {
    for (const contribution of itemsOrEmpty(ext.contributions.overlays)) {
      if (
        collides(scopeEntryFor(scopes, contribution.id), ext, "overlay", contribution.id, failures)
      )
        continue
      overlays.set(contribution.id, contribution.component)
      scopes.set(contribution.id, { scope: ext.scope, source: ext.filePath })
    }
  }

  return overlays
}

const resolveInteractionRenderers = (
  sorted: ReadonlyArray<LoadedTuiExtension>,
  failures: Array<ClientExtensionFailure>,
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
      if (collides(scopeEntryFor(scopes, mapKey), ext, "interaction renderer", label, failures))
        continue
      renderers.set(mapKey, contribution.component)
      scopes.set(mapKey, { scope: ext.scope, source: ext.filePath })
    }
  }

  return renderers
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
  return {
    renderers: resolveRenderers(sorted, failures),
    widgets: resolveWidgets(sorted, failures),
    commands: resolveCommands(sorted, failures),
    overlays: resolveOverlays(sorted, failures),
    interactionRenderers: resolveInteractionRenderers(sorted, failures),
    borderLabels: resolveBorderLabels(sorted),
    autocompleteItems: resolveAutocomplete(sorted),
    failures,
  }
}

// ── extension loading ───────────────────────────────────────────────────────

/**
 * TUI extension loader — discover → import → resolve pipeline.
 *
 * Builtins are passed as pre-imported modules (static imports at the call site)
 * so Bun's bundler includes them in compiled binaries. User/project extensions
 * are discovered via filesystem scan and dynamic import().
 *
 * `*-boundary.ts` per the `no-runpromise-outside-boundary` lint rule:
 * `runtime.runPromise` calls live inside this file because the loader runs
 * each extension's Effect-typed setup at the boundary between the JS module
 * world and the Effect runtime.
 */

// eslint-disable-next-line effect/noUnknownParameters -- dynamic imports are parsed at this module boundary.
const getClientModuleError = (value: unknown): Option.Option<string> => {
  if (!Predicate.isObject(value)) return Option.some("module must export an object")
  const id = Reflect.get(value, "id")
  if (!Predicate.isString(id)) return Option.some("missing id")
  const setup = Reflect.get(value, "setup")
  if (!Effect.isEffect(setup)) return Option.some("setup must be an Effect value")
  return Option.none()
}

// eslint-disable-next-line effect/noUnknownParameters -- dynamic imports are parsed at this module boundary.
const isExtensionClientModule = (value: unknown): value is AnyExtensionClientModule =>
  Option.isNone(getClientModuleError(value))

class TuiExtensionImportError extends Schema.TaggedError<TuiExtensionImportError>()(
  "TuiExtensionImportError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * Run an extension's Effect-typed setup against the per-provider runtime.
 * The runtime carries every TUI service the setup may yield (FileSystem,
 * Path, ClientTransport, ClientWorkspace, ClientShell);
 * `runtime.runPromise` enforces dependency satisfaction dynamically.
 */
const invokeSetup = (
  ext: AnyExtensionClientModule,
  runtime: ClientRuntime,
): Promise<ClientContributions> => runtime.runPromise(ext.setup)

const discoverExtensionsWithRuntime = (
  runtime: ClientRuntime,
  params: { userDir: string; projectDir: string },
): Promise<ReadonlyArray<DiscoveredTuiExtension>> =>
  runtime.runPromise(
    discoverTuiExtensions({ userDir: params.userDir, projectDir: params.projectDir }),
  )

interface ImportedExtension {
  readonly module: AnyExtensionClientModule
  readonly scope: ExtensionScope
  readonly filePath: string
}

const setupLoadedExtension = (params: {
  readonly module: AnyExtensionClientModule
  readonly scope: LoadedTuiExtension["scope"]
  readonly filePath: string
  readonly runtime: ClientRuntime
}): Effect.Effect<LoadedTuiExtension, ClientExtensionFailure> =>
  Effect.tryPromise({
    try: () =>
      invokeSetup(params.module, params.runtime).then((contributions) => ({
        id: params.module.id,
        scope: params.scope,
        filePath: params.filePath,
        contributions,
      })),
    catch: (cause) =>
      new ClientSetupError({
        extensionId: params.module.id,
        message: `Setup failed for ${params.module.id}`,
        cause,
      }),
  }).pipe(
    Effect.catch((error: ClientSetupError) =>
      Effect.logWarning("tui-ext.setup.failed").pipe(
        Effect.annotateLogs({ filePath: params.filePath, error: String(error.cause) }),
        Effect.andThen(
          Effect.fail({ id: params.module.id, reason: `setup failed: ${String(error.cause)}` }),
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

    const error = getClientModuleError(candidate)
    if (Option.isSome(error) || !isExtensionClientModule(candidate)) {
      return yield* Effect.fail({
        id: entry.filePath,
        reason: Option.getOrElse(error, () => "invalid module shape"),
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
 * Load all TUI extensions: discover files, import modules, resolve with scope precedence.
 *
 * @param opts.builtins — pre-imported builtin modules (static imports for bundler reachability)
 * @param opts.disabled — extension ids to skip (applies to builtins and discovered alike).
 *   Discovered extensions are imported to read their id, but setup() is skipped when disabled.
 *
 * Discovery uses `FileSystem` and `Path` from the runtime — the loader does
 * NOT take `fs`/`path` parameters. Any runtime that satisfies
 * `FileSystem | Path | <other services>` works.
 */
export const loadTuiExtensions = (opts: {
  readonly builtins?: ReadonlyArray<AnyExtensionClientModule>
  readonly userDir: string
  readonly projectDir: string
  readonly disabled?: ReadonlyArray<string>
  /** ManagedRuntime that satisfies the union of services any Effect-typed
   *  setup may yield, plus `FileSystem | Path` for discovery. The TUI
   *  shell builds this with the full client-services Layer. */
  readonly runtime: ClientRuntime
}): Promise<ResolvedTuiExtensions> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const disabledSet = new Set(Option.getOrElse(Option.fromNullishOr(opts.disabled), () => []))

      // Discovery runs through the runtime so `FileSystem`/`Path` come from the
      // same Layer that powers Effect-typed extension setups. This is the only
      // place outside `invokeSetup` that crosses the runtime boundary.
      const discovered = yield* Effect.promise(() =>
        discoverExtensionsWithRuntime(opts.runtime, {
          userDir: opts.userDir,
          projectDir: opts.projectDir,
        }),
      )

      // Import user/project modules, then filter by disabled before calling setup()
      const [importFailures, imported] = yield* Effect.partition(discovered, importExtension)
      const enabled = imported.filter((r) => !disabledSet.has(r.module.id))

      // Builtins: pre-imported, just filter disabled and call setup()
      const builtins = Option.getOrElse(Option.fromNullishOr(opts.builtins), () => [])
        .filter((ext) => !disabledSet.has(ext.id))
        .map((ext): ImportedExtension => ({
          module: ext,
          scope: "builtin",
          filePath: `builtin:${ext.id}`,
        }))

      const [setupFailures, loaded] = yield* Effect.partition([...builtins, ...enabled], (ext) =>
        setupLoadedExtension({ ...ext, runtime: opts.runtime }),
      )

      const resolved = resolveTuiExtensions(loaded, [...importFailures, ...setupFailures])

      if (resolved.autocompleteItems.length > 0) {
        const prefixes = resolved.autocompleteItems.map((c) => c.prefix).join(", ")
        yield* Effect.log(`[tui-ext] autocomplete contributions: ${prefixes}`)
      }

      return resolved
    }),
  )

// ── extension context ───────────────────────────────────────────────────────

/**
 * Boundary helper for extension UI loading.
 *
 * Solid's `onMount` callback runs in the Promise lane (sync setup -> async
 * effect callback). When that callback needs to await host-owned Effect
 * helpers, we exit Effect-land via `clientRuntime.runPromise(...)` here.
 *
 * Each export names a specific external seam. There is no generic
 * `runAnyEffect(runtime, effect)` trampoline.
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
      const disabledSet = yield* readDisabledExtensions({ home: params.home, cwd: params.cwd })
      return yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: params.builtins,
          userDir: `${params.home}/.gent/extensions`,
          projectDir: `${params.cwd}/.gent/extensions`,
          disabled: [...disabledSet],
          runtime: clientRuntime,
        }),
      )
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
