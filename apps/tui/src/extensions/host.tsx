import { Effect, Layer, ManagedRuntime, Option, Scope } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  type AutocompleteContribution,
  type ClientActivitySnapshot,
  type ClientLifecycleDefinition,
  type ClientRuntime,
  type ClientShellDefinition,
  type ClientShellTransportDefinition,
  type ClientWorkspaceDefinition,
  type InteractionRendererComponent,
  makeClientActivityLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientTransportLayer,
  makeClientWorkspaceLayer,
  type OverlayComponent,
} from "./client-facets.js"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
} from "solid-js"
import { useRequiredContext } from "../utils"
import { builtinClientModules } from "./builtins"
import type { ToolRenderer } from "../tool-renderers"
import type { Command } from "../commands"
import {
  type ClientExtensionFailure,
  type CommandSource,
  loadExtensionUi,
  resolveCommands,
  type ResolvedBorderLabel,
  type ResolvedTuiExtensions,
  type ResolvedWidget,
} from "./loader-boundary"
import { useWorkspace } from "../workspace"
import { useClient } from "../client"

// ── per-provider client runtime ─────────────────────────────────────────────

/**
 * One client `ManagedRuntime` for every surface that loads client
 * extensions: the interactive shell, the headless runner, and tests.
 *
 * A surface supplies the transport, the workspace, and the `cast` of its
 * connected runtime. Shell UI callbacks, the activity
 * provider, and the lifecycle cleanup registry default to no-ops so a
 * surface without a UI (headless) does not restate them.
 */

interface ClientRuntimeDeps {
  readonly transport: ClientShellTransportDefinition
  readonly workspace: ClientWorkspaceDefinition
  /** `cast` is required; every UI callback defaults to a no-op. */
  readonly shell: Pick<ClientShellDefinition, "cast"> & Partial<Omit<ClientShellDefinition, "cast">>
  /** Current UI activity; absent when the surface has no activity to report. */
  readonly activity?: () => ClientActivitySnapshot
  /** Cleanup registry; absent when the surface disposes the runtime whole. */
  readonly lifecycle?: Pick<ClientLifecycleDefinition, "addCleanup">
}

const noopShell: Omit<ClientShellDefinition, "cast"> = {
  notify: () => {},
  openOverlay: () => {},
  closeOverlay: () => {},
  switchSession: () => {},
}

const noopLifecycle: Pick<ClientLifecycleDefinition, "addCleanup"> = { addCleanup: () => {} }

export const makeClientRuntime = (deps: ClientRuntimeDeps): ClientRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      makeClientActivityLayer(deps.activity),
      BunServices.layer,
      makeClientTransportLayer(deps.transport),
      makeClientWorkspaceLayer(deps.workspace),
      makeClientShellLayer({ ...noopShell, ...deps.shell }),
      makeClientLifecycleLayer(
        Option.getOrElse(Option.fromUndefinedOr(deps.lifecycle), () => noopLifecycle),
      ),
    ),
  )

// ── extension UI provider ───────────────────────────────────────────────────

/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with
 * scope precedence. Provides resolved contributions to descendants.
 *
 *  deleted the paired-package snapshot cache. Widgets that need
 * server-side state subscribe to `ClientTransport.onSessionEvent` or
 * `ClientTransport.onExtensionStateChanged` and call
 * `ClientTransport.request(...)` directly — see e.g.
 * `builtins/tool-renderers.client.tsx`.
 */

// Static builtin imports — Bun's bundler needs these reachable for compiled binary

interface ExtensionUIContextValue {
  readonly setActivityProvider: (provider: () => ClientActivitySnapshot) => void
  readonly renderers: Accessor<Map<string, ToolRenderer>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  /**
   * Every command the reader can run: the session's own, the client
   * extensions' and the server's slash commands, under `resolveCommands`.
   */
  readonly commands: Accessor<ReadonlyArray<Command>>
  /** The session view supplies its own commands; they resolve at builtin scope. */
  readonly setSessionCommands: (commands: ReadonlyArray<Command>) => void
  readonly overlays: Accessor<Map<string, OverlayComponent>>
  // eslint-disable-next-line effect/noNullish -- the undefined key selects the default renderer.
  readonly interactionRenderers: Accessor<Map<string | undefined, InteractionRendererComponent>>
  readonly borderLabels: Accessor<ReadonlyArray<ResolvedBorderLabel>>
  readonly autocompleteItems: Accessor<ReadonlyArray<AutocompleteContribution>>
  /** Client extensions, or contributions, that did not load. */
  readonly failures: Accessor<ReadonlyArray<ClientExtensionFailure>>
  /** Wire overlay dispatch from the session controller */
  readonly setOverlayDispatch: (open: (id: string) => void, close: () => void) => void
  /** Register dynamic autocomplete contributions (e.g. from session controller) */
  readonly setDynamicAutocomplete: (items: ReadonlyArray<AutocompleteContribution>) => void
  /** ManagedRuntime providing FileSystem, Path, ClientTransport — used by
   *  Effect-typed contribution surfaces (autocomplete `items`, etc.). */
  readonly clientRuntime: ClientRuntime
}

const EMPTY_RESOLVED: ResolvedTuiExtensions = {
  renderers: new Map(),
  widgets: [],
  commandSources: [],
  overlays: new Map(),
  interactionRenderers: new Map(),
  borderLabels: [],
  autocompleteItems: [],
  failures: [],
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: { children: JSX.Element; scope?: Scope.Scope }) {
  const workspace = useWorkspace()
  const client = useClient()

  const [activityProvider, setActivityProvider] = createSignal<() => ClientActivitySnapshot>(
    () => ({ state: "unknown" }),
  )

  const [resolved, setResolved] = createSignal<ResolvedTuiExtensions>(EMPTY_RESOLVED)
  const [sessionCommands, setSessionCommands] = createSignal<ReadonlyArray<Command>>([])
  const [serverCommands, setServerCommands] = createSignal<ReadonlyArray<CommandSource>>([])
  const [dynamicAutocomplete, setDynamicAutocomplete] = createSignal<
    ReadonlyArray<AutocompleteContribution>
  >([])

  // Overlay dispatch — wired by session controller after mount
  const [overlayDispatch, setOverlayDispatchSignal] = createSignal<{
    open: (id: string) => void
    close: () => void
  }>({ open: () => {}, close: () => {} })

  const setOverlayDispatch = (open: (id: string) => void, close: () => void) => {
    setOverlayDispatchSignal({ open, close })
  }

  // Provider-scoped cleanup registry. Widget setups that detach Solid
  // roots or subscribe to pulses register their disposers here; the
  // `onCleanup` below runs them in order when the provider unmounts.
  // Without this, Solid `createRoot` disposers and pulse unsubscribes
  // would leak past provider remount.
  const cleanups: Array<() => void> = []
  const addCleanup = (fn: () => void): void => {
    cleanups.push(fn)
  }

  // Per-provider ManagedRuntime that augments the shared platform layer
  // (FileSystem, Path) with the TUI client services Effect-typed
  // extensions may yield: `ClientTransport` (typed RPC client + event
  // subscriptions), `ClientWorkspace` (cwd/home), `ClientShell`
  // (notify, overlays, session switch). The loader's `invokeSetup` runs each
  // setup against this runtime.
  const clientRuntime: ClientRuntime = makeClientRuntime({
    transport: {
      client: client.client,
      runtime: client.runtime,
      // The client's identity memo, read straight through: the reference is
      // stable across a rename, so an effect tracking this accessor stays put
      // while the session and the branch do.
      currentSession: () => Option.getOrUndefined(client.sessionIdentity()),
      onExtensionStateChanged: (cb) => client.onExtensionStateChanged(cb),
      onSessionEvent: (cb) => client.onSessionEvent(cb),
    },
    workspace: { cwd: workspace.cwd, home: workspace.home },
    shell: {
      notify: (message) => client.setError(message),
      openOverlay: (id) => overlayDispatch().open(id),
      closeOverlay: () => overlayDispatch().close(),
      switchSession: (input) => client.switchSession(input.sessionId, input.branchId, input.name),
      cast: client.runtime.cast,
    },
    activity: () => activityProvider()(),
    lifecycle: { addCleanup },
  })

  if (props.scope) {
    Effect.runSync(
      Scope.addFinalizer(
        props.scope,
        Effect.promise(() => clientRuntime.dispose()),
      ),
    )
  }

  // Run widget-registered cleanups (Solid root disposers, pulse
  // unsubscribes) FIRST, then dispose the per-provider runtime so layer
  // finalizers run and any in-flight Effects are interrupted. Without
  // this ordering, runtime disposal would yank `ClientTransport` out
  // from under widget cleanups that still need it.
  onCleanup(() => {
    for (const fn of cleanups) {
      Effect.runSync(Effect.ignore(Effect.try(fn)))
    }
    cleanups.length = 0
    void clientRuntime.dispose()
  })

  onMount(() => {
    void loadExtensionUi(clientRuntime, {
      builtins: builtinClientModules,
      home: workspace.home,
      cwd: workspace.cwd,
    })
      .then(setResolved)
      .catch((error: Error) =>
        setResolved({
          ...EMPTY_RESOLVED,
          failures: [{ id: "client extensions", reason: String(error) }],
        }),
      )
  })

  // The contributed rows belong to the session, not to its name: track the id
  // alone so a rename leaves the list up instead of clearing it for a round trip.
  createEffect(() => {
    const current = client.activeSessionId()
    if (Option.isNone(current)) {
      setServerCommands([])
      return
    }
    setServerCommands([])

    let active = true
    onCleanup(() => {
      active = false
    })

    client.runtime.cast(
      client.client.extension.listSlashCommands({ sessionId: current.value }).pipe(
        Effect.tap((cmds) =>
          Effect.sync(() => {
            if (!active) return
            const byExtension = new Map<string, Array<Command>>()
            for (const c of cmds) {
              const run = (args: string) => {
                const activeSession = Option.fromNullishOr(client.session())
                if (Option.isNone(activeSession)) return
                const sid = activeSession.value.sessionId
                const bid = activeSession.value.branchId
                client.runtime.cast(
                  client.client.extension
                    .request({
                      sessionId: sid,
                      extensionId: c.extensionId,
                      capabilityId: c.capabilityId,
                      input: args,
                      branchId: bid,
                    })
                    .pipe(
                      Effect.catchEager((error) =>
                        Effect.logWarning("slash.command.failed").pipe(
                          Effect.annotateLogs({
                            extensionId: c.extensionId,
                            capabilityId: c.capabilityId,
                            error: String(error),
                          }),
                        ),
                      ),
                    ),
                )
              }

              const base = {
                id: `server:${c.name}`,
                title: Option.getOrElse(Option.fromNullishOr(c.displayName), () =>
                  Option.getOrElse(Option.fromNullishOr(c.description), () => c.name),
                ),
                slash: c.name,
                category: Option.getOrElse(Option.fromNullishOr(c.category), () => "Extension"),
                onSelect: () => run(""),
                onSlash: run,
              }
              const command = Option.match(Option.fromNullishOr(c.keybind), {
                onNone: (): Command => base,
                onSome: (keybind): Command => ({ ...base, keybind }),
              })
              byExtension.set(c.extensionId, [
                ...Option.getOrElse(Option.fromNullishOr(byExtension.get(c.extensionId)), () => []),
                command,
              ])
            }
            setServerCommands(
              [...byExtension].map(([extensionId, commands]) => ({
                id: extensionId,
                scope: "builtin",
                source: `server:${extensionId}`,
                commands,
              })),
            )
          }),
        ),
        Effect.catchEager(() =>
          Effect.sync(() => {
            if (active) setServerCommands([])
          }),
        ),
      ),
    )
  })

  // The session's commands first, then the client extensions', then the
  // server's: inside builtin scope the earlier source keeps a contested key.
  const resolvedCommands = createMemo(() =>
    resolveCommands([
      {
        id: "@gent/session",
        scope: "builtin",
        source: "builtin:@gent/session",
        commands: sessionCommands(),
      },
      ...resolved().commandSources,
      ...serverCommands(),
    ]),
  )

  return (
    <ExtensionUIContext.Provider
      value={{
        renderers: () => resolved().renderers,
        widgets: () => resolved().widgets,
        commands: () => resolvedCommands().commands,
        setSessionCommands,
        overlays: () => resolved().overlays,
        interactionRenderers: () => resolved().interactionRenderers,
        borderLabels: () => resolved().borderLabels,
        autocompleteItems: () => [...resolved().autocompleteItems, ...dynamicAutocomplete()],
        failures: () => [...resolved().failures, ...resolvedCommands().failures],
        setDynamicAutocomplete,
        setOverlayDispatch,
        setActivityProvider: (provider) => setActivityProvider(() => provider),
        clientRuntime,
      }}
    >
      {props.children}
    </ExtensionUIContext.Provider>
  )
}

export function useExtensionUI(): ExtensionUIContextValue {
  return useRequiredContext(
    ExtensionUIContext,
    "useExtensionUI must be used within ExtensionUIProvider",
  )
}
