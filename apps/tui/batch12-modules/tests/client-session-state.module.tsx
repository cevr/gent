/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { onMount } from "solid-js"
import { Effect, Stream } from "effect"
import { emptyQueueSnapshot } from "@gent/sdk"
import { createMockClient, renderWithProviders } from "../../src/../tests/render-harness"
import { useClient } from "../../src/client"
import type { ClientContextValue, SessionState } from "../../src/client/context"
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
  setup.renderOnce().then(() => {
    const state = read()
    if (predicate(state)) return state
    if (remaining <= 1) {
      throw new Error(
        `session state did not reach expected condition; got ${JSON.stringify(state)}`,
      )
    }
    return waitForState(setup, read, predicate, remaining - 1)
  })
const waitForAgentError = (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  read: () => string | null,
  remaining = 10,
): Promise<string> =>
  setup.renderOnce().then(() => {
    const error = read()
    if (error !== null) return error
    if (remaining <= 1) throw new Error("agent error did not surface")
    return waitForAgentError(setup, read, remaining - 1)
  })
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
            branchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: 0,
            updatedAt: 0,
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
  it.live("stale snapshot failures do not repopulate connection issues after switch", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      let failOldSnapshot: ((error: Error) => void) | undefined
      const client = createMockClient({
        session: {
          getSnapshot: ({ sessionId }: { sessionId: SessionId; branchId: BranchId }) => {
            if (sessionId === SessionId.make("session-a")) {
              return Effect.callback<never, Error>((resume) => {
                failOldSnapshot = (error) => resume(Effect.fail(error))
                return Effect.void
              })
            }
            return Effect.succeed({
              sessionId: SessionId.make("session-b"),
              branchId: BranchId.make("branch-b"),
              messages: [],
              lastEventId: null,
              reasoningLevel: undefined,
              runtime: {
                _tag: "Idle" as const,
                agent: "cowork" as const,
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
          },
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          client,
          initialSession: {
            id: SessionId.make("session-a"),
            branchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.switchSession(SessionId.make("session-b"), BranchId.make("branch-b"), "B")
      failOldSnapshot?.(new Error("stale session failed"))
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(ctx.connectionIssue()).toBeNull()
      expect(ctx.sessionState()).toEqual({
        status: "active",
        session: {
          sessionId: SessionId.make("session-b"),
          branchId: BranchId.make("branch-b"),
          name: "B",
          reasoningLevel: undefined,
        },
      })
    }),
  )
  it.live("stale snapshot completion does not open an old event stream", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      let resumeOldSnapshot: ((effect: Effect.Effect<unknown, never>) => void) | undefined
      const eventCalls: string[] = []
      const client = createMockClient({
        session: {
          getSnapshot: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) => {
            if (sessionId === SessionId.make("session-a")) {
              return Effect.callback((resume) => {
                resumeOldSnapshot = resume
                return Effect.void
              })
            }
            return Effect.succeed({
              sessionId,
              branchId,
              messages: [],
              lastEventId: null,
              reasoningLevel: undefined,
              runtime: {
                _tag: "Idle" as const,
                agent: "cowork" as const,
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
          },
          events: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) => {
            eventCalls.push(`${sessionId}:${branchId}`)
            return Stream.empty
          },
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          client,
          initialSession: {
            id: SessionId.make("session-a"),
            branchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.switchSession(SessionId.make("session-b"), BranchId.make("branch-b"), "B")
      resumeOldSnapshot?.(
        Effect.succeed({
          sessionId: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          messages: [],
          lastEventId: null,
          reasoningLevel: undefined,
          runtime: {
            _tag: "Idle",
            agent: "cowork",
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
        }),
      )
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(eventCalls).not.toContain("session-a:branch-a")
    }),
  )
  it.live("model() prefers snapshot.metrics.lastModelId over agent default", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const client = createMockClient({
        session: {
          getSnapshot: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) =>
            Effect.succeed({
              sessionId,
              branchId,
              messages: [],
              lastEventId: null,
              reasoningLevel: undefined,
              runtime: {
                _tag: "Idle" as const,
                agent: "cowork" as const,
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
                lastModelId: "anthropic/claude-haiku-4-5-20251001",
              },
            }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          client,
          initialSession: {
            id: SessionId.make("session-model"),
            branchId: BranchId.make("branch-model"),
            name: "M",
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
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
  it.live("switchSession clears stale lastModelId before re-hydration", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      // Snapshot for the prior session resolves immediately with a known
      // lastModelId; snapshot for the next session never resolves so the
      // store has no chance to re-hydrate before our assertion.
      const client = createMockClient({
        session: {
          getSnapshot: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) => {
            if (sessionId === SessionId.make("session-prev")) {
              return Effect.succeed({
                sessionId,
                branchId,
                messages: [],
                lastEventId: null,
                reasoningLevel: undefined,
                runtime: {
                  _tag: "Idle" as const,
                  agent: "cowork" as const,
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
                  lastModelId: "anthropic/claude-haiku-4-5-20251001",
                },
              })
            }
            return Effect.never
          },
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(value) => (ctx = value)} />, {
          client,
          initialSession: {
            id: SessionId.make("session-prev"),
            branchId: BranchId.make("branch-prev"),
            name: "P",
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      )
      if (ctx === undefined) throw new Error("client context not ready")
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
      // The next-session snapshot never resolves in this fixture, so the only
      // way `model()` could still echo the prior session's lastModelId is if
      // switchSession failed to clear it. With clearing in place we get the
      // new agent's local default.
      expect(ctx.model()).not.toBe("anthropic/claude-haiku-4-5-20251001")
    }),
  )
})
