import {
  Cause,
  Context,
  Effect,
  Exit,
  type FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  type Path,
  Scope,
} from "effect"
import {
  type AutocompleteContribution,
  type ClientActivitySnapshot,
  type AnyExtensionClientModule,
  type ClientContextDeps,
  type ClientRuntime,
  type InteractionRendererComponent,
  makeClientContextLayer,
  type MessageRendererEntry,
  type PaneOwner,
  type StatusLabelItem,
} from "./client-facets.js"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  type JSX,
  onCleanup,
  on,
  onMount,
  untrack,
} from "solid-js"
import { formatError, isConnectionLoss, useRequiredContext } from "../utils"
// A static import: Bun's bundler reaches the builtins only through it in the compiled binary.
import { builtinClientModules } from "./builtins"
import { ToolRenderersProvider } from "../tool-renderers"
import type { Command } from "../commands"
import {
  type ClientExtensionFailure,
  type CommandSource,
  loadExtensionUi,
  resolveCommands,
  type ResolvedNoticeRows,
  type ResolvedTuiExtensions,
  type ResolvedWidget,
} from "./loader-boundary"
import { useWorkspace } from "../workspace"
import { useClient } from "../client"
import type { BranchId, SessionId } from "@gent/core/protocol"

// ── per-provider client runtime ─────────────────────────────────────────────

/**
 * One client `ManagedRuntime` for every surface that loads client
 * extensions: the interactive shell and tests. It adds `ClientContext` to the
 * platform services the caller's root built: the shell passes the services
 * `main.tsx` provides, a test passes its own platform layer.
 */
export const makeClientRuntime = (
  platform: Layer.Layer<FileSystem.FileSystem | Path.Path>,
  deps: ClientContextDeps,
): ClientRuntime => ManagedRuntime.make(Layer.merge(platform, makeClientContextLayer(deps)))

// ── extension UI provider ───────────────────────────────────────────────────

/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with
 * scope precedence. Provides resolved contributions to descendants.
 *
 * Widgets that need server-side state read it through `sessionQuery` and
 * refresh on `transport.onSessionEvent` or
 * `transport.onExtensionStateChanged`; see the goal label in
 * `builtins.tsx` and the wake tray in `wake.client.tsx`.
 */

interface ExtensionUIContextValue {
  /**
   * True once every client extension has loaded or failed. Native history
   * waits for it: a row committed before its renderer exists stays plain.
   */
  readonly loaded: Accessor<boolean>
  /**
   * True once every command source has answered: the client extensions have
   * loaded and the session's server slash commands have listed (or failed).
   * Until then an unresolved slash command may still be one of theirs.
   */
  readonly commandsSettled: Accessor<boolean>
  /**
   * Lists the session's server slash commands again: an extension can
   * register one after the last listing. Commands are unsettled until the
   * new listing answers.
   */
  readonly refreshCommands: () => void
  readonly setActivityProvider: (provider: () => ClientActivitySnapshot) => void
  /**
   * The session view installs its overlay as the pane owner while it is
   * mounted; with no session mounted, no pane opens.
   */
  readonly setPaneOwner: (owner: Option.Option<PaneOwner>) => void
  /** Message-row renderers by `metadata.customType`. */
  readonly messageRenderers: Accessor<Map<string, MessageRendererEntry>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  /**
   * Every command the reader can run: the session's own, the client
   * extensions' and the server's slash commands, under `resolveCommands`.
   */
  readonly commands: Accessor<ReadonlyArray<Command>>
  /** The session view supplies its own commands; they resolve at builtin scope. */
  readonly setSessionCommands: (commands: ReadonlyArray<Command>) => void
  readonly interactionRenderers: Accessor<Map<string, InteractionRendererComponent>>
  /**
   * Every status label's items, by priority. A `produce` that throws fails
   * its extension (`recordRenderFailure`) and draws nothing.
   */
  readonly statusLabelItems: Accessor<ReadonlyArray<StatusLabelItem>>
  /**
   * An extension's render code threw: it joins `failures` by name, as a setup
   * throw does, and its widgets and status labels draw no more. The first
   * throw is the one reported.
   */
  readonly recordRenderFailure: (extensionId: string, reason: string) => void
  /** Whether an extension's render code has thrown. */
  readonly renderFailed: (extensionId: string) => boolean
  /** Extension transcript rows by notice id; the session view merges the rows of its branch. */
  readonly noticeRows: Accessor<ReadonlyArray<ResolvedNoticeRows>>
  readonly autocompleteItems: Accessor<ReadonlyArray<AutocompleteContribution>>
  /** Client extensions, or contributions, that did not load. */
  readonly failures: Accessor<ReadonlyArray<ClientExtensionFailure>>
  /** Register dynamic autocomplete contributions (e.g. from session controller) */
  readonly setDynamicAutocomplete: (items: ReadonlyArray<AutocompleteContribution>) => void
  /** ManagedRuntime providing FileSystem, Path, ClientContext — used by
   *  Effect-typed contribution surfaces (autocomplete `items`, etc.). */
  readonly clientRuntime: ClientRuntime
}

const EMPTY_RESOLVED: ResolvedTuiExtensions = {
  renderers: new Map(),
  messageRenderers: new Map(),
  widgets: [],
  commandSources: [],
  interactionRenderers: new Map(),
  statusLabels: [],
  noticeRows: [],
  autocompleteItems: [],
  failures: [],
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: {
  children: JSX.Element
  scope?: Scope.Scope
  /** The statically imported builtins; a test adds a module to hold the load. */
  builtins?: ReadonlyArray<AnyExtensionClientModule>
}) {
  const workspace = useWorkspace()
  const client = useClient()

  const [activityProvider, setActivityProvider] = createSignal<() => ClientActivitySnapshot>(
    () => ({ state: "unknown" }),
  )

  const [paneOwner, setPaneOwner] = createSignal<Option.Option<PaneOwner>>(Option.none())

  const [resolved, setResolved] = createSignal<ResolvedTuiExtensions>(EMPTY_RESOLVED)
  const [loaded, setLoaded] = createSignal(false)
  const [renderFailures, setRenderFailures] = createSignal<ReadonlyArray<ClientExtensionFailure>>(
    [],
  )
  const renderFailed = (extensionId: string) =>
    renderFailures().some((failure) => failure.id === extensionId)
  // A throw comes from inside a render or a memo: the read here must not
  // subscribe it to the list it writes.
  const recordRenderFailure = (extensionId: string, reason: string) => {
    if (untrack(() => renderFailed(extensionId))) return
    client.log.warn("tui-ext.render.failed", { extensionId, reason })
    setRenderFailures((current) => [
      ...current,
      { id: extensionId, reason: `render failed: ${reason}` },
    ])
  }
  const statusLabelItems = () =>
    resolved()
      .statusLabels.filter((label) => !renderFailed(label.extensionId))
      .flatMap((label) =>
        Exit.match(Effect.runSyncExit(Effect.try(label.produce)), {
          onSuccess: (items) => items,
          onFailure: (cause) => {
            recordRenderFailure(label.extensionId, String(Cause.squash(cause)))
            return []
          },
        }),
      )
  const [sessionCommands, setSessionCommands] = createSignal<ReadonlyArray<Command>>([])
  const [serverCommands, setServerCommands] = createSignal<ReadonlyArray<CommandSource>>([])
  // The session and connection whose server slash commands have answered,
  // listed or failed. An answer settles only its own connection: the server a
  // reconnect reaches may list other commands.
  const [serverListed, setServerListed] = createSignal<
    Option.Option<{ readonly sessionId: SessionId; readonly generation: number }>
  >(Option.none())
  const commandsSettled = () =>
    loaded() &&
    Option.exists(
      serverListed(),
      (listed) =>
        listed.sessionId === client.activeSessionId() &&
        Option.contains(client.connectedGeneration(), listed.generation),
    )
  const [dynamicAutocomplete, setDynamicAutocomplete] = createSignal<
    ReadonlyArray<AutocompleteContribution>
  >([])

  // Provider-scoped cleanup registry. Widget setups that detach Solid
  // roots or subscribe to pulses register their disposers here; the
  // `onCleanup` below runs them in order when the provider unmounts.
  // Without this, Solid `createRoot` disposers and pulse unsubscribes
  // would leak past provider remount.
  const cleanups: Array<() => void> = []
  const addCleanup = (fn: () => void): void => {
    cleanups.push(fn)
  }

  // Per-provider ManagedRuntime that adds the `ClientContext` extensions yield
  // to the platform services the root provides (`uiServices` in `main.tsx`,
  // read through `ClientProvider`). `loadTuiExtensions` runs each setup on it.
  const platform = Layer.succeedContext(
    Context.makeUnsafe<FileSystem.FileSystem | Path.Path>(client.services.mapUnsafe),
  )
  const clientRuntime: ClientRuntime = makeClientRuntime(platform, {
    transport: {
      client: client.client,
      // The client's identity memo: it holds across a rename, so an effect
      // tracking this accessor stays put while the session and the branch do.
      currentSession: client.sessionIdentity,
      onExtensionStateChanged: (cb) => client.onExtensionStateChanged(cb),
      onSessionEvent: (cb) => client.onSessionEvent(cb),
      modelCatalog: client.modelCatalog,
    },
    workspace: {
      cwd: workspace.cwd,
      home: workspace.home,
      // A failed read leaves the launch directory, where a session without a
      // stored cwd resolves too.
      sessionCwd: client.sessionCwd.pipe(Effect.orElseSucceed(() => workspace.cwd)),
    },
    shell: {
      notify: (message) => client.setNotice(message),
      switchSession: (input) => client.switchSession(input.sessionId, input.branchId, input.name),
      cast: client.runtime.cast,
      pane: {
        open: (id) => Option.map(paneOwner(), (owner) => owner.open(id)),
        close: (id) => Option.map(paneOwner(), (owner) => owner.close(id)),
        isOpen: (id) => Option.exists(paneOwner(), (owner) => owner.isOpen(id)),
      },
    },
    activity: () => activityProvider()(),
    lifecycle: { addCleanup },
  })

  // One disposer for both owners: the provider unmount and the UI scope at
  // shutdown. It runs widget-registered cleanups (Solid root disposers, pulse
  // unsubscribes) FIRST, then disposes the per-provider runtime so layer
  // finalizers run and in-flight Effects are interrupted. Without this
  // ordering, runtime disposal would yank `ClientContext` out from under
  // widget cleanups that still need it. The first caller wins.
  let disposed: Option.Option<Promise<void>> = Option.none()
  const dispose = (): Promise<void> => {
    if (Option.isSome(disposed)) return disposed.value
    for (const fn of cleanups) {
      Effect.runSync(Effect.ignore(Effect.try(fn)))
    }
    cleanups.length = 0
    const done = clientRuntime.dispose()
    disposed = Option.some(done)
    return done
  }

  if (props.scope) {
    Effect.runSync(Scope.addFinalizer(props.scope, Effect.promise(dispose)))
  }
  onCleanup(() => {
    void dispose()
  })

  onMount(() => {
    void loadExtensionUi(clientRuntime, {
      builtins: props.builtins ?? builtinClientModules,
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
      .finally(() => setLoaded(true))
  })

  // The contributed rows belong to the session, not to its name: a move to
  // another session clears them, a rename leaves the list up.
  createEffect(
    on(client.activeSessionId, () => {
      setServerCommands([])
      setServerListed(Option.none())
    }),
  )

  // Listed once per session and connection, and again on each refresh: a
  // reconnect lists again, so a listing a dropped connection cut short is not
  // lost, and a command held for it waits for that answer. A refusal is an
  // answer and settles this connection.
  const [listingRequest, setListingRequest] = createSignal(0)
  // The last server command failure on the status row. It answers the
  // command the reader ran, so the next server command takes it back
  // (`dismissErrorIn`); a later error of another kind stays.
  let standingFailure = Option.none<{
    readonly target: { readonly sessionId: SessionId; readonly branchId: BranchId }
    readonly text: string
  }>()
  const refreshCommands = () => {
    setServerListed(Option.none())
    setListingRequest((request) => request + 1)
  }
  createEffect(
    on(
      [client.activeSessionId, client.connectedGeneration, listingRequest],
      ([current, generation]) => {
        if (Option.isNone(generation)) return

        let active = true
        const listed = () => {
          if (active)
            setServerListed(Option.some({ sessionId: current, generation: generation.value }))
        }
        onCleanup(() => {
          active = false
        })

        client.runtime.cast(
          client.client.extension.listSlashCommands({ sessionId: current }).pipe(
            Effect.tap((cmds) =>
              Effect.sync(() => {
                if (!active) return
                const byExtension = new Map<string, Array<Command>>()
                for (const c of cmds) {
                  const run = (args: string) => {
                    const { sessionId: sid, branchId: bid } = client.sessionIdentity()
                    Option.map(standingFailure, (failure) =>
                      client.dismissErrorIn(failure.target, failure.text),
                    )
                    standingFailure = Option.none()
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
                          // The reader ran the command, so a failure shows on the
                          // status row of the session it ran in.
                          Effect.catchEager((error) =>
                            Effect.sync(() => {
                              const failure = {
                                target: { sessionId: sid, branchId: bid },
                                text: `/${c.name} failed: ${formatError(error)}`,
                              }
                              client.setErrorIn(failure.target, failure.text)
                              standingFailure = Option.some(failure)
                            }).pipe(
                              Effect.andThen(Effect.logWarning("slash.command.failed")),
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
                    title: Option.getOrElse(Option.fromNullishOr(c.displayName), () => c.name),
                    slash: c.name,
                    description: c.description,
                    category: Option.getOrElse(Option.fromNullishOr(c.category), () => "Extension"),
                    onSelect: () => run(""),
                    onSlash: run,
                  }
                  const command = Option.match(Option.fromNullishOr(c.keybind), {
                    onNone: (): Command => base,
                    onSome: (keybind): Command => ({ ...base, keybind }),
                  })
                  byExtension.set(c.extensionId, [
                    ...Option.getOrElse(
                      Option.fromNullishOr(byExtension.get(c.extensionId)),
                      () => [],
                    ),
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
                listed()
              }),
            ),
            Effect.catchEager((error) =>
              Effect.sync(() => {
                // A drop is not an answer: the reconnect lists again.
                if (isConnectionLoss(error)) return
                if (active) setServerCommands([])
                listed()
              }),
            ),
          ),
        )
      },
    ),
  )

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
        loaded,
        commandsSettled,
        refreshCommands,
        messageRenderers: () => resolved().messageRenderers,
        widgets: () => resolved().widgets.filter((widget) => !renderFailed(widget.extensionId)),
        commands: () => resolvedCommands().commands,
        setSessionCommands,
        interactionRenderers: () => resolved().interactionRenderers,
        statusLabelItems,
        recordRenderFailure,
        renderFailed,
        noticeRows: () => resolved().noticeRows,
        autocompleteItems: () => [...resolved().autocompleteItems, ...dynamicAutocomplete()],
        failures: () => [
          ...resolved().failures,
          ...resolvedCommands().failures,
          ...renderFailures(),
        ],
        setDynamicAutocomplete,
        setActivityProvider: (provider) => setActivityProvider(() => provider),
        setPaneOwner: (owner) => setPaneOwner(() => owner),
        clientRuntime,
      }}
    >
      <ToolRenderersProvider value={() => resolved().renderers}>
        {props.children}
      </ToolRenderersProvider>
    </ExtensionUIContext.Provider>
  )
}

export function useExtensionUI(): ExtensionUIContextValue {
  return useRequiredContext(
    ExtensionUIContext,
    "useExtensionUI must be used within ExtensionUIProvider",
  )
}

// ── extension render boundary ───────────────────────────────────────────────

/** Reports the throw once it has its place: the report is a write the render may not make. */
function RenderFailed(props: {
  readonly extensionId: string
  readonly reason: string
  readonly fallback: JSX.Element
}) {
  const ext = useExtensionUI()
  onMount(() => ext.recordRenderFailure(props.extensionId, props.reason))
  return <>{props.fallback}</>
}

/**
 * The host's boundary around a component an extension contributed. A throw
 * in its render fails that extension by name, as a setup throw does, and
 * draws `fallback` (nothing when absent) in its place; the rest of the view
 * stays. Every place the host draws extension code goes through it.
 */
export function ExtensionRenderBoundary(props: {
  readonly extensionId: string
  readonly fallback?: JSX.Element
  readonly children: JSX.Element
}) {
  return (
    <ErrorBoundary
      fallback={(error) => (
        <RenderFailed
          extensionId={props.extensionId}
          reason={String(error)}
          fallback={props.fallback}
        />
      )}
    >
      {props.children}
    </ErrorBoundary>
  )
}
