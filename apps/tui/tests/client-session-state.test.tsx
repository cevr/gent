/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { onMount } from "solid-js"
import { Effect } from "effect"
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
      createSession: () =>
        Effect.succeed({
          sessionId: "session-created" as SessionId,
          branchId: "branch-created" as BranchId,
          name: "Created",
          bypass: false,
        }),
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
        bypass: false,
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
          bypass: true,
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.switchSession("session-b" as SessionId, "branch-b" as BranchId, "B", false)
    await setup.renderOnce()

    expect(ctx.sessionState()).toEqual({
      status: "active",
      session: {
        sessionId: "session-b",
        branchId: "branch-b",
        name: "B",
        bypass: false,
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
          bypass: true,
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
})
