import { describe, expect, it } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Result,
  Scope,
  Stream,
} from "effect"
import { Gent } from "@gent/sdk"
import { AgentName, AgentEvent, ToolCallId } from "@gent/core/protocol"
import {
  EventStore,
  type EventStoreError,
  type EventStoreService,
} from "@gent/core-internal/domain/event"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { baseLocalLayer } from "@gent/core-internal/test-utils/index"
import {
  makeChildSessionTracker,
  type ChildSessionEntry,
  type ChildSessionTrackerService,
} from "../src/client"

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

/** Closing the tracker scope must end parent tracking: a later spawn never lands. */
const expectTrackingEnded = (harness: {
  tracker: ChildSessionTrackerService
  trackerScope: Scope.Closeable
  lateChild: { sessionId: string }
  lateSpawn: Effect.Effect<unknown, EventStoreError>
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
  const tracker = yield* makeChildSessionTracker(client.session.events).pipe(
    Scope.provide(trackerScope),
  )
  const parentToolCallId = ToolCallId.make("delegate-call")
  const childToolCallId = ToolCallId.make("child-tool-call")
  const spawn = eventStore.publish(
    AgentEvent.cases.AgentRunSpawned.make({
      parentSessionId: parent.sessionId,
      childSessionId: child.sessionId,
      childBranchId: child.branchId,
      branchId: parent.branchId,
      agentName: AgentName.make("review"),
      prompt: "audit this",
      toolCallId: parentToolCallId,
    }),
  )
  const toolStarted = eventStore.publish(
    AgentEvent.cases.ToolCallStarted.make({
      ...child,
      toolCallId: childToolCallId,
      toolName: "read",
      input: { path: "note.txt" },
    }),
  )
  const succeeded = eventStore.publish(
    AgentEvent.cases.AgentRunSucceeded.make({
      parentSessionId: parent.sessionId,
      childSessionId: child.sessionId,
      branchId: parent.branchId,
      agentName: AgentName.make("review"),
      toolCallId: parentToolCallId,
      usage: { input: 10, output: 20, cost: 0.01 },
      preview: "done",
    }),
  )
  const lateSpawn = eventStore.publish(
    AgentEvent.cases.AgentRunSpawned.make({
      parentSessionId: parent.sessionId,
      childSessionId: lateChild.sessionId,
      childBranchId: lateChild.branchId,
      branchId: parent.branchId,
      agentName: AgentName.make("review"),
      prompt: "too late",
      toolCallId: ToolCallId.make("late-call"),
    }),
  )
  return {
    client,
    eventStore,
    tracker,
    trackerScope,
    parent,
    child,
    lateChild,
    parentToolCallId,
    childToolCallId,
    spawn,
    toolStarted,
    succeeded,
    lateSpawn,
  }
})

describe("ChildSessionTracker over RPC", () => {
  it.scopedLive("tracks live child tools and text without a server service in the client", () =>
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
      expect(completed.usage).toEqual({ input: 10, output: 20, cost: 0.01 })
      yield* expectTrackingEnded(harness)
    }).pipe(Effect.timeout("4 seconds")),
  )

  const outcomes: ReadonlyArray<ChildSessionEntry["status"]> = ["completed", "error"]
  for (const outcome of outcomes) {
    it.scopedLive(
      `hydrates ${outcome} children after parent completion has already been saved`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness
          const {
            client,
            eventStore,
            tracker,
            parent,
            child,
            childToolCallId,
            parentToolCallId,
            spawn,
            toolStarted,
            succeeded,
          } = harness
          yield* spawn
          yield* toolStarted
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
            yield* succeeded
          } else {
            yield* eventStore.publish(
              AgentEvent.cases.ToolCallFailed.make({
                ...child,
                toolCallId: childToolCallId,
                toolName: "read",
              }),
            )
            yield* eventStore.publish(
              AgentEvent.cases.AgentRunFailed.make({
                parentSessionId: parent.sessionId,
                childSessionId: child.sessionId,
                branchId: parent.branchId,
                agentName: AgentName.make("review"),
                toolCallId: parentToolCallId,
              }),
            )
          }
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
