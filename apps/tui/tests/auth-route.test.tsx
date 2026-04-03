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

  test("ignores stale auth mutations after the selected agent changes", async () => {
    let setAgentName: ((value: string) => void) | undefined
    let resolveOldKeySave: (() => void) | undefined

    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) =>
          Effect.succeed(
            input.agentName === "deepwork"
              ? [
                  {
                    provider: "openai",
                    hasKey: false,
                    required: false,
                    source: "none",
                    authType: undefined,
                  },
                ]
              : [
                  {
                    provider: "anthropic",
                    hasKey: false,
                    required: false,
                    source: "none",
                    authType: undefined,
                  },
                ],
          ),
        listMethods: () =>
          Effect.succeed({
            anthropic: [{ label: "API key", type: "api" as const }],
            openai: [{ label: "API key", type: "api" as const }],
          }),
        setKey: ({ provider }: { provider: string; key: string }) => {
          if (provider === "anthropic") {
            return Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  resolveOldKeySave = resolve
                }),
            )
          }
          return Effect.succeed(undefined)
        },
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

    await waitForFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForFrame(setup, (frame) => frame.includes("Enter API key for anthropic"))
    await setup.mockInput.typeText("old-key")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()

    setAgentName?.("deepwork")
    const reloaded = await waitForFrame(setup, (frame) => frame.includes("openai"))
    expect(reloaded).toContain("openai")

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForFrame(setup, (frame) => frame.includes("Enter API key for openai"))

    resolveOldKeySave?.()
    const frame = await waitForFrame(
      setup,
      (next) =>
        next.includes("Enter API key for openai") && !next.includes("API key saved for anthropic"),
    )

    expect(frame).toContain("Enter API key for openai")
    expect(frame).not.toContain("API key saved for anthropic")
    setup.renderer.destroy()
  })
})
