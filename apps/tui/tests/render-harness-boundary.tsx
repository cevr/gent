/** @jsxImportSource @opentui/solid */

import { afterEach } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import {
  Config,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Scope,
  Stream,
} from "effect"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import type { JSX } from "solid-js"
import { KeyboardScopeProvider, TerminalDimensionsProvider } from "../src/terminal"
import { ThemeProvider } from "../src/theme"
import { CommandProvider } from "../src/commands"
import { EnvProvider, WorkspaceProvider } from "../src/workspace"
import {
  type ClientContextValue,
  type ClientLog,
  ClientProvider,
  type Session,
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

let currentSetup: Option.Option<TestRenderSetup> = Option.none()

// ── temp homes ──────────────────────────────────────────────────────────────

/**
 * Each render gets its own home, so prompt history, frecency and caches never
 * reach another test or another run. The homes live under one root per test
 * process: prompt-history writes queue behind one process-wide gate, so a
 * write a test did not wait for can land after the test and make its removed
 * home again. The root holds those. It is made on first use inside the
 * process's own `HOME`: the temp home the shared test preload makes, and
 * removes in a global `afterAll` after the process's last test. So each
 * process removes its own root and never reads another's.
 */
const makeRenderHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(yield* Config.string("HOME"), "render-homes")
  yield* fs.makeDirectory(root, { recursive: true })
  return yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "home-" })
}).pipe(Effect.provide(BunServices.layer), Effect.orDie)

/** The scopes that own each render's home; closed after the test. */
let renderScopes: Array<Scope.Closeable> = []

let sharedServices: Option.Option<Context.Context<unknown>> = Option.none()
const defaultWorkspaceCwd = new URL("../../..", import.meta.url).pathname

type MockMethod = (...args: ReadonlyArray<never>) => unknown
type MockNamespace = { readonly [method: string]: MockMethod }
type NamespaceOverrides = Partial<Record<string, Partial<MockNamespace>>>

export const createMockClient = (overrides?: NamespaceOverrides): GentNamespacedClient => {
  const noRpcError = <A,>(value: A) => Effect.succeed(value)
  const absent = Option.getOrUndefined(Option.none())
  const nullValue = Option.getOrNull(Option.none())

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
      getSnapshot: () =>
        noRpcError({
          sessionId: SessionId.make("session-test"),
          branchId: BranchId.make("branch-test"),
          messages: [],
          lastEventId: nullValue,
          reasoningLevel: absent,
          resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
          agent: AgentName.make("cowork"),
          runtime: {
            _tag: "Idle",
            queue: emptyQueueSnapshot(),
          },
          metrics: {
            turns: 0,
            durationMs: 0,
            costUsd: 0,
            lastInputTokens: 0,
          },
        }),
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
      if (Option.isSome(extra)) return { ...base, ...extra.value }
      return base
    },
  })
}

export const createMockRuntime = (): GentRuntime => ({
  cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    Effect.runForkWith(Context.makeUnsafe<R>(new Map<string, never>()))(effect)
  },
  fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runForkWith(Context.makeUnsafe<R>(new Map<string, never>()))(effect),
  run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromiseWith(Context.makeUnsafe<R>(new Map<string, never>()))(effect),
  lifecycle: {
    getState: () => ConnectionState.cases.Connected.make({ generation: 0 }),
    subscribe: (listener) => {
      listener(ConnectionState.cases.Connected.make({ generation: 0 }))
      return () => {}
    },
    waitForReady: Effect.void,
  },
})

const toInitialSession = (
  session: Option.Option<DomainSession | Session>,
): Option.Option<Session> =>
  Option.flatMap(session, (value) => {
    if ("sessionId" in value) return Option.some(value)
    return Option.map(Option.fromNullishOr(value.activeBranchId), (branchId) => ({
      sessionId: value.id,
      branchId,
      name: Option.getOrElse(Option.fromNullishOr(value.name), () => "Unnamed"),
      modelId: value.modelId,
      reasoningLevel: value.reasoningLevel,
      cwd: value.cwd,
    }))
  })

const getServices = (): Promise<Context.Context<unknown>> => {
  if (Option.isSome(sharedServices)) return Effect.runPromise(Effect.succeed(sharedServices.value))
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(BunServices.layer, scope)
      const services = Context.makeUnsafe<unknown>(
        Context.add(context, Scope.Scope, scope).mapUnsafe,
      )
      sharedServices = Option.some(services)
      return services
    }),
  )
}

export const renderWithProviders = (
  node: () => JSX.Element,
  options?: {
    client?: GentNamespacedClient
    runtime?: GentRuntime
    initialSession?: DomainSession | Session
    initialAgent?: AgentName
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
      const homeScope = yield* Scope.make()
      renderScopes.push(homeScope)
      const home = yield* makeRenderHome.pipe(Scope.provide(homeScope))

      const setup = yield* Effect.promise(() =>
        createTestRenderer({
          width: options?.width ?? 80,
          height: options?.height ?? 24,
          exitOnCtrlC: false,
        }),
      )
      currentSetup = Option.some(setup)
      // Exercise terminal lifecycle operations against OpenTUI's in-memory streams.
      yield* Effect.promise(() => setup.renderer.setupTerminal())
      yield* Effect.promise(() =>
        render(
          () => (
            <TerminalDimensionsProvider>
              <ComposerMemoryProvider
                initialPrompt={Option.getOrElse(Option.fromNullishOr(options?.initialPrompt), () =>
                  Option.none<string>(),
                )}
                initialSessionId={Option.map(
                  toInitialSession(Option.fromNullishOr(options?.initialSession)),
                  (session) => session.sessionId,
                )}
              >
                <KeyboardScopeProvider>
                  <ThemeProvider mode="dark">
                    <EnvProvider
                      env={{ visual: Option.none(), editor: Option.none(), shutdown: () => {} }}
                    >
                      <CommandProvider>
                        <WorkspaceProvider
                          cwd={options?.cwd ?? defaultWorkspaceCwd}
                          home={home}
                          services={services}
                        >
                          <ClientProvider
                            client={client}
                            runtime={runtime}
                            services={services}
                            log={noopLog}
                            initialSession={Option.getOrUndefined(
                              toInitialSession(Option.fromNullishOr(options?.initialSession)),
                            )}
                            initialAgent={options?.initialAgent}
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

export const destroyRenderSetup = (setup: TestRenderSetup) => {
  if (Option.isSome(currentSetup) && currentSetup.value === setup) currentSetup = Option.none()
  setup.renderer.destroy()
}

// eslint-disable-next-line effect/noTestLifecycleHooks -- OpenTUI renderers require synchronous per-test teardown at this shared test boundary; the renders' homes are removed after it.
afterEach(() => {
  if (Option.isSome(currentSetup)) destroyRenderSetup(currentSetup.value)
  currentSetup = Option.none()
  const scopes = renderScopes
  renderScopes = []
  return Effect.runPromise(Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void)))
})

/**
 * The agent a session runs as reaches the UI only through its snapshot. A
 * test that needs the agent to change lands a snapshot that names the new
 * one: of the active session, as a refresh would, or of a test session when
 * none is active, as opening one would.
 */
export const applySnapshotAgent = (client: ClientContextValue, agent: AgentName): void => {
  const state = client.sessionState()
  let session: Pick<Session, "sessionId" | "branchId" | "name"> &
    Partial<Pick<Session, "modelId" | "reasoningLevel">> = {
    sessionId: SessionId.make("session-test"),
    branchId: BranchId.make("branch-test"),
    name: "Test Session",
  }
  if (state.status === "active") session = state.session
  client.applySessionSnapshot({
    sessionId: session.sessionId,
    branchId: session.branchId,
    name: session.name,
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    messages: [],
    lastEventId: Option.getOrNull(Option.none()),
    resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
    agent,
    runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
    metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
  })
}
