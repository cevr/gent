import { describe, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AgentName } from "@gent/core/domain/agent"
import { AgentEvent, EventStore } from "@gent/core/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import {
  make as makeChildSessionTracker,
  type ChildSessionEntry,
  type ChildSessionTrackerService,
} from "../src/services/child-session-tracker"

class ChildSessionTrackerTimeoutError extends Schema.TaggedErrorClass<ChildSessionTrackerTimeoutError>()(
  "ChildSessionTrackerTimeoutError",
  { message: Schema.String },
) {}

const waitForEntry = (
  tracker: ChildSessionTrackerService,
  childSessionId: string,
  predicate: (entry: ChildSessionEntry) => boolean,
): Effect.Effect<ChildSessionEntry, ChildSessionTrackerTimeoutError> => {
  const poll = (
    attempts: number,
  ): Effect.Effect<ChildSessionEntry, ChildSessionTrackerTimeoutError> =>
    Effect.gen(function* () {
      const entries = yield* tracker.getAll()
      const entry = entries.get(childSessionId)
      if (entry !== undefined && predicate(entry)) return entry
      if (attempts <= 0) {
        return yield* new ChildSessionTrackerTimeoutError({
          message: `child session ${childSessionId} did not settle`,
        })
      }
      yield* Effect.sleep("0 millis")
      return yield* poll(attempts - 1)
    })
  return poll(50)
}

describe("ChildSessionTracker", () => {
  it.live("preserves child tool state when parent completion interleaves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        const tracker = yield* makeChildSessionTracker

        const parentSessionId = SessionId.make("parent-session")
        const parentBranchId = BranchId.make("parent-branch")
        const childSessionId = SessionId.make("child-session")
        const childBranchId = BranchId.make("child-branch")
        const parentToolCallId = ToolCallId.make("delegate-call")
        const childToolCallId = ToolCallId.make("child-tool-call")

        yield* tracker.track({ sessionId: parentSessionId, branchId: parentBranchId })
        yield* Effect.yieldNow

        yield* eventStore.publish(
          AgentEvent.AgentRunSpawned.make({
            parentSessionId,
            childSessionId,
            childBranchId,
            branchId: parentBranchId,
            agentName: AgentName.make("review"),
            prompt: "audit this",
            toolCallId: parentToolCallId,
          }),
        )

        yield* waitForEntry(tracker, childSessionId, (entry) => entry.status === "running")
        yield* Effect.yieldNow

        yield* Effect.all(
          [
            eventStore.publish(
              AgentEvent.ToolCallStarted.make({
                sessionId: childSessionId,
                branchId: childBranchId,
                toolCallId: childToolCallId,
                toolName: "shell",
                input: { cmd: "pwd" },
              }),
            ),
            eventStore.publish(
              AgentEvent.AgentRunSucceeded.make({
                parentSessionId,
                childSessionId,
                branchId: parentBranchId,
                childBranchId,
                agentName: AgentName.make("review"),
                toolCallId: parentToolCallId,
                usage: { input: 10, output: 20, cost: 0.01 },
                preview: "done",
                savedPath: "/tmp/child.md",
              }),
            ),
          ],
          { concurrency: 2 },
        )

        const settled = yield* waitForEntry(
          tracker,
          childSessionId,
          (entry) => entry.status === "completed" && entry.toolCalls.length === 1,
        )
        expect(settled.status).toBe("completed")
        expect(settled.preview).toBe("done")
        expect(settled.toolCalls).toEqual([
          {
            toolCallId: childToolCallId,
            toolName: "shell",
            status: "running",
            input: { cmd: "pwd" },
          },
        ])
      }).pipe(Effect.provide(EventStore.Memory)),
    ),
  )
})
