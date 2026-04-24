/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LinkOpener, LinkOpenerError } from "../src/services/link-opener"
import { Auth } from "../src/routes/auth"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import type { AgentName } from "@gent/core/domain/agent"
import { SessionId } from "@gent/core/domain/ids"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"
import { waitForRenderedFrame } from "./helpers"
import { onMount } from "solid-js"

function ClientProbe(props: { readonly onReady: (ctx: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => props.onReady(client))
  return <box />
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
  const activeSessionId = SessionId.make("session-auth")

  test("loads providers for the selected agent", async () => {
    const calls: Array<{ agentName?: string; sessionId?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string; sessionId?: string }) => {
          calls.push(input)
          return Effect.succeed([])
        },
        listMethods: () => Effect.succeed({}),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
      client,
      runtime,
      initialAgent: "helper:google" as AgentName,
    })

    expect(calls).toEqual([{ agentName: "helper:google", sessionId: activeSessionId }])
    setup.renderer.destroy()
  })

  test("ignores stale auth loads after the selected agent changes", async () => {
    let ctx: ClientContextValue | undefined
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
      () => (
        <>
          <ClientProbe onReady={(c) => (ctx = c)} />
          <Auth sessionId={activeSessionId} />
        </>
      ),
      {
        client,
        runtime,
        initialAgent: "cowork" as AgentName,
      },
    )

    expect(pending.map((entry) => entry.agentName)).toEqual(["cowork"])

    ctx?.steer({ _tag: "SwitchAgent", agent: "deepwork" as AgentName })
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
    let ctx: ClientContextValue | undefined
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
      () => (
        <>
          <ClientProbe onReady={(c) => (ctx = c)} />
          <Auth sessionId={activeSessionId} />
        </>
      ),
      {
        client,
        runtime,
        initialAgent: "cowork" as AgentName,
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

    ctx?.steer({ _tag: "SwitchAgent", agent: "deepwork" as AgentName })
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
    let ctx: ClientContextValue | undefined
    let resolveAuthorize:
      | ((authorization: {
          authorizationId: string
          url: string
          method: "auto"
          instructions?: string
        }) => void)
      | undefined
    const authorizeCalls: Array<{ provider: string; method: number; sessionId: string }> = []
    const callbackCalls: Array<{ provider: string; authorizationId: string; sessionId: string }> =
      []

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
        authorize: (input: { provider: string; method: number; sessionId: string }) => {
          authorizeCalls.push(input)
          const { provider } = input
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
        callback: (input: { provider: string; authorizationId: string; sessionId: string }) =>
          Effect.sync(() => {
            callbackCalls.push(input)
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => (
        <>
          <ClientProbe onReady={(c) => (ctx = c)} />
          <Auth sessionId={activeSessionId} />
        </>
      ),
      {
        client,
        runtime,
        initialAgent: "cowork" as AgentName,
      },
    )

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()

    ctx?.steer({ _tag: "SwitchAgent", agent: "deepwork" as AgentName })
    await waitForRenderedFrame(setup, (frame) => frame.includes("openai"))

    resolveAuthorize?.({
      authorizationId: "auth-old",
      url: "https://example.com/oauth",
      method: "auto",
    })
    await setup.renderOnce()
    await setup.renderOnce()

    expect(authorizeCalls).toEqual([
      { provider: "anthropic", method: 0, sessionId: activeSessionId },
    ])
    expect(callbackCalls).toEqual([])
    setup.renderer.destroy()
  })

  test("ignores stale oauth opener failures after the selected agent changes", async () => {
    let ctx: ClientContextValue | undefined
    let rejectOpen: ((error: LinkOpenerError) => void) | undefined
    const calls: Array<{ agentName?: string }> = []
    const authorizeCalls: Array<{ provider: string; method: number; sessionId: string }> = []

    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string; sessionId?: string }) =>
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
        authorize: (input: { provider: string; method: number; sessionId: string }) => {
          authorizeCalls.push(input)
          const { provider } = input
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
      () => (
        <>
          <ClientProbe onReady={(c) => (ctx = c)} />
          <Auth sessionId={activeSessionId} />
        </>
      ),
      {
        client,
        runtime,
        initialAgent: "cowork" as AgentName,
      },
    )

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(setup, (frame) => frame.includes("Open the URL below"))

    ctx?.steer({ _tag: "SwitchAgent", agent: "deepwork" as AgentName })
    await Promise.resolve()
    await setup.renderOnce()
    expect(calls.at(-1)).toEqual({ agentName: "deepwork", sessionId: activeSessionId })

    rejectOpen?.(new LinkOpenerError({ message: "open failed" }))
    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("openai") && !next.includes("open failed"),
    )

    expect(frame).toContain("openai")
    expect(frame).not.toContain("open failed")
    expect(authorizeCalls).toEqual([
      { provider: "anthropic", method: 0, sessionId: activeSessionId },
    ])
    setup.renderer.destroy()
  })

  test("ignores stale oauth opener failures after cancelling the same auth flow", async () => {
    let rejectOpen: ((error: LinkOpenerError) => void) | undefined
    const authorizeCalls: Array<{ provider: string; method: number; sessionId: string }> = []

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
        authorize: (input: { provider: string; method: number; sessionId: string }) => {
          authorizeCalls.push(input)
          const { provider } = input
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

    const setup = await renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
      client,
      runtime,
      initialAgent: "cowork" as AgentName,
    })

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
    expect(authorizeCalls).toEqual([
      { provider: "anthropic", method: 0, sessionId: activeSessionId },
    ])
    setup.renderer.destroy()
  })
})
