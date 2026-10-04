/** @jsxImportSource @opentui/solid */

import { Writable } from "node:stream" // eslint-disable-line effect/noNodeBuiltinImport -- the renderer writes to a Node stream; a test terminal must be one.
import { BunServices } from "@effect/platform-bun"
import {
  Config,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Scope,
  Stream,
} from "effect"
import type { CliRenderer, CliRendererExternalOutputEvent, TerminalColors } from "@opentui/core"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { onMount, type JSX } from "solid-js"
import { KeyboardScopeProvider, TerminalDimensionsProvider } from "../src/terminal"
import { SpinnerClockProvider } from "../src/ui"
import { ThemeProvider } from "../src/theme"
import { CommandProvider } from "../src/commands"
import { EnvProvider, WorkspaceProvider } from "../src/workspace"
import {
  type ClientContextValue,
  type ClientLog,
  ClientProvider,
  type Session,
  useClient,
} from "../src/client"
import { type GentRuntime } from "@gent/sdk"
import { ExtensionUIProvider } from "../src/extensions/host"
import type { AnyExtensionClientModule } from "../src/extensions/client-facets"
import { ComposerMemoryProvider } from "../src/session"
import {
  AgentEvent,
  AgentName,
  EventEnvelope,
  BranchId,
  dateFromMillis,
  ModelId,
  SessionId,
  type Session as DomainSession,
  type GentNamespacedClient,
  ConnectionState,
} from "@gent/core/protocol"
import { emptyQueueSnapshot, EventId, testAgent } from "@gent/core/test-utils"

const noop = () => {}
const noopLog: ClientLog = { debug: noop, info: noop, warn: noop, error: noop }

type TestRenderSetup = Awaited<ReturnType<typeof createTestRenderer>>

// ── temp homes ──────────────────────────────────────────────────────────────

/**
 * Each render gets its own home, so prompt history, frecency and caches never
 * reach another test or another run. A render's home is not removed when its
 * test ends: the app casts writes into it (prompt history, frecency) that the
 * test does not wait for, and a recursive remove that races such a write
 * fails the test with `NotFound`. The homes live under one root inside the
 * test file's own `HOME`: the temp home the shared test preload makes, and
 * removes in a global `afterAll` after the file's last test. So every home is
 * removed once, when no test of the file runs, and no process reads another's.
 */
const makeRenderHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(yield* Config.String("HOME"), "render-homes")
  yield* fs.makeDirectory(root, { recursive: true })
  return yield* fs.makeTempDirectory({ directory: root, prefix: "home-" })
}).pipe(Effect.provide(BunServices.layer), Effect.orDie)

// ── platform ────────────────────────────────────────────────────────────────

/** Stand-ins for the optional tools a client extension runs; each names a program path. */
export interface TestTools {
  readonly gh?: string
  readonly hunk?: string
}

/** No test reaches the real `gh` or `hunk`: each runs as a program that is not there. */
const MISSING_TOOLS: Required<TestTools> = {
  gh: "/nonexistent/loop-probe-gh",
  hunk: "/nonexistent/loop-probe-hunk",
}

/**
 * The Bun platform a test renders on, with a process spawner that runs `gh`
 * and `hunk` from `tools`, by default from a path that does not exist, so a
 * test sees them missing. The real `gh` would read the reader's sign-in and
 * reach GitHub, and the real `hunk` would take the terminal. Every other
 * command runs for real.
 */
export const testPlatformLayer = (tools: TestTools = {}) => {
  const stand = { ...MISSING_TOOLS, ...tools }
  const programFor = (command: string): Option.Option<string> => {
    if (command === "gh") return Option.some(stand.gh)
    if (command === "hunk") return Option.some(stand.hunk)
    return Option.none()
  }
  return Layer.mergeAll(
    BunServices.layer,
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) return real.spawn(command)
          return Option.match(programFor(command.command), {
            onNone: () => real.spawn(command),
            onSome: (program) =>
              real.spawn(ChildProcess.make(program, command.args, command.options)),
          })
        })
      }),
    ).pipe(Layer.provide(BunServices.layer)),
  )
}

let sharedServices: Option.Option<Context.Context<unknown>> = Option.none()

/** The repo root: the workspace a render opens when its test names no cwd. */
const defaultWorkspaceCwd = Effect.gen(function* () {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("../../..", import.meta.url))
}).pipe(Effect.provide(BunServices.layer), Effect.orDie)

type MockMethod = (...args: ReadonlyArray<never>) => unknown
type MockNamespace = { readonly [method: string]: MockMethod }
type NamespaceOverrides = Partial<Record<string, Partial<MockNamespace>>>

/**
 * A `session` mock whose snapshot is of the session asked for and names
 * `agent`: the agent a session runs reaches the UI only through its snapshot.
 */
export const snapshotNaming = (agent: AgentName) => ({
  getSnapshot: (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
    Effect.succeed({
      sessionId: input.sessionId,
      branchId: input.branchId,
      messages: [],
      // eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
      lastEventId: null,
      // eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
      reasoningLevel: undefined,
      resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
      agent,
      runtime: { _tag: "Idle" satisfies "Idle", queue: emptyQueueSnapshot() },
      metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
    }),
})

/** How a mock client answers: `holdingReplies` makes one that holds every reply. */
interface ReplyHold {
  readonly hold: (method: MockMethod) => MockMethod
}

export const createMockClient = (
  overrides?: NamespaceOverrides,
  replies?: ReplyHold,
): GentNamespacedClient => {
  const noRpcError = <A,>(value: A) => Effect.succeed(value)
  // eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
  const absent = undefined
  // eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
  const nullValue = null

  const mocks = {
    session: {
      create: () =>
        noRpcError({
          sessionId: SessionId.make("session-test"),
          branchId: BranchId.make("branch-test"),
          name: "Test Session",
        }),
      list: () => noRpcError([]),
      get: () => noRpcError(nullValue),
      delete: () => noRpcError(absent),
      // The snapshot of the session asked for, as the server's: it names the
      // agent the session runs, the one way the UI learns it.
      getSnapshot: snapshotNaming(AgentName.make("primary")).getSnapshot,
      updateSettings: () => noRpcError({ modelId: absent, reasoningLevel: absent }),
      // As the server's: the events stream ends its (empty) replay with the
      // synchronized marker and stays open; the runtime watch stays open.
      events: (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
        Stream.concat(
          Stream.make(
            EventEnvelope.make({
              id: EventId.make(0),
              event: AgentEvent.cases.StreamSynchronized.make({
                sessionId: input.sessionId,
                branchId: input.branchId,
                lastEventId: EventId.make(0),
              }),
              createdAt: 0,
            }),
          ),
          Stream.never,
        ),
      watchRuntime: () => Stream.never,
    },
    branch: {
      list: () => noRpcError([]),
      create: () => noRpcError({ branchId: BranchId.make("branch-test") }),
      getTree: () => noRpcError([]),
      switch: () => noRpcError(absent),
      fork: () => noRpcError({ branchId: BranchId.make("branch-test") }),
    },
    message: {
      send: () => noRpcError(absent),
      list: () => noRpcError([]),
    },
    steer: {
      command: () => noRpcError(absent),
    },
    queue: {
      drain: () => noRpcError(emptyQueueSnapshot()),
      get: () => noRpcError(emptyQueueSnapshot()),
    },
    interaction: {
      respondQuestions: () => noRpcError(absent),
      respondPrompt: () => noRpcError(absent),
      respondHandoff: () => noRpcError({}),
    },
    model: {
      list: () => noRpcError([]),
    },
    driver: {
      list: () => noRpcError({ drivers: [], overrides: {}, agents: [testAgent] }),
    },
    auth: {
      listProviders: () => noRpcError([]),
      setKey: () => noRpcError(absent),
      deleteKey: () => noRpcError(absent),
      listMethods: () => noRpcError({}),
      listCatalogProviders: () => noRpcError({ providers: [], methods: {} }),
      authorize: () => noRpcError(nullValue),
      callback: () => noRpcError(absent),
    },
    task: {
      list: () => noRpcError([]),
    },
    skill: {
      list: () =>
        noRpcError([
          {
            name: "effect-v4",
            description: "Effect skill",
            content: "effect skill content",
            filePath: "/tmp/effect-v4.md",
          },
        ]),
      getContent: () => noRpcError(nullValue),
    },
    extension: {
      request: () => noRpcError(absent),
      listSlashCommands: () => noRpcError([]),
      listStatus: () =>
        noRpcError({
          _tag: "Healthy",
          extensions: [],
        }),
    },
    actor: {
      sendUserMessage: () => noRpcError(absent),
      sendToolResult: () => noRpcError(absent),
      interrupt: () => noRpcError(absent),
      getState: () => noRpcError(absent),
    },
  } satisfies Record<string, MockNamespace>

  return new Proxy(Object.create(null), {
    get(_target, ns: string) {
      const base = Option.getOrElse(
        Option.map(
          Option.fromNullishOr(Object.entries(mocks).find(([key]) => key === ns)),
          ([, value]) => value,
        ),
        () => ({}),
      )
      const extra = Option.fromNullishOr(overrides?.[ns])
      const methods: Partial<MockNamespace> = Option.match(extra, {
        onNone: () => base,
        onSome: (value) => ({ ...base, ...value }),
      })
      return Option.match(Option.fromUndefinedOr(replies), {
        onNone: () => methods,
        onSome: ({ hold }) =>
          Object.fromEntries(
            Object.entries(methods).flatMap(([name, method]) =>
              Option.match(Option.fromUndefinedOr(method), {
                onNone: () => [],
                onSome: (present) => [[name, hold(present)]],
              }),
            ),
          ),
      })
    },
  })
}

/**
 * A `createMockClient` hold that keeps every reply. Each call that answers
 * with an Effect waits until `release`, which lets the held replies go newest
 * first: a reply asked for in a session the reader has left lands last. A
 * stream is no reply and is never held. After `release` the client answers
 * at once. Because it holds every method, a new read is covered without a
 * list to keep.
 */
export const holdingReplies = () => {
  const held: Array<Deferred.Deferred<void>> = []
  let holding = true
  // A mocked method answers `unknown`. The hold only runs a reply later, so
  // it reads one as an Effect that needs nothing and leaves its error as is.
  const isReply = <T,>(value: T): value is T & Effect.Effect<unknown> => Effect.isEffect(value)
  const hold =
    (method: MockMethod): MockMethod =>
    (...args) => {
      const reply = method(...args)
      if (!holding || !isReply(reply)) return reply
      const gate = Deferred.makeUnsafe<void>()
      held.push(gate)
      return Deferred.await(gate).pipe(Effect.andThen(reply))
    }
  const release = Effect.gen(function* () {
    holding = false
    for (const gate of held.splice(0).reverse()) {
      yield* Deferred.complete(gate, Effect.void)
      yield* Effect.yieldNow
    }
  })
  return { hold, held: () => held.length, release }
}

/**
 * A runtime that runs each effect on `services`, keyed as `Context` keys them:
 * a test hands in its own clock or loggers here. None by default.
 */
export const createMockRuntime = (
  services: ReadonlyMap<string, unknown> = new Map(),
): GentRuntime => ({
  cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    Effect.runForkWith(Context.makeUnsafe<R>(new Map(services)))(effect)
  },
  fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runForkWith(Context.makeUnsafe<R>(new Map(services)))(effect),
  lifecycle: {
    getState: () => ConnectionState.cases.Connected.make({ generation: 0 }),
    subscribe: (listener) => {
      listener(ConnectionState.cases.Connected.make({ generation: 0 }))
      return () => {}
    },
    waitForReady: Effect.void,
  },
})

/** A mock runtime whose connection state a test moves: `emit` a drop, then a reconnect. */
export const createMutableRuntime = (initialState: ConnectionState) => {
  let state = initialState
  const listeners = new Set<(state: ConnectionState) => void>()
  const runtime: GentRuntime = {
    ...createMockRuntime(),
    lifecycle: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        listener(state)
        return () => {
          listeners.delete(listener)
        }
      },
      waitForReady: Effect.void,
    },
  }
  return {
    runtime,
    emit: (nextState: ConnectionState) => {
      state = nextState
      for (const listener of listeners) listener(nextState)
    },
  }
}

/** The session a render starts on when the test names none: the client always holds one. */
const defaultTestSession: Session = {
  sessionId: SessionId.make("session-test"),
  branchId: BranchId.make("branch-test"),
  name: "Test Session",
}

const toInitialSession = (session: Option.Option<DomainSession | Session>): Session =>
  Option.match(session, {
    onNone: () => defaultTestSession,
    onSome: (value) => {
      if ("sessionId" in value) return value
      return {
        sessionId: value.id,
        branchId: Option.getOrElse(
          Option.fromNullishOr(value.activeBranchId),
          () => defaultTestSession.branchId,
        ),
        name: Option.getOrElse(Option.fromNullishOr(value.name), () => "Unnamed"),
        modelId: value.modelId,
        reasoningLevel: value.reasoningLevel,
        cwd: value.cwd,
      }
    },
  })

/**
 * The platform `services` a render takes, with `tools` standing in for `gh`
 * and `hunk` (`testPlatformLayer`); the enclosing scope releases them.
 */
export const testPlatformServices = (tools: TestTools = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const context = yield* Layer.buildWithScope(testPlatformLayer(tools), scope)
    return Context.makeUnsafe<unknown>(Context.add(context, Scope.Scope, scope).mapUnsafe)
  })

const getServices = (): Promise<Context.Context<unknown>> => {
  if (Option.isSome(sharedServices)) return Effect.runPromise(Effect.succeed(sharedServices.value))
  return Effect.runPromise(
    Effect.gen(function* () {
      // The shared services live as long as the test process.
      const scope = yield* Scope.make()
      const services = yield* testPlatformServices().pipe(Effect.provideService(Scope.Scope, scope))
      sharedServices = Option.some(services)
      return services
    }),
  )
}

// ── terminal output ─────────────────────────────────────────────────────────

/**
 * A terminal a test reads back. OpenTUI's test stdout drops what the renderer
 * writes; handed to `renderWithProviders` as `output`, this one keeps every
 * byte in order, so a test can assert on a sequence the renderer sends the
 * terminal itself (an OSC 52 copy), not only on what it draws.
 */
export class TerminalOutput extends Writable {
  readonly isTTY = true
  private readonly chunks: Uint8Array[] = []

  constructor(
    readonly columns = 80,
    readonly rows = 24,
  ) {
    super()
  }

  override _write(chunk: Uint8Array, _encoding: string, callback: () => void) {
    // The renderer reuses its output buffer once the write returns: keep a copy
    // (`Buffer#slice` would share the memory).
    this.chunks.push(new Uint8Array(chunk))
    callback()
  }

  getColorDepth() {
    return 24
  }

  /** The stream as the renderer's stdout: it only writes, and reads the TTY fields above. */
  stdout(): NodeJS.WriteStream {
    // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- a Writable with the TTY fields OpenTUI reads stands in for stdout, as OpenTUI's own test stdout does.
    return this as unknown as NodeJS.WriteStream
  }

  /** Everything the renderer has written so far. */
  written(): string {
    const bytes = new Uint8Array(this.chunks.reduce((total, chunk) => total + chunk.length, 0))
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder().decode(bytes)
  }
}

export const renderWithProviders = (
  node: () => JSX.Element,
  options?: {
    client?: GentNamespacedClient
    runtime?: GentRuntime
    initialSession?: DomainSession | Session
    initialPrompt?: Option.Option<string>
    width?: number
    height?: number
    cwd?: string
    /** Client extension builtins; defaults to the shipped ones. */
    builtins?: ReadonlyArray<AnyExtensionClientModule>
    /** The UI scope main.tsx hands the extension host; closing it is shutdown. */
    uiScope?: Scope.Scope
    /**
     * Test-only override for the platform services context (e.g. supplying
     * a `LinkOpener.Test` layer). Defaults to the shared host context.
     */
    services?: Context.Context<unknown>
    /** A terminal that keeps what the renderer writes; OpenTUI's own drops it. */
    output?: TerminalOutput
    /** Keys arrive as the kitty keyboard protocol spells them (herdr, kitty). */
    kittyKeyboard?: boolean
    /** Sessions outlive the process; false as an in-memory store runs. Defaults to true. */
    resumable?: boolean
    /** Takes what the session writes to the terminal once the renderer is gone. */
    writeTerminal?: (text: string) => void
    /** Takes what the client logs; the default drops it. */
    log?: ClientLog
  },
): Promise<TestRenderSetup> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const suppliedServices = Option.fromNullishOr(options?.services)
      let services: Context.Context<unknown>
      if (Option.isSome(suppliedServices)) {
        services = suppliedServices.value
      } else {
        services = yield* Effect.promise(() => getServices())
      }
      const client = Option.getOrElse(Option.fromNullishOr(options?.client), createMockClient)
      const runtime = Option.getOrElse(Option.fromNullishOr(options?.runtime), createMockRuntime)
      // Each render gets its own home: prompt history, frecency and caches
      // written under it never reach another test or another run.
      const home = yield* makeRenderHome
      const cwd = options?.cwd ?? (yield* defaultWorkspaceCwd)
      const initialSession = toInitialSession(Option.fromNullishOr(options?.initialSession))

      // A kept terminal takes the renderer's bytes as a real stdout would.
      const output = Option.match(Option.fromNullishOr(options?.output), {
        onNone: (): Partial<TestRendererOptions> => ({}),
        onSome: (terminal): Partial<TestRendererOptions> => ({
          stdout: terminal.stdout(),
          bufferedOutput: "stdout",
        }),
      })
      const setup = yield* Effect.promise(() =>
        createTestRenderer({
          width: options?.width ?? 80,
          height: options?.height ?? 24,
          exitOnCtrlC: false,
          kittyKeyboard: options?.kittyKeyboard ?? false,
          ...output,
        }),
      )
      // Exercise terminal lifecycle operations against OpenTUI's in-memory streams.
      yield* Effect.promise(() => setup.renderer.setupTerminal())
      const history: Array<string> = []
      setup.renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
        history.push(snapshotText(event.snapshot))
      })
      // A terminal keeps its saved lines through a reset, unless the reset clears them.
      const reset = setup.renderer.resetSplitFooterForReplay.bind(setup.renderer)
      setup.renderer.resetSplitFooterForReplay = (resetOptions) => {
        if (resetOptions?.clearSavedLines === true) history.splice(0)
        reset(resetOptions)
      }
      histories.set(setup.renderer, history)
      yield* Effect.promise(() =>
        render(
          () => (
            <TerminalDimensionsProvider>
              <SpinnerClockProvider>
                <ComposerMemoryProvider
                  initialPrompt={Option.getOrElse(
                    Option.fromNullishOr(options?.initialPrompt),
                    () => Option.none<string>(),
                  )}
                  initialSessionId={Option.some(initialSession.sessionId)}
                >
                  <KeyboardScopeProvider>
                    <ThemeProvider mode="dark">
                      <EnvProvider
                        env={{
                          visual: Option.none(),
                          editor: Option.none(),
                          shutdown: () => {},
                          resumable: options?.resumable ?? true,
                          writeTerminal: options?.writeTerminal ?? (() => {}),
                        }}
                      >
                        <CommandProvider>
                          <WorkspaceProvider cwd={cwd} home={home}>
                            <ClientProvider
                              client={client}
                              runtime={runtime}
                              services={services}
                              log={options?.log ?? noopLog}
                              initialSession={initialSession}
                            >
                              <ExtensionUIProvider
                                builtins={options?.builtins}
                                scope={options?.uiScope}
                              >
                                {node()}
                              </ExtensionUIProvider>
                            </ClientProvider>
                          </WorkspaceProvider>
                        </CommandProvider>
                      </EnvProvider>
                    </ThemeProvider>
                  </KeyboardScopeProvider>
                </ComposerMemoryProvider>
              </SpinnerClockProvider>
            </TerminalDimensionsProvider>
          ),
          setup.renderer,
        ),
      )
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      return setup
    }),
  )

export const renderFrame = (setup: TestRenderSetup) =>
  setup.captureCharFrame().replaceAll("\u00a0", " ")

/** The rows each render committed to native history, in commit order. */
const histories = new WeakMap<CliRenderer, Array<string>>()

/** A snapshot's rows. Each row ends with a line break, the last one too; the rows join on them. */
const snapshotText = (snapshot: CliRendererExternalOutputEvent["snapshot"]) =>
  new TextDecoder()
    .decode(snapshot.getRealCharBytes(true))
    .replace(/\n$/, "")
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")

/**
 * What the terminal holds: the rows committed to native history, then the
 * split region's frame. The live tail keeps the transcript's last rows and
 * the rows above it move to history, so a row the reader sees is in one of
 * them, never both.
 */
export const terminalText = (setup: TestRenderSetup) =>
  [...(histories.get(setup.renderer) ?? []), renderFrame(setup)].join("\n")

/** The terminal answers the palette query with `colors`, as a terminal with that palette does. */
export const answerPalette = (renderer: CliRenderer, colors: TerminalColors) => {
  renderer.getPalette = () => Effect.runPromise(Effect.succeed(colors))
  renderer.clearPaletteCache = () => {}
}

export const destroyRenderSetup = (setup: TestRenderSetup) => {
  setup.renderer.destroy()
}

/** A render the enclosing scope destroys, on success, failure or timeout alike. */
export const renderScoped = (...args: Parameters<typeof renderWithProviders>) =>
  Effect.acquireRelease(
    Effect.promise(() => renderWithProviders(...args)),
    (setup) => Effect.sync(() => destroyRenderSetup(setup)),
  )

/** A stored session to start a render on: `initialSession` takes it as the server lists it. */
export const sessionFixture = (id: string, branch: string, name: string): DomainSession => ({
  id: SessionId.make(id),
  activeBranchId: BranchId.make(branch),
  name,
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
})

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => props.onReady(client))
  return <box />
}

/**
 * A scoped render that also hands back the client its tree reads. `view`
 * mounts after the probe; without it the render holds only the probe. The
 * effect dies when the probe does not mount.
 */
export const mountClient = (
  options: Parameters<typeof renderWithProviders>[1] & { readonly view?: () => JSX.Element } = {},
) =>
  Effect.gen(function* () {
    const { view, ...renderOptions } = options
    let held = Option.none<ClientContextValue>()
    const setup = yield* renderScoped(
      () => (
        <>
          <ClientProbe onReady={(client) => (held = Option.some(client))} />
          {view?.()}
        </>
      ),
      renderOptions,
    )
    if (Option.isNone(held)) return yield* Effect.die("the client probe did not mount")
    return { setup, client: held.value }
  })

/**
 * The agent a session runs as reaches the UI only through its snapshot. A
 * test that needs the agent to change lands a snapshot that names the new
 * one, of the session in view, as a refresh would.
 */
export const applySnapshotAgent = (client: ClientContextValue, agent: AgentName): void => {
  const session = client.session()
  client.applySessionSnapshot({
    sessionId: session.sessionId,
    branchId: session.branchId,
    name: session.name,
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    messages: [],
    // eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
    lastEventId: null,
    resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
    agent,
    runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
    metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
  })
}
