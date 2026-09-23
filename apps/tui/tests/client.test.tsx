/** @jsxImportSource @opentui/solid */
import {
  ErrorOccurred,
  EventId,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
  type SessionRuntimeState,
} from "@gent/core/test-utils"
import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Option, Predicate, Schema, Stream } from "effect"
import {
  type ActiveInteraction,
  AgentEvent,
  AgentName,
  assistantMessageIdForTurn,
  BranchId,
  dateFromMillis,
  EventEnvelope,
  Message,
  MessageId,
  ModelId,
  projectMessage,
  SessionId,
  type SessionSnapshot,
  ToolCallId,
  ToolInteraction,
  OutputCut,
} from "@gent/core/protocol"
import { ExtensionId } from "@gent/core/extensions/api"
import {
  AgentStatus,
  type ClientContextValue,
  reduceAgentLifecycle,
  type Session,
  sessionSettings,
  SessionState,
  SessionStateEvent,
  transitionSessionState,
  useClient,
} from "../src/client"
import { emptyQueueSnapshot } from "@gent/sdk"
import { createRoot, createSignal, onMount } from "solid-js"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness-boundary"
import { inRuntime, waitForFrame, waitUntil } from "./helpers-boundary"
import * as Prompt from "effect/unstable/ai/Prompt"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { useSessionFeed } from "../src/session"
import { useExtensionUI } from "../src/extensions/host"
import { ClientContext, type ClientRuntime } from "../src/extensions/client-facets"

// ── agent lifecycle ─────────────────────────────────────────────────────────

const makeMessage = (role: "user" | "assistant") =>
  Message.cases.regular.make({
    id: MessageId.make("m1"),
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    role,
    parts: [],
    createdAt: dateFromMillis(0),
  })

describe("reduceAgentLifecycle", () => {
  test("marks a turn as streaming when the stream starts", () => {
    const event = StreamStarted.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
    })

    expect(reduceAgentLifecycle(event)).toEqual({
      status: { _tag: "Streaming" },
    })
    expect(Schema.is(AgentStatus.cases.Streaming)(reduceAgentLifecycle(event).status)).toBe(true)
  })

  test("keeps streaming until TurnCompleted", () => {
    const streamEnded = StreamEnded.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
    })
    const assistantMessage = MessageReceived.make({
      message: makeMessage("assistant"),
    })
    const turnCompleted = TurnCompleted.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      durationMs: 42,
    })

    expect(reduceAgentLifecycle(streamEnded)).toEqual({})
    expect(reduceAgentLifecycle(assistantMessage)).toEqual({})
    expect(reduceAgentLifecycle(turnCompleted)).toEqual({
      status: { _tag: "Idle" },
    })
    expect(Schema.is(AgentStatus.cases.Idle)(reduceAgentLifecycle(turnCompleted).status)).toBe(true)
  })

  test("uses user messages to enter streaming immediately", () => {
    const userMessage = MessageReceived.make({
      message: makeMessage("user"),
    })

    expect(reduceAgentLifecycle(userMessage)).toEqual({
      status: { _tag: "Streaming" },
    })
    expect(Schema.is(AgentStatus.cases.Streaming)(reduceAgentLifecycle(userMessage).status)).toBe(
      true,
    )
  })

  test("surfaces errors", () => {
    const errored = ErrorOccurred.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      error: "boom",
    })

    expect(reduceAgentLifecycle(errored)).toEqual({
      status: { _tag: "Error", error: "boom" },
    })
    expect(Schema.is(AgentStatus.cases.Error)(reduceAgentLifecycle(errored).status)).toBe(true)
  })

  test("a notice leaves the status as it is", () => {
    const notice = ErrorOccurred.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      error: "compaction fell back to truncation",
      notice: true,
    })

    expect(reduceAgentLifecycle(notice)).toEqual({})
  })
})

// ── session settings state ──────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())

const active = SessionState.active({
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  name: "S",
  modelId: absent,
  reasoningLevel: "high",
  cwd: absent,
})

describe("session settings", () => {
  test("an update replaces both settings at once", () => {
    const next = transitionSessionState(
      active,
      SessionStateEvent.cases.UpdateSettings.make({
        modelId: ModelId.make("openai/gpt-5.6-luna"),
        reasoningLevel: absent,
      }),
    )
    expect(next.status).toBe("active")
    if (next.status === "active") {
      expect(sessionSettings(next.session)).toEqual({
        modelId: ModelId.make("openai/gpt-5.6-luna"),
        reasoningLevel: absent,
      })
      expect(next.session.name).toBe("S")
    }
  })

  test("an update while no session is active is ignored", () => {
    const next = transitionSessionState(
      SessionState.none(),
      SessionStateEvent.cases.UpdateSettings.make({ modelId: absent, reasoningLevel: "low" }),
    )
    expect(next).toEqual(SessionState.none())
  })
})

// ── client provider contract ────────────────────────────────────────────────

/**
 * The merged client provider's contract.
 *
 * `ClientProvider` used to publish four Solid contexts — transport, session,
 * agent, actions — and every consumer spread them back into one object. That
 * split had two observable costs, and each test below fails if it returns:
 *
 * 1. Two consumers read two different objects, so a value could not be
 *    compared or passed across the seam without re-merging it.
 * 2. A merged object captured before a write kept serving the value from the
 *    merge, so a consumer that held one observed a stale session while a
 *    consumer that re-read observed the new one.
 */

class ClientProviderContractError extends Schema.TaggedError<ClientProviderContractError>()(
  "ClientProviderContractError",
  { message: Schema.String },
) {}

const requireValue = <A,>(
  value: Option.Option<A>,
  message: string,
): Effect.Effect<A, ClientProviderContractError> => {
  if (Option.isNone(value)) return Effect.fail(new ClientProviderContractError({ message }))
  return Effect.succeed(value.value)
}

function Probe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

const settle = (setup: Awaited<ReturnType<typeof renderWithProviders>>) =>
  Effect.promise(() => setup.renderOnce())

describe("ClientProvider contract", () => {
  it.live("two consumers read one value, not one merge each", () =>
    Effect.gen(function* () {
      let first = Option.none<ClientContextValue>()
      let second = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <box>
            <Probe onReady={(value) => (first = Option.some(value))} />
            <Probe onReady={(value) => (second = Option.some(value))} />
          </box>
        )),
      )
      yield* settle(setup)

      const a = yield* requireValue(first, "first consumer never mounted")
      const b = yield* requireValue(second, "second consumer never mounted")

      // A spread per hook call would hand each consumer its own object.
      expect(a).toBe(b)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("a value held across a write reports the write, never the merge", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Probe onReady={(value) => (held = Option.some(value))} />),
      )
      yield* settle(setup)

      // Captured before the write. The old split let this object keep the
      // session accessor from one context and the agent accessor from
      // another, so a consumer that stored it could observe a session the
      // rest of the tree had already left.
      const captured = yield* requireValue(held, "consumer never mounted")
      expect(Option.fromNullishOr(captured.session())).toEqual(Option.none())

      const sessionId = SessionId.make("contract-session")
      const branchId = BranchId.make("contract-branch")
      captured.switchSession(sessionId, branchId, "Contract")
      yield* settle(setup)

      const observed = yield* requireValue(
        Option.fromNullishOr(captured.session()),
        "held value never observed the switch",
      )
      expect(observed.sessionId).toBe(sessionId)
      expect(observed.branchId).toBe(branchId)
      expect(captured.isActive()).toBe(true)
      expect(captured.sessionState().status).toBe("active")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("one value carries every facet the consumers used to merge", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Probe onReady={(value) => (held = Option.some(value))} />),
      )
      yield* settle(setup)

      const client = yield* requireValue(held, "consumer never mounted")

      // Transport, session, agent and actions — all exercised through one
      // read. Four contexts forced a consumer that needed two facets to
      // merge them; this one value answers for every facet at once.
      let seen = 0
      const unsubscribe = client.onSessionEvent(() => {
        seen = seen + 1
      })
      expect(client.isReconnecting()).toBe(false)
      expect(client.isActive()).toBe(false)
      expect(client.agentStatus()._tag).toBe("Idle")
      expect(client.isStreaming()).toBe(false)

      // An action writes; the agent facet on the same value reports it.
      client.setError("contract failure")
      expect(client.isError()).toBe(true)
      expect(client.error()).toBe("contract failure")

      // A session write; the session facet on the same value reports it.
      client.switchSession(SessionId.make("facet-session"), BranchId.make("facet-branch"), "Facets")
      yield* settle(setup)
      expect(client.isActive()).toBe(true)
      // switchSession also resets the agent facet, from the same value.
      expect(client.agentStatus()._tag).toBe("Idle")
      expect(client.cost()).toBe(0)

      unsubscribe()
      expect(seen).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── client session metrics ──────────────────────────────────────────────────

/**
 * Session metrics must not cross a session boundary.
 *
 * Two ways they used to: a session change reset the cost and the token count
 * but left `contextMetrics` behind, and an in-flight `getSnapshot` reply was
 * written back without checking which session had asked for it. Both are
 * visible: `buildContextLabels` prefers the projection over the live token
 * count whenever it carries a limit, so a stale projection renders the
 * previous session's context percentage on the status border.
 *
 * Each test below fails if its half of the repair is removed.
 */

class ClientMetricsTestError extends Schema.TaggedError<ClientMetricsTestError>()(
  "ClientMetricsTestError",
  { message: Schema.String },
) {}

const nullValue = Option.getOrNull(Option.none())

const requireClient = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, ClientMetricsTestError> => {
  if (Option.isNone(context)) {
    return Effect.fail(new ClientMetricsTestError({ message: "client context not ready" }))
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

const FIRST = {
  sessionId: SessionId.make("session-metrics-first"),
  branchId: BranchId.make("branch-metrics-first"),
}
const SECOND = {
  sessionId: SessionId.make("session-metrics-second"),
  branchId: BranchId.make("branch-metrics-second"),
}

/** A projection that fills most of the window: the value a reader would see as `ctx 90%`. */
const busyContext = {
  estimatedTokens: 90_000,
  availableInputTokens: 10_000,
  contextLimitTokens: 100_000,
  omittedMessages: 0,
  compactions: 1,
}

const snapshotOf = (
  session: { sessionId: SessionId; branchId: BranchId },
  metrics: {
    costUsd: number
    lastInputTokens: number
    context?: typeof busyContext
  },
): SessionSnapshot => ({
  sessionId: session.sessionId,
  branchId: session.branchId,
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
    turns: 1,
    durationMs: 10,
    costUsd: metrics.costUsd,
    lastInputTokens: metrics.lastInputTokens,
    context: metrics.context,
  },
})

describe("ClientProvider session metrics", () => {
  it.live("switching sessions drops the previous session's context projection", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed(
              snapshotOf(FIRST, { costUsd: 4.2, lastInputTokens: 9_000, context: busyContext }),
            ),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />, {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const clientContext = yield* requireClient(ctx)

      // Load the first session's metrics the way a finished turn would.
      clientContext.applySessionSnapshot(
        snapshotOf(FIRST, { costUsd: 4.2, lastInputTokens: 9_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(Option.isSome(clientContext.sessionMetrics().context)).toBe(true)
      expect(clientContext.cost()).toBe(4.2)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(9_000)

      clientContext.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      yield* Effect.promise(() => setup.renderOnce())

      // Every metric goes, not just the two that always did.
      expect(clientContext.cost()).toBe(0)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)
      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)

      setup.renderer.destroy()
    }),
  )

  it.live("clearing the session drops the context projection", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />, {
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const clientContext = yield* requireClient(ctx)

      clientContext.applySessionSnapshot(
        snapshotOf(FIRST, { costUsd: 1.5, lastInputTokens: 5_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(Option.isSome(clientContext.sessionMetrics().context)).toBe(true)

      clientContext.clearSession()
      yield* Effect.promise(() => setup.renderOnce())

      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)

      setup.renderer.destroy()
    }),
  )

  it.live("a snapshot reply that arrives after a session switch is dropped", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const held = yield* Deferred.make<SessionSnapshot>()
      const asked: Array<string> = []
      const client = createMockClient({
        session: {
          getSnapshot: (input: { sessionId: SessionId; branchId: BranchId }) => {
            asked.push(String(input.sessionId))
            // Hold the first session's reply open so the switch lands first.
            if (input.sessionId === FIRST.sessionId) return Deferred.await(held)
            return Effect.succeed(
              snapshotOf(SECOND, { costUsd: 0, lastInputTokens: 0, context: absent }),
            )
          },
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />, {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const clientContext = yield* requireClient(ctx)

      // The product path: a stream that ends with usage refreshes the metrics.
      // Its reply stays in flight because the mock holds this session's answer.
      clientContext.applySessionEvent(
        EventEnvelope.make({
          id: EventId.make(1),
          createdAt: 0,
          event: AgentEvent.cases.StreamEnded.make({
            sessionId: FIRST.sessionId,
            branchId: FIRST.branchId,
            usage: { inputTokens: 9_000, outputTokens: 120 },
          }),
        }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toContain(String(FIRST.sessionId))

      clientContext.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      yield* Effect.promise(() => setup.renderOnce())
      expect(clientContext.cost()).toBe(0)
      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)

      // The first session's reply lands now, naming a session nobody is on.
      yield* Deferred.succeed(
        held,
        snapshotOf(FIRST, { costUsd: 4.2, lastInputTokens: 9_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())

      // None of the first session's numbers come back.
      expect(clientContext.cost()).toBe(0)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)
      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)

      setup.renderer.destroy()
    }),
  )
})

// ── client session state ────────────────────────────────────────────────────

class ClientSessionStateTestError extends Schema.TaggedError<ClientSessionStateTestError>()(
  "ClientSessionStateTestError",
  { message: Schema.String },
) {}

const requireClientSessionState = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, ClientSessionStateTestError> => {
  if (Option.isNone(context)) {
    return Effect.fail(new ClientSessionStateTestError({ message: "client context not ready" }))
  }
  return Effect.succeed(context.value)
}
describe("ClientProvider session lifecycle", () => {
  it.live("a new session carries the workspace cwd and becomes the active one", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const createdSessionId = SessionId.make("session-created")
      const createdBranchId = BranchId.make("branch-created")
      const createInputs: Array<{ cwd?: string; requestId?: string }> = []
      const workspaceCwd = process.cwd()
      const client = createMockClient({
        session: {
          create: (input: { cwd?: string; requestId?: string }) =>
            Effect.sync(() => {
              createInputs.push(input)
              return { sessionId: createdSessionId, branchId: createdBranchId, name: "Created" }
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          client,
          cwd: workspaceCwd,
        }),
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      const active = ctx.value
      active.createSession()
      yield* waitForFrame(
        setup,
        () => active.session()?.sessionId === createdSessionId,
        "created session active",
      )
      expect(createInputs).toHaveLength(1)
      const firstInput = Option.fromNullishOr(createInputs[0])
      if (Option.isNone(firstInput)) return yield* Effect.die("session create was not called")
      expect(firstInput.value.cwd).toBe(workspaceCwd)
      expect(Predicate.isString(firstInput.value.requestId)).toBe(true)
      // The created session becomes the active one; the shell mounts what the
      // client says, so there is no second place a navigation could go wrong.
      expect(active.session()).toEqual({
        sessionId: createdSessionId,
        branchId: createdBranchId,
        name: "Created",
        modelId: absent,
        reasoningLevel: absent,
        cwd: workspaceCwd,
      })
    }),
  )
  it.live("a new session takes its agent from its snapshot, never from the session before it", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const client = createMockClient({
        session: {
          create: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-new"),
              branchId: BranchId.make("branch-new"),
              name: "New",
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          client,
          initialSession: {
            id: SessionId.make("session-resumed"),
            activeBranchId: BranchId.make("branch-resumed"),
            name: "Resumed",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialAgent: AgentName.make("deepwork"),
        }),
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      const active = ctx.value
      expect(active.agent()).toBe(AgentName.make("deepwork"))
      active.createSession()
      yield* waitForFrame(
        setup,
        () => active.session()?.sessionId === SessionId.make("session-new"),
        "new session active",
      )
      // No guess before the snapshot: a handoff inherits its parent's agent,
      // so assuming the default would flicker.
      expect(active.agent()).toBeUndefined()
      active.applySessionSnapshot({
        sessionId: SessionId.make("session-new"),
        branchId: BranchId.make("branch-new"),
        messages: [],
        lastEventId: 1,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("deepwork"),
        runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
        metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
      })
      expect(active.agent()).toBe(AgentName.make("deepwork"))
    }),
  )
  it.live("runtime idle clears finishing activity only for the current branch", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const sessionId = SessionId.make("session-runtime-idle")
      const branchId = BranchId.make("branch-runtime-idle")
      yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: sessionId,
            activeBranchId: branchId,
            name: "Runtime",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.applySessionSnapshot({
        sessionId,
        branchId,
        messages: [],
        lastEventId: 42,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("main"),
        runtime: { _tag: "Running", queue: emptyQueueSnapshot() },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        },
      })
      expect(client.isStreaming()).toBe(true)
      const runtime = {
        _tag: "Idle",
        queue: emptyQueueSnapshot(),
      } satisfies Parameters<ClientContextValue["applySessionRuntime"]>[0]["runtime"]
      client.applySessionRuntime({ sessionId, branchId: BranchId.make("old-branch"), runtime })
      expect(client.isStreaming()).toBe(true)
      client.applySessionRuntime({ sessionId, branchId, runtime })
      expect(client.isStreaming()).toBe(false)
    }),
  )
  it.live("an extension notice keeps the running turn and the standing error", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let runtime = Option.none<ClientRuntime>()
      const sessionId = SessionId.make("session-notice")
      const branchId = BranchId.make("branch-notice")
      function NoticeProbe() {
        const client = useClient()
        const ext = useExtensionUI()
        onMount(() => {
          ctx = Option.some(client)
          runtime = Option.some(ext.clientRuntime)
        })
        return <box />
      }
      yield* Effect.promise(() =>
        renderWithProviders(() => <NoticeProbe />, {
          initialSession: {
            id: sessionId,
            activeBranchId: branchId,
            name: "Notice",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      const clientRuntime = yield* requireValue(runtime, "extension runtime never mounted")
      const notify = (message: string) =>
        inRuntime(
          clientRuntime,
          ClientContext.use(({ shell }) => Effect.sync(() => shell.notify(message))),
        )
      client.applySessionSnapshot({
        sessionId,
        branchId,
        messages: [],
        lastEventId: 1,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("main"),
        runtime: { _tag: "Running", queue: emptyQueueSnapshot() },
        metrics: { turns: 1, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
      })
      yield* notify("Usage: /driver <agent> <driver-id|default>")
      // Esc cancels a streaming turn; a notice must not turn it into a quit.
      expect(client.isStreaming()).toBe(true)
      expect(client.notice()).toEqual(Option.some("Usage: /driver <agent> <driver-id|default>"))

      client.applySessionRuntime({
        sessionId,
        branchId,
        runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
      })
      client.setError("provider refused the request")
      yield* notify('Unknown driver "nope".')
      expect(client.error()).toBe("provider refused the request")
      expect(client.notice()).toEqual(Option.some('Unknown driver "nope".'))
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("model list failures surface as agent errors", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const mockClient = createMockClient({
        model: {
          list: () =>
            Effect.fail({
              _tag: "DriverError",
              driver: "openai",
              reason: "catalog filter failed",
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          client: mockClient,
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      yield* waitForFrame(setup, () => Predicate.isNotNullish(client.error()), "agent error")
      const error = client.error()
      expect(error).toBe("Driver openai: catalog filter failed")
    }),
  )
  it.live("a failing RPC through surfaceError lands the formatted text in the error line", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const mockClient = createMockClient({
        branch: {
          create: () => Effect.fail({ _tag: "NotFoundError", message: "branch gone" }),
        },
      })
      yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          client: mockClient,
          initialSession: {
            id: SessionId.make("session-surface"),
            activeBranchId: BranchId.make("branch-surface"),
            name: "Surface",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      expect(client.error()).toBe(nullValue)
      yield* client.surfaceError(client.createBranch())
      expect(client.error()).toBe("Not found: branch gone")
      expect(client.isError()).toBe(true)
    }),
  )
  it.live(
    "switchSession activates the target session at once; its agent waits for the snapshot",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
            {
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
        const client = yield* requireClientSessionState(ctx)
        client.switchSession(SessionId.make("session-b"), BranchId.make("branch-b"), "B")
        yield* waitForFrame(
          setup,
          () => {
            const current = client.sessionState()
            return current.status === "active"
          },
          "session state",
        )
        const state = client.sessionState()
        expect(state).toEqual({
          status: "active",
          session: {
            sessionId: SessionId.make("session-b"),
            branchId: BranchId.make("branch-b"),
            name: "B",
            modelId: absent,
            reasoningLevel: absent,
            cwd: absent,
          },
        })
        expect(client.agent()).toBeUndefined()
      }),
  )
  it.live("model() and agent() read the snapshot's server-resolved model and session agent", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-model"),
            activeBranchId: BranchId.make("branch-model"),
            name: "M",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-model"),
        branchId: BranchId.make("branch-model"),
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("cowork"),
        runtime: {
          _tag: "Idle",
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        },
      })
      yield* waitForFrame(
        setup,
        () => {
          const state = client.sessionState()
          return (
            state.status === "active" && client.model() === "anthropic/claude-haiku-4-5-20251001"
          )
        },
        "session state",
      )
      expect(client.model()).toBe("anthropic/claude-haiku-4-5-20251001")
      // The footer names the session's agent, which the snapshot carries.
      expect(client.agent()).toBe(AgentName.make("cowork"))
    }),
  )
  it.live("applySessionSnapshot refreshes the active session metadata", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-refresh"),
            activeBranchId: BranchId.make("branch-refresh"),
            name: "Stale",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-refresh"),
        branchId: BranchId.make("branch-refresh"),
        name: "Fresh",
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: "high",
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
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
      })
      yield* waitForFrame(
        setup,
        () => {
          const current = client.sessionState()
          return (
            current.status === "active" &&
            current.session.name === "Fresh" &&
            current.session.reasoningLevel === "high"
          )
        },
        "session state",
      )
      const state = client.sessionState()
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-refresh"),
          branchId: BranchId.make("branch-refresh"),
          name: "Fresh",
          modelId: absent,
          reasoningLevel: "high",
          cwd: absent,
        },
      })
    }),
  )
  it.live("applySessionSnapshot ignores stale foreign identity snapshots", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-source"),
            activeBranchId: BranchId.make("branch-source"),
            name: "Source",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.switchSession(
        SessionId.make("session-target"),
        BranchId.make("branch-target"),
        "Target",
      )
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-source"),
        branchId: BranchId.make("branch-source"),
        name: "Foreign",
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: "high",
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("cowork"),
        runtime: {
          _tag: "Running",
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 9,
          durationMs: 0,
          costUsd: 123,
          lastInputTokens: 456,
        },
      })
      yield* waitForFrame(
        setup,
        () => {
          const current = client.sessionState()
          return current.status === "active"
        },
        "session state",
      )
      const state = client.sessionState()
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-target"),
          branchId: BranchId.make("branch-target"),
          name: "Target",
          modelId: absent,
          reasoningLevel: absent,
          cwd: absent,
        },
      })
      expect(client.agent()).toBeUndefined()
      expect(client.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
      expect(client.cost()).toBe(0)
      expect(client.sessionMetrics().latestInputTokens).toBe(0)
    }),
  )
  it.live("applySessionSnapshot ignores stale snapshots for a previous branch", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-branch-race"),
            activeBranchId: BranchId.make("branch-old"),
            name: "Old",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.switchSession(
        SessionId.make("session-branch-race"),
        BranchId.make("branch-new"),
        "New",
      )
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-branch-race"),
        branchId: BranchId.make("branch-old"),
        name: "Old Snapshot",
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: "medium",
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("cowork"),
        runtime: {
          _tag: "Running",
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 12,
          lastInputTokens: 34,
        },
      })
      yield* waitForFrame(
        setup,
        () => {
          const current = client.sessionState()
          return (
            current.status === "active" && current.session.branchId === BranchId.make("branch-new")
          )
        },
        "session state",
      )
      const state = client.sessionState()
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-branch-race"),
          branchId: BranchId.make("branch-new"),
          name: "New",
          modelId: absent,
          reasoningLevel: absent,
          cwd: absent,
        },
      })
      expect(client.agent()).toBeUndefined()
      expect(client.cost()).toBe(0)
      expect(client.sessionMetrics().latestInputTokens).toBe(0)
    }),
  )
  it.live("switchSession clears the stale resolved model before re-hydration", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-prev"),
            activeBranchId: BranchId.make("branch-prev"),
            name: "P",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-prev"),
        branchId: BranchId.make("branch-prev"),
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("cowork"),
        runtime: {
          _tag: "Idle",
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        },
      })
      yield* waitForFrame(
        setup,
        () => {
          const state = client.sessionState()
          return (
            state.status === "active" && client.model() === "anthropic/claude-haiku-4-5-20251001"
          )
        },
        "session state",
      )
      client.switchSession(SessionId.make("session-next"), BranchId.make("branch-next"), "N")
      expect(client.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
    }),
  )
})

// ── use session feed ────────────────────────────────────────────────────────

type FeedClient = Parameters<typeof useSessionFeed>[2]

const snapshotFor = (
  sessionId: SessionId,
  branchId: BranchId,
  lastEventId?: number,
): SessionSnapshot => ({
  sessionId,
  branchId,
  messages: [],
  lastEventId: Option.getOrNull(Option.fromNullishOr(lastEventId)),
  modelId: Option.getOrUndefined(Option.none()),
  reasoningLevel: Option.getOrUndefined(Option.none()),
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
})

const runtimeSnapshot = (): SessionRuntimeState => ({
  _tag: "Idle",
  queue: emptyQueueSnapshot(),
})

const makeEnvelope = (id: number, event: AgentEvent, createdAt = 0): EventEnvelope =>
  EventEnvelope.make({
    id: EventId.make(id),
    event,
    createdAt,
  })

const makeUserMessage = (sessionId: SessionId, branchId: BranchId): Message =>
  Message.cases.regular.make({
    id: MessageId.make("message-feed-duplicate-user"),
    sessionId,
    branchId,
    role: "user",
    parts: [],
    createdAt: dateFromMillis(0),
  })

const makeCompactionMessage = (sessionId: SessionId, branchId: BranchId): Message =>
  Message.cases.regular.make({
    id: MessageId.make("context-handoff:branch-feed-compaction:anchor"),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text: "Context handoff: stored summary" })],
    metadata: {
      customType: "context-window",
      details: {
        keepFromMessageId: "anchor",
        summarized: { firstMessageId: "m1", lastMessageId: "m3", count: 3 },
      },
    },
    createdAt: dateFromMillis(0),
  })

const makeSession = (sessionId: SessionId, branchId: BranchId): Session => ({
  sessionId,
  branchId,
  name: "Test Session",
  modelId: Option.getOrUndefined(Option.none()),
  reasoningLevel: Option.getOrUndefined(Option.none()),
  cwd: Option.getOrUndefined(Option.none()),
})

/** The feed reads only which session is active, so the probe supplies only that. */
const identityOf = (active: () => Session) => () =>
  Option.some({ sessionId: active().sessionId, branchId: active().branchId })

const isSessionEvent = Predicate.or(
  Predicate.isTagged("turn-ended"),
  Predicate.or(Predicate.isTagged("retrying"), Predicate.isTagged("error")),
)

describe("useSessionFeed", () => {
  it.live("changes route when a branch event changes the active client identity", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("branch-navigation-session")
      const branchId = BranchId.make("branch-navigation-first")
      const nextBranchId = BranchId.make("branch-navigation-second")
      const switched = yield* Deferred.make<void>()
      let snapshotCount = 0
      const dispose = createRoot((disposeRoot) => {
        const [active, setActive] = createSignal(makeSession(sessionId, branchId))
        const runtime = createMockRuntime()
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(
                    makeEnvelope(
                      1,
                      AgentEvent.cases.BranchSwitched.make({
                        sessionId,
                        fromBranchId: branchId,
                        toBranchId: nextBranchId,
                      }),
                    ),
                  ),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime,
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {
            snapshotCount += 1
            setActive(makeSession(sessionId, branchId))
          },
          applySessionEvent: () => setActive(makeSession(sessionId, nextBranchId)),
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          runtime.cast,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onQueueSnapshot: () => {},
            onBranchSwitch: (nextSession, nextBranch) => {
              expect(nextSession).toBe(sessionId)
              expect(nextBranch).toBe(nextBranchId)
              runtime.cast(Deferred.succeed(switched, void 0))
            },
          },
        )
        return disposeRoot
      })
      yield* Deferred.await(switched).pipe(
        Effect.timeout("1 second"),
        Effect.ensuring(Effect.sync(dispose)),
      )
      expect(snapshotCount).toBe(1)
    }),
  )

  it.live("displays repeated events and resumed tool calls once with their final status", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-duplicates")
      const branchId = BranchId.make("branch-feed-duplicates")
      const toolCallId = ToolCallId.make("tool-call-feed-duplicates")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({ message: makeUserMessage(sessionId, branchId) }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "assistant text",
        }),
      )
      const toolStartedEnvelope = makeEnvelope(
        4,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          input: { command: "printf hi" },
        }),
        10_000,
      )
      const toolSucceededEnvelope = makeEnvelope(
        6,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          summary: "printed hi",
          output: "hi",
        }),
        11_200,
      )
      const streamEndedEnvelope = makeEnvelope(
        7,
        AgentEvent.cases.StreamEnded.make({
          sessionId,
          branchId,
          outcome: "ToolCalls",
          costUsd: 0.01,
        }),
      )
      const turnCompletedEnvelope = makeEnvelope(
        8,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
        }),
      )
      const retryEnvelope = makeEnvelope(
        9,
        AgentEvent.cases.ProviderRetrying.make({
          sessionId,
          branchId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          error: "temporary provider failure",
        }),
      )
      const errorEnvelope = makeEnvelope(
        10,
        AgentEvent.cases.ErrorOccurred.make({
          sessionId,
          branchId,
          error: "provider failed",
        }),
      )
      const uniqueEnvelopes = [
        messageEnvelope,
        streamStartedEnvelope,
        streamChunkEnvelope,
        toolStartedEnvelope,
        makeEnvelope(5, toolStartedEnvelope.event),
        toolSucceededEnvelope,
        streamEndedEnvelope,
        turnCompletedEnvelope,
        retryEnvelope,
        errorEnvelope,
      ]
      const errorSeen = yield* Deferred.make<void>()
      let appliedEvents = 0
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()

      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(...uniqueEnvelopes.flatMap((envelope) => [envelope, envelope])),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: (message: string) => {
              if (message === "sessionFeed.error")
                client.runtime.cast(Deferred.succeed(errorSeen, void 0))
            },
          },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: () => {
            appliedEvents += 1
          },
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient

        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            client.runtime.cast,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* Deferred.await(errorSeen)
      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.role === "assistant") &&
          feed.value.items().some((item) => item._tag === "error"),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        const messages = feed.value.messages()
        const userMessages = messages.filter((message) => message.role === "user")
        const assistantMessage = messages.find((message) => message.role === "assistant")
        const events = feed.value.items().filter(isSessionEvent)
        expect(appliedEvents).toBe(uniqueEnvelopes.length)
        expect(userMessages).toHaveLength(1)
        expect(assistantMessage?.content).toBe("assistant text")
        expect(assistantMessage?.toolCalls).toHaveLength(1)
        expect(assistantMessage?.toolCalls?.[0]?.status).toBe("completed")
        // The duration is the gap between the started and terminal envelope times.
        expect(assistantMessage?.toolCalls?.[0]?.durationMs).toBe(1_200)
        const toolSegments = assistantMessage?.segments?.filter(
          (segment) => segment._tag === "tool-call",
        )
        expect(toolSegments).toHaveLength(1)
        expect(toolSegments?.[0]?.toolCall.status).toBe("completed")
        expect(toolSegments?.[0]?.toolCall.durationMs).toBe(1_200)
        expect(events.map((event) => event._tag)).toEqual(["turn-ended", "retrying", "error"])
        // The single StreamEnded before TurnCompleted is the turn's only step.
        expect(events[0]).toMatchObject({
          _tag: "turn-ended",
          steps: { count: 1, toolCalls: 1, costUsd: 0.01 },
        })
        const retry = events.find((event) => event._tag === "retrying")
        expect(retry?._tag === "retrying" && retry.resolved).toBe(true)
        dispose()
      })
    }),
  )

  const expectNestedCellOperation = (
    feed: ReturnType<typeof useSessionFeed>,
    innerId: ToolCallId,
  ) => {
    const assistant = feed.messages().find((message) => message.role === "assistant")
    // The inner read is not a transcript sibling of the cell.
    expect(assistant?.toolCalls?.map((call) => call.toolName)).toEqual(["cell"])
    const operation = assistant?.toolCalls?.[0]?.operations?.[0]
    expect(assistant?.toolCalls?.[0]?.operations).toHaveLength(1)
    expect(operation?.id).toBe(innerId)
    expect(operation?.toolName).toBe("read")
    expect(operation?.status).toBe("error")
    expect(operation?.summary).toBe("missing file")
    const segment = assistant?.segments?.find((entry) => entry._tag === "tool-call")
    expect(segment?._tag === "tool-call" && segment.toolCall.operations?.[0]?.status).toBe("error")
    expect(feed.activeTool()).toBeUndefined()
  }

  const cellNestingEnvelopes = (
    sessionId: SessionId,
    branchId: BranchId,
    cellId: ToolCallId,
    innerId: ToolCallId,
  ): EventEnvelope[] => [
    makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
    makeEnvelope(
      2,
      AgentEvent.cases.ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId: cellId,
        toolName: "cell",
        input: { code: "await tools.read({path: 'a.txt'})" },
      }),
    ),
    makeEnvelope(
      3,
      AgentEvent.cases.ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId: innerId,
        toolName: "read",
        input: { path: "a.txt" },
        parentToolCallId: cellId,
      }),
    ),
    makeEnvelope(
      4,
      AgentEvent.cases.ToolCallFailed.make({
        sessionId,
        branchId,
        toolCallId: innerId,
        toolName: "read",
        summary: "missing file",
        parentToolCallId: cellId,
      }),
    ),
    makeEnvelope(
      5,
      AgentEvent.cases.ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId: cellId,
        toolName: "cell",
        summary: "done",
        output: "{}",
      }),
    ),
    makeEnvelope(6, AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 })),
  ]

  it.live("nests cell-admitted tool calls under their cell with final status", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-cell")
      const branchId = BranchId.make("branch-feed-cell")
      const cellId = ToolCallId.make("tool-call-cell")
      const innerId = ToolCallId.make("tool-call-cell-read")
      const envelopes = cellNestingEnvelopes(sessionId, branchId, cellId, innerId)
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: () => {},
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            client.runtime.cast,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.toolCalls?.[0]?.status === "completed"),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        expectNestedCellOperation(feed.value, innerId)
        dispose()
      })
    }),
  )

  /** A feed over one snapshot and a live event stream. */
  const openFeed = (snapshot: SessionSnapshot, envelopes: ReadonlyArray<EventEnvelope>) => {
    let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
    const dispose = createRoot((disposeRoot) => {
      const [active] = createSignal(makeSession(snapshot.sessionId, snapshot.branchId))
      const client = {
        sessionIdentity: identityOf(active),
        client: createMockClient({
          session: {
            getSnapshot: () => Effect.succeed(snapshot),
            events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
            watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
          },
        }),
        runtime: createMockRuntime(),
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        setConnectionIssue: () => {},
        waitForTransportReady: Effect.void,
        applySessionRuntime: () => {},
        applySessionSnapshot: () => {},
        applySessionEvent: () => {},
        applyBufferedSessionEvent: () => {},
      } satisfies FeedClient
      feed = Option.some(
        useSessionFeed(
          () => snapshot.sessionId,
          () => snapshot.branchId,
          client,
          client.runtime.cast,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onBranchSwitch: () => {},
            onQueueSnapshot: () => {},
          },
        ),
      )
      return disposeRoot
    })
    const cellOf = () =>
      Option.flatMap(feed, (value) =>
        Option.fromNullishOr(
          value.messages().find((message) => message.role === "assistant")?.toolCalls?.[0],
        ),
      )
    const activeTool = () =>
      Option.flatMap(feed, (value) => Option.fromUndefinedOr(value.activeTool()))
    return { cellOf, activeTool, dispose }
  }

  it.live("a cell's running ops show side by side while one of them waits", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-sibling-ops")
      const branchId = BranchId.make("branch-feed-sibling-ops")
      const cellId = ToolCallId.make("tool-call-sibling-cell")
      const opStarted = (id: string, command: string) =>
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make(id),
          toolName: "bash",
          input: { command },
          parentToolCallId: cellId,
        })
      const { activeTool, dispose } = openFeed(snapshotFor(sessionId, branchId), [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: cellId,
            toolName: "cell",
            input: { code: "await Promise.all([tools.bash(a), tools.bash(b)])" },
          }),
        ),
        makeEnvelope(3, opStarted("tool-call-ticks", "sleep 2; echo SLEPT")),
        makeEnvelope(4, opStarted("tool-call-asks", "git checkout HEAD -- README.md")),
      ])
      yield* waitUntil(() =>
        Option.exists(activeTool(), (label) => label.includes("git checkout")),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            // The asking op does not hide the one that runs on; the cell waits on both.
            const label = Option.getOrElse(activeTool(), () => "")
            expect(label).toContain("sleep 2")
            expect(label).toContain("git checkout")
            expect(label).not.toContain("cell")
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("an op still running when its cell fails reads as failed, as a reload draws it", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-interrupted-cell")
      const branchId = BranchId.make("branch-feed-interrupted-cell")
      const cellId = ToolCallId.make("tool-call-interrupted-cell")
      const opId = ToolCallId.make("tool-call-interrupted-op")
      const { cellOf, dispose } = openFeed(snapshotFor(sessionId, branchId), [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: cellId,
            toolName: "cell",
            input: { code: "await tools.bash({command: 'sleep 60'})" },
          }),
        ),
        makeEnvelope(
          3,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: opId,
            toolName: "bash",
            input: { command: "sleep 60" },
            parentToolCallId: cellId,
          }),
        ),
        makeEnvelope(
          4,
          AgentEvent.cases.ToolCallFailed.make({
            sessionId,
            branchId,
            toolCallId: cellId,
            toolName: "cell",
            summary: "The tool did not finish: the turn was interrupted.",
          }),
        ),
      ])
      yield* waitUntil(() => Option.exists(cellOf(), (cell) => cell.status === "error")).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const cell = Option.getOrUndefined(cellOf())
            expect(cell?.operations?.map((operation) => operation.status)).toEqual(["error"])
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("a live result on a reloaded op drops the cuts of the output it replaces", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-stale-cuts")
      const branchId = BranchId.make("branch-feed-stale-cuts")
      const cellId = ToolCallId.make("tool-call-stale-cuts-cell")
      const opId = ToolCallId.make("tool-call-stale-cuts-op")
      const cutOperation: NonNullable<ToolInteraction["operations"]>[number] = {
        id: opId,
        toolName: "bash",
        status: "running",
        input: { command: "seq 3000" },
        summary: Option.getOrUndefined(Option.none()),
        output: '{"stdout":"1\\n…\\n3000","stderr":"","exitCode":0}',
        durationMs: Option.getOrUndefined(Option.none()),
        cuts: [
          OutputCut.cases.Text.make({ field: "stdout", lines: 3000, tailLine: 3000, chars: 9 }),
        ],
      }
      const snapshot: SessionSnapshot = {
        ...snapshotFor(sessionId, branchId, 1),
        messages: [
          projectMessage(
            Message.cases.regular.make({
              id: MessageId.make("stale-cuts-assistant"),
              sessionId,
              branchId,
              role: "assistant",
              parts: [Prompt.textPart({ text: "" })],
              createdAt: dateFromMillis(0),
            }),
            [
              new ToolInteraction({
                id: cellId,
                toolName: "cell",
                status: "running",
                input: {},
                summary: Option.getOrUndefined(Option.none()),
                output: Option.getOrUndefined(Option.none()),
                durationMs: Option.getOrUndefined(Option.none()),
                operations: [cutOperation],
              }),
            ],
          ),
        ],
      }
      const wholeOutput = '{"stdout":"done","stderr":"","exitCode":0}'
      const { cellOf, dispose } = openFeed(snapshot, [
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: opId,
            toolName: "bash",
            summary: "exit 0 · 1 line",
            output: wholeOutput,
            parentToolCallId: cellId,
          }),
        ),
      ])
      yield* waitUntil(() =>
        Option.exists(cellOf(), (cell) => cell.operations?.[0]?.status === "completed"),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const operation = Option.getOrUndefined(cellOf())?.operations?.[0]
            expect(operation?.output).toBe(wholeOutput)
            expect(operation?.cuts).toBeUndefined()
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("replays buffered event-only state before the snapshot cursor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-buffered")
      const branchId = BranchId.make("branch-feed-buffered")
      const extensionId = ExtensionId.make("buffered-extension")
      const bufferedPulse = makeEnvelope(
        1,
        AgentEvent.cases.ExtensionStateChanged.make({ sessionId, branchId, extensionId }),
      )
      const bufferedInteraction = makeEnvelope(
        2,
        AgentEvent.cases.InteractionPresented.make({
          sessionId,
          branchId,
          requestId: InteractionRequestId.make("interaction-buffered"),
          text: "approve this",
          metadata: absent,
        }),
      )
      const bufferedBranchSwitch = makeEnvelope(
        3,
        AgentEvent.cases.BranchSwitched.make({
          sessionId,
          fromBranchId: branchId,
          toBranchId: BranchId.make("historical-other-branch"),
        }),
      )
      const liveEvent = makeEnvelope(
        4,
        AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
      )
      const interactionSeen = yield* Deferred.make<ActiveInteraction>()
      const liveSeen = yield* Deferred.make<void>()
      let requestedAfter: Option.Option<number> = Option.none()
      const bufferedTags: string[] = []
      const branchSwitches: Array<{ sessionId: SessionId; branchId: BranchId }> = []

      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId, 3)),
              events: ({ after }: { readonly after?: number }) => {
                requestedAfter = Option.fromNullishOr(after)
                return Stream.concat(
                  Stream.make(bufferedPulse, bufferedInteraction, bufferedBranchSwitch, liveEvent),
                  Stream.never,
                )
              },
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: (envelope) => {
            if (envelope.id === liveEvent.id)
              client.runtime.cast(Deferred.succeed(liveSeen, void 0))
          },
          applyBufferedSessionEvent: (envelope) => {
            bufferedTags.push(envelope.event._tag)
          },
        } satisfies FeedClient

        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          client.runtime.cast,
          {
            onInteraction: (interaction) => {
              client.runtime.cast(Deferred.succeed(interactionSeen, interaction))
            },
            onInteractionDismissed: () => {},
            onBranchSwitch: (nextSessionId, nextBranchId) => {
              branchSwitches.push({ sessionId: nextSessionId, branchId: nextBranchId })
            },
            onQueueSnapshot: () => {},
          },
        )
        return disposeRoot
      })

      const interaction = yield* Deferred.await(interactionSeen)
      yield* Deferred.await(liveSeen)
      yield* Effect.sync(() => {
        expect(Option.getOrElse(requestedAfter, () => -1)).toBe(0)
        expect(bufferedTags).toEqual(["ExtensionStateChanged", "InteractionPresented"])
        expect(interaction.requestId).toBe(InteractionRequestId.make("interaction-buffered"))
        expect(branchSwitches).toEqual([])
        dispose()
      })
    }),
  )

  for (const saved of [false, true]) {
    it.live(`keeps answers and tools with their owning message (saved: ${saved})`, () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-feed-compaction-live")
        const branchId = BranchId.make("branch-feed-compaction-live")
        const inputId = MessageId.make("first-input")
        const nextInputId = MessageId.make("follow-up-input")
        const toolCallId = ToolCallId.make("first-stream-tool")
        const events = [
          AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 1 }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "First " }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "answer" }),
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId,
            toolName: "cell",
            input: {},
          }),
          AgentEvent.cases.StreamEnded.make({ sessionId, branchId }),
          AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 2 }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "Next step" }),
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId,
            toolName: "cell",
            summary: "done",
            output: "result",
          }),
          AgentEvent.cases.TurnCompleted.make({
            sessionId,
            branchId,
            messageId: inputId,
            durationMs: 0,
          }),
          AgentEvent.cases.StreamStarted.make({
            sessionId,
            branchId,
            messageId: nextInputId,
            step: 1,
          }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "Follow-up " }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "answer" }),
          AgentEvent.cases.TurnCompleted.make({
            sessionId,
            branchId,
            messageId: nextInputId,
            durationMs: 0,
          }),
        ]
        // The snapshot projects a cell's operations from the branch's stored receipts.
        const savedOperation: NonNullable<ToolInteraction["operations"]>[number] = {
          id: ToolCallId.make("saved-read-op"),
          toolName: "read",
          status: "completed",
          input: { path: "a.md" },
          summary: "3 lines",
          output: "one",
          durationMs: 30,
        }
        let snapshot = snapshotFor(sessionId, branchId)
        if (saved) {
          const messages = [
            { id: assistantMessageIdForTurn(inputId, 1), text: "First answer" },
            { id: assistantMessageIdForTurn(inputId, 2), text: "Next step" },
            { id: assistantMessageIdForTurn(nextInputId, 1), text: "Follow-up answer" },
          ].map(({ id, text }, index) => {
            const calls: ToolInteraction[] = []
            if (index === 0)
              calls.push(
                new ToolInteraction({
                  id: toolCallId,
                  toolName: "cell",
                  status: "completed",
                  input: {},
                  summary: "done",
                  output: "result",
                  durationMs: 1_200,
                  operations: [savedOperation],
                }),
              )
            return projectMessage(
              Message.cases.regular.make({
                id,
                sessionId,
                branchId,
                role: "assistant",
                parts: [Prompt.textPart({ text })],
                createdAt: dateFromMillis(index),
              }),
              calls,
            )
          })
          snapshot = { ...snapshot, lastEventId: events.length, messages }
        }
        let applied = 0
        let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
        const dispose = createRoot((disposeRoot) => {
          const [active] = createSignal(makeSession(sessionId, branchId))
          const client = {
            sessionIdentity: identityOf(active),
            client: createMockClient({
              session: {
                getSnapshot: () => Effect.succeed(snapshot),
                events: () =>
                  Stream.concat(
                    Stream.make(
                      ...events.map((event, index) => makeEnvelope(index + 1, event, index * 300)),
                    ),
                    Stream.never,
                  ),
                watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
              },
            }),
            runtime: createMockRuntime(),
            log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            setConnectionIssue: () => {},
            waitForTransportReady: Effect.void,
            applySessionRuntime: () => {},
            applySessionSnapshot: () => {},
            applySessionEvent: () => {
              applied += 1
            },
            applyBufferedSessionEvent: () => {
              applied += 1
            },
          } satisfies FeedClient
          feed = Option.some(
            useSessionFeed(
              () => sessionId,
              () => branchId,
              client,
              client.runtime.cast,
              {
                onInteraction: () => {},
                onInteractionDismissed: () => {},
                onBranchSwitch: () => {},
                onQueueSnapshot: () => {},
              },
            ),
          )
          return disposeRoot
        })

        yield* waitUntil(
          () =>
            applied === events.length &&
            Option.isSome(feed) &&
            feed.value.messages().some((message) => message.content.includes("Follow-up answer")),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (Option.isNone(feed)) return
              const messages = feed.value.messages()
              expect(messages.map((message) => message.content)).toEqual([
                "First answer",
                "Next step",
                "Follow-up answer",
              ])
              expect(messages.map((message) => message.id)).toEqual([
                assistantMessageIdForTurn(inputId, 1),
                assistantMessageIdForTurn(inputId, 2),
                assistantMessageIdForTurn(nextInputId, 1),
              ])
              expect(messages[0]?.toolCalls?.[0]?.status).toBe("completed")
              // A saved interaction keeps the duration the snapshot projected from receipts.
              expect(messages[0]?.toolCalls?.[0]?.durationMs).toBe(1_200)
              if (saved) {
                // After a reload the cell draws its operations, not only its receipts.
                expect(messages[0]?.toolCalls?.[0]?.operations).toEqual([savedOperation])
              }
              expect(messages[1]?.toolCalls).toBeUndefined()
              expect(messages[2]?.toolCalls).toBeUndefined()
            }),
          ),
          Effect.ensuring(Effect.sync(dispose)),
        )
      }),
    )
  }

  it.live("starts a late tool call on the message the event names, not the newest one", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-late-tool")
      const branchId = BranchId.make("branch-feed-late-tool")
      const inputId = MessageId.make("late-tool-input")
      const firstAnswerId = assistantMessageIdForTurn(inputId, 1)
      const secondAnswerId = assistantMessageIdForTurn(inputId, 2)
      const lateToolCallId = ToolCallId.make("late-tool-call")
      const events = [
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 1 }),
        AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "First answer" }),
        AgentEvent.cases.StreamEnded.make({ sessionId, branchId }),
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 2 }),
        AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "Second answer" }),
        // The first step's tool receipt arrives after the second step began.
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: lateToolCallId,
          toolName: "read",
          input: {},
          assistantMessageId: firstAnswerId,
        }),
      ]
      let applied = 0
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(
                    ...events.map((event, index) => makeEnvelope(index + 1, event, index * 100)),
                  ),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: () => {
            applied += 1
          },
          applyBufferedSessionEvent: () => {
            applied += 1
          },
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            client.runtime.cast,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          applied === events.length &&
          Option.isSome(feed) &&
          feed.value.messages().length === 2 &&
          feed.value.messages().some((message) => Predicate.isNotUndefined(message.toolCalls)),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (Option.isNone(feed)) return
            const messages = feed.value.messages()
            const first = messages.find((message) => message.id === firstAnswerId)
            const second = messages.find((message) => message.id === secondAnswerId)
            expect(first?.toolCalls?.map((call) => call.id)).toEqual([lateToolCallId])
            expect(second?.toolCalls).toBe(absent)
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("shows a live compaction message as soon as its event arrives", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-live")
      const branchId = BranchId.make("branch-feed-compaction-live")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({
          message: makeCompactionMessage(sessionId, branchId),
        }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "native response",
        }),
      )
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(messageEnvelope, streamStartedEnvelope, streamChunkEnvelope),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: () => {},
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            client.runtime.cast,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.content.includes("native response")),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      expect(feed.value.messages()).toHaveLength(2)
      const summary = feed.value
        .messages()
        .find((message) => message.metadata?.customType === "context-window")
      const response = feed.value
        .messages()
        .find((message) => message.content.includes("native response"))
      expect(summary?.content).toBe("Context handoff: stored summary")
      expect(response?.id).toBeDefined()
      expect(response?.id).not.toBe(summary?.id)
      expect(response?.content).toBe("native response")
      dispose()
    }),
  )

  it.live("shows a live notice separately from later model output", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-live")
      const branchId = BranchId.make("branch-feed-compaction-live")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({
          message: {
            ...makeCompactionMessage(sessionId, branchId),
            metadata: { customType: "prompt-present", hidden: true },
          },
        }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "native response",
        }),
      )
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(messageEnvelope, streamStartedEnvelope, streamChunkEnvelope),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: () => {},
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            client.runtime.cast,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.content.includes("native response")),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      expect(feed.value.messages()).toHaveLength(2)
      const summary = feed.value
        .messages()
        .find((message) => message.metadata?.customType === "prompt-present")
      const response = feed.value
        .messages()
        .find((message) => message.content.includes("native response"))
      expect(summary?.content).toBe("Context handoff: stored summary")
      expect(response?.id).toBeDefined()
      expect(response?.id).not.toBe(summary?.id)
      expect(response?.content).toBe("native response")
      dispose()
    }),
  )

  it.live("reconstructs retry history and completion state during reload", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-reload")
      const branchId = BranchId.make("branch-feed-compaction-reload")
      const retryEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.ProviderRetrying.make({
          sessionId,
          branchId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          error: "temporary provider failure",
        }),
      )
      const interruptedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
          interrupted: true,
        }),
      )
      // The handoff marker is a durable user message, so a reload reads it
      // from the snapshot rather than from the buffered event stream.
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () =>
                Effect.succeed({
                  ...snapshotFor(sessionId, branchId, 3),
                  messages: [projectMessage(makeCompactionMessage(sessionId, branchId), [])],
                }),
              events: () =>
                Stream.concat(Stream.make(retryEnvelope, interruptedEnvelope), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionRuntime: () => {},
          applySessionSnapshot: () => {},
          applySessionEvent: () => {},
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            client.runtime.cast,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.items().some((item) => item._tag === "interruption") &&
          feed.value
            .messages()
            .some((message) => message.metadata?.customType === "context-window"),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      const retry = feed.value.items().find((item) => item._tag === "retrying")
      expect(retry?._tag === "retrying" && retry.resolved).toBe(true)
      expect(feed.value.items().some((item) => item._tag === "interruption")).toBe(true)
      expect(feed.value.messages()[0]?.content).toContain("stored summary")
      dispose()
    }),
  )
})
