/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { onMount } from "solid-js"
import { Effect, Stream } from "effect"
import {
  AgentSwitched,
  EventEnvelope as EventEnvelopeClass,
  type EventEnvelope,
} from "@gent/core/domain/event"
import { createMockClient, renderWithProviders } from "./render-harness"
import { useClient } from "../src/client"
import { useExtensionUI, type ExtensionUIContextValue } from "../src/extensions/context"
import type { ClientContextValue, SessionState } from "../src/client/context"

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

function ClientAndExtensionProbe(props: {
  readonly onReady: (client: ClientContextValue, ext: ExtensionUIContextValue) => void
}) {
  const client = useClient()
  const ext = useExtensionUI()
  onMount(() => {
    props.onReady(client, ext)
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
            sessionId: "session-created" as SessionId,
            branchId: "branch-created" as BranchId,
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
          id: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession("session-b" as SessionId, "branch-b" as BranchId, "B")
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
  })

  test("clearSession returns to none", async () => {
    let ctx: ClientContextValue | undefined
    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        initialSession: {
          id: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
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

  test("stale snapshot hydration does not overwrite the active session after switch", async () => {
    let ctx: ClientContextValue | undefined
    let ext: ExtensionUIContextValue | undefined
    let resolveOldSnapshot:
      | ((snapshot: {
          sessionId: SessionId
          branchId: BranchId
          messages: []
          lastEventId: null
          reasoningLevel: "high"
          runtime: {
            phase: "streaming"
            status: "running"
            agent: "deepwork"
            queue: { steering: []; followUp: [] }
          }
          extensionSnapshots: [
            {
              extensionId: "@test/shared"
              epoch: 9
              model: { status: "old-branch" }
            },
          ]
        }) => void)
      | undefined

    const oldSnapshot = new Promise<{
      sessionId: SessionId
      branchId: BranchId
      messages: []
      lastEventId: null
      reasoningLevel: "high"
      runtime: {
        phase: "streaming"
        status: "running"
        agent: "deepwork"
        queue: { steering: []; followUp: [] }
      }
      extensionSnapshots: [
        {
          extensionId: "@test/shared"
          epoch: 9
          model: { status: "old-branch" }
        },
      ]
    }>((resolve) => {
      resolveOldSnapshot = resolve
    })

    const client = createMockClient({
      session: {
        getSnapshot: ({ sessionId }: { sessionId: SessionId; branchId: BranchId }) => {
          if (sessionId === ("session-a" as SessionId)) {
            return Effect.promise(() => oldSnapshot)
          }
          return Effect.succeed({
            sessionId: "session-b" as SessionId,
            branchId: "branch-b" as BranchId,
            messages: [],
            lastEventId: null,
            reasoningLevel: "low" as const,
            runtime: {
              phase: "idle" as const,
              status: "idle" as const,
              agent: "cowork" as const,
              queue: { steering: [], followUp: [] },
            },
            extensionSnapshots: [
              {
                extensionId: "@test/shared",
                epoch: 1,
                model: { status: "new-branch" },
              },
            ],
          })
        },
      },
    })

    const setup = await renderWithProviders(
      () => <ClientAndExtensionProbe onReady={(client, ui) => ((ctx = client), (ext = ui))} />,
      {
        client,
        initialSession: {
          id: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined || ext === undefined) {
      throw new Error("client or extension context not ready")
    }

    ctx.switchSession("session-b" as SessionId, "branch-b" as BranchId, "B")
    await setup.renderOnce()
    await setup.renderOnce()

    expect(ctx.agent()).toBe("cowork")
    expect(ctx.sessionState()).toEqual({
      status: "active",
      session: {
        sessionId: "session-b",
        branchId: "branch-b",
        name: "B",
        reasoningLevel: "low",
      },
    })
    expect(ext.snapshots().get("@test/shared")?.model).toEqual({ status: "new-branch" })

    resolveOldSnapshot?.({
      sessionId: "session-a" as SessionId,
      branchId: "branch-a" as BranchId,
      messages: [],
      lastEventId: null,
      reasoningLevel: "high",
      runtime: {
        phase: "streaming",
        status: "running",
        agent: "deepwork",
        queue: { steering: [], followUp: [] },
      },
      extensionSnapshots: [
        {
          extensionId: "@test/shared",
          epoch: 9,
          model: { status: "old-branch" },
        },
      ],
    })
    await Promise.resolve()
    await setup.renderOnce()
    await setup.renderOnce()

    expect(ctx.agent()).toBe("cowork")
    expect(ctx.sessionState()).toEqual({
      status: "active",
      session: {
        sessionId: "session-b",
        branchId: "branch-b",
        name: "B",
        reasoningLevel: "low",
      },
    })
    expect(ext.snapshots().get("@test/shared")?.model).toEqual({ status: "new-branch" })
  })

  test("stale snapshot failures do not repopulate connection issues after switch", async () => {
    let ctx: ClientContextValue | undefined
    let failOldSnapshot: ((error: Error) => void) | undefined

    const client = createMockClient({
      session: {
        getSnapshot: ({ sessionId }: { sessionId: SessionId; branchId: BranchId }) => {
          if (sessionId === ("session-a" as SessionId)) {
            return Effect.async<never, Error>((resume) => {
              failOldSnapshot = (error) => resume(Effect.fail(error))
              return Effect.void
            })
          }
          return Effect.succeed({
            sessionId: "session-b" as SessionId,
            branchId: "branch-b" as BranchId,
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
          id: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession("session-b" as SessionId, "branch-b" as BranchId, "B")
    await setup.renderOnce()
    await setup.renderOnce()
    expect(ctx.connectionIssue()).toBeNull()

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

  test("old session events are ignored immediately after a session switch", async () => {
    let ctx: ClientContextValue | undefined
    let nextEventId = 0
    const emitters = new Map<string, (envelope: EventEnvelope) => void>()

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
              phase: "idle" as const,
              status: "idle" as const,
              agent: "cowork" as const,
              queue: { steering: [], followUp: [] },
            },
          }),
        events: ({ sessionId, branchId }: { sessionId: SessionId; branchId: BranchId }) =>
          Stream.async<EventEnvelope>((emit) => {
            emitters.set(`${sessionId}:${branchId}`, (envelope) => {
              emit.single(envelope)
            })
            return Effect.sync(() => {
              emitters.delete(`${sessionId}:${branchId}`)
            })
          }),
      },
    })

    const setup = await renderWithProviders(
      () => <ClientProbe onReady={(value) => (ctx = value)} />,
      {
        client,
        initialSession: {
          id: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession("session-b" as SessionId, "branch-b" as BranchId, "B")
    emitters.get("session-a:branch-a")?.(
      new EventEnvelopeClass({
        id: ++nextEventId as EventEnvelope["id"],
        event: new AgentSwitched({
          sessionId: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          fromAgent: "cowork",
          toAgent: "deepwork",
        }),
        createdAt: Date.now(),
      }),
    )

    expect(ctx.agent()).toBe("cowork")

    await setup.renderOnce()
    await setup.renderOnce()

    expect(ctx.agent()).toBe("cowork")
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
})
