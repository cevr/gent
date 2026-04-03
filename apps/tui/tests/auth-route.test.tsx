/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createSignal } from "solid-js"
import type { ClientLog } from "../src/utils/client-logger"
import { Auth } from "../src/routes/auth"
import { Route } from "../src/router"
import {
  createMockClient,
  createMockRuntime,
  renderFrame,
  renderWithProviders,
} from "./render-harness"

const noop = () => {}
const log: ClientLog = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
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
    throw new Error(`auth frame did not reach expected condition; got:\n${frame}`)
  }
  return waitForFrame(setup, predicate, remaining - 1)
}

describe("Auth route", () => {
  test("loads providers for the selected agent", async () => {
    const calls: Array<{ agentName?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) => {
          calls.push(input)
          return Effect.succeed([])
        },
        listMethods: () => Effect.succeed({}),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => <Auth client={client} runtime={runtime} log={log} agentName="helper:google" />,
      {
        client,
        runtime,
        initialRoute: Route.auth(),
      },
    )

    expect(calls).toEqual([{ agentName: "helper:google" }])
    setup.renderer.destroy()
  })

  test("ignores stale auth loads after the selected agent changes", async () => {
    let setAgentName: ((value: string) => void) | undefined
    const pending: Array<{
      agentName?: string
      resolve: (
        providers: ReadonlyArray<{ provider: string; hasKey: boolean; required: boolean }>,
      ) => void
    }> = []

    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<{ provider: string; hasKey: boolean; required: boolean }>>(
                (resolve) => {
                  pending.push({ agentName: input.agentName, resolve })
                },
              ),
          ),
        listMethods: () => Effect.succeed({}),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => {
        const [agentName, setAgent] = createSignal("cowork")
        setAgentName = setAgent
        return <Auth client={client} runtime={runtime} log={log} agentName={agentName()} />
      },
      {
        client,
        runtime,
        initialRoute: Route.auth(),
      },
    )

    expect(pending.map((entry) => entry.agentName)).toEqual(["cowork"])

    setAgentName?.("deepwork")
    await setup.renderOnce()

    expect(pending.map((entry) => entry.agentName)).toEqual(["cowork", "deepwork"])

    pending[1]?.resolve([{ provider: "openai", hasKey: false, required: false }])
    await waitForFrame(setup, (frame) => frame.includes("openai") && !frame.includes("anthropic"))

    pending[0]?.resolve([{ provider: "anthropic", hasKey: false, required: false }])
    const frame = await waitForFrame(
      setup,
      (next) => next.includes("openai") && !next.includes("anthropic"),
    )

    expect(frame).toContain("openai")
    expect(frame).not.toContain("anthropic")
    setup.renderer.destroy()
  })
})
