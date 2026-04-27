/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, Scope } from "effect"
import { LinkOpener, LinkOpenerError } from "../src/services/link-opener"
import { Auth } from "../src/routes/auth"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { AgentName } from "@gent/core/domain/agent"
import { SessionId } from "@gent/core/domain/ids"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"
import { waitForRenderedFrame } from "./helpers"
import { onMount } from "solid-js"

function ClientProbe(props: { readonly onReady: (ctx: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => props.onReady(client))
  return <box />
}

/**
 * Build a services Context that includes a test `LinkOpener` impl.
 *
 * Per [[central-provider-wiring]], component effects requiring `LinkOpener`
 * resolve it through the host-provided services Context — the same path
 * production uses (`uiServices` in main.tsx). Tests that need to override
 * the opener pass this Context via `renderWithProviders({ services })`.
 */
const servicesWithLinkOpener = async (
  open: (url: string) => Effect.Effect<void, LinkOpenerError>,
): Promise<Context.Context<unknown>> => {
  const layer = Layer.merge(BunServices.layer, LinkOpener.Test({ open }))
  const scope = await Effect.runPromise(Scope.make())
  const built = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test harness: foreign-runtime context shape is validated at use sites
  return Context.add(built, Scope.Scope, scope) as unknown as Context.Context<unknown>
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
      initialAgent: AgentName.make("helper:google"),
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
        initialAgent: AgentName.make("cowork"),
      },
    )

    expect(pending.map((entry) => entry.agentName)).toEqual(["cowork"])

    ctx?.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
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
        initialAgent: AgentName.make("cowork"),
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

    ctx?.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
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
    const callbackCalls: Array<{
      provider: string
      method: number
      authorizationId: string
      sessionId: string
    }> = []

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
        callback: (input: {
          provider: string
          method: number
          authorizationId: string
          sessionId: string
        }) =>
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
        initialAgent: AgentName.make("cowork"),
      },
    )

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()

    ctx?.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
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

  test("threads the active session through successful auto OAuth callbacks", async () => {
    const authorizeCalls: Array<{ provider: string; method: number; sessionId: string }> = []
    const callbackCalls: Array<{
      provider: string
      method: number
      authorizationId: string
      sessionId: string
    }> = []

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
        authorize: (input: { provider: string; method: number; sessionId: string }) =>
          Effect.sync(() => {
            authorizeCalls.push(input)
            return {
              authorizationId: "auth-active",
              url: "https://example.com/oauth",
              method: "auto" as const,
            }
          }),
        callback: (input: {
          provider: string
          method: number
          authorizationId: string
          sessionId: string
        }) =>
          Effect.sync(() => {
            callbackCalls.push(input)
          }),
      },
    })
    const services = await servicesWithLinkOpener(() => Effect.void)
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
      client,
      runtime,
      services,
      initialAgent: AgentName.make("cowork"),
    })

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()

    await waitForRenderedFrame(setup, () => callbackCalls.length === 1, "successful OAuth callback")

    expect(authorizeCalls).toEqual([
      { provider: "anthropic", method: 0, sessionId: activeSessionId },
    ])
    expect(callbackCalls).toEqual([
      {
        provider: "anthropic",
        method: 0,
        authorizationId: "auth-active",
        sessionId: activeSessionId,
      },
    ])
    setup.renderer.destroy()
  })

  test("ignores stale oauth opener failures after the selected agent changes", async () => {
    let ctx: ClientContextValue | undefined
    let rejectOpen: ((error: LinkOpenerError) => void) | undefined
    const calls: Array<{ agentName?: string; sessionId?: string }> = []
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
    const services = await servicesWithLinkOpener(() =>
      Effect.callback<void, LinkOpenerError>((resume) => {
        rejectOpen = (error) => resume(Effect.fail(error))
      }),
    )
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
        services,
        initialAgent: AgentName.make("cowork"),
      },
    )

    await waitForRenderedFrame(setup, (frame) => frame.includes("anthropic"))

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(setup, (frame) => frame.includes("Open the URL below"))

    ctx?.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
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
    const services = await servicesWithLinkOpener(() =>
      Effect.callback<void, LinkOpenerError>((resume) => {
        rejectOpen = (error) => resume(Effect.fail(error))
      }),
    )
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
      client,
      runtime,
      services,
      initialAgent: AgentName.make("cowork"),
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
      (frame) =>
        frame.includes("anthropic") &&
        !frame.includes("Open the URL below") &&
        !frame.includes("open failed"),
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
