/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { onMount } from "solid-js"
import { Effect, Stream } from "effect"
import { createMockClient, renderWithProviders } from "./render-harness"
import { useClient } from "../src/client"
import type { ClientContextValue, SessionState } from "../src/client/context"

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

const waitForState = async (
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

describe("ClientProvider session lifecycle", () => {
  test("createSession activates the created session", async () => {
    let ctx: ClientContextValue | undefined
    const client = createMockClient({
      session: {
        create: () =>
          Effect.succeed({
            sessionId: SessionId.of("session-created"),
            branchId: BranchId.of("branch-created"),
            name: "Created",
          }),
      },
    })

    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        client,
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.createSession()
    const state = await waitForState(
      setup,
      () => ctx!.sessionState(),
      (current) => current.status === "active",
    )

    expect(state).toEqual({
      status: "active",
      session: {
        sessionId: "session-created",
        branchId: "branch-created",
        name: "Created",
        reasoningLevel: undefined,
      },
    })
  })

  test("switchSession activates the target session immediately", async () => {
    let ctx: ClientContextValue | undefined
    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        initialSession: {
          id: SessionId.of("session-a"),
          branchId: BranchId.of("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession(SessionId.of("session-b"), BranchId.of("branch-b"), "B")
    await setup.renderOnce()

    expect(ctx.sessionState()).toEqual({
      status: "active",
      session: {
        sessionId: "session-b",
        branchId: "branch-b",
        name: "B",
        reasoningLevel: undefined,
      },
    })
    expect(ctx.agent()).toBeUndefined()
  })

  test("switchSession seeds the target agent when provided", async () => {
    let ctx: ClientContextValue | undefined
    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        initialSession: {
          id: SessionId.of("session-a"),
          branchId: BranchId.of("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession(SessionId.of("session-b"), BranchId.of("branch-b"), "B", "deepwork")
    await setup.renderOnce()

    expect(ctx.agent()).toBe("deepwork")
    expect(ctx.sessionState()).toEqual({
      status: "active",
      session: {
        sessionId: "session-b",
        branchId: "branch-b",
        name: "B",
        reasoningLevel: undefined,
      },
    })
  })

  test("clearSession returns to none", async () => {
    let ctx: ClientContextValue | undefined
    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        initialSession: {
          id: SessionId.of("session-a"),
          branchId: BranchId.of("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.clearSession()
    await setup.renderOnce()

    expect(ctx.sessionState()).toEqual({ status: "none" })
  })

  // B11.6a counsel: deleted skipped `stale snapshot hydration` test.
  // It targeted the in-process `ext.snapshots()` map and `getSnapshotRaw`
  // — both removed when the paired-package wrapper died. Widget-level
  // stale-data gating is now exercised by the keyed `(sessionId,
  // branchId)` state in `auto.client.ts`, `artifacts.client.ts`, and
  // `tasks.client.tsx`; per-cwd EventPublisher (B11.6c) covers
  // pulse-routing isolation.

  test("stale snapshot failures do not repopulate connection issues after switch", async () => {
    let ctx: ClientContextValue | undefined
    let failOldSnapshot: ((error: Error) => void) | undefined

    const client = createMockClient({
      session: {
        getSnapshot: ({ sessionId }: { sessionId: SessionId; branchId: BranchId }) => {
          if (sessionId === SessionId.of("session-a")) {
            return Effect.async<never, Error>((resume) => {
              failOldSnapshot = (error) => resume(Effect.fail(error))
              return Effect.void
            })
          }
          return Effect.succeed({
            sessionId: SessionId.of("session-b"),
            branchId: BranchId.of("branch-b"),
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              phase: "idle" as const,
              status: "idle" as const,
              agent: "cowork" as const,
              queue: { steering: [], followUp: [] },
            },
          })
        },
      },
    })

    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        client,
        initialSession: {
          id: SessionId.of("session-a"),
          branchId: BranchId.of("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession(SessionId.of("session-b"), BranchId.of("branch-b"), "B")
    failOldSnapshot?.(new Error("stale session failed"))
    await Promise.resolve()
    await setup.renderOnce()
    await setup.renderOnce()

    expect(ctx.connectionIssue()).toBeNull()
    expect(ctx.sessionState()).toEqual({
      status: "active",
      session: {
        sessionId: "session-b",
        branchId: "branch-b",
        name: "B",
        reasoningLevel: undefined,
      },
    })
  })

  test("stale snapshot completion does not open an old event stream", async () => {
    let ctx: ClientContextValue | undefined
    let resumeOldSnapshot:
      | ((
          effect: Effect.Effect<
            {
              sessionId: SessionId
              branchId: BranchId
              messages: []
              lastEventId: null
              reasoningLevel: undefined
              runtime: {
                phase: "idle"
                status: "idle"
                agent: "cowork"
                queue: { steering: []; followUp: [] }
              }
            },
            never
          >,
        ) => void)
      | undefined
    const eventCalls: string[] = []

    const client = createMockClient({
      session: {
        getSnapshot: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) => {
          if (sessionId === SessionId.of("session-a")) {
            return Effect.async((resume) => {
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
              phase: "idle" as const,
              status: "idle" as const,
              agent: "cowork" as const,
              queue: { steering: [], followUp: [] },
            },
          })
        },
        events: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) =>
          Effect.sync(() => {
            eventCalls.push(`${sessionId}:${branchId}`)
            return Stream.empty
          }).pipe(Effect.flatten),
      },
    })

    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        client,
        initialSession: {
          id: SessionId.of("session-a"),
          branchId: BranchId.of("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession(SessionId.of("session-b"), BranchId.of("branch-b"), "B")
    resumeOldSnapshot?.(
      Effect.succeed({
        sessionId: SessionId.of("session-a"),
        branchId: BranchId.of("branch-a"),
        messages: [],
        lastEventId: null,
        reasoningLevel: undefined,
        runtime: {
          phase: "idle",
          status: "idle",
          agent: "cowork",
          queue: { steering: [], followUp: [] },
        },
      }),
    )

    await Promise.resolve()
    await setup.renderOnce()
    await setup.renderOnce()

    expect(eventCalls).not.toContain("session-a:branch-a")
  })
})
