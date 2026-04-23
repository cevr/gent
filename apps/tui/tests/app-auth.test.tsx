/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { Effect } from "effect"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { emptyQueueSnapshot } from "@gent/sdk"
import { App } from "../src/app"
import { Route, useRouter, type RouterContextValue } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"
import { waitForRenderedFrame } from "./helpers"

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

function RouterProbe(props: { readonly onReady: (router: RouterContextValue) => void }) {
  const router = useRouter()
  onMount(() => {
    props.onReady(router)
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

  test("branch resume with a prompt waits for auth before sending the first turn", async () => {
    let ctx: ClientContextValue | undefined
    let router: RouterContextValue | undefined
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
    const calls: Array<{ agentName?: string }> = []
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
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId: SessionId.make("session-a"),
            branchId: BranchId.make("branch-b"),
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              _tag: "Idle" as const,
              agent: "deepwork" as const,
              queue: emptyQueueSnapshot(),
            },
          }),
      },
      auth: {
        listProviders: (input: { agentName?: string }) => {
          calls.push(input)
          return Effect.promise(() => providersPromise)
        },
        listMethods: () =>
          Effect.succeed({
            openai: [{ label: "API key", type: "api" as const }],
          }),
      },
      branch: {
        getTree: () =>
          Effect.succeed([
            { id: BranchId.make("branch-a"), name: "Main", messageCount: 3, children: [] },
            { id: BranchId.make("branch-b"), name: "Side", messageCount: 1, children: [] },
          ]),
      },
      message: {
        send: (input: { content: string }) =>
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
          <ClientProbe onReady={(value) => (ctx = value)} />
          <RouterProbe onReady={(value) => (router = value)} />
        </>
      ),
      {
        client,
        runtime,
        initialRoute: Route.branchPicker(SessionId.make("session-a"), "Session A", [
          { id: BranchId.make("branch-a"), sessionId: SessionId.make("session-a"), createdAt: 0 },
          { id: BranchId.make("branch-b"), sessionId: SessionId.make("session-a"), createdAt: 1 },
        ]),
      },
    )
    if (ctx === undefined || router === undefined) {
      throw new Error("client or router context not ready")
    }

    ctx.switchSession(SessionId.make("session-a"), BranchId.make("branch-b"), "Session A")
    router.navigateToSession(SessionId.make("session-a"), BranchId.make("branch-b"), "ship it")

    // Auth gate should be checking — prompt must not be sent yet
    expect(sentMessages).toEqual([])

    resolveProviders?.([
      {
        provider: "openai",
        hasKey: false,
        required: true,
        source: "none",
        authType: undefined,
      },
    ])

    const authFrame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("API Keys"),
      "auth gate",
    )
    expect(authFrame).toContain("API Keys")
    expect(sentMessages).toEqual([])
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
})
