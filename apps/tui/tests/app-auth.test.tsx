/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { Effect } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { App } from "../src/app"
import { Route } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import {
  createMockClient,
  createMockRuntime,
  renderFrame,
  renderWithProviders,
} from "./render-harness"

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

const waitForFrame = async (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  predicate: (frame: string) => boolean,
  remaining = 10,
): Promise<string> => {
  await setup.renderOnce()
  const frame = renderFrame(setup)
  if (predicate(frame)) return frame
  if (remaining <= 1) {
    throw new Error(`app frame did not reach expected condition; got:\n${frame}`)
  }
  return waitForFrame(setup, predicate, remaining - 1)
}

describe("App auth gate", () => {
  test("rechecks auth requirements when the selected agent changes", async () => {
    let ctx: ClientContextValue | undefined
    const calls: Array<{ agentName?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) => {
          calls.push(input)
          if (input.agentName === "deepwork") {
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: "none",
                authType: undefined,
              },
            ])
          }
          return Effect.succeed([])
        },
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => (
        <>
          <App missingAuthProviders={[]} />
          <ClientProbe onReady={(value) => (ctx = value)} />
        </>
      ),
      {
        client,
        runtime,
        initialSession: {
          id: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.permissions(),
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.steer({ _tag: "SwitchAgent", agent: "deepwork" })

    const frame = await waitForFrame(setup, (next) => next.includes("API Keys"))

    expect(calls.slice(0, 2)).toEqual([{ agentName: "cowork" }, { agentName: "deepwork" }])
    expect(calls.at(-1)).toEqual({ agentName: "deepwork" })
    expect(frame).toContain("API Keys")
    setup.renderer.destroy()
  })

  test("seeds startup auth gating from the initial selected agent", async () => {
    const calls: Array<{ agentName?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) => {
          calls.push(input)
          if (input.agentName === "deepwork") {
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: "none",
                authType: undefined,
              },
            ])
          }
          return Effect.succeed([])
        },
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <App missingAuthProviders={["openai"]} />, {
      client,
      runtime,
      initialAgent: "deepwork",
      initialRoute: Route.auth(),
    })

    const frame = await waitForFrame(setup, (next) => next.includes("API Keys"))

    expect(calls[0]).toEqual({ agentName: "deepwork" })
    expect(frame).toContain("API Keys")
    setup.renderer.destroy()
  })
})
