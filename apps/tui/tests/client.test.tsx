/** @jsxImportSource @opentui/solid */
import {
  emptyQueueSnapshot,
  testAgent,
  ErrorOccurred,
  EventId,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
} from "@gent/core/test-utils"
import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Exit, Option, Predicate, Schema } from "effect"
import {
  AgentEvent,
  AgentName,
  BranchId,
  ConnectionState,
  dateFromMillis,
  EventEnvelope,
  GentRpcError,
  Message,
  Model,
  MessageId,
  ModelId,
  ProviderId,
  SessionId,
  type SessionSnapshot,
  type ReasoningEffort,
  type UpdateSessionSettingsInput,
} from "@gent/core/protocol"
import { ExtensionId } from "@gent/core/extensions/api"
import {
  type ClientContextValue,
  reduceAgentLifecycle,
  SteerCommandInput,
  SessionStateEvent,
  transitionSessionState,
  useClient,
  useRuntime,
} from "../src/client"
import { createSignal, onMount, Show } from "solid-js"
import {
  createMockClient,
  createMutableRuntime,
  defaultTestSession,
  renderScoped,
} from "./render-harness-boundary"
import { inRuntime, waitForFrame, waitUntil } from "./helpers-boundary"
import { useExtensionUI } from "../src/extensions/host"
import { ClientContext, type ClientRuntime } from "../src/extensions/client-facets"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import { SocketCloseError } from "effect/socket/Socket"

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
  test("a stream start says a turn runs", () => {
    const event = StreamStarted.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
    })

    expect(reduceAgentLifecycle(event).running).toEqual(Option.some(true))
    expect(reduceAgentLifecycle(event).error).toEqual(Option.none())
  })

  test("the turn runs until TurnCompleted", () => {
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

    expect(reduceAgentLifecycle(streamEnded).running).toEqual(Option.none())
    expect(reduceAgentLifecycle(assistantMessage).running).toEqual(Option.none())
    expect(reduceAgentLifecycle(turnCompleted).running).toEqual(Option.some(false))
  })

  test("a user message starts the turn at once", () => {
    const userMessage = MessageReceived.make({
      message: makeMessage("user"),
    })

    expect(reduceAgentLifecycle(userMessage).running).toEqual(Option.some(true))
  })

  test("an error shows and leaves the turn as it is", () => {
    const errored = ErrorOccurred.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      error: "boom",
    })

    expect(reduceAgentLifecycle(errored).error).toEqual(Option.some("boom"))
    expect(reduceAgentLifecycle(errored).running).toEqual(Option.none())
  })

  test("a notice shows no error", () => {
    const notice = ErrorOccurred.make({
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      error: "compaction fell back to truncation",
      notice: true,
    })

    expect(reduceAgentLifecycle(notice).error).toEqual(Option.none())
    expect(reduceAgentLifecycle(notice).running).toEqual(Option.none())
  })
})

// ── session settings state ──────────────────────────────────────────────────

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined

const active = {
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  name: "S",
  modelId: absent,
  reasoningLevel: "high" as const,
  cwd: absent,
}

describe("session settings", () => {
  test("an update replaces both settings at once", () => {
    const next = transitionSessionState(
      active,
      SessionStateEvent.cases.UpdateSettings.make({
        modelId: ModelId.make("openai/gpt-5.6-luna"),
        reasoningLevel: absent,
      }),
    )
    expect(next).toMatchObject({
      modelId: ModelId.make("openai/gpt-5.6-luna"),
      reasoningLevel: absent,
    })
    expect(next.name).toBe("S")
  })
})

// ── client provider contract ────────────────────────────────────────────────

/**
 * What a consumer of `ClientProvider` reads: a value it holds reports every
 * later write, a session switch resets the turn state, and a late subscriber
 * to session events first receives what the feed already delivered.
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

const settle = (setup: Effect.Success<ReturnType<typeof renderScoped>>) =>
  Effect.promise(() => setup.renderOnce())

describe("ClientProvider contract", () => {
  it.scopedLive("a value held across a write reports the write, never the merge", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(() => (
        <Probe onReady={(value) => (held = Option.some(value))} />
      ))
      yield* settle(setup)

      // Captured before the write. The old split let this object keep the
      // session accessor from one context and the agent accessor from
      // another, so a consumer that stored it could observe a session the
      // rest of the tree had already left.
      const captured = yield* requireValue(held, "consumer never mounted")
      expect(captured.session().sessionId).toBe(defaultTestSession.sessionId)

      const sessionId = SessionId.make("contract-session")
      const branchId = BranchId.make("contract-branch")
      captured.switchSession(sessionId, branchId, "Contract")
      yield* settle(setup)

      const observed = captured.session()
      expect(observed.sessionId).toBe(sessionId)
      expect(observed.branchId).toBe(branchId)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a session switch clears the error, the stream and the cost", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(() => (
        <Probe onReady={(value) => (held = Option.some(value))} />
      ))
      yield* settle(setup)

      const client = yield* requireValue(held, "consumer never mounted")

      let seen = 0
      const unsubscribe = client.onSessionEvent(() => {
        seen = seen + 1
      })
      expect(client.isReconnecting()).toBe(false)
      expect(client.isError()).toBe(false)
      expect(client.isStreaming()).toBe(false)

      client.setError("contract failure")
      expect(client.isError()).toBe(true)
      expect(client.error()).toEqual(Option.some("contract failure"))

      client.switchSession(SessionId.make("facet-session"), BranchId.make("facet-branch"), "Facets")
      yield* settle(setup)
      expect(client.isError()).toBe(false)
      expect(client.isStreaming()).toBe(false)
      expect(client.cost()).toBe(0)

      unsubscribe()
      expect(seen).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a late session-event subscriber first receives what the feed delivered", () =>
    Effect.gen(function* () {
      let held = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(() => (
        <Probe onReady={(value) => (held = Option.some(value))} />
      ))
      yield* settle(setup)
      const client = yield* requireValue(held, "consumer never mounted")
      const envelope = (id: number) =>
        EventEnvelope.make({
          id: EventId.make(id),
          createdAt: id,
          event: AgentEvent.cases.StreamStarted.make({
            sessionId: SessionId.make("late-session"),
            branchId: BranchId.make("late-branch"),
          }),
        })
      client.applyBufferedSessionEvent(envelope(1))
      client.applySessionEvent(envelope(2))
      const seen: Array<number> = []
      const unsubscribe = client.onSessionEvent((delivered) => seen.push(delivered.id))
      expect(seen).toEqual([1, 2])
      client.applySessionEvent(envelope(3))
      expect(seen).toEqual([1, 2, 3])
      unsubscribe()
      // The feed opened on another branch: a subscriber from now on starts empty.
      client.resetSessionEvents()
      const after: Array<number> = []
      const unsubscribeAfter = client.onSessionEvent((delivered) => after.push(delivered.id))
      expect(after).toEqual([])
      unsubscribeAfter()
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

// eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
const nullValue = null

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
/** The model the server resolves for the first session only. */
const firstResolvedModel = ModelId.make("anthropic/first-session-model")

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
  agent: AgentName.make("primary"),
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
  it.scopedLive("switching sessions drops the previous session's context projection", () =>
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
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />,
        {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
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
    }),
  )

  it.scopedLive("a route reply that arrives after a session switch is dropped", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const held = yield* Deferred.make<ModelId>()
      const asked: Array<string> = []
      const client = createMockClient({
        session: {
          get: (input: { sessionId: SessionId }) => {
            asked.push(String(input.sessionId))
            const view = (resolvedModelId: ModelId) => ({
              id: input.sessionId,
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
              resolvedModelId,
            })
            // Hold the first session's reply open so the switch lands first.
            if (input.sessionId === FIRST.sessionId)
              return Deferred.await(held).pipe(Effect.map(view))
            return Effect.succeed(view(ModelId.make("anthropic/second-session-model")))
          },
          getSnapshot: () =>
            Effect.succeed(snapshotOf(SECOND, { costUsd: 0, lastInputTokens: 0, context: absent })),
        },
      })
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />,
        {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      )
      const clientContext = yield* requireClient(ctx)

      // The product path: a settings change reads what the server resolves.
      // Its reply stays in flight because the mock holds this session's answer.
      clientContext.applySessionEvent(
        EventEnvelope.make({
          id: EventId.make(1),
          createdAt: 0,
          event: AgentEvent.cases.SessionSettingsUpdated.make({ sessionId: FIRST.sessionId }),
        }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toContain(String(FIRST.sessionId))

      clientContext.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      yield* Effect.promise(() => setup.renderOnce())
      expect(clientContext.model()).not.toBe(firstResolvedModel)

      // The first session's reply lands now, naming a session nobody is on.
      yield* Deferred.succeed(held, firstResolvedModel)
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())

      // The first session's model does not come back.
      expect(clientContext.model()).not.toBe(firstResolvedModel)
    }),
  )

  it.scopedLive("live events move the totals on the snapshot's, with no snapshot read", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let reads = 0
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.sync(() => {
              reads += 1
              return snapshotOf(FIRST, { costUsd: 1, lastInputTokens: 9_000, context: busyContext })
            }),
        },
      })
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />,
        {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      )
      const clientContext = yield* requireClient(ctx)
      clientContext.applySessionSnapshot(
        snapshotOf(FIRST, { costUsd: 1, lastInputTokens: 9_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      const readsAfterHydrate = reads
      const live = (id: number, event: AgentEvent) =>
        clientContext.applySessionEvent(
          EventEnvelope.make({ id: EventId.make(id), createdAt: 0, event }),
        )

      // A new step's projection moves the gauge before the step ends.
      live(
        10,
        AgentEvent.cases.ModelContextProjected.make({
          sessionId: FIRST.sessionId,
          branchId: FIRST.branchId,
          estimatedTokens: 95_000,
          availableInputTokens: 5_000,
          contextLimitTokens: 100_000,
          omittedMessages: 0,
          compacted: false,
        }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(
        Option.map(clientContext.sessionMetrics().context, (context) => context.estimatedTokens),
      ).toEqual(Option.some(95_000))
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)

      live(
        11,
        AgentEvent.cases.StreamEnded.make({
          sessionId: FIRST.sessionId,
          branchId: FIRST.branchId,
          usage: { inputTokens: 96_000, outputTokens: 10 },
          costUsd: 0.5,
        }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(clientContext.cost()).toBe(1.5)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(96_000)
      expect(reads).toBe(readsAfterHydrate)
    }),
  )

  it.scopedLive("a finished turn reads the model the next turn resolves to, once", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let reads = 0
      let snapshotReads = 0
      // The project config changes during the turn; the server resolves the new model.
      let resolvedModelId = ModelId.make("anthropic/claude-sonnet-5")
      const configModel = ModelId.make("anthropic/config-changed-model")
      // The route is a narrow read: the snapshot, with every message, is not
      // read again at a turn's end.
      const client = createMockClient({
        session: {
          get: () =>
            Effect.sync(() => {
              reads += 1
              return {
                id: FIRST.sessionId,
                activeBranchId: FIRST.branchId,
                createdAt: dateFromMillis(0),
                updatedAt: dateFromMillis(0),
                resolvedModelId,
              }
            }),
          getSnapshot: () =>
            Effect.sync(() => {
              snapshotReads += 1
              return snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 })
            }),
        },
      })
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />,
        {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      )
      const clientContext = yield* requireClient(ctx)
      clientContext.applySessionSnapshot(snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }))
      yield* Effect.promise(() => setup.renderOnce())
      const readsAfterHydrate = reads
      const snapshotReadsAfterHydrate = snapshotReads
      const live = (id: number, event: AgentEvent) =>
        clientContext.applySessionEvent(
          EventEnvelope.make({ id: EventId.make(id), createdAt: 0, event }),
        )
      resolvedModelId = configModel
      // Two steps end: neither reads the route.
      for (const id of [10, 11]) {
        live(
          id,
          AgentEvent.cases.StreamEnded.make({
            sessionId: FIRST.sessionId,
            branchId: FIRST.branchId,
          }),
        )
      }
      expect(reads).toBe(readsAfterHydrate)
      live(
        12,
        AgentEvent.cases.TurnCompleted.make({
          sessionId: FIRST.sessionId,
          branchId: FIRST.branchId,
          durationMs: 10,
        }),
      )
      yield* waitUntil(() => clientContext.model() === configModel, "the next turn's model")
      expect(reads).toBe(readsAfterHydrate + 1)
      expect(snapshotReads).toBe(snapshotReadsAfterHydrate)
    }).pipe(Effect.timeout("4 seconds")),
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
  it.scopedLive("a new session carries the workspace cwd and becomes the active one", () =>
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
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        {
          client,
          cwd: workspaceCwd,
        },
      )
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      const active = ctx.value
      active.createSession()
      yield* waitForFrame(
        setup,
        () => active.session().sessionId === createdSessionId,
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
  // A handoff continues its parent's thread, so it works in the parent's
  // directory, not the one gent was launched in.
  it.scopedLive("a handoff creates its session in the current session's cwd", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const createInputs: Array<{ cwd?: string }> = []
      const client = createMockClient({
        session: {
          get: () =>
            Effect.succeed({
              id: SessionId.make("session-parent"),
              name: "Parent",
              cwd: "/work/parent",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            }),
          create: (input: { cwd?: string }) =>
            Effect.sync(() => {
              createInputs.push(input)
              return {
                sessionId: SessionId.make("session-handoff"),
                branchId: BranchId.make("branch-handoff"),
                name: "Handoff",
              }
            }),
        },
      })
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        {
          client,
          cwd: "/work/launch",
          initialSession: {
            id: SessionId.make("session-parent"),
            activeBranchId: BranchId.make("branch-parent"),
            name: "Parent",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      )
      const active = yield* requireClientSessionState(ctx)
      active.openHandoffSession("the summary")
      yield* waitForFrame(
        setup,
        () => active.session().sessionId === SessionId.make("session-handoff"),
        "handoff session active",
      )
      expect(createInputs.map((input) => input.cwd)).toEqual(["/work/parent"])
      expect(active.session().cwd).toEqual("/work/parent")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "a new session takes its agent from its snapshot, never from the session before it",
    () =>
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
        const setup = yield* renderScoped(
          () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
          {
            client,
            initialSession: {
              id: SessionId.make("session-resumed"),
              activeBranchId: BranchId.make("branch-resumed"),
              name: "Resumed",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialAgent: AgentName.make("secondary"),
          },
        )
        if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
        const active = ctx.value
        expect(active.agent()).toEqual(Option.some(AgentName.make("secondary")))
        active.createSession()
        yield* waitForFrame(
          setup,
          () => active.session().sessionId === SessionId.make("session-new"),
          "new session active",
        )
        // No guess before the snapshot: a handoff inherits its parent's agent,
        // so assuming the default would flicker.
        expect(active.agent()).toEqual(Option.none())
        active.applySessionSnapshot({
          sessionId: SessionId.make("session-new"),
          branchId: BranchId.make("branch-new"),
          messages: [],
          lastEventId: 1,
          reasoningLevel: absent,
          resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
          agent: AgentName.make("secondary"),
          runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
          metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
        })
        expect(active.agent()).toEqual(Option.some(AgentName.make("secondary")))
      }),
  )
  // A create answers late. Only the latest navigation may take the view: a
  // create that a later /new or session switch has overtaken is dropped.
  it.scopedLive("a create a later navigation overtook does not take the view", () =>
    Effect.gen(function* () {
      const created = (n: number) => ({
        sessionId: SessionId.make(`session-created-${n}`),
        branchId: BranchId.make(`branch-created-${n}`),
        name: `Created ${n}`,
      })
      // Each create waits for its gate, then marks that it answered.
      const pending = yield* Effect.forEach([0, 1, 2], () =>
        Effect.all({ gate: Deferred.make<void>(), answered: Deferred.make<void>() }),
      )
      let calls = 0
      const client = createMockClient({
        session: {
          create: () => {
            const n = calls++
            return Option.match(Option.fromUndefinedOr(pending[n]), {
              onNone: () => Effect.succeed(created(n)),
              onSome: ({ gate, answered }) =>
                Deferred.await(gate).pipe(
                  Effect.andThen(Deferred.done(answered, Exit.void)),
                  Effect.as(created(n)),
                ),
            })
          },
        },
      })
      const release = (n: number) =>
        Option.match(Option.fromUndefinedOr(pending[n]), {
          onNone: () => Effect.die(`no create ${n}`),
          onSome: ({ gate, answered }) =>
            Deferred.done(gate, Exit.void).pipe(Effect.andThen(Deferred.await(answered))),
        })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        { client },
      )
      const active = yield* requireClientSessionState(ctx)
      const inView = () => active.session().sessionId
      // Two /new: the second answers first and takes the view; the first
      // answers after it and must not take the view back.
      active.createSession()
      active.createSession()
      yield* waitUntil(() => calls === 2, "both creates sent")
      yield* release(1)
      yield* waitForFrame(setup, () => inView() === created(1).sessionId, "the second create")
      yield* release(0)
      yield* Effect.promise(() => setup.renderOnce())
      expect(inView()).toEqual(created(1).sessionId)
      // A switch while a create is pending wins over the create's answer.
      active.createSession()
      yield* waitUntil(() => calls === 3, "the third create sent")
      const chosen = SessionId.make("session-chosen")
      active.switchSession(chosen, BranchId.make("branch-chosen"), "Chosen")
      yield* release(2)
      yield* Effect.promise(() => setup.renderOnce())
      expect(inView()).toEqual(chosen)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // An overtaken create's failure belongs to the session the reader left:
  // the one now in view shows nothing of it.
  it.scopedLive("a create a later navigation overtook drops its failure too", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const refused = yield* Schema.decodeEffect(GentRpcError)({
        _tag: "InvalidStateError",
        message: "create refused",
      })
      const client = createMockClient({
        session: {
          create: () =>
            Deferred.await(gate).pipe(
              Effect.andThen(Deferred.done(answered, Exit.void)),
              Effect.andThen(Effect.fail(refused)),
            ),
        },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        { client },
      )
      const active = yield* requireClientSessionState(ctx)
      active.createSession()
      const chosen = SessionId.make("session-chosen")
      active.switchSession(chosen, BranchId.make("branch-chosen"), "Chosen")
      yield* Deferred.done(gate, Exit.void)
      yield* Deferred.await(answered)
      yield* Effect.promise(() => setup.renderOnce())
      expect(active.session().sessionId).toEqual(chosen)
      expect(active.error()).toEqual(Option.none())
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("choosing the session already in view keeps its settings, status and metrics", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClientSessionState(ctx)
      const model = ModelId.make("openai/gpt-5.6-luna")
      client.applySessionSnapshot({
        ...snapshotOf(FIRST, { costUsd: 1.5, lastInputTokens: 9_000, context: busyContext }),
        modelId: model,
        reasoningLevel: "high",
        runtime: { _tag: "Running", queue: emptyQueueSnapshot(), startedAtMs: 0 },
      })
      client.switchSession(FIRST.sessionId, FIRST.branchId, "First")
      const session = client.session()
      expect(session).toMatchObject({ modelId: model, reasoningLevel: "high" })
      expect(client.isStreaming()).toBe(true)
      expect(client.cost()).toBe(1.5)
      expect(client.agent()).toEqual(Option.some(AgentName.make("primary")))
      expect(client.sessionMetrics().latestInputTokens).toBe(9_000)
      expect(Option.isSome(client.sessionMetrics().context)).toBe(true)
    }),
  )
  it.scopedLive(
    "a branch switch event moves to the new branch with the old branch's metrics dropped",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        })
        const client = yield* requireClientSessionState(ctx)
        client.applySessionSnapshot({
          ...snapshotOf(FIRST, { costUsd: 1.5, lastInputTokens: 9_000, context: busyContext }),
          runtime: { _tag: "Running", queue: emptyQueueSnapshot(), startedAtMs: 0 },
        })
        const nextBranch = BranchId.make("branch-metrics-next")
        // The feed's order: the event goes to the client, then the feed routes.
        client.applySessionEvent(
          makeEnvelope(
            1,
            AgentEvent.cases.BranchSwitched.make({
              sessionId: FIRST.sessionId,
              fromBranchId: FIRST.branchId,
              toBranchId: nextBranch,
            }),
          ),
        )
        client.switchSession(FIRST.sessionId, nextBranch, "First")
        expect(client.session().branchId).toEqual(nextBranch)
        expect(client.isStreaming()).toBe(false)
        expect(client.cost()).toBe(0)
        expect(Option.isNone(client.sessionMetrics().context)).toBe(true)
      }),
  )
  it.scopedLive("a settings change sends only the field it names", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const sent: Array<UpdateSessionSettingsInput> = []
      const low: ReasoningEffort = "low"
      const client = createMockClient({
        session: {
          updateSettings: (input: UpdateSessionSettingsInput) =>
            Effect.sync(() => {
              sent.push(input)
              return { modelId: ModelId.make("openai/gpt-5.6-luna"), reasoningLevel: low }
            }),
        },
      })
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        client,
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const active = yield* requireClientSessionState(ctx)
      // Just switched: the session's model is not known here yet.
      active.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      yield* active.updateSessionSettings({ reasoningLevel: Option.some("low") })
      expect(sent).toEqual([{ sessionId: SECOND.sessionId, reasoningLevel: Option.some("low") }])
      expect(active.session().modelId).toEqual(ModelId.make("openai/gpt-5.6-luna"))
    }),
  )
  it.scopedLive("runtime idle clears finishing activity only for the current branch", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const sessionId = SessionId.make("session-runtime-idle")
      const branchId = BranchId.make("branch-runtime-idle")
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: sessionId,
          activeBranchId: branchId,
          name: "Runtime",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClientSessionState(ctx)
      client.applySessionSnapshot({
        sessionId,
        branchId,
        messages: [],
        lastEventId: 42,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("main"),
        runtime: { _tag: "Running", queue: emptyQueueSnapshot(), startedAtMs: 0 },
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
  it.scopedLive("an extension notice keeps the running turn and the standing error", () =>
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
      yield* renderScoped(() => <NoticeProbe />, {
        initialSession: {
          id: sessionId,
          activeBranchId: branchId,
          name: "Notice",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
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
        runtime: { _tag: "Running", queue: emptyQueueSnapshot(), startedAtMs: 0 },
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
      expect(client.error()).toEqual(Option.some("provider refused the request"))
      expect(client.notice()).toEqual(Option.some('Unknown driver "nope".'))
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("model list failures surface as agent errors", () =>
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
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        {
          client: mockClient,
        },
      )
      const client = yield* requireClientSessionState(ctx)
      yield* waitForFrame(setup, () => Option.isSome(client.error()), "agent error")
      expect(client.error()).toEqual(Option.some("Driver openai: catalog filter failed"))
    }),
  )
  it.scopedLive("a model catalog that failed to load is read again after a reconnect", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let listings = 0
      const lifecycle = createMutableRuntime(
        ConnectionState.cases.Connected.make({ generation: 0 }),
      )
      const mockClient = createMockClient({
        model: {
          list: () =>
            Effect.suspend(() => {
              listings += 1
              if (listings === 1) {
                return Effect.fail({ _tag: "DriverError", driver: "openai", reason: "dropped" })
              }
              return Effect.succeed([])
            }),
        },
      })
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        client: mockClient,
        runtime: lifecycle.runtime,
      })
      const client = yield* requireClientSessionState(ctx)
      yield* waitUntil(() => Option.isSome(client.error()), "the failed load")
      lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
      lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
      yield* waitUntil(() => listings === 2, "the reconnect reads the catalog again")
      expect(listings).toBe(2)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a classifier model in the catalog is not offered as a chat model", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const chat = Model.make({
        id: ModelId.make("anthropic/sonnet"),
        name: "Sonnet",
        provider: ProviderId.make("anthropic"),
      })
      const classifier = Model.make({
        id: ModelId.make("typesafe/jev-latest"),
        name: "Jev",
        provider: ProviderId.make("typesafe"),
        kind: "classifier",
      })
      const mockClient = createMockClient({
        model: { list: () => Effect.succeed([chat, classifier]) },
        driver: {
          list: () =>
            Effect.succeed({
              drivers: [{ id: "anthropic" }, { id: "typesafe" }],
              overrides: {},
              agents: [testAgent],
            }),
        },
      })
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        client: mockClient,
      })
      const client = yield* requireClientSessionState(ctx)
      yield* waitUntil(() => Option.isSome(client.modelCatalog()), "the catalog load")
      expect(client.models().map((model) => model.id)).toEqual([chat.id])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "extension health reads again on a settings change or an extension pulse, not a rename",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        const healthReads: Array<Option.Option<SessionId>> = []
        const mockClient = createMockClient({
          session: {
            updateSettings: () =>
              Effect.succeed({
                modelId: ModelId.make("openai/gpt-5.6-luna"),
                reasoningLevel: absent,
              }),
          },
          extension: {
            listStatus: (input: { readonly sessionId?: SessionId }) =>
              Effect.sync(() => {
                healthReads.push(Option.fromUndefinedOr(input.sessionId))
                return { _tag: "Healthy" satisfies "Healthy", extensions: [] }
              }),
          },
        })
        yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          client: mockClient,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        })
        const client = yield* requireClientSessionState(ctx)
        yield* waitUntil(() => healthReads.length === 1, "the mount read")
        const pulse = (id: number, event: EventEnvelope["event"]) =>
          client.applySessionEvent(
            EventEnvelope.make({ id: EventId.make(id), createdAt: 0, event }),
          )
        // A rename changes nothing health reads.
        pulse(
          1,
          AgentEvent.cases.SessionNameUpdated.make({ sessionId: FIRST.sessionId, name: "Renamed" }),
        )
        expect(client.session().name).toEqual("Renamed")
        yield* client.updateSessionSettings({ modelId: Option.none() })
        expect(client.session().modelId).toEqual(ModelId.make("openai/gpt-5.6-luna"))
        // A settings change can change what an extension reports; so can its own pulse.
        yield* waitUntil(() => healthReads.length === 2, "the settings change reads health")
        pulse(
          2,
          AgentEvent.cases.ExtensionStateChanged.make({
            sessionId: FIRST.sessionId,
            branchId: FIRST.branchId,
            extensionId: ExtensionId.make("health-pulse"),
          }),
        )
        yield* waitUntil(() => healthReads.length === 3, "the extension pulse reads health")
        client.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
        yield* waitUntil(
          () => healthReads.some((read) => Option.contains(read, SECOND.sessionId)),
          "the switch reads the next session's health",
        )
        expect(healthReads).toEqual([
          Option.some(FIRST.sessionId),
          Option.some(FIRST.sessionId),
          Option.some(FIRST.sessionId),
          Option.some(SECOND.sessionId),
        ])
      }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "a failing RPC through surfaceError lands the formatted text in the error line",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        const mockClient = createMockClient({
          branch: {
            create: () => Effect.fail({ _tag: "NotFoundError", message: "branch gone" }),
          },
        })
        yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          client: mockClient,
          initialSession: {
            id: SessionId.make("session-surface"),
            activeBranchId: BranchId.make("branch-surface"),
            name: "Surface",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        })
        const client = yield* requireClientSessionState(ctx)
        expect(client.error()).toEqual(Option.none())
        yield* client.surfaceError(client.createBranch)
        expect(client.error()).toEqual(Option.some("Not found: branch gone"))
        expect(client.isError()).toBe(true)
      }),
  )
  it.scopedLive(
    "switchSession activates the target session at once; its agent waits for the snapshot",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        })
        const client = yield* requireClientSessionState(ctx)
        client.switchSession(SessionId.make("session-b"), BranchId.make("branch-b"), "B")
        expect(client.session()).toEqual({
          sessionId: SessionId.make("session-b"),
          branchId: BranchId.make("branch-b"),
          name: "B",
          modelId: absent,
          reasoningLevel: absent,
          cwd: absent,
        })
        expect(client.agent()).toEqual(Option.none())
      }),
  )
  it.scopedLive("the model and agent shown are the ones the snapshot resolved", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        {
          initialSession: {
            id: SessionId.make("session-model"),
            activeBranchId: BranchId.make("branch-model"),
            name: "M",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      )
      const client = yield* requireClientSessionState(ctx)
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-model"),
        branchId: BranchId.make("branch-model"),
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        agent: AgentName.make("primary"),
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
        () => client.model() === "anthropic/claude-haiku-4-5-20251001",
        "session state",
      )
      expect(client.model()).toBe("anthropic/claude-haiku-4-5-20251001")
      // The footer names the session's agent, which the snapshot carries.
      expect(client.agent()).toEqual(Option.some(AgentName.make("primary")))
    }),
  )
  it.scopedLive("a snapshot for the session in view refreshes its name and reasoning level", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        {
          initialSession: {
            id: SessionId.make("session-refresh"),
            activeBranchId: BranchId.make("branch-refresh"),
            name: "Stale",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
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
        agent: AgentName.make("primary"),
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
        () => client.session().name === "Fresh" && client.session().reasoningLevel === "high",
        "session state",
      )
      expect(client.session()).toEqual({
        sessionId: SessionId.make("session-refresh"),
        branchId: BranchId.make("branch-refresh"),
        name: "Fresh",
        modelId: absent,
        reasoningLevel: "high",
        cwd: absent,
      })
    }),
  )
  it.scopedLive("a snapshot for a session the reader left changes nothing", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: SessionId.make("session-source"),
          activeBranchId: BranchId.make("branch-source"),
          name: "Source",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
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
        agent: AgentName.make("primary"),
        runtime: {
          _tag: "Running",
          queue: emptyQueueSnapshot(),
          startedAtMs: 0,
        },
        metrics: {
          turns: 9,
          durationMs: 0,
          costUsd: 123,
          lastInputTokens: 456,
        },
      })
      expect(client.session()).toEqual({
        sessionId: SessionId.make("session-target"),
        branchId: BranchId.make("branch-target"),
        name: "Target",
        modelId: absent,
        reasoningLevel: absent,
        cwd: absent,
      })
      expect(client.agent()).toEqual(Option.none())
      expect(client.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
      expect(client.cost()).toBe(0)
      expect(client.sessionMetrics().latestInputTokens).toBe(0)
    }),
  )
  it.scopedLive("a snapshot for a branch the reader left changes nothing", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* renderScoped(
        () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
        {
          initialSession: {
            id: SessionId.make("session-branch-race"),
            activeBranchId: BranchId.make("branch-old"),
            name: "Old",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
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
        agent: AgentName.make("primary"),
        runtime: {
          _tag: "Running",
          queue: emptyQueueSnapshot(),
          startedAtMs: 0,
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
        () => client.session().branchId === BranchId.make("branch-new"),
        "session state",
      )
      expect(client.session()).toEqual({
        sessionId: SessionId.make("session-branch-race"),
        branchId: BranchId.make("branch-new"),
        name: "New",
        modelId: absent,
        reasoningLevel: absent,
        cwd: absent,
      })
      expect(client.agent()).toEqual(Option.none())
      expect(client.cost()).toBe(0)
      expect(client.sessionMetrics().latestInputTokens).toBe(0)
    }),
  )
  it.scopedLive(
    "a session switch drops the previous session's model before its snapshot lands",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        const setup = yield* renderScoped(
          () => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />,
          {
            initialSession: {
              id: SessionId.make("session-prev"),
              activeBranchId: BranchId.make("branch-prev"),
              name: "P",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        )
        const client = yield* requireClientSessionState(ctx)
        client.applySessionSnapshot({
          sessionId: SessionId.make("session-prev"),
          branchId: BranchId.make("branch-prev"),
          messages: [],
          lastEventId: nullValue,
          reasoningLevel: absent,
          resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
          agent: AgentName.make("primary"),
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
          () => client.model() === "anthropic/claude-haiku-4-5-20251001",
          "session state",
        )
        client.switchSession(SessionId.make("session-next"), BranchId.make("branch-next"), "N")
        expect(client.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
      }),
  )
})

const makeEnvelope = (id: number, event: AgentEvent, createdAt = 0): EventEnvelope =>
  EventEnvelope.make({
    id: EventId.make(id),
    event,
    createdAt,
  })

// ── sends ───────────────────────────────────────────────────────────────────

/**
 * A lost connection is not an answer: the send may have landed. It is tried
 * again under the same request id, so the server's dedup runs it at most
 * once. A refusal is an answer, and it is final at once.
 */
describe("ClientProvider send", () => {
  const refused = Schema.decodeSync(GentRpcError)({ _tag: "InvalidStateError", message: "refused" })
  const target = { sessionId: FIRST.sessionId, branchId: FIRST.branchId }
  type Failure = GentRpcError | RpcClientError
  /**
   * A client whose send and steer both answer the first attempt with `first`
   * and then land. Each verb records the request id of every attempt.
   */
  const mountFailingOnce = (first: Failure) =>
    Effect.gen(function* () {
      const requestIds: Array<string> = []
      const attempt = (input: { readonly requestId?: string }) =>
        Effect.suspend(() => {
          requestIds.push(input.requestId ?? "<missing>")
          if (requestIds.length === 1) return Effect.fail(first)
          return Effect.void
        })
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        client: createMockClient({
          message: { send: attempt },
          steer: {
            command: (input: { readonly command: { readonly requestId?: string } }) =>
              attempt(input.command),
          },
        }),
      })
      return { client: yield* requireClient(ctx), requestIds }
    })
  const verbs = {
    send: (client: ClientContextValue) => client.sendMessage(target, "once", "request-once"),
    steer: (client: ClientContextValue) =>
      client.steer(
        target,
        SteerCommandInput.cases.Interject.make({ message: "once" }),
        "request-once",
      ),
  }
  const lost = {
    "a socket close": new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
  }
  const answered = {
    "a refusal": refused,
    "a protocol defect": new RpcClientError({
      reason: new RpcClientDefect({ message: "Error decoding message", cause: "bad frame" }),
    }),
  }

  for (const [verb, run] of Object.entries(verbs)) {
    for (const [name, failure] of Object.entries(lost)) {
      it.scopedLive(`${verb}: ${name} retries under the first request id`, () =>
        Effect.gen(function* () {
          const { client, requestIds } = yield* mountFailingOnce(failure)
          yield* run(client)
          expect(requestIds).toHaveLength(2)
          expect(new Set(requestIds).size).toBe(1)
          expect(requestIds[0]).not.toBe("<missing>")
        }).pipe(Effect.timeout("5 seconds")),
      )
    }
    // Not a lost connection: another try gets the same answer.
    for (const [name, failure] of Object.entries(answered)) {
      it.scopedLive(`${verb}: ${name} is final at once`, () =>
        Effect.gen(function* () {
          const { client, requestIds } = yield* mountFailingOnce(failure)
          const exit = yield* Effect.exit(run(client))
          expect(exit._tag).toBe("Failure")
          expect(requestIds).toHaveLength(1)
        }).pipe(Effect.timeout("5 seconds")),
      )
    }
  }
})

// ── runtime calls ───────────────────────────────────────────────────────────

describe("useRuntime call", () => {
  // A call its component's unmount interrupts did not fail: the log keeps
  // only real failures, which `gent doctor` reports.
  it.scopedLive("an unmount's interrupt is not logged as a failed call; a failure is", () =>
    Effect.gen(function* () {
      const logged: Array<string> = []
      const interrupted = yield* Deferred.make<void>()
      const [mounted, setMounted] = createSignal(true)
      const [failing, setFailing] = createSignal(false)
      const Waits = () => {
        useRuntime().call(
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.done(interrupted, Exit.void))),
        )
        return <box />
      }
      const Fails = () => {
        useRuntime().call(Effect.fail("refused"))
        return <box />
      }
      yield* renderScoped(
        () => (
          <>
            <Show when={mounted()}>
              <Waits />
            </Show>
            <Show when={failing()}>
              <Fails />
            </Show>
          </>
        ),
        { log: { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => logged.push(m) } },
      )
      setMounted(false)
      yield* Deferred.await(interrupted)
      setFailing(true)
      yield* waitUntil(() => logged.length > 0, "the failure logged")
      expect(logged).toEqual(["call.failed"])
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── errors ──────────────────────────────────────────────────────────────────

/**
 * A session's snapshot writes its status, so an error set before the snapshot
 * lands would be overwritten. An error for the session in view waits for the
 * snapshot, as one for a session the reader left does.
 */
describe("ClientProvider errors", () => {
  it.scopedLive(
    "an error set after a switch, before the snapshot lands, survives the snapshot",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        })
        const client = yield* requireClient(ctx)
        client.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
        client.setErrorIn(SECOND, "send refused")
        client.applySessionSnapshot(snapshotOf(SECOND, { costUsd: 0, lastInputTokens: 0 }))
        expect(client.error()).toEqual(Option.some("send refused"))
      }),
  )

  it.scopedLive(
    "an error cleared on screen does not come back after a switch to the same session",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        })
        const client = yield* requireClient(ctx)
        client.applySessionSnapshot(snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }))
        client.switchSession(FIRST.sessionId, FIRST.branchId, "First")
        client.setErrorIn(FIRST, "send refused")
        expect(client.error()).toEqual(Option.some("send refused"))
        // A later turn replaces the error on screen.
        client.applySessionEvent(
          makeEnvelope(
            1,
            StreamStarted.make({ sessionId: FIRST.sessionId, branchId: FIRST.branchId }),
          ),
        )
        expect(client.isStreaming()).toBe(true)
        client.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
        client.switchSession(FIRST.sessionId, FIRST.branchId, "First")
        client.applySessionSnapshot(snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }))
        expect(client.error()).toEqual(Option.none())
      }),
  )

  it.scopedLive("a refetched snapshot keeps the error on screen", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClient(ctx)
      client.applySessionSnapshot(snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }))
      client.setErrorIn(FIRST, "send refused")
      // The feed came back after a reconnect and hydrates again.
      client.applySessionSnapshot(snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }))
      expect(client.error()).toEqual(Option.some("send refused"))
    }),
  )

  it.scopedLive("an error a later turn replaced does not come back with a snapshot", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClient(ctx)
      client.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      client.setErrorIn(SECOND, "send refused")
      client.applySessionSnapshot(snapshotOf(SECOND, { costUsd: 0, lastInputTokens: 0 }))
      expect(client.error()).toEqual(Option.some("send refused"))
      client.applySessionEvent(
        makeEnvelope(
          1,
          StreamStarted.make({ sessionId: SECOND.sessionId, branchId: SECOND.branchId }),
        ),
      )
      client.applySessionSnapshot(snapshotOf(SECOND, { costUsd: 0, lastInputTokens: 0 }))
      expect(client.error()).toEqual(Option.none())
    }),
  )

  it.scopedLive("an error set once the snapshot is in shows at once", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClient(ctx)
      client.applySessionSnapshot(snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }))
      client.setErrorIn(FIRST, "send refused")
      expect(client.error()).toEqual(Option.some("send refused"))
    }),
  )

  // The feed skips the lifecycle events a snapshot covers, so a turn that
  // started while the connection was down reaches the client only inside the
  // snapshot. It is still a turn start, and it clears the error.
  it.scopedLive("a turn that started during a disconnect drops the held error", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClient(ctx)
      const idle = snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 })
      client.applySessionSnapshot(idle)
      client.setErrorIn(FIRST, "send refused")
      // The connection drops; a queued message starts the next turn meanwhile.
      const running: SessionSnapshot["runtime"] = {
        _tag: "Running",
        queue: emptyQueueSnapshot(),
        startedAtMs: 0,
      }
      client.applySessionSnapshot({ ...idle, runtime: running })
      expect(client.isStreaming()).toBe(true)
      expect(client.error()).toEqual(Option.none())
    }),
  )

  it.scopedLive("a snapshot of the turn the error was shown in keeps the error", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClient(ctx)
      const running: SessionSnapshot["runtime"] = {
        _tag: "Running",
        queue: emptyQueueSnapshot(),
        startedAtMs: 0,
      }
      const midTurn = { ...snapshotOf(FIRST, { costUsd: 0, lastInputTokens: 0 }), runtime: running }
      client.applySessionSnapshot(midTurn)
      client.setErrorIn(FIRST, "interject refused")
      // The same turn still runs when the feed hydrates again.
      client.applySessionSnapshot(midTurn)
      expect(client.error()).toEqual(Option.some("interject refused"))
      // It ends while the connection is down; no new turn starts.
      client.applySessionSnapshot({
        ...midTurn,
        runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
        metrics: { ...midTurn.metrics, turns: midTurn.metrics.turns + 1 },
      })
      expect(client.error()).toEqual(Option.some("interject refused"))
    }),
  )

  it.scopedLive("an error leaves the turn running; the next turn start clears it", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
        initialSession: {
          id: FIRST.sessionId,
          activeBranchId: FIRST.branchId,
          name: "First",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      })
      const client = yield* requireClient(ctx)
      const running: SessionSnapshot["runtime"] = {
        _tag: "Running",
        queue: emptyQueueSnapshot(),
        startedAtMs: 0,
      }
      client.applySessionRuntime({ ...FIRST, runtime: running })
      client.setError('No model matches "typo"')
      expect(client.isStreaming()).toBe(true)
      // A queue change re-emits Running; the turn did not start again.
      client.applySessionRuntime({ ...FIRST, runtime: running })
      expect(client.error()).toEqual(Option.some('No model matches "typo"'))
      // The turn ends; the error stays until a turn starts.
      client.applySessionEvent(
        makeEnvelope(
          1,
          TurnCompleted.make({
            sessionId: FIRST.sessionId,
            branchId: FIRST.branchId,
            durationMs: 1,
          }),
        ),
      )
      expect(client.isStreaming()).toBe(false)
      expect(client.error()).toEqual(Option.some('No model matches "typo"'))
      client.applySessionRuntime({ ...FIRST, runtime: running })
      expect(client.isStreaming()).toBe(true)
      expect(client.error()).toEqual(Option.none())
    }),
  )
})
