/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with
 * scope precedence. Provides resolved contributions to descendants.
 *
 * B11.6 deleted the paired-package snapshot cache. Widgets that need
 * server-side state subscribe to `ClientTransport.onExtensionStateChanged`
 * and call `client.extension.request`/`ask` directly — see e.g.
 * `builtins/tasks.client.tsx`.
 */

import {
  createEffect,
  createContext,
  useContext,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js"
import { Effect, Layer, ManagedRuntime } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
// Static builtin imports — Bun's bundler needs these reachable for compiled binary
import { builtinClientModules } from "./builtins/index"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"
import type { ResolvedBorderLabel, ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import type {
  AutocompleteContribution,
  ClientRuntime,
  ComposerSurfaceComponent,
  InteractionRendererComponent,
  OverlayComponent,
} from "./client-facets.js"
import { loadTuiExtensions } from "./loader-boundary"
import { loadDisabledExtensions } from "./context-boundary"
import { makeClientTransportLayer } from "./client-transport"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientComposerLayer,
  makeClientLifecycleLayer,
} from "./client-services"
import { useWorkspace } from "../workspace/index"
import {
  useClientActions,
  useClientSession,
  useClientTransport,
  useClientTransportState,
} from "../client/context"

export interface ExtensionUIContextValue {
  readonly renderers: Accessor<Map<string, ToolRenderer>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  readonly commands: Accessor<ReadonlyArray<Command>>
  readonly overlays: Accessor<Map<string, OverlayComponent>>
  readonly interactionRenderers: Accessor<Map<string | undefined, InteractionRendererComponent>>
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
  /** Current session ID (undefined before session is active) */
  readonly sessionId: Accessor<string | undefined>
  /** Current branch ID (undefined before session is active) */
  readonly branchId: Accessor<string | undefined>
  /** ManagedRuntime providing FileSystem, Path, ClientTransport — used by
   *  Effect-typed contribution surfaces (autocomplete `items`, etc.). */
  readonly clientRuntime: ClientRuntime
}

const EMPTY_RESOLVED: ResolvedTuiExtensions = {
  renderers: new Map(),
  widgets: [],
  commands: [],
  overlays: new Map(),
  interactionRenderers: new Map(),
  composerSurface: undefined,
  borderLabels: [],
  autocompleteItems: [],
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: { children: JSX.Element }) {
  const workspace = useWorkspace()
  const transport = useClientTransport()
  const session = useClientSession()
  const actions = useClientActions()
  const transportState = useClientTransportState()

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
    (() => ComposerStateSnapshot) | undefined
  >(undefined)

  const setComposerStateProvider = (provider: () => ComposerStateSnapshot) => {
    setComposerStateProviderSignal(() => provider)
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
  // extensions may yield: `ClientTransport` (typed RPC client + pulse
  // subscription), `ClientWorkspace` (cwd/home), `ClientShell`
  // (send/sendMessage/overlays), `ClientComposer` (reactive composer
  // state). The loader's `invokeSetup` runs each setup against this
  // runtime.
  const clientRuntime: ClientRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      BunServices.layer,
      makeClientTransportLayer({
        client: transport.client,
        runtime: transport.runtime,
        currentSession: () => {
          const current = session.session()
          if (current === null) return undefined
          return { sessionId: current.sessionId, branchId: current.branchId }
        },
        onExtensionStateChanged: (cb) => transportState.onExtensionStateChanged(cb),
      }),
      makeClientWorkspaceLayer({
        cwd: workspace.cwd,
        home: workspace.home,
      }),
      makeClientShellLayer({
        send: (message) => {
          const current = session.session()
          if (current === null) return
          transport.runtime.cast(
            transport.client.extension.send({
              sessionId: current.sessionId,
              message,
              branchId: current.branchId,
            }),
          )
        },
        sendMessage: (content) => actions.sendMessage(content),
        openOverlay: (id) => overlayDispatch().open(id),
        closeOverlay: () => overlayDispatch().close(),
      }),
      makeClientComposerLayer({
        state: () => {
          const provider = composerStateProvider()
          if (provider === undefined) {
            return {
              draft: "",
              mode: "editing" as const,
              inputFocused: false,
              autocompleteOpen: false,
            }
          }
          return provider()
        },
      }),
      makeClientLifecycleLayer({ addCleanup }),
    ),
  )

  // Run widget-registered cleanups (Solid root disposers, pulse
  // unsubscribes) FIRST, then dispose the per-provider runtime so layer
  // finalizers run and any in-flight Effects are interrupted. Without
  // this ordering, runtime disposal would yank `ClientTransport` out
  // from under widget cleanups that still need it.
  onCleanup(() => {
    for (const fn of cleanups) {
      try {
        fn()
      } catch {
        // Swallow — one broken disposer must not block the rest.
      }
    }
    cleanups.length = 0
    void clientRuntime.dispose()
  })

  onMount(async () => {
    try {
      const home = workspace.home

      // Read disabled extensions from user + project config (shared with server)
      const disabledSet = await loadDisabledExtensions(clientRuntime, {
        home,
        cwd: workspace.cwd,
      })

      const result = await loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: `${home}/.gent/extensions`,
        projectDir: `${workspace.cwd}/.gent/extensions`,
        disabled: [...disabledSet],
        runtime: clientRuntime,
      })
      setResolved(result)

      // Fetch server-side extension commands
    } catch (err) {
      console.log(`[tui-ext] Extension loading failed: ${err}`)
    } finally {
      setLoading(false)
    }
  })

  createEffect(() => {
    const current = session.session()
    if (current === null) {
      setServerCommands([])
      return
    }
    setServerCommands([])

    let active = true
    onCleanup(() => {
      active = false
    })

    transport.runtime.cast(
      transport.client.extension.listCommands({ sessionId: current.sessionId }).pipe(
        Effect.tap((cmds) =>
          Effect.sync(() => {
            if (!active) return
            setServerCommands(
              cmds.map((c) => {
                const run = (args: string) => {
                  const sid = session.session()?.sessionId
                  const bid = session.session()?.branchId
                  if (sid === undefined || bid === undefined) return
                  transport.runtime.cast(
                    transport.client.extension
                      .request({
                        sessionId: sid,
                        extensionId: c.extensionId,
                        capabilityId: c.capabilityId,
                        intent: c.intent,
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

                return {
                  id: `server:${c.name}`,
                  title: c.displayName ?? c.description ?? c.name,
                  slash: c.name,
                  category: c.category ?? "Extension",
                  ...(c.keybind !== undefined ? { keybind: c.keybind } : {}),
                  onSelect: () => run(""),
                  onSlash: run,
                }
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
        sessionId: () => session.session()?.sessionId,
        branchId: () => session.session()?.branchId,
        clientRuntime,
      }}
    >
      {props.children}
    </ExtensionUIContext.Provider>
  )
}

export function useExtensionUI(): ExtensionUIContextValue {
  const ctx = useContext(ExtensionUIContext)
  if (ctx === undefined) throw new Error("useExtensionUI must be used within ExtensionUIProvider")
  return ctx
}
