/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with
 * scope precedence. Provides resolved contributions to descendants.
 *
 *  deleted the paired-package snapshot cache. Widgets that need
 * server-side state subscribe to `ClientTransport.onSessionEvent` or
 * `ClientTransport.onExtensionStateChanged` and call
 * `requestExtension(...)` directly — see e.g.
 * `builtins/tool-renderers.client.tsx`.
 */

import {
  createEffect,
  createContext,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js"
import { Effect, Layer, ManagedRuntime, Option, Scope } from "effect"
import { useRequiredContext } from "../utils/solid-context"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
// Static builtin imports — Bun's bundler needs these reachable for compiled binary
import { builtinClientModules } from "./builtins/index"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { HeadlessToolRenderer } from "../headless-tool-renderers"
import type { Command } from "../command/types"
import type { ResolvedBorderLabel, ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import type {
  AutocompleteContribution,
  ClientRuntime,
  ComposerSurfaceComponent,
  InteractionRendererComponent,
  OverlayComponent,
} from "./client-facets.js"
import { loadExtensionUi } from "../services/extension-context-boundary"
import { makeClientTransportLayer } from "./client-transport"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientDriverLayer,
  makeClientComposerLayer,
  makeClientLifecycleLayer,
} from "./client-services"
import { useWorkspace } from "../workspace/context"
import {
  useClientActions,
  useClientSession,
  useClientTransport,
  useClientTransportState,
} from "../client/context"

import { makeClientActivityLayer, type ClientActivitySnapshot } from "./client-activity"

export interface ExtensionUIContextValue {
  readonly setActivityProvider: (provider: () => ClientActivitySnapshot) => void
  readonly renderers: Accessor<Map<string, ToolRenderer>>
  readonly headlessRenderers: Accessor<Map<string, HeadlessToolRenderer>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  readonly commands: Accessor<ReadonlyArray<Command>>
  readonly overlays: Accessor<Map<string, OverlayComponent>>
  // eslint-disable-next-line effect/noNullish -- the undefined key selects the default renderer.
  readonly interactionRenderers: Accessor<Map<string | undefined, InteractionRendererComponent>>
  // eslint-disable-next-line effect/noNullish -- no composer contribution is a valid result.
  readonly composerSurface: Accessor<ComposerSurfaceComponent | undefined>
  readonly borderLabels: Accessor<ReadonlyArray<ResolvedBorderLabel>>
  readonly autocompleteItems: Accessor<ReadonlyArray<AutocompleteContribution>>
  readonly loading: Accessor<boolean>
  /** Wire overlay dispatch from the session controller */
  readonly setOverlayDispatch: (open: (id: string) => void, close: () => void) => void
  /** Register dynamic autocomplete contributions (e.g. from session controller) */
  readonly setDynamicAutocomplete: (items: ReadonlyArray<AutocompleteContribution>) => void
  /** Wire composer state reactive getter from the session controller */
  readonly setComposerStateProvider: (
    provider: () => {
      draft: string
      mode: "editing" | "shell"
      inputFocused: boolean
      autocompleteOpen: boolean
    },
  ) => void
  /** Current session ID (absent before session is active). */
  // eslint-disable-next-line effect/noNullish -- extension consumers use absence before session activation.
  readonly sessionId: Accessor<string | undefined>
  /** Current branch ID (absent before session is active). */
  // eslint-disable-next-line effect/noNullish -- extension consumers use absence before session activation.
  readonly branchId: Accessor<string | undefined>
  /** ManagedRuntime providing FileSystem, Path, ClientTransport — used by
   *  Effect-typed contribution surfaces (autocomplete `items`, etc.). */
  readonly clientRuntime: ClientRuntime
}

const EMPTY_RESOLVED: ResolvedTuiExtensions = {
  renderers: new Map(),
  headlessRenderers: new Map(),
  widgets: [],
  commands: [],
  overlays: new Map(),
  interactionRenderers: new Map(),
  // eslint-disable-next-line effect/noNullish -- no composer contribution is a valid resolved result.
  composerSurface: undefined,
  borderLabels: [],
  autocompleteItems: [],
}

const toError = (cause: unknown): Error => {
  if (cause instanceof Error) return cause
  // eslint-disable-next-line effect/noNewError -- the client service boundary requires an Error value.
  return new Error(String(cause))
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: { children: JSX.Element; scope?: Scope.Scope }) {
  const workspace = useWorkspace()
  const transport = useClientTransport()
  const session = useClientSession()
  const actions = useClientActions()
  const transportState = useClientTransportState()

  const [activityProvider, setActivityProvider] = createSignal<() => ClientActivitySnapshot>(
    () => ({ state: "unknown" }),
  )

  const [resolved, setResolved] = createSignal<ResolvedTuiExtensions>(EMPTY_RESOLVED)
  const [serverCommands, setServerCommands] = createSignal<ReadonlyArray<Command>>([])
  const [dynamicAutocomplete, setDynamicAutocomplete] = createSignal<
    ReadonlyArray<AutocompleteContribution>
  >([])
  const [loading, setLoading] = createSignal(true)

  // Overlay dispatch — wired by session controller after mount
  const [overlayDispatch, setOverlayDispatchSignal] = createSignal<{
    open: (id: string) => void
    close: () => void
  }>({ open: () => {}, close: () => {} })

  const setOverlayDispatch = (open: (id: string) => void, close: () => void) => {
    setOverlayDispatchSignal({ open, close })
  }

  // Composer state provider — wired by session controller
  type ComposerStateSnapshot = {
    draft: string
    mode: "editing" | "shell"
    inputFocused: boolean
    autocompleteOpen: boolean
  }
  const [composerStateProvider, setComposerStateProviderSignal] = createSignal<
    Option.Option<() => ComposerStateSnapshot>
  >(Option.none())

  const setComposerStateProvider = (provider: () => ComposerStateSnapshot) => {
    setComposerStateProviderSignal(Option.some(provider))
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
  // (send/sendMessage/overlays), `ClientComposer` (reactive composer
  // state). The loader's `invokeSetup` runs each setup against this
  // runtime.
  const clientRuntime: ClientRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      makeClientActivityLayer(() => activityProvider()()),
      BunServices.layer,
      makeClientTransportLayer({
        client: transport.client,
        runtime: transport.runtime,
        currentSession: () => {
          const current = Option.fromNullishOr(session.session())
          if (Option.isNone(current)) return Option.getOrUndefined(Option.none())
          return { sessionId: current.value.sessionId, branchId: current.value.branchId }
        },
        onExtensionStateChanged: (cb) => transportState.onExtensionStateChanged(cb),
        onSessionEvent: (cb) => transportState.onSessionEvent(cb),
      }),
      makeClientWorkspaceLayer({
        cwd: workspace.cwd,
        home: workspace.home,
      }),
      makeClientShellLayer({
        sendMessage: (content) => actions.sendMessage(content),
        openOverlay: (id) => overlayDispatch().open(id),
        closeOverlay: () => overlayDispatch().close(),
        run: transport.runtime.run,
        cast: transport.runtime.cast,
      }),
      makeClientDriverLayer({
        list: transport.client.driver.list().pipe(Effect.mapError(toError)),
        set: (input) => transport.client.driver.set(input).pipe(Effect.mapError(toError)),
        clear: (input) => transport.client.driver.clear(input).pipe(Effect.mapError(toError)),
      }),
      makeClientComposerLayer({
        state: () => {
          const provider = composerStateProvider()
          if (Option.isNone(provider)) {
            return {
              draft: "",
              mode: "editing" satisfies ComposerStateSnapshot["mode"],
              inputFocused: false,
              autocompleteOpen: false,
            }
          }
          return provider.value()
        },
      }),
      makeClientLifecycleLayer({ addCleanup }),
    ),
  )

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
      .catch(() => {})
      .finally(() => setLoading(false))
  })

  createEffect(() => {
    const current = Option.fromNullishOr(session.session())
    if (Option.isNone(current)) {
      setServerCommands([])
      return
    }
    setServerCommands([])

    let active = true
    onCleanup(() => {
      active = false
    })

    transport.runtime.cast(
      transport.client.extension.listSlashCommands({ sessionId: current.value.sessionId }).pipe(
        Effect.tap((cmds) =>
          Effect.sync(() => {
            if (!active) return
            setServerCommands(
              cmds.map((c) => {
                const run = (args: string) => {
                  const activeSession = Option.fromNullishOr(session.session())
                  if (Option.isNone(activeSession)) return
                  const sid = activeSession.value.sessionId
                  const bid = activeSession.value.branchId
                  transport.runtime.cast(
                    transport.client.extension
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
                return Option.match(Option.fromNullishOr(c.keybind), {
                  onNone: () => base,
                  onSome: (keybind) => ({ ...base, keybind }),
                })
              }),
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

  return (
    <ExtensionUIContext.Provider
      value={{
        renderers: () => resolved().renderers,
        headlessRenderers: () => resolved().headlessRenderers,
        widgets: () => resolved().widgets,
        commands: () => [...resolved().commands, ...serverCommands()],
        overlays: () => resolved().overlays,
        interactionRenderers: () => resolved().interactionRenderers,
        composerSurface: () => resolved().composerSurface,
        borderLabels: () => resolved().borderLabels,
        autocompleteItems: () => [...resolved().autocompleteItems, ...dynamicAutocomplete()],
        loading,
        setDynamicAutocomplete,
        setOverlayDispatch,
        setComposerStateProvider,
        setActivityProvider: (provider) => setActivityProvider(() => provider),
        sessionId: () =>
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(session.session()), (value) => value.sessionId),
          ),
        branchId: () =>
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(session.session()), (value) => value.branchId),
          ),
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
