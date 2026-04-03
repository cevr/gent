/** @jsxImportSource @opentui/solid */

import { beforeEach, afterEach } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Scope, ServiceMap, Stream } from "effect"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { RegistryProvider } from "../src/atom-solid"
import { KeyboardScopeProvider } from "../src/keyboard/context"
import { ThemeProvider } from "../src/theme"
import { CommandProvider } from "../src/command"
import { EnvProvider } from "../src/env/context"
import { WorkspaceProvider } from "../src/workspace"
import { ClientProvider } from "../src/client"
import type { GentNamespacedClient, GentRuntime, Session } from "../src/client"
import { ExtensionUIProvider } from "../src/extensions/context"
import { RouterProvider, Route, type AppRoute } from "../src/router"
import type { SessionInfo, SessionRuntime } from "@gent/sdk"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { AgentName } from "@gent/core/domain/agent"
import type { ClientLog } from "../src/utils/client-logger"

const noop = () => {}
const noopLog: ClientLog = { debug: noop, info: noop, warn: noop, error: noop }

type TestRenderSetup = Awaited<ReturnType<typeof testRender>>

let currentSetup: TestRenderSetup | undefined
let sharedServices: ServiceMap.ServiceMap<unknown> | undefined
let sharedScope: Scope.Closeable | undefined
const defaultWorkspaceCwd = new URL("../../..", import.meta.url).pathname

type NamespaceOverrides = Partial<Record<string, Record<string, unknown>>>

export const createMockClient = (overrides?: NamespaceOverrides): GentNamespacedClient => {
  const noRpcError = <A,>(value: A) => Effect.succeed(value)

  const mocks: Record<string, Record<string, unknown>> = {
    session: {
      create: () =>
        noRpcError({
          sessionId: "session-test" as SessionId,
          branchId: "branch-test" as BranchId,
          name: "Test Session",
        }),
      list: () => noRpcError([]),
      get: () => noRpcError(null),
      delete: () => noRpcError(undefined),
      getChildren: () => noRpcError([]),
      getTree: () => noRpcError({ id: "session-test", name: "Test Session", children: [] }),
      getSnapshot: () =>
        noRpcError({
          sessionId: "session-test" as SessionId,
          branchId: "branch-test" as BranchId,
          messages: [],
          lastEventId: null,
          reasoningLevel: undefined,
        }),
      updateReasoningLevel: () => noRpcError({ reasoningLevel: undefined }),
      events: () => Stream.empty,
      watchRuntime: () => Stream.empty as Stream.Stream<SessionRuntime>,
    },
    branch: {
      list: () => noRpcError([]),
      create: () => noRpcError({ branchId: "branch-test" as BranchId }),
      getTree: () => noRpcError([]),
      switch: () => noRpcError(undefined),
      fork: () => noRpcError({ branchId: "branch-test" as BranchId }),
    },
    message: {
      send: () => noRpcError(undefined),
      list: () => noRpcError([]),
    },
    steer: {
      command: () => noRpcError(undefined),
    },
    queue: {
      drain: () => noRpcError({ steering: [], followUp: [] }),
      get: () => noRpcError({ steering: [], followUp: [] }),
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
      send: () => noRpcError(undefined),
      ask: () => noRpcError(undefined),
      listStatus: () =>
        noRpcError({
          extensions: [],
          summary: {
            status: "healthy" as const,
            failedExtensions: [],
            failedActors: [],
            failedScheduledJobs: [],
          },
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
    Effect.runFork(effect)
  },
  fork: Effect.runFork as never,
  run: Effect.runPromise as never,
  lifecycle: {
    getState: () => ({ _tag: "connected" as const, generation: 0 }),
    subscribe: (listener) => {
      listener({ _tag: "connected", generation: 0 })
      return () => {}
    },
    restart: Effect.void,
    waitForReady: Effect.void,
  },
})

const toInitialSession = (session: SessionInfo | Session | undefined): Session | undefined => {
  if (session === undefined) return undefined
  if ("sessionId" in session) return session
  if (session.branchId === undefined) return undefined
  return {
    sessionId: session.id,
    branchId: session.branchId,
    name: session.name ?? "Unnamed",
    reasoningLevel: session.reasoningLevel,
  }
}

const getServices = async () => {
  if (sharedServices !== undefined) return sharedServices
  sharedScope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(BunServices.layer, sharedScope))
  sharedServices = ServiceMap.add(context, Scope.Scope, sharedScope)
  return sharedServices
}

export const renderWithProviders = async (
  node: () => JSX.Element,
  options?: {
    client?: GentNamespacedClient
    runtime?: GentRuntime
    initialSession?: SessionInfo
    initialAgent?: AgentName
    initialRoute?: AppRoute
    width?: number
    height?: number
    cwd?: string
  },
) => {
  const services = await getServices()
  const client = options?.client ?? createMockClient()
  const runtime = options?.runtime ?? createMockRuntime()

  currentSetup = await testRender(
    () => (
      <RegistryProvider services={services}>
        <KeyboardScopeProvider>
          <ThemeProvider mode="dark">
            <EnvProvider env={{ visual: undefined, editor: undefined }}>
              <CommandProvider>
                <RouterProvider
                  initialRoute={
                    options?.initialRoute ??
                    Route.session("test-session" as SessionId, "test-branch" as BranchId)
                  }
                >
                  <ClientProvider
                    client={client}
                    runtime={runtime}
                    log={noopLog}
                    initialSession={toInitialSession(options?.initialSession)}
                    initialAgent={options?.initialAgent}
                  >
                    <WorkspaceProvider
                      cwd={options?.cwd ?? defaultWorkspaceCwd}
                      services={services}
                    >
                      <ExtensionUIProvider>{node()}</ExtensionUIProvider>
                    </WorkspaceProvider>
                  </ClientProvider>
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
  )

  await currentSetup.renderOnce()
  await Promise.resolve()
  await currentSetup.renderOnce()
  return currentSetup
}

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
