/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  AgentEvent,
  AgentName,
  BranchId,
  EventEnvelope,
  EventId,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import { SyntaxStyle } from "@opentui/core"
import { MessageList, type ToolCall } from "../../src/message-list"
import { DelegateChild, DelegateRpc } from "@gent/extensions/client"
import { ref, RequestId } from "@gent/core/extensions/api"
import { Gent, type GentNamespacedClient, type GentRuntime } from "@gent/sdk"
import {
  baseLocalLayer,
  EventStore,
  type EventStoreService,
  CurrentWorkspaceId,
  WorkspaceId,
} from "@gent/core/test-utils"
import { createMemo, createRoot, createSignal } from "solid-js"
import type { Session } from "../../src/client"
import { ClientContext, type ClientShellTransport } from "../../src/extensions/client-facets"
import {
  type ChildSessionEntry,
  type ChildSessionTrackerDeps,
  type ChildSessionTrackerService,
  makeChildSessionTracker,
  trackDelegateChildren,
} from "../../src/extensions/delegate.client"
import {
  createMockClient,
  createMockRuntime,
  renderFrame,
  renderWithProviders,
} from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"
import { provideClientServices } from "../extension-test-harness-boundary"

/** A shell transport over a real client, with no session mounted and no pulses. */
const shellTransport = (
  client: GentNamespacedClient,
  runtime: GentRuntime,
): ClientShellTransport => ({
  client,
  runtime,
  currentSession: () => Option.none(),
  onExtensionStateChanged: () => () => {},
  onSessionEvent: () => () => {},
})

/** The transport facet an extension reads, over that shell transport. */
const transportFacet = (client: GentNamespacedClient, runtime: GentRuntime) =>
  provideClientServices(
    Effect.gen(function* () {
      const { transport } = yield* ClientContext
      return transport
    }),
    { transport: shellTransport(client, runtime) },
  )

// ── child session tracker ───────────────────────────────────────────────────

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
  const transport = yield* transportFacet(client, runtime)
  const roster = yield* makeDelegateRoster(transport.sessionEvents, parent)
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

// ── roster for the shell's branch ───────────────────────────────────────────

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

describe("delegate children for the shell's branch", () => {
  it.scopedLive("keeps its projected child rows when the session is renamed", () =>
    Effect.gen(function* () {
      let rosterFetches = 0
      // The record the client holds: a rename rebuilds it, ids unchanged.
      const { renameTo, currentSession, dispose } = createRoot((disposeRoot) => {
        const [record, setRecord] = createSignal(sessionNamed("A"))
        // The shell's identity accessor, with the equivalence the provider
        // installs: the value an extension sees must not move on a rename.
        const identity = createMemo(
          () => Option.some({ sessionId: record().sessionId, branchId: record().branchId }),
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
        return {
          renameTo: (name: string) => setRecord(sessionNamed(name)),
          currentSession: identity,
          dispose: disposeRoot,
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(dispose))

      const children = yield* provideClientServices(trackDelegateChildren, {
        transport: {
          ...shellTransport(
            createMockClient({
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
            createMockRuntime(),
          ),
          // No pulse fires in this test: the roster is read once on mount and
          // must survive a rename without a restart re-reading it.
          currentSession,
        },
      })

      yield* waitFor("child row", () => children.forToolCall(toolCallId).length === 1).pipe(
        Effect.timeout("2 seconds"),
      )
      const fetchesBeforeRename = rosterFetches

      // The tracker holds the only copy of these rows. Restarting it on a
      // rename would drop them, then re-read the roster to rebuild them.
      renameTo("A better name")
      // gent/no-sleep: allow a real-clock gap so a restart, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")

      expect(children.forToolCall(toolCallId)).toHaveLength(1)
      expect(rosterFetches).toBe(fetchesBeforeRename)
    }),
  )
})

describe("delegate row in the transcript", () => {
  it.live("draws the child run and its tool calls under the delegate call", () =>
    Effect.gen(function* () {
      const childTool = EventEnvelope.make({
        id: EventId.make(1),
        createdAt: 0,
        event: AgentEvent.cases.ToolCallStarted.make({
          sessionId: childRow.sessionId,
          branchId: childRow.branchId,
          toolCallId: ToolCallId.make("child-read"),
          toolName: "read",
          input: { path: "CHILD-NOTE.md" },
        }),
      })
      const client = createMockClient({
        session: {
          // Only the child branch has events; the parent's feed is empty.
          events: (input: { readonly sessionId: SessionId }) => {
            if (input.sessionId === childRow.sessionId) return Stream.make(childTool)
            return Stream.empty
          },
        },
        extension: {
          request: (input: { readonly capabilityId: string }) => {
            if (input.capabilityId !== delegateChildrenRef.capabilityId)
              return Effect.succeed(Option.getOrUndefined(Option.none()))
            return Effect.succeed([childRow])
          },
        },
      })
      const call: ToolCall = {
        id: toolCallId,
        toolName: "delegate.start",
        status: "running",
        input: { todo: "review the loader" },
        summary: Option.getOrUndefined(Option.none<string>()),
        output: Option.getOrUndefined(Option.none<string>()),
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={[
                {
                  _tag: "regular-message",
                  id: "assistant-delegate",
                  role: "assistant",
                  content: "",
                  reasoning: "",
                  images: [],
                  createdAt: 0,
                  toolCalls: [call],
                  segments: [{ _tag: "tool-call", toolCall: call }],
                },
              ]}
              disclosure="full"
              syntaxStyle={() => SyntaxStyle.create()}
              streaming={false}
            />
          ),
          { client, initialSession: sessionNamed("parent") },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (text) => text.includes("cowork") && text.includes("CHILD-NOTE.md"),
          "delegate child row",
        ),
      )
      expect(frame).toContain("review the loader")
      expect(renderFrame(setup)).toContain("read")
    }),
  )

  it.live("a cell's ops draw through the renderers registered for their tools", () =>
    Effect.gen(function* () {
      const childTool = EventEnvelope.make({
        id: EventId.make(1),
        createdAt: 0,
        event: AgentEvent.cases.ToolCallStarted.make({
          sessionId: childRow.sessionId,
          branchId: childRow.branchId,
          toolCallId: ToolCallId.make("child-read"),
          toolName: "read",
          input: { path: "CHILD-NOTE.md" },
        }),
      })
      const client = createMockClient({
        session: {
          events: (input: { readonly sessionId: SessionId }) => {
            if (input.sessionId === childRow.sessionId) return Stream.make(childTool)
            return Stream.empty
          },
        },
        extension: {
          request: (input: { readonly capabilityId: string }) => {
            if (input.capabilityId !== delegateChildrenRef.capabilityId)
              return Effect.succeed(Option.getOrUndefined(Option.none()))
            return Effect.succeed([childRow])
          },
        },
      })
      const absent = Option.getOrUndefined(Option.none<string>())
      // The model sees only `cell`; delegate.start and read run inside it.
      const cell: ToolCall = {
        id: "cell-call",
        toolName: "cell",
        status: "completed",
        input: { code: "await tools.delegate.start(...)" },
        summary: absent,
        output: absent,
        operations: [
          {
            id: toolCallId,
            toolName: "delegate.start",
            status: "completed",
            input: { todo: "review the loader" },
            summary: "CHILD-HANDLE-SUMMARY",
            output: absent,
          },
          {
            id: "cell-read-op",
            toolName: "read",
            status: "completed",
            input: { path: "/tmp/op-read.md" },
            summary: "OP-READ-SUMMARY",
            output: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
              content: Array.from({ length: 40 }, (_, i) => `OP-READ-LINE-${i + 1}`).join("\n"),
              lineCount: 40,
            }),
          },
          {
            id: "cell-unknown-op",
            toolName: "no_renderer_tool",
            status: "completed",
            input: {},
            summary: "UNKNOWN-OP-SUMMARY",
            output: absent,
          },
        ],
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={[
                {
                  _tag: "regular-message",
                  id: "assistant-cell",
                  role: "assistant",
                  content: "",
                  reasoning: "",
                  images: [],
                  createdAt: 0,
                  toolCalls: [cell],
                  segments: [{ _tag: "tool-call", toolCall: cell }],
                },
              ]}
              disclosure="full"
              syntaxStyle={() => SyntaxStyle.create()}
              streaming={false}
            />
          ),
          { client, initialSession: sessionNamed("parent"), width: 100, height: 80 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (text) =>
            text.includes("CHILD-NOTE.md") &&
            text.includes("OP-READ-LINE-40") &&
            text.includes("UNKNOWN-OP-SUMMARY"),
          "cell ops through their renderers",
        ),
      )
      // The delegate renderer draws the child tree and the read renderer the file
      // body; neither op falls back to its one-line receipt. The op with no
      // renderer keeps its line.
      expect(frame).not.toContain("✓ delegate.start")
      expect(frame).not.toContain("✓ read OP-READ-SUMMARY")
      expect(frame).toContain("✓ no_renderer_tool UNKNOWN-OP-SUMMARY")
      // An op is a collapsed sub-row: it draws its own header and an excerpt,
      // never its full body, even inside the full cell body.
      expect(frame).toContain("#cell-read-op")
      expect(frame).not.toContain("OP-READ-LINE-20")
    }),
  )
})
