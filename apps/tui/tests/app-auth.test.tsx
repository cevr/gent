/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { Effect } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
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

    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("API Keys"),
      "API Keys after agent switch",
    )

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.agentName === "deepwork")).toBe(true)
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

    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("API Keys"),
      "API Keys from initial agent",
    )

    expect(calls[0]).toEqual({ agentName: "deepwork" })
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
            { id: "branch-a" as BranchId, name: "Main", messageCount: 3, children: [] },
            { id: "branch-b" as BranchId, name: "Side", messageCount: 1, children: [] },
          ]),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(() => <App missingAuthProviders={[]} />, {
      client,
      runtime,
      initialSession: {
        id: "session-a" as SessionId,
        branchId: "branch-a" as BranchId,
        name: "Session A",
        createdAt: 0,
        updatedAt: 0,
      },
      initialRoute: Route.branchPicker("session-a" as SessionId, "Session A", [
        { id: "branch-a" as BranchId, sessionId: "session-a" as SessionId, createdAt: 0 },
        { id: "branch-b" as BranchId, sessionId: "session-a" as SessionId, createdAt: 1 },
      ]),
    })

    await waitForRenderedFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker")
    expect(calls).toEqual([])
    setup.renderer.destroy()
  })

  test("loading route renders while the runtime is disconnected", async () => {
    const runtime = createMockRuntime()
    runtime.lifecycle = {
      getState: () => ({ _tag: "disconnected", reason: "boot boom" }),
      subscribe: (listener) => {
        listener({ _tag: "disconnected", reason: "boot boom" })
        return () => {}
      },
      restart: Effect.void,
      waitForReady: Effect.void,
    }

    const setup = await renderWithProviders(
      () => (
        <App
          startup={{
            cwd: "/tmp/project",
            continue_: false,
          }}
        />
      ),
      {
        runtime,
        initialRoute: Route.loading(),
      },
    )

    const frame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("Loading Gent") && next.includes("runtime unavailable"),
      "loading with runtime unavailable",
    )

    expect(frame).toContain("boot boom")
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
            sessionId: "session-a" as SessionId,
            branchId: "branch-b" as BranchId,
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              phase: "idle" as const,
              status: "idle" as const,
              agent: "deepwork" as const,
              queue: { steering: [], followUp: [] },
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
            { id: "branch-a" as BranchId, name: "Main", messageCount: 3, children: [] },
            { id: "branch-b" as BranchId, name: "Side", messageCount: 1, children: [] },
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
        initialRoute: Route.branchPicker("session-a" as SessionId, "Session A", [
          { id: "branch-a" as BranchId, sessionId: "session-a" as SessionId, createdAt: 0 },
          { id: "branch-b" as BranchId, sessionId: "session-a" as SessionId, createdAt: 1 },
        ]),
      },
    )
    if (ctx === undefined || router === undefined) {
      throw new Error("client or router context not ready")
    }

    ctx.switchSession("session-a" as SessionId, "branch-b" as BranchId, "Session A")
    router.navigateToSession("session-a" as SessionId, "branch-b" as BranchId, "ship it")

    const loadingFrame = await waitForRenderedFrame(
      setup,
      (next) => next.includes("Loading session"),
      "loading session",
    )
    expect(loadingFrame).toContain("Loading session")
    expect(calls).toEqual([{ agentName: "deepwork" }])
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
})
