/** @jsxImportSource @opentui/solid */

import { afterEach } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, Option, Scope, Stream } from "effect"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import type { JSX } from "solid-js"
import { KeyboardScopeProvider } from "../src/keyboard/context"
import { ThemeProvider } from "../src/theme"
import { CommandProvider } from "../src/command/context"
import { EnvProvider } from "../src/env/context"
import { WorkspaceProvider } from "../src/workspace/context"
import { ClientProvider } from "../src/client"
import type { Session as DomainSession, GentNamespacedClient, GentRuntime } from "@gent/sdk"
import type { Session } from "../src/client"
import { ExtensionUIProvider } from "../src/extensions/context"
import { TerminalDimensionsProvider } from "../src/terminal-dimensions"
import { ComposerDraftsProvider } from "../src/components/composer-drafts"
import { SessionShellProvider } from "../src/session-shell"
import { ConnectionState, emptyQueueSnapshot } from "@gent/sdk"
import type { SessionRuntimeState } from "@gent/core-internal/server/transport-contract"
import { AgentName, BranchId, ModelId, SessionId } from "@gent/core/protocol"
import type { ClientLog } from "../src/utils/client-logger"
import { AllBuiltinAgents } from "../../../packages/extensions/tests/helpers/builtin-agents.js"

const noop = () => {}
const noopLog: ClientLog = { debug: noop, info: noop, warn: noop, error: noop }

type TestRenderSetup = Awaited<ReturnType<typeof createTestRenderer>>

let currentSetup: Option.Option<TestRenderSetup> = Option.none()
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
          runtime: {
            _tag: "Idle",
            agent: AgentName.make("cowork"),
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
      events: () => Stream.empty,
      watchRuntime: () => Stream.fromIterable<SessionRuntimeState>([]),
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
      list: () => noRpcError({ drivers: [], overrides: {}, agents: AllBuiltinAgents }),
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
          _tag: "healthy",
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

  // eslint-disable-next-line effect/noAs -- Proxy keys are runtime namespace names; the mock preserves the typed client surface used by render tests.
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
    getState: () => ConnectionState.cases.connected.make({ generation: 0 }),
    subscribe: (listener) => {
      listener(ConnectionState.cases.connected.make({ generation: 0 }))
      return () => {}
    },
    restart: Effect.void,
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
              <ComposerDraftsProvider>
                <KeyboardScopeProvider>
                  <ThemeProvider mode="dark">
                    <EnvProvider
                      env={{ visual: Option.none(), editor: Option.none(), shutdown: () => {} }}
                    >
                      <CommandProvider>
                        <SessionShellProvider
                          initialPrompt={Option.getOrElse(
                            Option.fromNullishOr(options?.initialPrompt),
                            () => Option.none<string>(),
                          )}
                          initialSessionId={Option.map(
                            toInitialSession(Option.fromNullishOr(options?.initialSession)),
                            (session) => session.sessionId,
                          )}
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
                              initialSession={Option.getOrUndefined(
                                toInitialSession(Option.fromNullishOr(options?.initialSession)),
                              )}
                              initialAgent={options?.initialAgent}
                            >
                              <ExtensionUIProvider>{node()}</ExtensionUIProvider>
                            </ClientProvider>
                          </WorkspaceProvider>
                        </SessionShellProvider>
                      </CommandProvider>
                    </EnvProvider>
                  </ThemeProvider>
                </KeyboardScopeProvider>
              </ComposerDraftsProvider>
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

// eslint-disable-next-line effect/noTestLifecycleHooks -- OpenTUI renderers require synchronous per-test teardown at this shared test boundary.
afterEach(() => {
  if (Option.isSome(currentSetup)) destroyRenderSetup(currentSetup.value)
  currentSetup = Option.none()
})
