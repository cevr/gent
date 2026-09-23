/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  ErrorOccurred,
  EventId,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
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
  type SessionRuntimeState,
} from "@gent/core/protocol"
import {
  EventStore,
  type EventStoreService,
  CurrentWorkspaceId,
  WorkspaceId,
} from "@gent/core/host"
import { DelegateChild, DelegateRpc } from "@gent/extensions/client"
import { ref, ExtensionId, RequestId } from "@gent/core/extensions/api"
import {
  AgentStatus,
  type ChildSessionEntry,
  type ChildSessionTrackerDeps,
  type ChildSessionTrackerService,
  type ClientContextValue,
  makeChildSessionTracker,
  reduceAgentLifecycle,
  type Session,
  sessionSettings,
  SessionState,
  SessionStateEvent,
  transitionSessionState,
  useChildSessions,
  useClient,
} from "../src/client"
import { emptyQueueSnapshot, Gent } from "@gent/sdk"
import { baseLocalLayer } from "@gent/core/test-utils"
import { createMemo, createRoot, createSignal, onMount } from "solid-js"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness-boundary"
import { runEffectBoundary, runRuntimeEffectBoundary } from "./run-effect-boundary"
import * as Prompt from "effect/unstable/ai/Prompt"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { useSessionFeed } from "../src/session"
import { useExtensionUI } from "../src/extensions/host"
import { ClientContext, type ClientRuntime } from "../src/extensions/client-facets"

// ── agent-lifecycle.test ────────────────────────────────────────────────────

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
})

// ── session-settings-state.test ─────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())

const active = SessionState.active({
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  name: "S",
  modelId: absent,
  reasoningLevel: "high",
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

// ── child-session-tracker.test ──────────────────────────────────────────────

const entryChanges = (tracker: ChildSessionTrackerService, childSessionId: string) =>
  tracker.changes.pipe(
    Stream.filterMap((entries) =>
      Result.fromOption(Option.fromUndefinedOr(entries.get(childSessionId)), () => "missing"),
    ),
  )

const waitForEntry = (
  tracker: ChildSessionTrackerService,
  childSessionId: string,
  predicate: (entry: ChildSessionEntry) => boolean,
) =>
  entryChanges(tracker, childSessionId).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("2 seconds"),
  )

/** Closing the tracker scope must end tracking: a later roster pulse never lands. */
const expectTrackingEnded = (harness: {
  tracker: ChildSessionTrackerService
  trackerScope: Scope.Closeable
  lateChild: { sessionId: string }
  lateSpawn: Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    yield* Scope.close(harness.trackerScope, Exit.void)
    yield* harness.lateSpawn
    const late = yield* entryChanges(harness.tracker, harness.lateChild.sessionId).pipe(
      Stream.runHead,
      Effect.timeoutOption("300 millis"),
    )
    expect(Option.isNone(late)).toBe(true)
  })

/** A controllable delegate roster and pulse source, standing in for the extension. */
interface DelegateRosterControl {
  readonly deps: ChildSessionTrackerDeps
  readonly set: (children: ReadonlyArray<DelegateChild>) => Effect.Effect<void>
}

const makeDelegateRoster = (
  events: ChildSessionTrackerDeps["events"],
  parent: { sessionId: SessionId; branchId: BranchId },
): Effect.Effect<DelegateRosterControl> =>
  Effect.gen(function* () {
    const roster = yield* Ref.make<ReadonlyArray<DelegateChild>>([])
    const subscribers = new Set<(pulse: DelegatePulse) => void>()
    const deps: ChildSessionTrackerDeps = {
      events,
      fetchChildren: () => Ref.get(roster),
      onExtensionStateChanged: (cb) => {
        subscribers.add(cb)
        return () => {
          subscribers.delete(cb)
        }
      },
    }
    // A set both stores the new roster and pulses every subscriber for the
    // tracked parent, exactly as an `ExtensionStateChanged` from the delegate
    // on that branch would.
    const set = (children: ReadonlyArray<DelegateChild>) =>
      Ref.set(roster, children).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const cb of subscribers) {
              cb({
                extensionId: DELEGATE_EXTENSION_ID,
                sessionId: parent.sessionId,
                branchId: parent.branchId,
              })
            }
          }),
        ),
      )
    return { deps, set }
  })

type DelegatePulse = { sessionId: SessionId; branchId: BranchId; extensionId: string }

const DELEGATE_EXTENSION_ID = ref(DelegateRpc.Children).extensionId

const runningChild = (over: {
  sessionId: SessionId
  branchId: BranchId
  agentName: string
  toolCallId: ToolCallId
}): DelegateChild =>
  DelegateChild.make({
    requestId: RequestId.make(`req-${over.sessionId}`),
    sessionId: over.sessionId,
    branchId: over.branchId,
    agentName: AgentName.make(over.agentName),
    toolCallId: over.toolCallId,
    status: "running",
  })

const makeHarness = Effect.gen(function* () {
  const storeReady = yield* Deferred.make<EventStoreService>()
  const { client, runtime } = yield* Gent.test(
    baseLocalLayer({ agents: [] }).pipe(
      Layer.tap((context) => Deferred.succeed(storeReady, Context.get(context, EventStore))),
    ),
  )
  const serverStore = yield* Deferred.await(storeReady)
  const workspaceId = WorkspaceId.make(
    new Bun.CryptoHasher("sha256").update(process.cwd()).digest("hex"),
  )
  const eventStore = {
    publish: (event: AgentEvent) =>
      serverStore.publish(event).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId)),
  }
  // The TUI runtime has no server EventStore. Tracking must cross the RPC boundary.
  const clientStore = yield* Fiber.join(runtime.fork(Effect.serviceOption(EventStore)))
  expect(Option.isNone(clientStore)).toBe(true)
  const parent = yield* client.session.create({ cwd: "/tmp" })
  const child = yield* client.session.create({ cwd: "/tmp" })
  const lateChild = yield* client.session.create({ cwd: "/tmp" })
  const trackerScope = yield* Scope.fork(yield* Effect.scope)
  const roster = yield* makeDelegateRoster(client.session.events, parent)
  const tracker = yield* makeChildSessionTracker(roster.deps).pipe(Scope.provide(trackerScope))
  const parentToolCallId = ToolCallId.make("delegate-call")
  const childToolCallId = ToolCallId.make("child-tool-call")
  const runningRow = runningChild({
    sessionId: child.sessionId,
    branchId: child.branchId,
    agentName: "review",
    toolCallId: parentToolCallId,
  })
  const spawn = roster.set([runningRow])
  const toolStarted = eventStore.publish(
    AgentEvent.cases.ToolCallStarted.make({
      ...child,
      toolCallId: childToolCallId,
      toolName: "read",
      input: { path: "note.txt" },
    }),
  )
  const succeeded = roster.set([
    {
      ...runningRow,
      status: "completed",
      usage: { input: 10, output: 20 },
      preview: "done",
    },
  ])
  const lateSpawn = roster.set([
    runningRow,
    runningChild({
      sessionId: lateChild.sessionId,
      branchId: lateChild.branchId,
      agentName: "review",
      toolCallId: ToolCallId.make("late-call"),
    }),
  ])
  return {
    client,
    eventStore,
    roster,
    tracker,
    trackerScope,
    parent,
    child,
    lateChild,
    parentToolCallId,
    childToolCallId,
    runningRow,
    spawn,
    toolStarted,
    succeeded,
    lateSpawn,
  }
})

describe("ChildSessionTracker over the delegate roster", () => {
  it.scopedLive("tracks live child tools and text from the delegate registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness
      const { eventStore, tracker, parent, child, childToolCallId, spawn, toolStarted, succeeded } =
        harness
      yield* tracker.track(parent)
      yield* spawn
      const running = yield* waitForEntry(
        tracker,
        child.sessionId,
        (entry) => entry.status === "running",
      )
      expect(running.childBranchId).toBe(child.branchId)
      yield* toolStarted
      yield* eventStore.publish(AgentEvent.cases.StreamChunk.make({ ...child, chunk: "live text" }))
      const streamed = yield* waitForEntry(
        tracker,
        child.sessionId,
        (entry) => entry.streamText === "live text" && entry.toolCalls.length === 1,
      )
      expect(streamed.toolCalls[0]?.status).toBe("running")
      yield* eventStore.publish(
        AgentEvent.cases.ToolCallSucceeded.make({
          ...child,
          toolCallId: childToolCallId,
          toolName: "read",
        }),
      )
      yield* succeeded
      const completed = yield* waitForEntry(
        tracker,
        child.sessionId,
        (entry) => entry.status === "completed",
      )
      expect(completed.toolCalls).toEqual([
        {
          toolCallId: childToolCallId,
          toolName: "read",
          status: "completed",
          input: { path: "note.txt" },
        },
      ])
      expect(completed.streamText).toBe("live text")
      expect(completed.preview).toBe("done")
      expect(completed.usage).toEqual({ input: 10, output: 20 })
      yield* expectTrackingEnded(harness)
    }).pipe(Effect.timeout("4 seconds")),
  )

  const outcomes: ReadonlyArray<ChildSessionEntry["status"]> = ["completed", "error"]
  for (const outcome of outcomes) {
    it.scopedLive(`hydrates ${outcome} children after their turn has already been saved`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness
        const { client, eventStore, roster, tracker, parent, child, childToolCallId, runningRow } =
          harness
        yield* eventStore.publish(
          AgentEvent.cases.ToolCallStarted.make({
            ...child,
            toolCallId: childToolCallId,
            toolName: "read",
            input: { path: "note.txt" },
          }),
        )
        yield* eventStore.publish(
          AgentEvent.cases.StreamChunk.make({ ...child, chunk: "retained history" }),
        )
        const otherBranch = yield* client.branch.create({
          sessionId: child.sessionId,
          name: "other",
        })
        yield* eventStore.publish(
          AgentEvent.cases.ToolCallStarted.make({
            sessionId: child.sessionId,
            branchId: otherBranch.branchId,
            toolCallId: ToolCallId.make("unrelated-call"),
            toolName: "write",
          }),
        )
        if (outcome === "completed") {
          yield* eventStore.publish(
            AgentEvent.cases.ToolCallSucceeded.make({
              ...child,
              toolCallId: childToolCallId,
              toolName: "read",
            }),
          )
        } else {
          yield* eventStore.publish(
            AgentEvent.cases.ToolCallFailed.make({
              ...child,
              toolCallId: childToolCallId,
              toolName: "read",
            }),
          )
        }
        // The registry already reads this child as terminal before tracking
        // starts, exactly as a crashed or already-finished run would.
        yield* roster.set([{ ...runningRow, status: outcome }])
        yield* tracker.track(parent)
        const restored = yield* waitForEntry(
          tracker,
          child.sessionId,
          (entry) => entry.status === outcome,
        )
        expect(restored.toolCalls).toEqual([
          {
            toolCallId: childToolCallId,
            toolName: "read",
            status: outcome,
            input: { path: "note.txt" },
          },
        ])
        expect(restored.streamText).toBe("retained history")
        yield* expectTrackingEnded(harness)
      }).pipe(Effect.timeout("4 seconds")),
    )
  }
})

// ── use-child-sessions.test ─────────────────────────────────────────────────

type ChildSessionsClient = Parameters<typeof useChildSessions>[0]
type SessionIdentity = ReturnType<ChildSessionsClient["sessionIdentity"]>

class ChildSessionsTestTimeoutError extends Schema.TaggedError<ChildSessionsTestTimeoutError>()(
  "ChildSessionsTestTimeoutError",
  { message: Schema.String },
) {}

const waitFor = (
  label: string,
  predicate: () => boolean,
): Effect.Effect<void, ChildSessionsTestTimeoutError> => {
  let attempts = 200
  const check: Effect.Effect<void, ChildSessionsTestTimeoutError> = Effect.gen(function* () {
    if (predicate()) return
    attempts -= 1
    if (attempts <= 0) {
      return yield* new ChildSessionsTestTimeoutError({ message: `${label} did not settle` })
    }
    // gent/no-sleep: allow yield-then-retry primitive — the tracker fiber must run between checks
    yield* Effect.sleep("1 millis")
    return yield* check
  })
  return check
}

const parentSessionId = SessionId.make("session-parent")
const parentBranchId = BranchId.make("branch-parent")
const childSessionId = SessionId.make("session-child")
const toolCallId = ToolCallId.make("tool-call-agent")

const sessionNamed = (name: string): Session => ({
  sessionId: parentSessionId,
  branchId: parentBranchId,
  name,
  modelId: Option.getOrUndefined(Option.none()),
  reasoningLevel: Option.getOrUndefined(Option.none()),
})

const childRow = DelegateChild.make({
  requestId: RequestId.make("req-child"),
  sessionId: childSessionId,
  branchId: BranchId.make("branch-child"),
  agentName: AgentName.make("cowork"),
  toolCallId,
  status: "running",
})

const delegateChildrenRef = ref(DelegateRpc.Children)

describe("useChildSessions", () => {
  it.live("keeps its projected child rows when the session is renamed", () =>
    Effect.gen(function* () {
      let renameTo: (name: string) => void = () => {}
      let getChildren: (id: string) => ReadonlyArray<unknown> = () => []
      let rosterFetches = 0

      const dispose = createRoot((disposeRoot) => {
        // The record the client holds: a rename rebuilds it, ids unchanged.
        const [record, setRecord] = createSignal(sessionNamed("A"))
        renameTo = (name) => setRecord(sessionNamed(name))
        // The client's identity accessor, with the equivalence the provider
        // installs: the value a consumer sees must not move on a rename.
        const sessionIdentity = createMemo(
          (): SessionIdentity =>
            Option.some({ sessionId: record().sessionId, branchId: record().branchId }),
          Option.none(),
          {
            equals: Option.makeEquivalence<{
              readonly sessionId: SessionId
              readonly branchId: BranchId
            }>(
              (left, right) =>
                left.sessionId === right.sessionId && left.branchId === right.branchId,
            ),
          },
        )
        const client = {
          sessionIdentity,
          // No pulse fires in this test: the roster is read once on mount and
          // must survive a rename without a restart re-reading it.
          onExtensionStateChanged: () => () => {},
          runtime: createMockRuntime(),
          client: createMockClient({
            extension: {
              request: (input: { readonly capabilityId: string }) => {
                // The delegate roster read; every other request is empty.
                if (input.capabilityId !== delegateChildrenRef.capabilityId)
                  return Effect.succeed(Option.getOrUndefined(Option.none()))
                rosterFetches += 1
                return Effect.succeed([childRow])
              },
            },
          }),
        } satisfies ChildSessionsClient
        const hook = useChildSessions(client)
        getChildren = hook.getChildren
        return disposeRoot
      })

      yield* waitFor("child row", () => getChildren(toolCallId).length === 1).pipe(
        Effect.timeout("2 seconds"),
        Effect.onError(() => Effect.sync(dispose)),
      )
      const fetchesBeforeRename = rosterFetches

      // The tracker holds the only copy of these rows. Restarting it on a
      // rename would drop them, then re-read the roster to rebuild them.
      renameTo("A better name")
      // gent/no-sleep: allow a real-clock gap so a restart, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")

      expect(getChildren(toolCallId)).toHaveLength(1)
      expect(rosterFetches).toBe(fetchesBeforeRename)
      dispose()
    }),
  )
})

// ── client-provider-contract.test ───────────────────────────────────────────

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

// ── client-session-metrics.test ─────────────────────────────────────────────

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
  runtime: {
    _tag: "Idle",
    agent: AgentName.make("cowork"),
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

// ── client-session-state.test ───────────────────────────────────────────────

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
const waitForState = (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  read: () => SessionState,
  predicate: (state: SessionState) => boolean,
  remaining = 10,
): Promise<SessionState> =>
  runEffectBoundary(
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      const state = read()
      if (predicate(state)) return state
      if (remaining <= 1) {
        return yield* new ClientSessionStateTestError({
          message: `session state did not reach expected condition; got ${state.status}`,
        })
      }
      return yield* Effect.promise(() => waitForState(setup, read, predicate, remaining - 1))
    }),
  )
const waitForAgentError = (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  read: () => Option.Option<string>,
  remaining = 10,
): Promise<string> =>
  runEffectBoundary(
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      const error = read()
      if (Option.isSome(error)) return error.value
      if (remaining <= 1)
        return yield* new ClientSessionStateTestError({ message: "agent error did not surface" })
      return yield* Effect.promise(() => waitForAgentError(setup, read, remaining - 1))
    }),
  )
describe("ClientProvider session lifecycle", () => {
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
        runtime: { _tag: "Running", agent: AgentName.make("main"), queue: emptyQueueSnapshot() },
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
        agent: AgentName.make("main"),
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
        Effect.promise(() =>
          runRuntimeEffectBoundary(
            clientRuntime,
            ClientContext.use(({ shell }) => Effect.sync(() => shell.notify(message))),
          ),
        )
      client.applySessionSnapshot({
        sessionId,
        branchId,
        messages: [],
        lastEventId: 1,
        reasoningLevel: absent,
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        runtime: { _tag: "Running", agent: AgentName.make("main"), queue: emptyQueueSnapshot() },
        metrics: { turns: 1, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
      })
      yield* notify("Usage: /driver <agent> <driver-id|default>")
      // Esc cancels a streaming turn; a notice must not turn it into a quit.
      expect(client.isStreaming()).toBe(true)
      expect(client.notice()).toEqual(Option.some("Usage: /driver <agent> <driver-id|default>"))

      client.applySessionRuntime({
        sessionId,
        branchId,
        runtime: { _tag: "Idle", agent: AgentName.make("main"), queue: emptyQueueSnapshot() },
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
      const error = yield* Effect.promise(() =>
        waitForAgentError(setup, () => Option.fromNullishOr(client.error())),
      )
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
  it.live("switchSession activates the target session immediately and seeds the target agent", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = Option.some(value))} />, {
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const client = yield* requireClientSessionState(ctx)
      client.switchSession(
        SessionId.make("session-b"),
        BranchId.make("branch-b"),
        "B",
        AgentName.make("deepwork"),
      )
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => client.sessionState(),
          (current) => current.status === "active",
        ),
      )
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-b"),
          branchId: BranchId.make("branch-b"),
          name: "B",
          modelId: absent,
          reasoningLevel: absent,
        },
      })
      expect(client.agent()).toBe(AgentName.make("deepwork"))
    }),
  )
  it.live("model() reads the snapshot's server-resolved model", () =>
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
        runtime: {
          _tag: "Idle",
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        },
      })
      yield* Effect.promise(() =>
        waitForState(
          setup,
          () => client.sessionState(),
          (state) =>
            state.status === "active" && client.model() === "anthropic/claude-haiku-4-5-20251001",
        ),
      )
      expect(client.model()).toBe("anthropic/claude-haiku-4-5-20251001")
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
      })
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => client.sessionState(),
          (current) =>
            current.status === "active" &&
            current.session.name === "Fresh" &&
            current.session.reasoningLevel === "high",
        ),
      )
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-refresh"),
          branchId: BranchId.make("branch-refresh"),
          name: "Fresh",
          modelId: absent,
          reasoningLevel: "high",
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
        AgentName.make("deepwork"),
      )
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-source"),
        branchId: BranchId.make("branch-source"),
        name: "Foreign",
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: "high",
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        runtime: {
          _tag: "Running",
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 9,
          durationMs: 0,
          costUsd: 123,
          lastInputTokens: 456,
        },
      })
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => client.sessionState(),
          (current) => current.status === "active",
        ),
      )
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-target"),
          branchId: BranchId.make("branch-target"),
          name: "Target",
          modelId: absent,
          reasoningLevel: absent,
        },
      })
      expect(client.agent()).toBe(AgentName.make("deepwork"))
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
        AgentName.make("deepwork"),
      )
      client.applySessionSnapshot({
        sessionId: SessionId.make("session-branch-race"),
        branchId: BranchId.make("branch-old"),
        name: "Old Snapshot",
        messages: [],
        lastEventId: nullValue,
        reasoningLevel: "medium",
        resolvedModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        runtime: {
          _tag: "Running",
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 12,
          lastInputTokens: 34,
        },
      })
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => client.sessionState(),
          (current) =>
            current.status === "active" && current.session.branchId === BranchId.make("branch-new"),
        ),
      )
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-branch-race"),
          branchId: BranchId.make("branch-new"),
          name: "New",
          modelId: absent,
          reasoningLevel: absent,
        },
      })
      expect(client.agent()).toBe(AgentName.make("deepwork"))
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
        runtime: {
          _tag: "Idle",
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        },
      })
      yield* Effect.promise(() =>
        waitForState(
          setup,
          () => client.sessionState(),
          (state) =>
            state.status === "active" && client.model() === "anthropic/claude-haiku-4-5-20251001",
        ),
      )
      client.switchSession(
        SessionId.make("session-next"),
        BranchId.make("branch-next"),
        "N",
        AgentName.make("deepwork"),
      )
      expect(client.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
    }),
  )
})

// ── use-session-feed.test ───────────────────────────────────────────────────

type FeedClient = Parameters<typeof useSessionFeed>[2]

class FeedTestTimeoutError extends Schema.TaggedError<FeedTestTimeoutError>()(
  "FeedTestTimeoutError",
  { message: Schema.String },
) {}

const waitForFeed = (predicate: () => boolean): Effect.Effect<void, FeedTestTimeoutError> => {
  let attempts = 20
  const check: Effect.Effect<void, FeedTestTimeoutError> = Effect.gen(function* () {
    if (predicate()) return
    attempts -= 1
    if (attempts <= 0) {
      return yield* new FeedTestTimeoutError({ message: "condition did not settle" })
    }
    // gent/no-sleep: allow yield-then-retry primitive — Solid signal microtasks must drain between checks
    yield* Effect.sleep("0 millis")
    return yield* check
  })
  return check
}

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
})

const runtimeSnapshot = (): SessionRuntimeState => ({
  _tag: "Idle",
  agent: AgentName.make("cowork"),
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
      yield* waitForFeed(
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

      yield* waitForFeed(
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

        yield* waitForFeed(
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

      yield* waitForFeed(
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

      yield* waitForFeed(
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

      yield* waitForFeed(
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

      yield* waitForFeed(
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
