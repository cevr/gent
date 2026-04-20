/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with
 * scope precedence. Provides resolved contributions to descendants.
 *
 * B11.6 deleted the paired-package snapshot cache. Widgets that need
 * server-side state subscribe to `ClientTransport.onExtensionStateChanged`
 * and call `client.extension.query`/`ask` directly — see e.g.
 * `builtins/tasks.client.tsx`.
 */

import {
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
import type { JSX as _JSX } from "@opentui/solid"
// Static builtin imports — Bun's bundler needs these reachable for compiled binary
import { builtinClientModules } from "./builtins/index"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"
import type { ResolvedBorderLabel, ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import type { AutocompleteContribution } from "@gent/core/domain/extension-client.js"
import { loadTuiExtensions } from "./loader-boundary"
import { loadDisabledExtensions } from "./context-boundary"
import { makeClientTransportLayer } from "./client-transport"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientComposerLayer,
} from "./client-services"
import { useWorkspace } from "../workspace/index"
import { useClient } from "../client/context"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolidComponent = (props?: any) => _JSX.Element

export interface ExtensionUIContextValue {
  readonly renderers: Accessor<Map<string, ToolRenderer>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  readonly commands: Accessor<ReadonlyArray<Command>>
  readonly overlays: Accessor<Map<string, SolidComponent>>
  readonly interactionRenderers: Accessor<Map<string | undefined, SolidComponent>>
  readonly composerSurface: Accessor<SolidComponent | undefined>
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly clientRuntime: ManagedRuntime.ManagedRuntime<any, never>
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
  const clientCtx = useClient()

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

  // Per-provider ManagedRuntime that augments the shared platform layer
  // (FileSystem, Path) with the TUI client services Effect-typed
  // extensions may yield: `ClientTransport` (typed RPC client + pulse
  // subscription), `ClientWorkspace` (cwd/home), `ClientShell`
  // (send/sendMessage/overlays), `ClientComposer` (reactive composer
  // state). The loader's `invokeSetup` runs each setup against this
  // runtime.
  const clientRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      BunServices.layer,
      makeClientTransportLayer({
        client: clientCtx.client,
        runtime: clientCtx.runtime,
        currentSession: () => {
          const session = clientCtx.session()
          if (session === null) return undefined
          return { sessionId: session.sessionId, branchId: session.branchId }
        },
        onExtensionStateChanged: (cb) => clientCtx.onExtensionStateChanged(cb),
      }),
      makeClientWorkspaceLayer({
        cwd: workspace.cwd,
        home: workspace.home,
      }),
      makeClientShellLayer({
        send: (message) => {
          const session = clientCtx.session()
          if (session === null) return
          clientCtx.runtime.cast(
            clientCtx.client.extension.send({
              sessionId: session.sessionId,
              message,
              branchId: session.branchId,
            }),
          )
        },
        sendMessage: (content) => clientCtx.sendMessage(content),
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
    ),
  )

  // Dispose the per-provider runtime on unmount so layer finalizers run and
  // any in-flight Effects are interrupted. Without this, provider remount
  // and shutdown leak runtime resources (counsel C9.3 finding 3).
  onCleanup(() => {
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
      clientCtx.runtime.cast(
        clientCtx.client.extension.listCommands().pipe(
          Effect.tap((cmds) =>
            Effect.sync(() => {
              setServerCommands(
                cmds.map((c) => ({
                  id: `server:${c.name}`,
                  title: c.description ?? c.name,
                  slash: c.name,
                  category: "Extension",
                  onSelect: () => {
                    const sid = clientCtx.session()?.sessionId
                    const bid = clientCtx.session()?.branchId
                    if (sid !== undefined && bid !== undefined) {
                      clientCtx.runtime.cast(
                        clientCtx.client.extension
                          .invokeCommand({ name: c.name, args: "", sessionId: sid, branchId: bid })
                          .pipe(Effect.catchEager(() => Effect.void)),
                      )
                    }
                  },
                  onSlash: (args: string) => {
                    const sid = clientCtx.session()?.sessionId
                    const bid = clientCtx.session()?.branchId
                    if (sid !== undefined && bid !== undefined) {
                      clientCtx.runtime.cast(
                        clientCtx.client.extension
                          .invokeCommand({ name: c.name, args, sessionId: sid, branchId: bid })
                          .pipe(Effect.catchEager(() => Effect.void)),
                      )
                    }
                  },
                })),
              )
            }),
          ),
          Effect.catchEager(() => Effect.void),
        ),
      )
    } catch (err) {
      console.log(`[tui-ext] Extension loading failed: ${err}`)
    } finally {
      setLoading(false)
    }
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
        sessionId: () => clientCtx.session()?.sessionId,
        branchId: () => clientCtx.session()?.branchId,
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
