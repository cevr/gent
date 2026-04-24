/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { Effect } from "effect"
import { ProviderAuthError } from "@gent/core/domain/driver"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { emptyQueueSnapshot } from "@gent/sdk"
import { App } from "../src/app"
import { Route } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"
import { renderFrame, waitForRenderedFrame } from "./helpers"

type AppAuthRenderSetup = Awaited<ReturnType<typeof renderWithProviders>>

const waitForMessage = async (
  setup: AppAuthRenderSetup,
  messages: readonly { readonly content: string }[],
  content: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const startedAt = Date.now()
  const poll = async (): Promise<void> => {
    await setup.renderOnce()
    if (messages.some((message) => message.content === content)) return
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for message: ${content}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    return poll()
  }
  return poll()
}

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
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
          id: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    ctx.steer({ _tag: "SwitchAgent", agent: "deepwork" })

    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("API Keys"),
      "API Keys after agent switch",
    )

    expect(calls.length).toBeGreaterThan(0)
    expect(frame).toContain("API Keys")
    setup.renderer.destroy()
  })

  test("seeds startup auth gating from the initial selected agent", async () => {
    const calls: Array<{ agentName?: string; sessionId?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string; sessionId?: string }) => {
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
      initialSession: {
        id: SessionId.make("session-a"),
        branchId: BranchId.make("branch-a"),
        name: "A",
        createdAt: 0,
        updatedAt: 0,
      },
    })

    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("API Keys"),
      "API Keys from initial agent",
    )

    expect(calls[0]).toEqual({ agentName: "deepwork", sessionId: "test-session" })
    expect(frame).toContain("API Keys")
    setup.renderer.destroy()
  })

  test("branch picker does not trigger auth gating before a branch is selected", async () => {
    const calls: Array<{ agentName?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) => {
          calls.push(input)
          return Effect.succeed([])
        },
      },
      branch: {
        getTree: () =>
          Effect.succeed([
            { id: BranchId.make("branch-a"), name: "Main", messageCount: 3, children: [] },
            { id: BranchId.make("branch-b"), name: "Side", messageCount: 1, children: [] },
          ]),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <App missingAuthProviders={[]} />, {
      client,
      runtime,
      initialSession: {
        id: SessionId.make("session-a"),
        branchId: BranchId.make("branch-a"),
        name: "Session A",
        createdAt: 0,
        updatedAt: 0,
      },
      initialRoute: Route.branchPicker(SessionId.make("session-a"), "Session A", [
        { id: BranchId.make("branch-a"), sessionId: SessionId.make("session-a"), createdAt: 0 },
        { id: BranchId.make("branch-b"), sessionId: SessionId.make("session-a"), createdAt: 1 },
      ]),
    })

    await waitForRenderedFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker")
    expect(calls).toEqual([])
    setup.renderer.destroy()
  })

  test("cold start with prompt and missing auth defers the prompt until auth resolves", async () => {
    let resolveProviders:
      | ((
          providers: Array<{
            provider: string
            hasKey: boolean
            required: boolean
            source: "none"
            authType: undefined
          }>,
        ) => void)
      | undefined
    const sentMessages: Array<{ content: string }> = []
    const providersPromise = new Promise<
      Array<{
        provider: string
        hasKey: boolean
        required: boolean
        source: "none"
        authType: undefined
      }>
    >((resolve) => {
      resolveProviders = resolve
    })
    const client = createMockClient({
      auth: {
        listProviders: () => Effect.promise(() => providersPromise),
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
      },
      message: {
        send: (input: { content: string }) =>
          Effect.sync(() => {
            sentMessages.push(input)
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <App missingAuthProviders={["openai"]} />, {
      client,
      runtime,
      initialAgent: "cowork",
      initialSession: {
        id: SessionId.make("session-a"),
        branchId: BranchId.make("branch-a"),
        name: "A",
        createdAt: 0,
        updatedAt: 0,
      },
      initialRoute: Route.session(
        SessionId.make("session-a"),
        BranchId.make("branch-a"),
        "build a feature",
      ),
    })

    // Auth is pending — prompt must not be sent yet
    await setup.renderOnce()
    expect(sentMessages).toEqual([])

    // Resolve auth — keys are required but missing
    resolveProviders?.([
      {
        provider: "openai",
        hasKey: false,
        required: true,
        source: "none",
        authType: undefined,
      },
    ])

    // Auth overlay should appear
    const authFrame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("API Keys"),
      "auth overlay",
    )
    expect(authFrame).toContain("API Keys")
    // Prompt still not sent while auth overlay is open
    expect(sentMessages).toEqual([])
    setup.renderer.destroy()
  })

  test("cold start with prompt does not continue when auth checking fails", async () => {
    let authChecks = 0
    const sentMessages: Array<{ content: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: () =>
          Effect.sync(() => {
            authChecks += 1
          }).pipe(
            Effect.flatMap(() =>
              Effect.fail(new ProviderAuthError({ message: "session auth lookup failed" })),
            ),
          ),
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
      },
      message: {
        send: (input: { content: string }) =>
          Effect.sync(() => {
            sentMessages.push(input)
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <App missingAuthProviders={[]} />, {
      client,
      runtime,
      initialAgent: "cowork",
      initialSession: {
        id: SessionId.make("session-a"),
        branchId: BranchId.make("branch-a"),
        name: "A",
        createdAt: 0,
        updatedAt: 0,
      },
      initialRoute: Route.session(
        SessionId.make("session-a"),
        BranchId.make("branch-a"),
        "must not send",
      ),
    })

    await waitForRenderedFrame(setup, () => authChecks > 0, "auth check failure")
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
    expect(sentMessages).toEqual([])
    setup.renderer.destroy()
  })

  test("branch resume route gates auth, sends deferred prompt, and searches prompt history", async () => {
    let hasOpenAiKey = false
    let initialAuthCheckResolved = false
    let resolveInitialAuthCheck: (() => void) | undefined
    const initialAuthCheck = new Promise<void>((resolve) => {
      resolveInitialAuthCheck = () => {
        initialAuthCheckResolved = true
        resolve()
      }
    })
    const sentMessages: Array<{
      sessionId: SessionId
      branchId: BranchId
      content: string
      requestId: string
    }> = []

    const alphaSessionId = SessionId.make("session-alpha")
    const alphaBranchId = BranchId.make("branch-alpha")
    const betaBranchId = BranchId.make("branch-beta")
    const initialPrompt = "deferred route-flow prompt"
    const historyPrompt = "batch eighteen prompt search route flow"

    const client = createMockClient({
      session: {
        getSnapshot: ({
          sessionId,
          branchId,
        }: {
          readonly sessionId: SessionId
          readonly branchId: BranchId
        }) =>
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
          }),
      },
      branch: {
        getTree: () =>
          Effect.succeed([
            { id: alphaBranchId, name: "Main", messageCount: 3, children: [] },
            { id: betaBranchId, name: "Side", messageCount: 1, children: [] },
          ]),
      },
      auth: {
        listProviders: () => {
          const providers = [
            {
              provider: "openai",
              hasKey: hasOpenAiKey,
              required: true,
              source: hasOpenAiKey ? ("stored" as const) : ("none" as const),
              authType: undefined,
            },
          ]
          if (hasOpenAiKey || initialAuthCheckResolved) return Effect.succeed(providers)
          return Effect.promise(() => initialAuthCheck).pipe(Effect.as(providers))
        },
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
        setKey: ({ key }: { readonly key: string }) =>
          Effect.sync(() => {
            hasOpenAiKey = key.length > 0
          }),
      },
      message: {
        send: (input: {
          readonly sessionId: SessionId
          readonly branchId: BranchId
          readonly content: string
          readonly requestId: string
        }) =>
          Effect.sync(() => {
            sentMessages.push(input)
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => (
        <>
          <App missingAuthProviders={[]} />
        </>
      ),
      {
        client,
        runtime,
        initialAgent: "cowork",
        initialSession: {
          id: alphaSessionId,
          branchId: alphaBranchId,
          name: "Alpha",
          createdAt: 0,
          updatedAt: 1,
        },
        initialRoute: Route.branchPicker(
          alphaSessionId,
          "Alpha",
          [
            { id: alphaBranchId, sessionId: alphaSessionId, name: "Main", createdAt: 0 },
            { id: betaBranchId, sessionId: alphaSessionId, name: "Side", createdAt: 1 },
          ],
          initialPrompt,
        ),
        width: 100,
        height: 30,
      },
    )

    await waitForRenderedFrame(
      setup,
      (frame) => frame.includes("Resume: Alpha") && frame.includes("Side (1)"),
      "branch picker",
    )
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await Promise.resolve()
    await setup.renderOnce()
    expect(sentMessages).toEqual([])

    resolveInitialAuthCheck?.()
    await waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate")
    expect(sentMessages).toEqual([])

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await waitForRenderedFrame(
      setup,
      (frame) => frame.includes("Enter API key for openai"),
      "openai key input",
    )
    await setup.mockInput.typeText("sk-test")
    setup.mockInput.pressEnter()

    await waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth overlay closed")
    expect(hasOpenAiKey).toBe(true)
    await waitForMessage(setup, sentMessages, initialPrompt)
    expect(sentMessages.find((message) => message.content === initialPrompt)).toMatchObject({
      sessionId: alphaSessionId,
      branchId: betaBranchId,
    })

    await setup.mockInput.typeText(historyPrompt)
    setup.mockInput.pressEnter()
    await waitForMessage(setup, sentMessages, historyPrompt)

    setup.mockInput.pressKey("r", { ctrl: true })
    await waitForRenderedFrame(
      setup,
      (frame) => frame.includes("Prompt Search") && frame.includes(historyPrompt),
      "prompt search history",
    )
    setup.mockInput.pressEscape()
    await waitForRenderedFrame(
      setup,
      (frame) => !frame.includes("Prompt Search"),
      "prompt search closed",
    )
    setup.renderer.destroy()
  })

  test("stale auth checks cannot reopen the auth gate after key save", async () => {
    let ctx: ClientContextValue | undefined
    let hasOpenAiKey = false
    let sessionAuthChecks = 0
    let resolveStaleSessionCheck:
      | ((
          providers: Array<{
            provider: string
            hasKey: boolean
            required: boolean
            source: "none"
            authType: undefined
          }>,
        ) => void)
      | undefined
    const staleSessionCheck = new Promise<
      Array<{
        provider: string
        hasKey: boolean
        required: boolean
        source: "none"
        authType: undefined
      }>
    >((resolve) => {
      resolveStaleSessionCheck = resolve
    })
    const sentMessages: Array<{ content: string }> = []
    const initialPrompt = "stale auth race prompt"

    const client = createMockClient({
      auth: {
        listProviders: (input: { readonly sessionId?: SessionId; readonly agentName?: string }) => {
          if (input.sessionId !== undefined) {
            sessionAuthChecks++
            if (sessionAuthChecks === 1) {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: true,
                  source: "none" as const,
                  authType: undefined,
                },
              ])
            }
            if (sessionAuthChecks === 2) return Effect.promise(() => staleSessionCheck)
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: hasOpenAiKey ? ("stored" as const) : ("none" as const),
                authType: undefined,
              },
            ])
          }
          return Effect.succeed([
            {
              provider: "openai",
              hasKey: hasOpenAiKey,
              required: true,
              source: hasOpenAiKey ? ("stored" as const) : ("none" as const),
              authType: undefined,
            },
          ])
        },
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
        setKey: ({ key }: { readonly key: string }) =>
          Effect.sync(() => {
            hasOpenAiKey = key.length > 0
          }),
      },
      message: {
        send: (input: { readonly content: string }) =>
          Effect.sync(() => {
            sentMessages.push(input)
          }),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => (
        <>
          <App missingAuthProviders={["openai"]} />
          <ClientProbe onReady={(value) => (ctx = value)} />
        </>
      ),
      {
        client,
        runtime,
        initialAgent: "cowork",
        initialSession: {
          id: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          name: "A",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session(
          SessionId.make("session-a"),
          BranchId.make("branch-a"),
          initialPrompt,
        ),
        width: 100,
        height: 30,
      },
    )
    if (ctx === undefined) throw new Error("client context not ready")

    await waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate")
    ctx.steer({ _tag: "SwitchAgent", agent: "deepwork" })
    await waitForRenderedFrame(
      setup,
      () => sessionAuthChecks >= 2,
      "stale session auth check started",
    )
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await waitForRenderedFrame(
      setup,
      (frame) => frame.includes("Enter API key for openai"),
      "openai key input",
    )
    await setup.mockInput.typeText("sk-test")
    setup.mockInput.pressEnter()

    await waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth resolved")
    await waitForMessage(setup, sentMessages, initialPrompt)

    resolveStaleSessionCheck?.([
      {
        provider: "openai",
        hasKey: false,
        required: true,
        source: "none",
        authType: undefined,
      },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
    expect(renderFrame(setup)).not.toContain("API Keys")
    expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
    setup.renderer.destroy()
  })
})
