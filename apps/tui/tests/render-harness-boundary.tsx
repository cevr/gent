/** @jsxImportSource @opentui/solid */

import { beforeEach, afterEach } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Scope, Context, Stream } from "effect"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { RegistryProvider } from "../src/atom-solid"
import { KeyboardScopeProvider } from "../src/keyboard/context"
import { ThemeProvider } from "../src/theme"
import { CommandProvider } from "../src/command/context"
import { EnvProvider } from "../src/env/context"
import { WorkspaceProvider } from "../src/workspace/context"
import { ClientProvider } from "../src/client"
import type { DomainSession, GentNamespacedClient, GentRuntime, Session } from "../src/client"
import { ExtensionUIProvider } from "../src/extensions/context"
import { RouterProvider, Route, type AppRoute } from "../src/router"
import { ConnectionState, emptyQueueSnapshot } from "@gent/sdk"
import type { SessionRuntimeState } from "@gent/core-internal/server/transport-contract"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { AgentName } from "@gent/core-internal/domain/agent"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import type { ClientLog } from "../src/utils/client-logger"
import { AllBuiltinAgents } from "../../../packages/extensions/tests/helpers/builtin-agents.js"

const noop = () => {}
const noopLog: ClientLog = { debug: noop, info: noop, warn: noop, error: noop }

type TestRenderSetup = Awaited<ReturnType<typeof testRender>>

let currentSetup: TestRenderSetup | undefined
let sharedServices: Context.Context<unknown> | undefined
let sharedScope: Scope.Closeable | undefined
const defaultWorkspaceCwd = new URL("../../..", import.meta.url).pathname

type NamespaceOverrides = Partial<Record<string, Record<string, unknown>>>

export const createMockClient = (overrides?: NamespaceOverrides): GentNamespacedClient => {
  const noRpcError = <A,>(value: A) => Effect.succeed(value)

  const mocks: Record<string, Record<string, unknown>> = {
    session: {
      create: () =>
        noRpcError({
          sessionId: SessionId.make("session-test"),
          branchId: BranchId.make("branch-test"),
          name: "Test Session",
        }),
      list: () => noRpcError([]),
      get: () => noRpcError(null),
      delete: () => noRpcError(undefined),
      getChildren: () => noRpcError([]),
      getTree: () =>
        noRpcError({
          session: {
            id: SessionId.make("session-test"),
            activeBranchId: BranchId.make("branch-test"),
            name: "Test Session",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          children: [],
        }),
      getSnapshot: () =>
        noRpcError({
          sessionId: SessionId.make("session-test"),
          branchId: BranchId.make("branch-test"),
          messages: [],
          lastEventId: null,
          reasoningLevel: undefined,
          runtime: {
            _tag: "Idle" as const,
            agent: AgentName.make("cowork"),
            queue: emptyQueueSnapshot(),
          },
          metrics: {
            turns: 0,
            tokens: 0,
            toolCalls: 0,
            retries: 0,
            durationMs: 0,
            costUsd: 0,
            lastInputTokens: 0,
          },
        }),
      updateReasoningLevel: () => noRpcError({ reasoningLevel: undefined }),
      events: () => Stream.empty,
      watchRuntime: () => Stream.empty as Stream.Stream<SessionRuntimeState>,
    },
    branch: {
      list: () => noRpcError([]),
      create: () => noRpcError({ branchId: BranchId.make("branch-test") }),
      getTree: () => noRpcError([]),
      switch: () => noRpcError(undefined),
      fork: () => noRpcError({ branchId: BranchId.make("branch-test") }),
    },
    message: {
      send: () => noRpcError(undefined),
      list: () => noRpcError([]),
    },
    steer: {
      command: () => noRpcError(undefined),
    },
    queue: {
      drain: () => noRpcError(emptyQueueSnapshot()),
      get: () => noRpcError(emptyQueueSnapshot()),
    },
    interaction: {
      respondQuestions: () => noRpcError(undefined),
      respondPrompt: () => noRpcError(undefined),
      respondHandoff: () => noRpcError({}),
    },
    permission: {
      listRules: () => noRpcError([]),
      deleteRule: () => noRpcError(undefined),
    },
    model: {
      list: () => noRpcError([]),
    },
    driver: {
      list: () => noRpcError({ drivers: [], overrides: {}, agents: AllBuiltinAgents }),
    },
    auth: {
      listProviders: () => noRpcError([]),
      setKey: () => noRpcError(undefined),
      deleteKey: () => noRpcError(undefined),
      listMethods: () => noRpcError({}),
      authorize: () => noRpcError(null),
      callback: () => noRpcError(undefined),
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
      getContent: () => noRpcError(null),
    },
    extension: {
      request: () => noRpcError(undefined),
      listSlashCommands: () => noRpcError([]),
      listStatus: () =>
        noRpcError({
          _tag: "healthy",
          extensions: [],
        }),
    },
    actor: {
      sendUserMessage: () => noRpcError(undefined),
      sendToolResult: () => noRpcError(undefined),
      invokeTool: () => noRpcError(undefined),
      interrupt: () => noRpcError(undefined),
      getState: () => noRpcError(undefined),
      getMetrics: () => noRpcError(undefined),
    },
  }

  return new Proxy({} as GentNamespacedClient, {
    get(_target, ns: string) {
      const base = mocks[ns] ?? {}
      const extra = overrides?.[ns]
      if (extra !== undefined) return { ...base, ...extra }
      return base
    },
  })
}

export const createMockRuntime = (): GentRuntime => ({
  cast: (effect) => {
    Effect.runFork(
      effect as Effect.Effect<unknown, never, never> as Effect.Effect<void, never, never>,
    )
  },
  fork: Effect.runFork as never,
  run: Effect.runPromise as never,
  lifecycle: {
    getState: () => ConnectionState.cases.connected.make({ generation: 0 }),
    subscribe: (listener) => {
      listener(ConnectionState.cases.connected.make({ generation: 0 }))
      return () => {}
    },
    restart: Effect.void,
    waitForReady: Effect.void,
  },
})

const toInitialSession = (session: DomainSession | Session | undefined): Session | undefined => {
  if (session === undefined) return undefined
  if ("sessionId" in session) return session
  if (session.activeBranchId === undefined) return undefined
  return {
    sessionId: session.id,
    branchId: session.activeBranchId,
    name: session.name ?? "Unnamed",
    reasoningLevel: session.reasoningLevel,
  }
}

const getServices = (): Promise<Context.Context<unknown>> => {
  if (sharedServices !== undefined) return Effect.runPromise(Effect.succeed(sharedServices))
  return Effect.runPromise(
    Effect.gen(function* () {
      sharedScope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(BunServices.layer, sharedScope)
      sharedServices = Context.add(
        context,
        Scope.Scope,
        sharedScope,
      ) as unknown as Context.Context<unknown>
      return sharedServices
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
    initialRoute?: AppRoute
    width?: number
    height?: number
    cwd?: string
    /**
     * Test-only override for the platform services context (e.g. supplying
     * a `LinkOpener.Test` layer). Defaults to the shared host context.
     */
    services?: Context.Context<unknown>
  },
): Promise<TestRenderSetup> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services =
        options?.services === undefined
          ? yield* Effect.promise(() => getServices())
          : options.services
      const client = options?.client ?? createMockClient()
      const runtime = options?.runtime ?? createMockRuntime()

      const setup = yield* Effect.promise(() =>
        testRender(
          () => (
            <RegistryProvider services={services}>
              <KeyboardScopeProvider>
                <ThemeProvider mode="dark">
                  <EnvProvider env={{ visual: undefined, editor: undefined, shutdown: () => {} }}>
                    <CommandProvider>
                      <RouterProvider
                        initialRoute={
                          options?.initialRoute ??
                          Route.session(
                            SessionId.make("test-session"),
                            BranchId.make("test-branch"),
                          )
                        }
                      >
                        <WorkspaceProvider
                          cwd={options?.cwd ?? defaultWorkspaceCwd}
                          home="/tmp"
                          services={services}
                        >
                          <ClientProvider
                            client={client}
                            runtime={runtime}
                            services={services}
                            log={noopLog}
                            initialSession={toInitialSession(options?.initialSession)}
                            initialAgent={options?.initialAgent}
                          >
                            <ExtensionUIProvider>{node()}</ExtensionUIProvider>
                          </ClientProvider>
                        </WorkspaceProvider>
                      </RouterProvider>
                    </CommandProvider>
                  </EnvProvider>
                </ThemeProvider>
              </KeyboardScopeProvider>
            </RegistryProvider>
          ),
          {
            width: options?.width ?? 80,
            height: options?.height ?? 24,
          },
        ),
      )
      currentSetup = setup
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      return setup
    }),
  )

export const renderFrame = (setup: TestRenderSetup) =>
  setup.captureCharFrame().replaceAll("\u00a0", " ")

export const destroyRenderSetup = (setup: TestRenderSetup) => {
  if (currentSetup === setup) currentSetup = undefined
  setup.renderer.destroy()
}

beforeEach(() => {
  currentSetup = undefined
})

afterEach(() => {
  if (currentSetup !== undefined) destroyRenderSetup(currentSetup)
  currentSetup = undefined
})
