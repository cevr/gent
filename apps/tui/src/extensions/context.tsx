/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with scope precedence.
 * Provides resolved contributions to descendants.
 */

import { createContext, useContext, createSignal, onMount, type Accessor, type JSX } from "solid-js"
// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os"
import type { JSX as _JSX } from "@opentui/solid"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"
import type { ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import { loadTuiExtensions } from "./loader"
import { useWorkspace } from "../workspace/index"
import { useClient } from "../client/context"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolidComponent = (props?: any) => _JSX.Element

/** Server-projected UI snapshot from extension state machines */
export interface ExtensionSnapshot {
  readonly extensionId: string
  readonly epoch: number
  readonly model: unknown
}

export interface ExtensionUIContextValue {
  readonly renderers: Accessor<Map<string, ToolRenderer>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  readonly commands: Accessor<ReadonlyArray<Command>>
  readonly overlays: Accessor<Map<string, SolidComponent>>
  readonly loading: Accessor<boolean>
  /** Wire overlay dispatch from the session controller */
  readonly setOverlayDispatch: (open: (id: string) => void, close: () => void) => void
  /** Server-projected extension state snapshots, keyed by extensionId */
  readonly snapshots: Accessor<ReadonlyMap<string, ExtensionSnapshot>>
  /** Update a server-projected snapshot (called from event stream) */
  readonly updateSnapshot: (snapshot: ExtensionSnapshot) => void
  /** Current session ID (undefined before session is active) */
  readonly sessionId: Accessor<string | undefined>
  /** Current branch ID (undefined before session is active) */
  readonly branchId: Accessor<string | undefined>
}

const EMPTY_RESOLVED: ResolvedTuiExtensions = {
  renderers: new Map(),
  widgets: [],
  commands: [],
  overlays: new Map(),
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: { children: JSX.Element }) {
  const workspace = useWorkspace()
  const [resolved, setResolved] = createSignal<ResolvedTuiExtensions>(EMPTY_RESOLVED)
  const [loading, setLoading] = createSignal(true)
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, ExtensionSnapshot>>(new Map())

  const updateSnapshot = (snapshot: ExtensionSnapshot) => {
    setSnapshots((prev) => {
      const next = new Map(prev)
      next.set(snapshot.extensionId, snapshot)
      return next
    })
  }

  // Mutable overlay dispatch — wired by session controller after mount
  let overlayOpen: (id: string) => void = () => {}
  let overlayClose: () => void = () => {}

  const setOverlayDispatch = (open: (id: string) => void, close: () => void) => {
    overlayOpen = open
    overlayClose = close
  }

  // Wire extension snapshot events from client event stream
  const clientCtx = useClient()
  clientCtx.onExtensionSnapshot(updateSnapshot)

  onMount(async () => {
    try {
      const home = homedir()
      const result = await loadTuiExtensions(
        {
          userDir: `${home}/.gent/extensions`,
          projectDir: `${workspace.cwd}/.gent/extensions`,
        },
        {
          openOverlay: (id) => overlayOpen(id),
          closeOverlay: () => overlayClose(),
          get sessionId() {
            return clientCtx.session()?.sessionId
          },
          get branchId() {
            return clientCtx.session()?.branchId
          },
          sendIntent: (extensionId, intent) => {
            const sid = clientCtx.session()?.sessionId
            const bid = clientCtx.session()?.branchId
            if (sid === undefined) return
            const snap = snapshots().get(extensionId)
            const epoch = snap?.epoch ?? 0
            clientCtx.client.runFork(
              clientCtx.client.sendExtensionIntent(sid, extensionId, intent, epoch, bid),
            )
          },
        },
      )
      setResolved(result)
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
        commands: () => resolved().commands,
        overlays: () => resolved().overlays,
        loading,
        setOverlayDispatch,
        snapshots,
        updateSnapshot,
        sessionId: () => clientCtx.session()?.sessionId,
        branchId: () => clientCtx.session()?.branchId,
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
