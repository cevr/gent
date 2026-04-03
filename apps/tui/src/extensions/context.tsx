/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with scope precedence.
 * Provides resolved contributions to descendants.
 */

import { createContext, useContext, createSignal, onMount, type Accessor, type JSX } from "solid-js"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"
// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os"
import type { JSX as _JSX } from "@opentui/solid"
// Static builtin imports — Bun's bundler needs these reachable for compiled binary
import builtinTools from "./builtins/tools.client"
import builtinPlan from "./builtins/plan.client"
import builtinAuto from "./builtins/auto.client"
import builtinTasks from "./builtins/tasks.client"
import builtinConnection from "./builtins/connection.client"
import builtinInteractions from "./builtins/interactions.client"
import builtinHandoff from "./builtins/handoff.client"
import type { InteractionEventTag } from "@gent/core/domain/event.js"
import type {
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "@gent/core/domain/extension-protocol.js"
import { getExtensionReplyDecoder } from "@gent/core/domain/extension-protocol.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"
import type { ResolvedBorderLabel, ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import { loadTuiExtensions } from "./loader"
import { useWorkspace } from "../workspace/index"
import { useClient } from "../client/context"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolidComponent = (props?: any) => _JSX.Element

const disabledRuntime = ManagedRuntime.make(Layer.merge(BunFileSystem.layer, BunServices.layer))

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
  readonly interactionRenderers: Accessor<Map<InteractionEventTag, SolidComponent>>
  readonly composerSurface: Accessor<SolidComponent | undefined>
  readonly borderLabels: Accessor<ReadonlyArray<ResolvedBorderLabel>>
  readonly loading: Accessor<boolean>
  /** Wire overlay dispatch from the session controller */
  readonly setOverlayDispatch: (open: (id: string) => void, close: () => void) => void
  /** Wire composer state reactive getter from the session controller */
  readonly setComposerStateProvider: (
    provider: () => {
      draft: string
      mode: "editing" | "shell"
      inputFocused: boolean
      autocompleteOpen: boolean
    },
  ) => void
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
  interactionRenderers: new Map(),
  composerSurface: undefined,
  borderLabels: [],
  protocols: new Map(),
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

  // Mutable composer state provider — wired by session controller
  let composerStateProvider:
    | (() => {
        draft: string
        mode: "editing" | "shell"
        inputFocused: boolean
        autocompleteOpen: boolean
      })
    | undefined

  const setComposerStateProvider = (
    provider: () => {
      draft: string
      mode: "editing" | "shell"
      inputFocused: boolean
      autocompleteOpen: boolean
    },
  ) => {
    composerStateProvider = provider
  }

  // Wire extension snapshot events from client event stream
  const clientCtx = useClient()
  clientCtx.onExtensionSnapshot(updateSnapshot)

  onMount(async () => {
    try {
      const home = homedir()

      // Read disabled extensions from user + project config (shared with server)
      const disabledSet = await disabledRuntime.runPromise(
        readDisabledExtensions({ home, cwd: workspace.cwd }),
      )

      const result = await loadTuiExtensions(
        {
          builtins: [
            builtinTools,
            builtinPlan,
            builtinAuto,
            builtinTasks,
            builtinConnection,
            builtinInteractions,
            builtinHandoff,
          ],
          userDir: `${home}/.gent/extensions`,
          projectDir: `${workspace.cwd}/.gent/extensions`,
          disabled: [...disabledSet],
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
          send: (message) => {
            const sid = clientCtx.session()?.sessionId
            const bid = clientCtx.session()?.branchId
            if (sid === undefined) return
            clientCtx.runtime.cast(
              clientCtx.client.extension.send({
                sessionId: sid,
                message,
                branchId: bid,
              }),
            )
          },
          ask: async <M extends AnyExtensionRequestMessage>(message: M) => {
            const sid = clientCtx.session()?.sessionId
            const bid = clientCtx.session()?.branchId
            if (sid === undefined) {
              throw new Error("Cannot ask extension without an active session")
            }
            const registered = resolved().protocols.get(message.extensionId)?.get(message._tag)
            const replyDecoder =
              registered?.kind === "request"
                ? (registered.replyDecoder as Schema.Decoder<ExtractExtensionReply<M>>)
                : getExtensionReplyDecoder(message)
            return clientCtx.runtime.run(
              clientCtx.client.extension
                .ask({
                  sessionId: sid,
                  message,
                  branchId: bid,
                })
                .pipe(
                  Effect.flatMap((reply) =>
                    replyDecoder === undefined
                      ? Effect.succeed(reply as ExtractExtensionReply<M>)
                      : Schema.decodeUnknownEffect(replyDecoder)(reply),
                  ),
                ),
            )
          },
          getSnapshot: (extensionId) => {
            const snap = snapshots().get(extensionId)
            if (snap === undefined) return undefined
            return { epoch: snap.epoch, model: snap.model }
          },
          sendMessage: (content) => clientCtx.sendMessage(content),
          composerState: () => {
            if (composerStateProvider === undefined) {
              return {
                draft: "",
                mode: "editing" as const,
                inputFocused: false,
                autocompleteOpen: false,
              }
            }
            return composerStateProvider()
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
        interactionRenderers: () => resolved().interactionRenderers,
        composerSurface: () => resolved().composerSurface,
        borderLabels: () => resolved().borderLabels,
        loading,
        setOverlayDispatch,
        setComposerStateProvider,
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
