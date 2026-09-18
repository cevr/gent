import { describe, it, expect } from "effect-bun-test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { Effect, Option, Schema, Stream } from "effect"
import {
  AgentEvent,
  AgentName,
  BranchId,
  EventEnvelope,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import { EventId } from "@gent/core-internal/domain/event"
import { type Session, useChildSessions } from "../src/client"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"

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

const spawnEnvelope = EventEnvelope.make({
  id: EventId.make(1),
  event: AgentEvent.cases.AgentRunSpawned.make({
    parentSessionId,
    childSessionId,
    agentName: AgentName.make("cowork"),
    prompt: "do the thing",
    toolCallId,
  }),
  createdAt: 0,
})

describe("useChildSessions", () => {
  it.live("keeps its projected child rows when the session is renamed", () =>
    Effect.gen(function* () {
      let renameTo: (name: string) => void = () => {}
      let getChildren: (id: string) => ReadonlyArray<unknown> = () => []
      let parentSubscriptions = 0

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
          runtime: createMockRuntime(),
          client: createMockClient({
            session: {
              events: (input: { readonly sessionId: SessionId }) => {
                // The child stream stays open; the parent stream replays the
                // one spawn so the tracker has a row to lose.
                if (input.sessionId !== parentSessionId) return Stream.never
                parentSubscriptions += 1
                return Stream.concat(Stream.make(spawnEnvelope), Stream.never)
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
      const subscriptionsBeforeRename = parentSubscriptions

      // The tracker holds the only copy of these rows. Restarting it on a
      // rename would drop them with no refetch behind it.
      renameTo("A better name")
      // gent/no-sleep: allow a real-clock gap so a restart, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")

      expect(getChildren(toolCallId)).toHaveLength(1)
      expect(parentSubscriptions).toBe(subscriptionsBeforeRename)
      dispose()
    }),
  )
})
