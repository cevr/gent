/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with scope precedence.
 * Provides resolved contributions to descendants.
 */

import { createContext, useContext, createSignal, onMount, type Accessor, type JSX } from "solid-js"
import { Effect, FileSystem, Layer, ManagedRuntime, Path, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"
import { makeAsyncFs } from "@gent/core/runtime/platform-proxy"
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
import { loadTuiExtensions } from "./loader"
import { useWorkspace } from "../workspace/index"
import { useClient } from "../client/context"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolidComponent = (props?: any) => _JSX.Element

const platformRuntime = ManagedRuntime.make(Layer.merge(BunFileSystem.layer, BunServices.layer))
const { _fsInstance, _pathInstance } = Effect.runSync(
  // @effect-diagnostics-next-line strictEffectProvide:off — module-level platform capture
  Effect.provide(
    Effect.gen(function* () {
      const _fsInstance = yield* FileSystem.FileSystem
      const _pathInstance = yield* Path.Path
      return { _fsInstance, _pathInstance }
    }),
    Layer.merge(BunFileSystem.layer, BunServices.layer),
  ),
)
const _asyncFs = makeAsyncFs(_fsInstance, (effect) => platformRuntime.runPromise(effect))

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
  // Per-extension snapshot cache, keyed by extensionId.
  // Populated by `refetchExtensionSnapshot` on every `ExtensionStateChanged`
  // pulse for an extension whose package declared a snapshot source.
  // Reads happen through `ctx.getSnapshotRaw()` (per-extension binding below).
  const [snapshotCache, setSnapshotCache] = createSignal<ReadonlyMap<string, unknown>>(new Map())
  // Ordered registry of snapshot sources for loaded extensions. Filled at
  // setup time before contributions run, so the first widget read sees the
  // cache as soon as the first pulse arrives.
  const snapshotSources = new Map<string, SnapshotSource>()

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

  // Refetch a single extension's snapshot via the package's declared source.
  // Called once per `ExtensionStateChanged` pulse for that extension.
  const refetchExtensionSnapshot = async (extensionId: string): Promise<void> => {
    const source = snapshotSources.get(extensionId)
    if (source === undefined) return
    const session = clientCtx.session()
    if (session === null) return
    try {
      let value: unknown
      if (source._tag === "request") {
        const message = source.request()
        const reply = await clientCtx.runtime.run(
          clientCtx.client.extension
            .ask({
              sessionId: session.sessionId,
              message,
              branchId: session.branchId,
            })
            .pipe(Effect.flatMap((raw) => decodeExtensionAskReply(message, raw))),
        )
        value = reply
      } else {
        const ref = source.query
        const out = await clientCtx.runtime.run(
          clientCtx.client.extension.query({
            sessionId: session.sessionId,
            extensionId,
            queryId: ref.queryId,
            input: {},
            branchId: session.branchId,
          }),
        )
        value = out
      }
      setSnapshotCache((prev) => {
        const next = new Map(prev)
        next.set(extensionId, value)
        return next
      })
    } catch (err) {
      clientCtx.log.debug("extension.snapshot.refetch.failed", {
        extensionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Wire extension state-change pulses from the client event stream.
  // Each pulse triggers a refetch for that extension only — no fan-out, no
  // schema travelling through the channel (see EventPublisher pulse policy).
  clientCtx.onExtensionStateChanged(({ extensionId }) => {
    void refetchExtensionSnapshot(extensionId)
  })

  onMount(async () => {
    try {
      const home = workspace.home

      // Read disabled extensions from user + project config (shared with server)
      const disabledSet = await platformRuntime.runPromise(
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
      const makeCtx = (extensionId: string): ExtensionClientContext => ({
        cwd: workspace.cwd,
        home,
        fs: _asyncFs,
        path: _pathInstance,
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
        ask: async <M extends AnyExtensionRequestMessage>(message: M) => {
          const sid = clientCtx.session()?.sessionId
          const bid = clientCtx.session()?.branchId
          if (sid === undefined) {
            throw new Error("Cannot ask extension without an active session")
          }
          clientCtx.log.debug("extension.ask.sending", {
            extensionId: message.extensionId,
            tag: message._tag,
            sessionId: sid,
            branchId: bid,
          })
          try {
            const result = await clientCtx.runtime.run(
              clientCtx.client.extension
                .ask({
                  sessionId: sid,
                  message,
                  branchId: bid,
                })
                .pipe(Effect.flatMap((reply) => decodeExtensionAskReply(message, reply))),
            )
            clientCtx.log.debug("extension.ask.received", {
              extensionId: message.extensionId,
              tag: message._tag,
            })
            return result
          } catch (err) {
            clientCtx.log.error("extension.ask.failed", {
              extensionId: message.extensionId,
              tag: message._tag,
              error: err instanceof Error ? err.message : String(err),
            })
            throw err
          }
        },
        getSnapshotRaw: () => snapshotCache().get(extensionId),
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
        },
        makeCtx,
        _asyncFs,
        _pathInstance,
      )
      setResolved(result)

      // Initial fetch for any active session — pulses only fire on machine
      // transitions, but widgets need their first read at session entry.
      const session = clientCtx.session()
      if (session !== null) {
        for (const id of snapshotSources.keys()) {
          void refetchExtensionSnapshot(id)
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
