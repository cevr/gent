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
  type Accessor,
  type JSX,
} from "solid-js"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"
import type { JSX as _JSX } from "@opentui/solid"
// Static builtin imports — Bun's bundler needs these reachable for compiled binary
import { builtinClientModules } from "./builtins/index"
import type {
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "@gent/core/domain/extension-protocol.js"
import { getExtensionReplyDecoder } from "@gent/core/domain/extension-protocol.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"
import type { ResolvedBorderLabel, ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import type {
  AutocompleteContribution,
  ExtensionClientContext,
  ExtensionClientModule,
  SnapshotSource,
} from "@gent/core/domain/extension-client.js"
import { loadTuiExtensions } from "./loader-boundary"
import { makeClientTransportLayer } from "./client-transport"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientComposerLayer,
  makeClientSnapshotsLayer,
} from "./client-services"
import { useWorkspace } from "../workspace/index"
import { useClient } from "../client/context"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolidComponent = (props?: any) => _JSX.Element

export const decodeExtensionAskReply = <M extends AnyExtensionRequestMessage>(
  message: M,
  reply: unknown,
) => {
  const replyDecoder = getExtensionReplyDecoder(message)
  return replyDecoder === undefined
    ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      Effect.succeed(reply as ExtractExtensionReply<M>)
    : Schema.decodeUnknownEffect(replyDecoder)(reply)
}

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
  // Snapshot cache, keyed by `sessionId|branchId|extensionId`. Cache slots
  // are scoped to the (session, branch) the snapshot was fetched in — so a
  // session/branch switch does NOT serve a stale value from the previous
  // session. Cleared on every session/branch change (see createEffect below).
  const [snapshotCache, setSnapshotCache] = createSignal<ReadonlyMap<string, unknown>>(new Map())
  // Ordered registry of snapshot sources for loaded extensions. Filled at
  // setup time before contributions run, so the first widget read sees the
  // cache as soon as the first pulse arrives.
  const snapshotSources = new Map<string, SnapshotSource>()

  const cacheKey = (sessionId: string, branchId: string, extensionId: string): string =>
    `${sessionId}|${branchId}|${extensionId}`

  // Reactive memo of the current session key. Recomputes whenever session
  // identity changes — drives both cache eviction and session-entry refetch.
  const activeSessionKey = createMemo(() => {
    const session = clientCtx.session()
    if (session === null) return undefined
    return `${session.sessionId}|${session.branchId}`
  })

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

  // C9.2/C9.3: build a per-provider ManagedRuntime that augments the shared
  // platform layer (FileSystem, Path) with all the TUI client services
  // Effect-typed extensions may yield: `ClientTransport` (typed RPC client),
  // `ClientWorkspace` (cwd/home), `ClientShell` (send/sendMessage/overlays),
  // `ClientComposer` (reactive composer state), `ClientSnapshots`
  // (per-extension snapshot cache). The loader's `invokeSetup` runs each
  // setup against this runtime.
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
      makeClientSnapshotsLayer({
        read: (extensionId) => {
          const session = clientCtx.session()
          if (session === null) return undefined
          return snapshotCache().get(cacheKey(session.sessionId, session.branchId, extensionId))
        },
      }),
    ),
  )

  // Refetch a single extension's snapshot via the package's declared source.
  // Called once per `ExtensionStateChanged` pulse for that extension and on
  // every session-entry. The fetched value is stored under a session-scoped
  // cache key so a subsequent session switch cannot serve it as if it
  // belonged to the new session.
  //
  // `isInitial` distinguishes "first read after session entry" (warn on
  // failure — user-visible widgets stay empty) from "incremental refresh on
  // pulse" (debug-only — last value remains in cache).
  const refetchExtensionSnapshot = async (
    extensionId: string,
    isInitial: boolean,
  ): Promise<void> => {
    const source = snapshotSources.get(extensionId)
    if (source === undefined) return
    const session = clientCtx.session()
    if (session === null) return
    const fetchSessionId = session.sessionId
    const fetchBranchId = session.branchId
    try {
      let value: unknown
      if (source._tag === "request") {
        const message = source.request()
        const reply = await clientCtx.runtime.run(
          clientCtx.client.extension
            .ask({
              sessionId: fetchSessionId,
              message,
              branchId: fetchBranchId,
            })
            .pipe(Effect.flatMap((raw) => decodeExtensionAskReply(message, raw))),
        )
        value = reply
      } else {
        const ref = source.query
        const out = await clientCtx.runtime.run(
          clientCtx.client.extension.query({
            sessionId: fetchSessionId,
            extensionId,
            queryId: ref.queryId,
            input: {},
            branchId: fetchBranchId,
          }),
        )
        value = out
      }
      // Drop the result if the session has switched out from under us
      // mid-fetch — otherwise a slow refetch from the prior session would
      // poison the cache for the new session.
      const currentSession = clientCtx.session()
      if (
        currentSession === null ||
        currentSession.sessionId !== fetchSessionId ||
        currentSession.branchId !== fetchBranchId
      ) {
        return
      }
      setSnapshotCache((prev) => {
        const next = new Map(prev)
        next.set(cacheKey(fetchSessionId, fetchBranchId, extensionId), value)
        return next
      })
    } catch (err) {
      const log = isInitial ? clientCtx.log.warn : clientCtx.log.debug
      log("extension.snapshot.refetch.failed", {
        extensionId,
        sessionId: fetchSessionId,
        branchId: fetchBranchId,
        isInitial,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Session/branch change: evict any cache slots that don't belong to the
  // new (session, branch), then trigger a session-entry refetch for every
  // registered snapshot source.
  createEffect(() => {
    const key = activeSessionKey()
    setSnapshotCache((prev) => {
      if (key === undefined) {
        return prev.size === 0 ? prev : new Map()
      }
      let changed = false
      const next = new Map<string, unknown>()
      for (const [k, v] of prev) {
        if (k.startsWith(`${key}|`)) {
          next.set(k, v)
          continue
        }
        changed = true
      }
      return changed ? next : prev
    })
    if (key !== undefined) {
      // Session-entry refetch — pulses fire only on machine transitions /
      // owned events, but widgets need their first read at session entry.
      for (const id of snapshotSources.keys()) {
        void refetchExtensionSnapshot(id, true)
      }
    }
  })

  // Wire extension state-change pulses from the client event stream.
  // Each pulse triggers a refetch for that extension only — no fan-out, no
  // schema travelling through the channel (see EventPublisher pulse policy).
  clientCtx.onExtensionStateChanged(({ extensionId }) => {
    void refetchExtensionSnapshot(extensionId, false)
  })

  onMount(async () => {
    try {
      const home = workspace.home

      // Read disabled extensions from user + project config (shared with server)
      const disabledSet = await clientRuntime.runPromise(
        readDisabledExtensions({ home, cwd: workspace.cwd }),
      )

      // Pre-register each builtin's snapshot source so refetch knows where to look.
      // Discovered (user/project) extensions register the same way inside the
      // loader's import phase via `registerExtensionModule` below.
      for (const m of builtinClientModules ?? []) {
        if (m.snapshotSource !== undefined) snapshotSources.set(m.id, m.snapshotSource)
      }

      const registerExtensionModule = (m: ExtensionClientModule) => {
        if (m.snapshotSource !== undefined) snapshotSources.set(m.id, m.snapshotSource)
      }

      // Build a per-extension context: each extension's `getSnapshotRaw`
      // reads its own slot in the cache, so paired packages narrow correctly.
      // C9.3: `fs`/`path`/`ask` deleted — Effect-typed setups read those
      // through TUI services (`FileSystem.FileSystem`, `Path.Path`,
      // `ClientTransport`/`askExtension`).
      const makeCtx = (extensionId: string): ExtensionClientContext => ({
        cwd: workspace.cwd,
        home,
        openOverlay: (id) => overlayDispatch().open(id),
        closeOverlay: () => overlayDispatch().close(),
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
        getSnapshotRaw: () => {
          const session = clientCtx.session()
          if (session === null) return undefined
          return snapshotCache().get(cacheKey(session.sessionId, session.branchId, extensionId))
        },
        sendMessage: (content) => clientCtx.sendMessage(content),
        composerState: () => {
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
      })

      const result = await loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: `${home}/.gent/extensions`,
          projectDir: `${workspace.cwd}/.gent/extensions`,
          disabled: [...disabledSet],
          onModuleLoaded: registerExtensionModule,
          runtime: clientRuntime,
        },
        makeCtx,
      )
      setResolved(result)

      // Initial fetch for any active session at mount time. The session-key
      // `createEffect` above also handles entries; this catches the case
      // where a session is already active before extensions finish loading.
      if (activeSessionKey() !== undefined) {
        for (const id of snapshotSources.keys()) {
          void refetchExtensionSnapshot(id, true)
        }
      }

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
