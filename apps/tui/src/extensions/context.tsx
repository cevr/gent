/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with scope precedence.
 * Provides resolved contributions to descendants.
 */

import {
  createContext,
  useContext,
  createSignal,
  createEffect,
  createMemo,
  onMount,
  on,
  type Accessor,
  type JSX,
} from "solid-js"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"
import type { ExtensionHealthSnapshot } from "@gent/sdk"
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
  readonly sessionId: string
  readonly branchId: string
  readonly extensionId: string
  readonly epoch: number
  readonly model: unknown
}

export const applyExtensionSnapshot = (
  prev: ReadonlyMap<string, ExtensionSnapshot>,
  snapshot: ExtensionSnapshot,
): ReadonlyMap<string, ExtensionSnapshot> => {
  const current = prev.get(snapshot.extensionId)
  if (
    current !== undefined &&
    current.sessionId === snapshot.sessionId &&
    current.branchId === snapshot.branchId &&
    current.epoch > snapshot.epoch
  ) {
    return prev
  }
  const next = new Map(prev)
  next.set(snapshot.extensionId, snapshot)
  return next
}

export const decodeExtensionAskReply = <M extends AnyExtensionRequestMessage>(
  message: M,
  reply: unknown,
) => {
  const replyDecoder = getExtensionReplyDecoder(message)
  return replyDecoder === undefined
    ? Effect.succeed(reply as ExtractExtensionReply<M>)
    : Schema.decodeUnknownEffect(replyDecoder)(reply)
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
  /** Server-owned extension health snapshot */
  readonly health: Accessor<ExtensionHealthSnapshot>
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
}

const EMPTY_HEALTH: ExtensionHealthSnapshot = {
  extensions: [],
  summary: {
    status: "healthy",
    failedExtensions: [],
    failedActors: [],
    failedScheduledJobs: [],
  },
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: { children: JSX.Element }) {
  const workspace = useWorkspace()
  const clientCtx = useClient()
  const [resolved, setResolved] = createSignal<ResolvedTuiExtensions>(EMPTY_RESOLVED)
  const [loading, setLoading] = createSignal(true)
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, ExtensionSnapshot>>(new Map())
  const [health, setHealth] = createSignal<ExtensionHealthSnapshot>(EMPTY_HEALTH)
  let statusLoadVersion = 0

  const activeSessionKey = createMemo(() => {
    const session = clientCtx.session()
    if (session === null) return undefined
    return `${session.sessionId}:${session.branchId}`
  })

  const updateSnapshot = (snapshot: ExtensionSnapshot) => {
    const session = clientCtx.session()
    if (
      session === null ||
      session.sessionId !== snapshot.sessionId ||
      session.branchId !== snapshot.branchId
    ) {
      return
    }
    setSnapshots((prev) => applyExtensionSnapshot(prev, snapshot))
  }

  createEffect(() => {
    const key = activeSessionKey()
    setSnapshots((prev) => {
      if (key === undefined) {
        return prev.size === 0 ? prev : new Map()
      }
      const sep = key.indexOf(":")
      const sessionId = key.slice(0, sep)
      const branchId = key.slice(sep + 1)
      let changed = false
      const next = new Map<string, ExtensionSnapshot>()
      for (const [extensionId, snapshot] of prev) {
        if (snapshot.sessionId === sessionId && snapshot.branchId === branchId) {
          next.set(extensionId, snapshot)
          continue
        }
        changed = true
      }
      return changed ? next : prev
    })
  })

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
            return clientCtx.runtime.run(
              clientCtx.client.extension
                .ask({
                  sessionId: sid,
                  message,
                  branchId: bid,
                })
                .pipe(Effect.flatMap((reply) => decodeExtensionAskReply(message, reply))),
            )
          },
          getSnapshot: (extensionId) => {
            const snap = snapshots().get(extensionId)
            if (snap === undefined) return undefined
            return { model: snap.model }
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

  createEffect(
    on(
      () =>
        [
          clientCtx.connectionGeneration(),
          clientCtx.connectionState()?._tag,
          clientCtx.session()?.sessionId,
        ] as const,
      ([, connectionTag, sessionId]) => {
        const version = ++statusLoadVersion
        setHealth(EMPTY_HEALTH)
        if (connectionTag !== "connected") return
        clientCtx.runtime.cast(
          clientCtx.getExtensionHealth(sessionId).pipe(
            Effect.tap((nextHealth) =>
              Effect.sync(() => {
                if (version !== statusLoadVersion) return
                setHealth(nextHealth)
              }),
            ),
            Effect.catchEager((error) =>
              Effect.sync(() => {
                if (version !== statusLoadVersion) return
                setHealth(EMPTY_HEALTH)
                console.log(`[tui-ext] Extension status refresh failed: ${error}`)
              }),
            ),
          ),
        )
      },
      { defer: false },
    ),
  )

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
        health,
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
