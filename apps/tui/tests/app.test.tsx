/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Cause, Clock, Deferred, Effect, Exit, Option, Schema } from "effect"
import {
  AgentName,
  BranchId,
  dateFromMillis,
  DEFAULT_AGENT_NAME,
  MessageId,
  ProviderId,
  Session,
  SessionId,
} from "@gent/core/protocol"
import {
  ConnectionState,
  emptyQueueSnapshot,
  Gent,
  type ExtensionHealthSnapshot,
  type GentClientRpcError,
  type GentRuntime,
  type QueueEntryInfo,
} from "@gent/sdk"
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
} from "./render-harness-boundary"
import { onMount } from "solid-js"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { type ClientContextValue, useClient } from "../src/client"
import { waitForRenderedFrame } from "./helpers-boundary"
import { useTerminalDimensions } from "../src/terminal"
import { SyntaxStyle } from "@opentui/core"
import { type Message, MessageList, type SessionItem } from "../src/message-list"
import { useExtensionUI } from "../src/extensions/host"

// ── app-bootstrap.test ──────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())
const idleTag = "Idle" satisfies "Idle"
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
              runtime: {
                _tag: idleTag,
                agent: AgentName.make("deepwork"),
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
        requestedAgent: AgentName.make("cowork"),
      })
      expect(auth.initialAgent).toBe(AgentName.make("deepwork"))
      expect(auth.missingProviders).toEqual([ProviderId.make("openai")])
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("uses the requested agent for headless auth checks", () =>
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
              runtime: {
                _tag: idleTag,
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
        requestedAgent: AgentName.make("deepwork"),
      })
      expect(auth.initialAgent).toBeUndefined()
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("falls back to the default agent when a fresh session has no runtime agent yet", () =>
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
              runtime: {
                _tag: idleTag,
                agent: absent,
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

// ── app-auth.test ───────────────────────────────────────────────────────────

type AppAuthRenderSetup = Awaited<ReturnType<typeof renderWithProviders>>

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

const waitForMessage = (
  setup: AppAuthRenderSetup,
  messages: readonly {
    readonly content: string
  }[],
  content: string,
  timeoutMs = 2000,
): Effect.Effect<void, MessageTimeoutError> => {
  const poll = (startedAt: number): Effect.Effect<void, MessageTimeoutError> =>
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      if (messages.some((message) => message.content === content)) return
      const now = yield* Clock.currentTimeMillis
      if (now - startedAt >= timeoutMs) {
        return yield* new MessageTimeoutError({
          message: `timed out waiting for message: ${content}`,
        })
      }
      // gent/no-sleep: allow render-poll primitive — TUI frame must be re-rendered between observations
      yield* Effect.sleep("10 millis")
      return yield* poll(startedAt)
    })
  return Clock.currentTimeMillis.pipe(Effect.flatMap(poll))
}
function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

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
      clientContext.selectAgent(AgentName.make("deepwork"))
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("API Keys"),
          "API Keys after agent switch",
        ),
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
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("API Keys"),
          "API Keys from initial agent",
        ),
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
      yield* waitForMessage(setup, sentMessages, startupPrompt)
      expect(sentMessages).toHaveLength(1)
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      ctx.value.createSession()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          () => ctx.pipe(Option.exists((value) => value.session()?.sessionId === nextSessionId)),
          "next session mounted",
        ),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("ready ·"), "session view"),
      )
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      // One escape arms the quit; the palette keybind disarms it, and an escape closes the palette.
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      setup.mockInput.pressKey("p", { ctrl: true })
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Commands"), "palette"),
      )
      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("Commands"), "palette closed"),
      )
      // The quit is disarmed, so this escape only arms it again.
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow the escape must be parsed and handled before the negative assertion
      yield* Effect.sleep("100 millis")
      expect(shutdowns).toBe(0)
      // A second escape in the window quits.
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => shutdowns > 0, "quit"))
      setup.renderer.destroy = destroy
      expect(shutdowns).toBe(1)
      setup.renderer.destroy()
    }),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Resume: Session A"), "picker"),
      )
      // `useEnv().shutdown` is a no-op in the harness, so observe the renderer
      // teardown the controller performs alongside it.
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => shutdowns > 0, "quit"))
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker"),
      )
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
      const authFrame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (next) => next.includes("API Keys"), "auth overlay"),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => authChecks > 0, "auth check failure"),
      )
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
      yield* waitForMessage(setup, sentMessages, "send after retry")
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) =>
            frame.includes("temporary auth lookup failed") && frame.includes("Press r to retry"),
          "retryable auth error",
        ),
      )
      setup.mockInput.pressKey("r")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth retry resolved"),
      )
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
              runtime: {
                _tag: "Idle",
                agent: "cowork",
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Resume: Alpha") && frame.includes("Side (1)"),
          "branch picker",
        ),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate"),
      )
      expect(sentMessages).toEqual([])
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Enter API key for openai"),
          "openai key input",
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth overlay closed"),
      )
      expect(hasOpenAiKey).toBe(true)
      yield* waitForMessage(setup, sentMessages, initialPrompt)
      expect(sentMessages.find((message) => message.content === initialPrompt)).toMatchObject({
        sessionId: alphaSessionId,
        branchId: betaBranchId,
      })
      yield* Effect.promise(() => setup.mockInput.typeText(historyPrompt))
      setup.mockInput.pressEnter()
      yield* waitForMessage(setup, sentMessages, historyPrompt)
      setup.mockInput.pressKey("r", { ctrl: true })
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Prompt Search") && frame.includes(historyPrompt),
          "prompt search history",
        ),
      )
      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => !frame.includes("Prompt Search"),
          "prompt search closed",
        ),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate"),
      )
      clientContext.selectAgent(AgentName.make("deepwork"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          () => sessionAuthChecks >= 2,
          "stale session auth check started",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Enter API key for openai"),
          "openai key input",
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth resolved"),
      )
      yield* waitForMessage(setup, sentMessages, initialPrompt)
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
      yield* waitForMessage(setup, sentMessages, initialPrompt)
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
  it.live("a startup prompt whose send failed is sent again under the same request id", () =>
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
                return Effect.fail(new ProviderAuthError({ message: "connection lost" }))
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
      yield* waitForMessage(setup, attempts, initialPrompt)
      // Nothing else changes: the send itself goes again.
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => attempts.length >= 2, "second send"),
      )
      // The send landed; one more mount must not send again.
      clientContext.switchSession(SessionId.make("session-a"), BranchId.make("branch-b"), "A")
      yield* Effect.promise(() => setup.renderOnce())
      // gent/no-sleep: allow real-clock gap so a third send, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(attempts).toHaveLength(2)
      expect(attempts[0]?.requestId).toBeDefined()
      expect(attempts[1]?.requestId).toBe(attempts[0]?.requestId)
      setup.renderer.destroy()
    }),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => slashCommandCalls >= 1, "slash commands fetched"),
      )
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

// ── widgets-render.test ─────────────────────────────────────────────────────

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
      restart: Effect.void,
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
      expect(frame).toContain("@gent/memory")
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

// ── debug-playground.test ───────────────────────────────────────────────────

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
          const frame = yield* Effect.promise(() =>
            waitForRenderedFrame(
              setup,
              (text) => text.includes("Review the TUI renderer cleanup"),
              "seeded transcript",
              5_000,
            ),
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => Option.isSome(driverCommand()), "driver command loaded"),
      )
      const command = driverCommand()
      if (Option.isNone(command)) return yield* Effect.die("driver command not loaded")
      command.value.onSlash?.("")
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (text) => text.includes("Usage: /driver <agent> <driver-id|default>"),
          "driver usage in the footer",
        ),
      )
      expect(frame).toContain("Usage: /driver")
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
})
