/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createSignal } from "solid-js"
import { LinkOpener, LinkOpenerError } from "../src/services/link-opener"
import type { ClientLog } from "../src/utils/client-logger"
import { Auth } from "../src/routes/auth"
import { Route } from "../src/router"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"
import { waitForRenderedFrame } from "./helpers"

const noop = () => {}
const log: ClientLog = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

const runtimeWithLinkOpener = (open: (url: string) => Effect.Effect<void, LinkOpenerError>) => {
  const base = createMockRuntime()
  const provideLinkOpener = <A, E>(effect: Effect.Effect<A, E, LinkOpener>) =>
    effect.pipe(
      Effect.provide(
        LinkOpener.Test({
          open,
        }),
      ),
    )

  return {
    ...base,
    cast: (effect: Effect.Effect<unknown, unknown, never>) => {
      Effect.runFork(provideLinkOpener(effect))
    },
    fork: (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runFork(provideLinkOpener(effect)),
    run: (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(provideLinkOpener(effect)),
  }
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
    await waitForRenderedFrame(
      setup,
      (frame) => frame.includes("openai") && !frame.includes("anthropic"),
    )

    pending[0]?.resolve([{ provider: "anthropic", hasKey: false, required: false }])
    const frame = await waitForRenderedFrame(
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

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(setup, (frame) => frame.includes("Enter API key for anthropic"))
    await setup.mockInput.typeText("old-key")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()

    setAgentName?.("deepwork")
    const reloaded = await waitForRenderedFrame(setup, (frame) => frame.includes("openai"))
    expect(reloaded).toContain("openai")

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(setup, (frame) => frame.includes("Enter API key for openai"))

    resolveOldKeySave?.()
    const frame = await waitForRenderedFrame(
      setup,
      (next) =>
        next.includes("Enter API key for openai") && !next.includes("API key saved for anthropic"),
    )

    expect(frame).toContain("Enter API key for openai")
    expect(frame).not.toContain("API key saved for anthropic")
    setup.renderer.destroy()
  })

  test("ignores stale oauth callbacks after the selected agent changes", async () => {
    let setAgentName: ((value: string) => void) | undefined
    let resolveAuthorize:
      | ((authorization: {
          authorizationId: string
          url: string
          method: "auto"
          instructions?: string
        }) => void)
      | undefined
    const callbackCalls: Array<{ provider: string; authorizationId: string }> = []

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
            anthropic: [{ label: "Browser OAuth", type: "oauth" as const }],
            openai: [{ label: "API key", type: "api" as const }],
          }),
        authorize: ({ provider }: { provider: string; method: number; sessionId: string }) => {
          if (provider !== "anthropic") return Effect.succeed(null)
          return Effect.promise(
            () =>
              new Promise<{
                authorizationId: string
                url: string
                method: "auto"
                instructions?: string
              }>((resolve) => {
                resolveAuthorize = resolve
              }),
          )
        },
        callback: ({ provider, authorizationId }: { provider: string; authorizationId: string }) =>
          Effect.sync(() => {
            callbackCalls.push({ provider, authorizationId })
          }),
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

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()

    setAgentName?.("deepwork")
    await waitForRenderedFrame(setup, (frame) => frame.includes("openai"))

    resolveAuthorize?.({
      authorizationId: "auth-old",
      url: "https://example.com/oauth",
      method: "auto",
    })
    await setup.renderOnce()
    await setup.renderOnce()

    expect(callbackCalls).toEqual([])
    setup.renderer.destroy()
  })

  test("ignores stale oauth opener failures after the selected agent changes", async () => {
    let setAgentName: ((value: string) => void) | undefined
    let rejectOpen: ((error: LinkOpenerError) => void) | undefined
    const calls: Array<{ agentName?: string }> = []

    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) =>
          Effect.sync(() => {
            calls.push(input)
            return input.agentName === "deepwork"
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
                ]
          }),
        listMethods: () =>
          Effect.succeed({
            anthropic: [{ label: "Browser OAuth", type: "oauth" as const }],
            openai: [{ label: "API key", type: "api" as const }],
          }),
        authorize: ({ provider }: { provider: string; method: number; sessionId: string }) => {
          if (provider !== "anthropic") return Effect.succeed(null)
          return Effect.succeed({
            authorizationId: "auth-old",
            url: "https://example.com/oauth",
            method: "code" as const,
          })
        },
      },
    })
    const runtime = runtimeWithLinkOpener(() =>
      Effect.promise<void, LinkOpenerError>(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOpen = (error) => reject(error)
          }),
      ),
    )

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

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(setup, (frame) => frame.includes("Open the URL below"))

    setAgentName?.("deepwork")
    await Promise.resolve()
    await setup.renderOnce()
    expect(calls.at(-1)).toEqual({ agentName: "deepwork" })

    rejectOpen?.(new LinkOpenerError({ message: "open failed" }))
    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("openai") && !next.includes("open failed"),
    )

    expect(frame).toContain("openai")
    expect(frame).not.toContain("open failed")
    setup.renderer.destroy()
  })

  test("ignores stale oauth opener failures after cancelling the same auth flow", async () => {
    let rejectOpen: ((error: LinkOpenerError) => void) | undefined

    const client = createMockClient({
      auth: {
        listProviders: () =>
          Effect.succeed([
            {
              provider: "anthropic",
              hasKey: false,
              required: false,
              source: "none",
              authType: undefined,
            },
          ]),
        listMethods: () =>
          Effect.succeed({
            anthropic: [{ label: "Browser OAuth", type: "oauth" as const }],
          }),
        authorize: ({ provider }: { provider: string; method: number; sessionId: string }) => {
          if (provider !== "anthropic") return Effect.succeed(null)
          return Effect.succeed({
            authorizationId: "auth-cancelled",
            url: "https://example.com/oauth",
            method: "code" as const,
          })
        },
      },
    })
    const runtime = runtimeWithLinkOpener(() =>
      Effect.promise<void, LinkOpenerError>(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOpen = (error) => reject(error)
          }),
      ),
    )

    const setup = await renderWithProviders(
      () => <Auth client={client} runtime={runtime} log={log} agentName="cowork" />,
      {
        client,
        runtime,
        initialRoute: Route.auth(),
      },
    )

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(setup, (frame) => frame.includes("Open the URL below"))

    setup.mockInput.pressEscape()
    await setup.renderOnce()
    await waitForRenderedFrame(
      setup,
      (frame) => frame.includes("anthropic") && !frame.includes("open failed"),
    )

    rejectOpen?.(new LinkOpenerError({ message: "open failed" }))
    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("anthropic") && !next.includes("open failed"),
    )

    expect(frame).toContain("anthropic")
    expect(frame).not.toContain("open failed")
    setup.renderer.destroy()
  })
})
