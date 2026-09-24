/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Cause, Deferred, Effect, Exit, Option, Schema, Stream } from "effect"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { SocketCloseError } from "effect/unstable/socket/Socket"
import {
  AgentName,
  BranchId,
  dateFromMillis,
  DEFAULT_AGENT_NAME,
  GentRpcError,
  MessageId,
  ModelId,
  ProviderId,
  Session,
  SessionId,
  ConnectionState,
  type ExtensionHealthSnapshot,
  type GentClientRpcError,
  type QueueEntryInfo,
} from "@gent/core/protocol"
import { emptyQueueSnapshot } from "@gent/core/test-utils"
import { Gent, type GentRuntime } from "@gent/sdk"
import {
  App,
  AppBootstrapError,
  ConnectionWidget,
  type InitialState,
  QueueWidget,
  resolveInitialState,
  resolveStartupAuthState,
} from "../src/app"
import {
  createMockClient,
  createMockRuntime,
  renderFrame,
  renderWithProviders,
  applySnapshotAgent,
} from "./render-harness-boundary"
import { onMount } from "solid-js"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { type ClientContextValue, useClient } from "../src/client"
import { waitForFrame } from "./helpers-boundary"
import { useTerminalDimensions } from "../src/terminal"
import { SyntaxStyle } from "@opentui/core"
import { type Message, MessageList, type SessionItem } from "../src/message-list"
import { useExtensionUI } from "../src/extensions/host"
import { builtinClientModules } from "../src/extensions/builtins"
import {
  ClientContext,
  clientContributions,
  defineClientExtension,
} from "../src/extensions/client-facets"

// ── app bootstrap ───────────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())
const idleTag = "Idle" satisfies "Idle"
const refusedInA = Schema.decodeSync(GentRpcError)({
  _tag: "InvalidStateError",
  message: "send refused in A",
})
const noAuthSource = "none" satisfies "none"

const expectAppBootstrapFailure = (
  effect: Effect.Effect<unknown, AppBootstrapError | GentClientRpcError>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return yield* Effect.die("expected app bootstrap failure")
    const reason = Option.fromUndefinedOr(exit.cause.reasons.find(Cause.isFailReason))
    if (Option.isNone(reason) || !Schema.is(AppBootstrapError)(reason.value.error)) {
      return yield* Effect.die("expected AppBootstrapError")
    }
    return reason.value.error
  })

describe("resolveStartupAuthState", () => {
  it.live("uses the session snapshot agent for interactive startup", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("deepwork"),
              runtime: {
                _tag: idleTag,
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
            ])
          },
        },
      })
      const state: InitialState = {
        _tag: "session",
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
      })
      expect(auth.initialAgent).toBe(AgentName.make("deepwork"))
      expect(auth.missingProviders).toEqual([ProviderId.make("openai")])
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("a headless session checks auth for the agent it was created with", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("deepwork"),
              runtime: {
                _tag: idleTag,
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
      })
      const state: InitialState = {
        _tag: "headless",
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
        prompt: "hi",
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
      })
      expect(auth.initialAgent).toBeUndefined()
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("a session with no branch yet checks auth for the default agent", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
      })
      const state: InitialState = {
        _tag: "session",
        session: {
          id: SessionId.make("session-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
      })
      expect(auth.initialAgent).toBe(DEFAULT_AGENT_NAME)
      expect(calls).toEqual([
        { agentName: DEFAULT_AGENT_NAME, sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("skips pre-auth gating while the user is choosing a branch", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) =>
            Effect.sync(() => {
              calls.push(input)
              return []
            }),
        },
      })
      const state: InitialState = {
        _tag: "branchPicker",
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
        branches: [
          {
            id: BranchId.make("branch-a"),
            sessionId: SessionId.make("session-a"),
            createdAt: dateFromMillis(0),
          },
          {
            id: BranchId.make("branch-b"),
            sessionId: SessionId.make("session-a"),
            createdAt: dateFromMillis(1),
          },
        ],
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
      })
      expect(auth.initialAgent).toBeUndefined()
      expect(auth.missingProviders).toEqual([])
      expect(calls).toEqual([])
    }),
  )
})

describe("resolveInitialState", () => {
  it.live("fails with typed bootstrap error when headless prompt is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.none(),
          continue_: false,
          headless: true,
          prompt: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }),
  )

  // The composer sends nothing for a blank draft; headless holds the same line.
  it.live("a whitespace-only headless prompt is a missing prompt", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.none(),
          continue_: false,
          headless: true,
          prompt: Option.none(),
          promptArg: Option.some(" \n\t "),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }),
  )

  it.live("a new headless session is created as the requested agent and run spec", () =>
    Effect.gen(function* () {
      const created: Array<{ readonly admission?: unknown }> = []
      const session = new Session({
        id: SessionId.make("session-test"),
        activeBranchId: BranchId.make("branch-test"),
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(0),
      })
      const admission = {
        agent: AgentName.make("deepwork"),
        runSpec: { overrides: { maxSteps: 3 } },
      }
      const state = yield* resolveInitialState({
        client: createMockClient({
          session: {
            create: (input: { readonly admission?: unknown }) =>
              Effect.sync(() => {
                created.push(input)
                return {
                  sessionId: session.id,
                  branchId: BranchId.make("branch-test"),
                  name: "Test Session",
                }
              }),
            get: () => Effect.succeed(session),
          },
        }),
        cwd: "/tmp",
        session: Option.none(),
        continue_: false,
        headless: true,
        prompt: Option.none(),
        promptArg: Option.some("hi"),
        admission,
      })
      expect(state).toMatchObject({ _tag: "headless", session: { id: "session-test" } })
      // The agent is fixed on the session; the prompt's turn carries none.
      expect(created.map((input) => input.admission)).toEqual([admission])
    }),
  )

  it.live("fails with typed bootstrap error when requested session is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.some("missing-session"),
          continue_: false,
          headless: false,
          prompt: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("session-not-found")
      expect(error.sessionId).toBe(SessionId.make("missing-session"))
    }),
  )
  it.live("resume opens the user's last session, not a child a delegate spawned later", () =>
    Effect.gen(function* () {
      const at = (ms: number) => dateFromMillis(1_767_225_600_000 + ms)
      const root = new Session({
        id: SessionId.make("root"),
        cwd: "/work",
        threadId: SessionId.make("root"),
        createdAt: at(0),
        updatedAt: at(10),
      })
      // A handoff continues the user's thread, so it is the session to reopen.
      const handoff = new Session({
        id: SessionId.make("handoff"),
        cwd: "/work",
        parentSessionId: root.id,
        threadId: root.id,
        createdAt: at(20),
        updatedAt: at(30),
      })
      // A delegate child starts its own thread and finishes last.
      const child = new Session({
        id: SessionId.make("child"),
        cwd: "/work",
        parentSessionId: handoff.id,
        threadId: SessionId.make("child"),
        createdAt: at(40),
        updatedAt: at(50),
      })
      const state = yield* resolveInitialState({
        client: createMockClient({
          session: { list: () => Effect.succeed([child, root, handoff]) },
        }),
        cwd: "/work",
        session: Option.none(),
        continue_: true,
        headless: false,
        prompt: Option.none(),
        promptArg: Option.none(),
      })
      expect(state).toMatchObject({ _tag: "session", session: { id: "handoff" } })
    }),
  )
})

// ── app auth ────────────────────────────────────────────────────────────────

class MessageTimeoutError extends Schema.TaggedError<MessageTimeoutError>()("MessageTimeoutError", {
  message: Schema.String,
}) {}

const apiMethod = { label: "API key", type: "api" } satisfies { label: string; type: "api" }

const authSource = (hasKey: boolean): "stored" | "none" => {
  if (hasKey) return "stored"
  return "none"
}

const requireClient = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, MessageTimeoutError> => {
  if (Option.isNone(context)) {
    return Effect.fail(new MessageTimeoutError({ message: "client context not ready" }))
  }
  return Effect.succeed(context.value)
}

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

/**
 * The session view over a turn that runs, with an error on screen from a
 * `/model` that matched nothing. The runtime stream says Running once and then
 * stays quiet, as it does through a long generation or a long tool call.
 */
const mountRunningTurnWithError = Effect.gen(function* () {
  const sessionId = SessionId.make("session-running")
  const branchId = BranchId.make("branch-running")
  const running = { _tag: "Running" satisfies "Running", queue: emptyQueueSnapshot() }
  const steers: Array<string> = []
  const sent: Array<string> = []
  let shutdowns = 0
  let readActivity = () => "unmounted"
  const activityProbe = defineClientExtension("@test/activity-probe", {
    setup: Effect.gen(function* () {
      const { activity } = yield* ClientContext
      readActivity = () => activity.snapshot().state
      return clientContributions()
    }),
  })
  const client = createMockClient({
    auth: { listProviders: () => Effect.succeed([]) },
    branch: { getTree: () => Effect.succeed([]) },
    session: {
      getSnapshot: () =>
        Effect.succeed({
          sessionId,
          branchId,
          messages: [],
          lastEventId: nullValue,
          reasoningLevel: absent,
          resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
          agent: AgentName.make("main"),
          runtime: running,
          metrics: { turns: 1, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
        }),
      watchRuntime: () => Stream.concat(Stream.make(running), Stream.never),
    },
    steer: {
      command: (input: { readonly command: { readonly _tag: string } }) =>
        Effect.sync(() => {
          steers.push(input.command._tag)
        }),
    },
    message: {
      send: (input: { readonly content: string }) =>
        Effect.sync(() => {
          sent.push(input.content)
        }),
    },
  })
  let ctx = Option.none<ClientContextValue>()
  const setup = yield* Effect.promise(() =>
    renderWithProviders(
      () => (
        <>
          <App missingAuthProviders={[]} />
          <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
        </>
      ),
      {
        client,
        runtime: createMockRuntime(),
        builtins: [...builtinClientModules, activityProbe],
        initialSession: {
          id: sessionId,
          activeBranchId: branchId,
          name: "Running",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      },
    ),
  )
  setup.renderer.destroy = () => {
    shutdowns += 1
  }
  yield* waitForFrame(
    setup,
    () => ctx.pipe(Option.exists((value) => value.isStreaming())),
    "running turn",
  )
  yield* waitForFrame(setup, () => readActivity() !== "unmounted", "activity probe loaded")
  yield* Effect.promise(() => setup.mockInput.typeText("/model typo"))
  setup.mockInput.pressEnter()
  yield* waitForFrame(setup, (frame) => frame.includes("No model matches"), "error shown")
  const clientValue = yield* requireClient(ctx)
  return {
    setup,
    client: clientValue,
    steers,
    sent,
    shutdowns: () => shutdowns,
    activity: () => readActivity(),
  }
})

function ExtensionUIProbe(props: {
  readonly onReady: (ext: ReturnType<typeof useExtensionUI>) => void
}) {
  const ext = useExtensionUI()
  onMount(() => {
    props.onReady(ext)
  })
  return <box />
}

function TerminalDimensionsProbe() {
  const dimensions = useTerminalDimensions()
  return <text>{`${dimensions().width}x${dimensions().height}`}</text>
}

describe("App auth gate", () => {
  it.live("shares one terminal resize source across App and cleans it up", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <TerminalDimensionsProbe />
            </>
          ),
          {
            initialSession: {
              id: SessionId.make("session-resize"),
              activeBranchId: BranchId.make("branch-resize"),
              name: "Resize",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      expect(setup.renderer.listenerCount("resize")).toBe(1)
      expect(renderFrame(setup)).toContain("80x24")

      setup.renderer.resize(100, 30)
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("100x30")

      setup.renderer.destroy()
      expect(setup.renderer.listenerCount("resize")).toBe(0)
    }),
  )

  it.live("rechecks auth requirements when the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const calls: Array<{
        agentName?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            calls.push(input)
            if (input.agentName === "deepwork") {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: true,
                  source: "none",
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("API Keys"),
        "API Keys after agent switch",
      )
      expect(calls.length).toBeGreaterThan(0)
      expect(frame).toContain("API Keys")
      setup.renderer.destroy()
    }),
  )
  it.live("seeds startup auth gating from the initial selected agent", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string; sessionId?: string }) => {
            calls.push(input)
            if (input.agentName === "deepwork") {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: true,
                  source: "none",
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={["openai"]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("deepwork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("API Keys"),
        "API Keys from initial agent",
      )
      // The auth check names the session that is actually mounted. It used to
      // name the route's session instead, which the harness could set to a
      // different id than the one the client held.
      expect(calls[0]).toEqual({
        agentName: AgentName.make("deepwork"),
        sessionId: SessionId.make("session-a"),
      })
      // The gate opens the auth overlay itself, and the branch picker is read
      // off that same overlay. A gate that re-ran on its own write would keep
      // checking; it settles instead. (Two checks: the agent arrives after the
      // first, which predates the overlay being the picker's owner.)
      expect(calls.length).toBe(2)
      expect(frame).toContain("API Keys")
      setup.renderer.destroy()
    }),
  )
  it.live("a send refused after a switch waits in its own session, draft and reason both", () =>
    Effect.gen(function* () {
      // The reader sends in A and moves to B before A's server answers. The
      // refusal belongs to A: B shows none of it, and A has both on return.
      const sessionA = SessionId.make("session-a")
      const branchA = BranchId.make("branch-a")
      const sessionB = SessionId.make("session-b")
      const branchB = BranchId.make("branch-b")
      const sentOut = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
        session: {
          getSnapshot: (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
            Effect.succeed({
              sessionId: input.sessionId,
              branchId: input.branchId,
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("cowork"),
              runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
              metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
            }),
        },
        message: {
          send: () =>
            Deferred.complete(sentOut, Effect.void).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.andThen(Effect.fail(refusedInA)),
              Effect.ensuring(Deferred.complete(answered, Effect.void)),
            ),
        },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialSession: {
              id: sessionA,
              activeBranchId: branchA,
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session A")
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      const clientCtx = ctx.value
      yield* Effect.promise(() => setup.mockInput.typeText("keep me in A"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Deferred.await(sentOut)
      clientCtx.switchSession(sessionB, branchB, "Session B")
      yield* waitForFrame(
        setup,
        () => Option.exists(clientCtx.sessionIdentity(), (s) => s.sessionId === sessionB),
        "session B",
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session B view")
      yield* Deferred.complete(answer, Effect.void)
      yield* Deferred.await(answered)
      // A few frames for anything the refusal would draw in B.
      for (let frame = 0; frame < 3; frame++) {
        yield* Effect.yieldNow
        yield* Effect.promise(() => setup.renderOnce())
      }
      const inB = renderFrame(setup)
      expect(inB).not.toContain("send refused in A")
      expect(inB).not.toContain("keep me in A")
      expect(clientCtx.error()).toBeNull()
      clientCtx.switchSession(sessionA, branchA, "Session A")
      yield* waitForFrame(setup, (frame) => frame.includes("keep me in A"), "draft back in A")
      yield* waitForFrame(setup, (frame) => frame.includes("send refused in A"), "reason in A")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("the startup prompt belongs to the boot session, not the next one", () =>
    Effect.gen(function* () {
      // The boot picker re-mounts the session view on the chosen branch, so
      // the prompt has to outlive one mount. A session the reader opens after
      // that is a different session and must start empty.
      const bootSessionId = SessionId.make("session-boot")
      const bootBranchId = BranchId.make("branch-boot")
      const nextSessionId = SessionId.make("session-next")
      const nextBranchId = BranchId.make("branch-next")
      const startupPrompt = "only for the boot session"
      const sentMessages: Array<{ sessionId: SessionId; content: string }> = []
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        session: {
          create: () =>
            Effect.succeed({
              sessionId: nextSessionId,
              branchId: nextBranchId,
              name: "Next",
            }),
        },
        message: {
          send: (input: { readonly sessionId: SessionId; readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialPrompt: Option.some(startupPrompt),
            initialSession: {
              id: bootSessionId,
              activeBranchId: bootBranchId,
              name: "Boot",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === startupPrompt),
        "sent message",
      )
      expect(sentMessages).toHaveLength(1)
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      ctx.value.createSession()
      yield* waitForFrame(
        setup,
        () => ctx.pipe(Option.exists((value) => value.session()?.sessionId === nextSessionId)),
        "next session mounted",
      )
      // Several frames for the new session's feed to settle.
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages.filter((message) => message.sessionId === nextSessionId)).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("opening the palette between two escapes does not quit", () =>
    Effect.gen(function* () {
      let shutdowns = 0
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime: createMockRuntime(),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "Session A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      // One escape arms the quit; the palette keybind disarms it, and an escape closes the palette.
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("Commands"), "palette")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !frame.includes("Commands"), "palette closed")
      // The quit is disarmed, so this escape only arms it again.
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow the escape must be parsed and handled before the negative assertion
      yield* Effect.sleep("100 millis")
      expect(shutdowns).toBe(0)
      // A second escape in the window quits.
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => shutdowns > 0, "quit")
      setup.renderer.destroy = destroy
      expect(shutdowns).toBe(1)
      setup.renderer.destroy()
    }),
  )
  it.live("an error shown during a running turn leaves the turn running", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      expect(view.client.isStreaming()).toBe(true)
      expect(view.client.error()).toBe('No model matches "typo"')
      expect(view.activity()).toBe("working")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("escape cancels a running turn while an error shows, and never quits", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "first cancel")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, () => view.steers.length === 2, "second cancel")
      expect(view.steers).toEqual(["Cancel", "Cancel"])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("ctrl+c with an empty draft cancels a running turn while an error shows", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      expect(view.steers).toEqual(["Cancel"])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("an interjection steers a running turn while an error shows", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      yield* Effect.promise(() => view.setup.mockInput.typeText("steer this"))
      view.setup.mockInput.pressEnter({ meta: true })
      yield* waitForFrame(
        view.setup,
        () => view.steers.length + view.sent.length === 1,
        "interjection",
      )
      expect(view.steers).toEqual(["Interject"])
      expect(view.sent).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("escape in the boot branch picker quits, because no branch was chosen", () =>
    Effect.gen(function* () {
      // The picker is where a resumed multi-branch session starts. With no
      // branch chosen there is nothing behind it to fall back to, so escape
      // has to leave the program, not just close the pane.
      let shutdowns = 0
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <App
              missingAuthProviders={[]}
              initialBranches={Option.some([
                {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  name: "main",
                  createdAt: dateFromMillis(0),
                },
                {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  name: "side",
                  createdAt: dateFromMillis(1),
                },
              ])}
            />
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("Resume: Session A"), "picker")
      // `useEnv().shutdown` is a no-op in the harness, so observe the renderer
      // teardown the controller performs alongside it.
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => shutdowns > 0, "quit")
      setup.renderer.destroy = destroy
      expect(shutdowns).toBe(1)
      setup.renderer.destroy()
    }),
  )
  it.live("branch picker does not trigger auth gating before a branch is selected", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
        branch: {
          getTree: () =>
            Effect.succeed([
              {
                branch: {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  name: "Main",
                  createdAt: dateFromMillis(0),
                },
                messageCount: 3,
                children: [],
              },
              {
                branch: {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  name: "Side",
                  createdAt: dateFromMillis(1),
                },
                messageCount: 1,
                children: [],
              },
            ]),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <App
              missingAuthProviders={[]}
              initialBranches={Option.some([
                {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  createdAt: dateFromMillis(0),
                },
                {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  createdAt: dateFromMillis(1),
                },
              ])}
            />
          ),
          {
            client,
            runtime,
            // An agent is what makes the auth check runnable at all. Without one
            // the gate short-circuits before it reads the picker, and this test
            // proves nothing.
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker")
      expect(calls).toEqual([])

      // Choosing a branch closes the picker, and only then does the gate run.
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(calls.map((call) => call.agentName)).toEqual(["cowork"])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt and missing auth defers the prompt until auth resolves", () =>
    Effect.gen(function* () {
      const providersDeferred = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: typeof absent
        }>
      >()
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () => Deferred.await(providersDeferred),
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={["openai"]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("build a feature"),
        }),
      )
      // Auth is pending — prompt must not be sent yet
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      // Resolve auth — keys are required but missing
      yield* Deferred.succeed(providersDeferred, [
        {
          provider: "openai",
          hasKey: false,
          required: true,
          source: "none",
          authType: absent,
        },
      ])
      // Auth overlay should appear
      const authFrame = yield* waitForFrame(
        setup,
        (next) => next.includes("API Keys"),
        "auth overlay",
      )
      expect(authFrame).toContain("API Keys")
      // Prompt still not sent while auth overlay is open
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt does not continue when auth checking fails", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(new ProviderAuthError({ message: "session auth lookup failed" })),
              ),
            ),
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("must not send"),
        }),
      )
      yield* waitForFrame(setup, () => authChecks > 0, "auth check failure")
      // gent/no-sleep: allow real-clock gap so any spurious send fiber has time to surface (negative assertion follows)
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt recovers after a transient auth check failure", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                (() => {
                  if (authChecks === 1) {
                    return Effect.fail(
                      new ProviderAuthError({ message: "temporary auth lookup failed" }),
                    )
                  }
                  return Effect.succeed([])
                })(),
              ),
            ),
          listMethods: () => Effect.succeed({}),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("send after retry"),
        }),
      )
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === "send after retry"),
        "sent message",
      )
      expect(authChecks).toBeGreaterThan(1)
      setup.renderer.destroy()
    }),
  )
  it.live("enforced auth overlay can retry failed provider loads", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                (() => {
                  if (authChecks < 3) {
                    return Effect.fail(
                      new ProviderAuthError({ message: "temporary auth lookup failed" }),
                    )
                  }
                  return Effect.succeed([])
                })(),
              ),
            ),
          listMethods: () => Effect.succeed({}),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes("temporary auth lookup failed") && frame.includes("Press r to retry"),
        "retryable auth error",
      )
      setup.mockInput.pressKey("r")
      yield* waitForFrame(setup, (frame) => !frame.includes("API Keys"), "auth retry resolved")
      expect(authChecks).toBe(3)
      setup.renderer.destroy()
    }),
  )
  it.live("branch resume pane gates auth, sends deferred prompt, and searches prompt history", () =>
    Effect.gen(function* () {
      let hasOpenAiKey = false
      let initialAuthCheckResolved = false
      const initialAuthCheck = yield* Deferred.make<void>()
      const sentMessages: Array<{
        sessionId: SessionId
        branchId: BranchId
        content: string
        requestId: string
      }> = []
      const alphaSessionId = SessionId.make("session-alpha")
      const alphaBranchId = BranchId.make("branch-alpha")
      const betaBranchId = BranchId.make("branch-beta")
      const initialPrompt = "deferred route-flow prompt"
      const historyPrompt = "resume prompt search route flow"
      const client = createMockClient({
        session: {
          getSnapshot: ({
            sessionId,
            branchId,
          }: {
            readonly sessionId: SessionId
            readonly branchId: BranchId
          }) =>
            Effect.succeed({
              sessionId,
              branchId,
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: "cowork",
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
        },
        branch: {
          getTree: () =>
            Effect.succeed([
              {
                branch: {
                  id: alphaBranchId,
                  sessionId: alphaSessionId,
                  name: "Main",
                  createdAt: dateFromMillis(0),
                },
                messageCount: 3,
                children: [],
              },
              {
                branch: {
                  id: betaBranchId,
                  sessionId: alphaSessionId,
                  name: "Side",
                  createdAt: dateFromMillis(1),
                },
                messageCount: 1,
                children: [],
              },
            ]),
        },
        auth: {
          listProviders: () => {
            const providers = [
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: authSource(hasOpenAiKey),
                authType: absent,
              },
            ]
            if (hasOpenAiKey || initialAuthCheckResolved) return Effect.succeed(providers)
            return Deferred.await(initialAuthCheck).pipe(Effect.as(providers))
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
          setKey: ({ key }: { readonly key: string }) =>
            Effect.sync(() => {
              hasOpenAiKey = key.length > 0
            }),
        },
        message: {
          send: (input: {
            readonly sessionId: SessionId
            readonly branchId: BranchId
            readonly content: string
            readonly requestId: string
          }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App
                missingAuthProviders={[]}
                initialBranches={Option.some([
                  {
                    id: alphaBranchId,
                    sessionId: alphaSessionId,
                    name: "Main",
                    createdAt: dateFromMillis(0),
                  },
                  {
                    id: betaBranchId,
                    sessionId: alphaSessionId,
                    name: "Side",
                    createdAt: dateFromMillis(1),
                  },
                ])}
              />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: alphaSessionId,
              activeBranchId: alphaBranchId,
              name: "Alpha",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(1),
            },
            initialPrompt: Option.some(initialPrompt),
            width: 100,
            height: 30,
          },
        ),
      )
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Resume: Alpha") && frame.includes("Side (1)"),
        "branch picker",
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      initialAuthCheckResolved = true
      yield* Deferred.succeed(initialAuthCheck, void 0)
      yield* waitForFrame(setup, (frame) => frame.includes("API Keys"), "auth gate")
      expect(sentMessages).toEqual([])
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Enter API key for openai"),
        "openai key input",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("API Keys"), "auth overlay closed")
      expect(hasOpenAiKey).toBe(true)
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      expect(sentMessages.find((message) => message.content === initialPrompt)).toMatchObject({
        sessionId: alphaSessionId,
        branchId: betaBranchId,
      })
      yield* Effect.promise(() => setup.mockInput.typeText(historyPrompt))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === historyPrompt),
        "sent message",
      )
      setup.mockInput.pressKey("r", { ctrl: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Prompt Search") && frame.includes(historyPrompt),
        "prompt search history",
      )
      setup.mockInput.pressEscape()
      yield* waitForFrame(
        setup,
        (frame) => !frame.includes("Prompt Search"),
        "prompt search closed",
      )
      setup.renderer.destroy()
    }),
  )
  it.live("stale auth checks cannot reopen the auth gate after key save", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let hasOpenAiKey = false
      let sessionAuthChecks = 0
      const staleSessionCheck = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: typeof absent
        }>
      >()
      const sentMessages: Array<{
        content: string
      }> = []
      const initialPrompt = "stale auth race prompt"
      const client = createMockClient({
        auth: {
          listProviders: (input: {
            readonly sessionId?: SessionId
            readonly agentName?: string
          }) => {
            const sessionId = Option.fromNullishOr(input.sessionId)
            if (Option.isSome(sessionId)) {
              sessionAuthChecks++
              if (sessionAuthChecks === 1) {
                return Effect.succeed([
                  {
                    provider: "openai",
                    hasKey: false,
                    required: true,
                    source: authSource(false),
                    authType: absent,
                  },
                ])
              }
              if (sessionAuthChecks === 2) return Deferred.await(staleSessionCheck)
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: hasOpenAiKey,
                  required: true,
                  source: authSource(hasOpenAiKey),
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: authSource(hasOpenAiKey),
                authType: absent,
              },
            ])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
          setKey: ({ key }: { readonly key: string }) =>
            Effect.sync(() => {
              hasOpenAiKey = key.length > 0
            }),
        },
        message: {
          send: (input: { readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={["openai"]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
            width: 100,
            height: 30,
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* waitForFrame(setup, (frame) => frame.includes("API Keys"), "auth gate")
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      yield* waitForFrame(setup, () => sessionAuthChecks >= 2, "stale session auth check started")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Enter API key for openai"),
        "openai key input",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("API Keys"), "auth resolved")
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      yield* Deferred.succeed(staleSessionCheck, [
        {
          provider: "openai",
          hasKey: false,
          required: true,
          source: "none",
          authType: absent,
        },
      ])
      // gent/no-sleep: allow real-clock gap so the resumed-send fiber resolves before assertion
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("API Keys")
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
      setup.renderer.destroy()
    }),
  )
  it.live("a renamed session keeps its view and does not send the startup prompt again", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const sentMessages: Array<{ readonly content: string }> = []
      const initialPrompt = "send me once"
      const client = createMockClient({
        message: {
          send: (input: { readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      // The server names the session after the first turn. The record is new;
      // the session is the same one.
      clientContext.switchSession(
        SessionId.make("session-a"),
        BranchId.make("branch-a"),
        "A better name",
      )
      yield* Effect.promise(() => setup.renderOnce())
      // gent/no-sleep: allow real-clock gap so a second send, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
      setup.renderer.destroy()
    }),
  )
  it.live("a startup prompt the server refuses comes back to the draft with its reason", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const attempts: Array<{ readonly content: string; readonly requestId?: string }> = []
      const initialPrompt = "survive one failure"
      const client = createMockClient({
        message: {
          send: (input: { readonly content: string; readonly requestId?: string }) =>
            Effect.suspend(() => {
              attempts.push(input)
              if (attempts.length === 1) {
                return Effect.fail(new ProviderAuthError({ message: "send refused" }))
              }
              return Effect.void
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      // The refusal is an answer: the prompt comes back as a draft, with why.
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes(`┃ ${initialPrompt}`) &&
          Option.exists(Option.fromNullishOr(clientContext.error()), (error) =>
            error.includes("send refused"),
          ),
        "prompt back in the draft",
      )
      expect(attempts).toHaveLength(1)
      // The reader sends it; nothing sends it on its own.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => attempts.length === 2, "sent by the reader")
      expect(attempts[1]?.content).toBe(initialPrompt)
      setup.renderer.destroy()
    }),
  )
  it.live(
    "a startup prompt whose replies were lost goes again under its request id",
    () =>
      Effect.gen(function* () {
        const ids: Array<string> = []
        const initialPrompt = "lost on the way back"
        const client = createMockClient({
          message: {
            send: (input: { readonly content: string; readonly requestId?: string }) =>
              Effect.suspend(() => {
                ids.push(input.requestId ?? "<missing>")
                // The first send and its four retries: admitted, reply lost.
                if (ids.length <= 5) {
                  return Effect.fail(
                    new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
                  )
                }
                return Effect.void
              }),
          },
        })
        const setup = yield* Effect.promise(() =>
          renderWithProviders(() => <App missingAuthProviders={[]} />, {
            client,
            runtime: createMockRuntime(),
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
          }),
        )
        yield* waitForFrame(
          setup,
          (frame) => frame.includes(`┃ ${initialPrompt}`),
          "prompt back in the draft",
          8_000,
        )
        expect(ids).toHaveLength(5)
        setup.mockInput.pressEnter()
        yield* waitForFrame(setup, () => ids.length === 6, "sent by the reader")
        expect(new Set(ids).size).toBe(1)
        setup.renderer.destroy()
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
  it.live("a renamed session does not refetch the extension slash commands", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      let slashCommandCalls = 0
      const client = createMockClient({
        extension: {
          listSlashCommands: () =>
            Effect.sync(() => {
              slashCommandCalls += 1
              return []
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* waitForFrame(setup, () => slashCommandCalls >= 1, "slash commands fetched")
      const before = slashCommandCalls
      // The extension-contributed rows belong to the session, not to its name.
      clientContext.switchSession(
        SessionId.make("session-a"),
        BranchId.make("branch-a"),
        "A better name",
      )
      yield* Effect.promise(() => setup.renderOnce())
      // gent/no-sleep: allow real-clock gap so a refetch, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(slashCommandCalls).toBe(before)
      setup.renderer.destroy()
    }),
  )
})

// ── widgets render ──────────────────────────────────────────────────────────

const syntaxStyle = () => SyntaxStyle.create()
const testSession: Session = {
  id: SessionId.make("session-test"),
  name: "Test Session",
  cwd: "/tmp/gent-test",
  reasoningLevel: absent,
  activeBranchId: BranchId.make("branch-test"),
  parentSessionId: absent,
  parentBranchId: absent,
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
}
const nextSession: Session = {
  id: SessionId.make("session-next"),
  name: "Next Session",
  cwd: "/tmp/gent-next",
  reasoningLevel: absent,
  activeBranchId: BranchId.make("branch-next"),
  parentSessionId: absent,
  parentBranchId: absent,
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
}

const scheduledFailureHealth = (id: string, error: string): ExtensionHealthSnapshot => ({
  _tag: "Degraded",
  healthyExtensions: [],
  degradedExtensions: [
    {
      manifest: { id },
      scope: "builtin",
      sourcePath: "builtin",
      _tag: "Degraded",
      issues: [{ _tag: "ActivationFailed", phase: "startup", error }],
    },
  ],
})

const healthyHealth: ExtensionHealthSnapshot = { _tag: "Healthy", extensions: [] }

const HealthControlsProbe = (props: {
  expose: (controls: {
    switchSession: () => void
    switchBranchSameSession: () => void
    clearSession: () => void
  }) => void
}) => {
  const client = useClient()
  const nextBranchId = Option.getOrElse(Option.fromNullishOr(nextSession.activeBranchId), () =>
    BranchId.make("branch-next"),
  )
  const nextName = Option.getOrElse(Option.fromNullishOr(nextSession.name), () => "Next Session")
  const testName = Option.getOrElse(Option.fromNullishOr(testSession.name), () => "Test Session")
  props.expose({
    switchSession: () => client.switchSession(nextSession.id, nextBranchId, nextName),
    switchBranchSameSession: () =>
      client.switchSession(testSession.id, BranchId.make("branch-alt"), testName),
    clearSession: () => client.clearSession(),
  })
  const failedActivation = () => {
    const health = client.extensionHealth()
    if (health._tag !== "Degraded") return []
    return health.degradedExtensions
      .filter((extension) => extension.issues.some((issue) => issue._tag === "ActivationFailed"))
      .map((extension) => extension.manifest.id)
  }
  return <text>{failedActivation().join(",")}</text>
}
const createMutableRuntime = (initialState: ConnectionState) => {
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
describe("TUI renderer surfaces", () => {
  it.live("MessageList renders user labels and assistant reasoning", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        {
          _tag: "interjection-message",
          id: "user-1",
          role: "user",
          pendingMode: "steer",
          content: "Stop and switch agent",
          reasoning: "",
          images: [],
          createdAt: 0,
          toolCalls: absent,
        } satisfies Message,
        {
          _tag: "regular-message",
          id: "assistant-1",
          role: "assistant",
          content: "Switching now",
          reasoning: "Considering current todo state",
          images: [],
          createdAt: 0,
          toolCalls: absent,
          // The feed spells an assistant answer as segments in part order,
          // with the flat fields alongside for readers that want the whole
          // text at once.
          segments: [
            { _tag: "reasoning", content: "Considering current todo state" },
            { _tag: "text", content: "Switching now" },
          ],
        } satisfies Message,
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={items}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("[steer]")
      expect(frame).toContain("Stop and switch agent")
      expect(frame).toContain("Considering current todo state")
    }),
  )
  it.live("QueueWidget renders steer and queued summaries", () =>
    Effect.gen(function* () {
      const steerMessages: QueueEntryInfo[] = [
        {
          _tag: "Steering",
          id: MessageId.make("m1"),
          content: "switch to deepwork",
          createdAt: 0,
        },
      ]
      const queuedMessages: QueueEntryInfo[] = [
        {
          _tag: "FollowUp",
          id: MessageId.make("m2"),
          content: "line one\nline two\nline three",
          createdAt: 0,
        },
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <QueueWidget queuedMessages={queuedMessages} steerMessages={steerMessages} />
        )),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("queue")
      expect(frame).toContain("[steer 1] switch to deepwork")
      expect(frame).toContain("[queued 1] line one +2 lines")
      expect(frame).toContain("cmd+up restore")
    }),
  )
  it.live("ConnectionWidget renders nothing when no connection issue", () =>
    Effect.gen(function* () {
      // ConnectionWidget now self-sources from useClient() — no props.
      // Default mock client has no connection issues, so widget renders nothing.
      const setup = yield* Effect.promise(() => renderWithProviders(() => <ConnectionWidget />))
      const frame = renderFrame(setup)
      expect(frame).not.toContain("connection")
    }),
  )
  it.live("ConnectionWidget surfaces failed extension activation", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          client: createMockClient({
            extension: {
              listStatus: () =>
                Effect.succeed({
                  _tag: "Degraded",
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/memory" },
                      scope: "builtin",
                      sourcePath: "builtin",
                      _tag: "Degraded",
                      issues: [
                        {
                          _tag: "ActivationFailed",
                          phase: "startup",
                          error: "startup boom",
                        },
                      ],
                    },
                  ],
                }),
            },
          }),
        }),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("failed extensions")
      // The reason, not only the id: a broken config names its parse error.
      expect(frame).toContain("@gent/memory: startup boom")
    }),
  )
  it.live("ConnectionWidget names a model catalog that did not load", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          client: createMockClient({
            extension: {
              listStatus: () =>
                Effect.succeed({
                  _tag: "Degraded",
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@user/local-models" },
                      scope: "user",
                      sourcePath: "/home/.gent/extensions/local-models.ts",
                      _tag: "Degraded",
                      issues: [
                        {
                          _tag: "ModelCatalogFailed",
                          driverId: "ollama",
                          error: "connect ECONNREFUSED",
                        },
                      ],
                    },
                  ],
                }),
            },
          }),
        }),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("some models unavailable")
      expect(frame).toContain("ollama: connect ECONNREFUSED")
      expect(frame).not.toContain("failed extensions")
    }),
  )
  it.live("ConnectionWidget surfaces failed extensions for the active session", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          initialSession: testSession,
          client: createMockClient({
            extension: {
              listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                expect(sessionId).toBe(testSession.id)
                return Effect.succeed({
                  _tag: "Degraded",
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/plan" },
                      scope: "builtin",
                      sourcePath: "builtin",
                      _tag: "Degraded",
                      issues: [
                        {
                          _tag: "ActivationFailed",
                          phase: "startup",
                          error: "launchd boom",
                        },
                      ],
                    },
                  ],
                })
              },
            },
          }),
        }),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("failed extensions")
      expect(frame).toContain("@gent/plan")
    }),
  )
  // The status row and the activity report read `isReconnecting`, so both
  // wire states that mean "not connected yet" have to answer true.
  it.live("isReconnecting follows the connecting and reconnecting states", () =>
    Effect.gen(function* () {
      const lifecycle = createMutableRuntime(
        ConnectionState.cases.Connected.make({ generation: 0 }),
      )
      const ReconnectProbe = () => {
        const client = useClient()
        return <text>{`reconnecting:${String(client.isReconnecting())}`}</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ReconnectProbe />, { runtime: lifecycle.runtime }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:false"), "connected")
      lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:true"), "reconnecting")
      lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:false"), "reconnected")
      lifecycle.emit(ConnectionState.cases.Connecting.make({}))
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:true"), "connecting")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("ConnectionWidget refreshes extension status after reconnect generation changes", () =>
    Effect.gen(function* () {
      const lifecycle = createMutableRuntime(
        ConnectionState.cases.Connected.make({ generation: 0 }),
      )
      let callCount = 0
      let currentHealth: ExtensionHealthSnapshot = {
        _tag: "Degraded",
        healthyExtensions: [],
        degradedExtensions: [
          {
            manifest: { id: "@gent/plan" },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "Degraded",
            issues: [
              {
                _tag: "ActivationFailed",
                phase: "startup",
                error: "launchd boom",
              },
            ],
          },
        ],
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          initialSession: testSession,
          runtime: lifecycle.runtime,
          client: createMockClient({
            extension: {
              listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                callCount += 1
                expect(sessionId).toBe(testSession.id)
                return Effect.succeed(currentHealth)
              },
            },
          }),
        }),
      )
      expect(renderFrame(setup)).toContain("failed extensions")
      expect(callCount).toBe(1)
      currentHealth = {
        _tag: "Healthy",
        extensions: [],
      }
      lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(callCount).toBe(2)
      expect(frame).not.toContain("failed extensions")
      expect(frame).not.toContain("@gent/plan")
    }),
  )
  it.live("ConnectionWidget clears stale extension status when switching sessions", () =>
    Effect.gen(function* () {
      let controls = Option.none<{
        switchSession: () => void
        clearSession: () => void
      }>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ConnectionWidget />
              <HealthControlsProbe expose={(next) => (controls = Option.some(next))} />
            </>
          ),
          {
            initialSession: testSession,
            client: createMockClient({
              extension: {
                listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                  if (sessionId === testSession.id) {
                    return Effect.succeed(scheduledFailureHealth("@gent/plan", "launchd boom"))
                  }
                  return Effect.succeed(healthyHealth)
                },
              },
            }),
          },
        ),
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      if (Option.isNone(controls)) return yield* Effect.die("health controls not ready")
      controls.value.switchSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).not.toContain("failed extensions")
      expect(frame).not.toContain("@gent/plan")
    }),
  )
  it.live("same-session branch switches preserve session-scoped extension health", () =>
    Effect.gen(function* () {
      let controls = Option.none<{
        switchSession: () => void
        switchBranchSameSession: () => void
        clearSession: () => void
      }>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <HealthControlsProbe expose={(value) => (controls = Option.some(value))} />
              <ConnectionWidget />
            </>
          ),
          {
            initialSession: testSession,
            client: createMockClient({
              extension: {
                listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                  if (sessionId === testSession.id) {
                    return Effect.succeed(scheduledFailureHealth("@gent/plan", "launchd boom"))
                  }
                  return Effect.succeed(healthyHealth)
                },
              },
            }),
          },
        ),
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      if (Option.isNone(controls)) return yield* Effect.die("health controls not ready")
      controls.value.switchBranchSameSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("failed extensions")
      expect(frame).toContain("@gent/plan")
    }),
  )
})
describe("uiModel schema validation", () => {
  const ArtifactUiModel = Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        sourceTool: Schema.String,
        status: Schema.Literals(["active", "resolved"]),
      }),
    ),
  })
  const decode = Schema.decodeUnknownOption(ArtifactUiModel)
  test("valid artifact snapshot decodes correctly", () => {
    const valid = {
      items: [{ id: "a1", label: "Plan: auth refactor", sourceTool: "plan", status: "active" }],
    }
    const result = decode(valid)
    expect(result._tag).toBe("Some")
  })
  test("empty items decodes correctly", () => {
    const valid = { items: [] }
    const result = decode(valid)
    expect(result._tag).toBe("Some")
  })
  test("malformed snapshot decodes to None (not crash)", () => {
    const malformed = { items: "not-an-array" }
    const result = decode(malformed)
    expect(result._tag).toBe("None")
  })
  test("missing fields decode to None", () => {
    const partial = {}
    const result = decode(partial)
    expect(result._tag).toBe("None")
  })
  test("null snapshot decodes to None", () => {
    const result = decode(nullValue)
    expect(result._tag).toBe("None")
  })
})

// ── debug playground ────────────────────────────────────────────────────────

describe("debug playground", () => {
  it.live(
    "the session view renders the seeded transcript with the shipped tool ids",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Gent.server({
            cwd: "/tmp",
            debug: true,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const { client, runtime } = yield* Gent.client(server, { cwd: "/tmp" })
          const [session] = yield* client.session.list()
          const initialSession = yield* Effect.fromNullishOr(session)
          const setup = yield* Effect.promise(() =>
            renderWithProviders(() => <App missingAuthProviders={[]} />, {
              client,
              runtime,
              initialSession,
              cwd: "/tmp",
              width: 120,
              height: 40,
            }),
          )
          const frame = yield* waitForFrame(
            setup,
            (text) => text.includes("Review the TUI renderer cleanup"),
            "seeded transcript",
            5_000,
          )
          setup.renderer.destroy()
          expect(frame).toContain("✓ 5 tool calls · 1 read · 1 grep · 1 bash · 1 edit · 1 write")
          expect(frame).toContain("✓ 3 tool calls · 2 delegate.start · 1 read_session")
          expect(frame).toContain("Audit lines up")
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )
})

describe("client extension status", () => {
  it.live("a /driver usage hint lands in the footer and never starts a model turn", () =>
    Effect.gen(function* () {
      const sentMessages: Array<{ readonly content: string }> = []
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        message: {
          send: (input: { readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      let ext = Option.none<ReturnType<typeof useExtensionUI>>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            width: 140,
            initialSession: {
              id: SessionId.make("session-driver"),
              activeBranchId: BranchId.make("branch-driver"),
              name: "Driver",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const driverCommand = () =>
        ext.pipe(
          Option.flatMap((value) =>
            Option.fromUndefinedOr(value.commands().find((command) => command.slash === "driver")),
          ),
        )
      yield* waitForFrame(setup, () => Option.isSome(driverCommand()), "driver command loaded")
      const command = driverCommand()
      if (Option.isNone(command)) return yield* Effect.die("driver command not loaded")
      command.value.onSlash?.("")
      const frame = yield* waitForFrame(
        setup,
        (text) => text.includes("Usage: /driver <agent> <driver-id|default>"),
        "driver usage in the footer",
      )
      expect(frame).toContain("Usage: /driver")
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
})
