/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { AgentName } from "@gent/core-internal/domain/agent"
import { ModelId } from "@gent/core-internal/domain/model"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import { onMount } from "solid-js"
import { Effect, Schema } from "effect"
import { emptyQueueSnapshot } from "@gent/sdk"
import { createMockClient, renderWithProviders } from "./render-harness"
import { useClient } from "../src/client"
import type { ClientContextValue, SessionState } from "../src/client/context"
class ClientSessionStateTestError extends Schema.TaggedErrorClass<ClientSessionStateTestError>()(
  "ClientSessionStateTestError",
  { message: Schema.String },
) {}
function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}
const waitForState = (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  read: () => SessionState,
  predicate: (state: SessionState) => boolean,
  remaining = 10,
): Promise<SessionState> =>
  Effect.runPromise(
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
  read: () => string | null,
  remaining = 10,
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      const error = read()
      if (error !== null) return error
      if (remaining <= 1)
        return yield* new ClientSessionStateTestError({ message: "agent error did not surface" })
      return yield* Effect.promise(() => waitForAgentError(setup, read, remaining - 1))
    }),
  )
describe("ClientProvider session lifecycle", () => {
  it.live("model list failures surface as agent errors", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const client = createMockClient({
        model: {
          list: () =>
            Effect.fail({
              _tag: "DriverError",
              driver: { _tag: "model", id: "openai" },
              reason: "catalog filter failed",
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          client,
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      const error = yield* Effect.promise(() => waitForAgentError(setup, () => ctx!.error()))
      expect(error).toBe("Driver model: openai: catalog filter failed")
    }),
  )
  it.live("switchSession activates the target session immediately and seeds the target agent", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.switchSession(
        SessionId.make("session-b"),
        BranchId.make("branch-b"),
        "B",
        AgentName.make("deepwork"),
      )
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => ctx!.sessionState(),
          (current) => current.status === "active",
        ),
      )
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-b"),
          branchId: BranchId.make("branch-b"),
          name: "B",
          reasoningLevel: undefined,
        },
      })
      expect(ctx.agent()).toBe(AgentName.make("deepwork"))
    }),
  )
  it.live("model() prefers snapshot.metrics.lastModelId over agent default", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          initialSession: {
            id: SessionId.make("session-model"),
            activeBranchId: BranchId.make("branch-model"),
            name: "M",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.applySessionSnapshot({
        sessionId: SessionId.make("session-model"),
        branchId: BranchId.make("branch-model"),
        messages: [],
        lastEventId: null,
        reasoningLevel: undefined,
        runtime: {
          _tag: "Idle" as const,
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
          lastModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        },
      })
      yield* Effect.promise(() =>
        waitForState(
          setup,
          () => ctx!.sessionState(),
          (state) =>
            state.status === "active" && ctx!.model() === "anthropic/claude-haiku-4-5-20251001",
        ),
      )
      expect(ctx.model()).toBe("anthropic/claude-haiku-4-5-20251001")
    }),
  )
  it.live("applySessionSnapshot refreshes the active session metadata", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          initialSession: {
            id: SessionId.make("session-refresh"),
            activeBranchId: BranchId.make("branch-refresh"),
            name: "Stale",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.applySessionSnapshot({
        sessionId: SessionId.make("session-refresh"),
        branchId: BranchId.make("branch-refresh"),
        name: "Fresh",
        messages: [],
        lastEventId: null,
        reasoningLevel: "high",
        runtime: {
          _tag: "Idle" as const,
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 0,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        },
      })
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => ctx!.sessionState(),
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
          reasoningLevel: "high",
        },
      })
    }),
  )
  it.live("applySessionSnapshot ignores stale foreign identity snapshots", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          initialSession: {
            id: SessionId.make("session-source"),
            activeBranchId: BranchId.make("branch-source"),
            name: "Source",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.switchSession(
        SessionId.make("session-target"),
        BranchId.make("branch-target"),
        "Target",
        AgentName.make("deepwork"),
      )
      ctx.applySessionSnapshot({
        sessionId: SessionId.make("session-source"),
        branchId: BranchId.make("branch-source"),
        name: "Foreign",
        messages: [],
        lastEventId: null,
        reasoningLevel: "high",
        runtime: {
          _tag: "Running" as const,
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 9,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 123,
          lastInputTokens: 456,
          lastModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        },
      })
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => ctx!.sessionState(),
          (current) => current.status === "active",
        ),
      )
      expect(state).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-target"),
          branchId: BranchId.make("branch-target"),
          name: "Target",
          reasoningLevel: undefined,
        },
      })
      expect(ctx.agent()).toBe(AgentName.make("deepwork"))
      expect(ctx.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
      expect(ctx.cost()).toBe(0)
      expect(ctx.latestInputTokens()).toBe(0)
    }),
  )
  it.live("applySessionSnapshot ignores stale snapshots for a previous branch", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          initialSession: {
            id: SessionId.make("session-branch-race"),
            activeBranchId: BranchId.make("branch-old"),
            name: "Old",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.switchSession(
        SessionId.make("session-branch-race"),
        BranchId.make("branch-new"),
        "New",
        AgentName.make("deepwork"),
      )
      ctx.applySessionSnapshot({
        sessionId: SessionId.make("session-branch-race"),
        branchId: BranchId.make("branch-old"),
        name: "Old Snapshot",
        messages: [],
        lastEventId: null,
        reasoningLevel: "medium",
        runtime: {
          _tag: "Running" as const,
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 12,
          lastInputTokens: 34,
          lastModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        },
      })
      const state = yield* Effect.promise(() =>
        waitForState(
          setup,
          () => ctx!.sessionState(),
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
          reasoningLevel: undefined,
        },
      })
      expect(ctx.agent()).toBe(AgentName.make("deepwork"))
      expect(ctx.cost()).toBe(0)
      expect(ctx.latestInputTokens()).toBe(0)
    }),
  )
  it.live("switchSession clears stale lastModelId before re-hydration", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          initialSession: {
            id: SessionId.make("session-prev"),
            activeBranchId: BranchId.make("branch-prev"),
            name: "P",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.applySessionSnapshot({
        sessionId: SessionId.make("session-prev"),
        branchId: BranchId.make("branch-prev"),
        messages: [],
        lastEventId: null,
        reasoningLevel: undefined,
        runtime: {
          _tag: "Idle" as const,
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        },
        metrics: {
          turns: 1,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
          lastModelId: ModelId.make("anthropic/claude-haiku-4-5-20251001"),
        },
      })
      yield* Effect.promise(() =>
        waitForState(
          setup,
          () => ctx!.sessionState(),
          (state) =>
            state.status === "active" && ctx!.model() === "anthropic/claude-haiku-4-5-20251001",
        ),
      )
      ctx.switchSession(
        SessionId.make("session-next"),
        BranchId.make("branch-next"),
        "N",
        AgentName.make("deepwork"),
      )
      expect(ctx.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
    }),
  )
})
