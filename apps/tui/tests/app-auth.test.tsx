/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { onMount } from "solid-js"
import { Deferred, Effect } from "effect"
import { ProviderAuthError } from "@gent/core/domain/driver"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { emptyQueueSnapshot } from "@gent/sdk"
import { App } from "../src/app"
import { Route } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"
import { renderFrame, waitForRenderedFrame } from "./helpers"
import { AgentName } from "@gent/core/domain/agent"
type AppAuthRenderSetup = Awaited<ReturnType<typeof renderWithProviders>>
const waitForMessage = (
  setup: AppAuthRenderSetup,
  messages: readonly {
    readonly content: string
  }[],
  content: string,
  timeoutMs = 2000,
): Promise<void> => {
  const startedAt = Date.now()
  const poll: Effect.Effect<void, Error> = Effect.gen(function* () {
    yield* Effect.promise(() => setup.renderOnce())
    if (messages.some((message) => message.content === content)) return
    if (Date.now() - startedAt >= timeoutMs) {
      return yield* Effect.fail(new Error(`timed out waiting for message: ${content}`))
    }
    yield* Effect.sleep("10 millis")
    return yield* poll
  })
  return Effect.runPromise(poll)
}
function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}
describe("App auth gate", () => {
  it.live("rechecks auth requirements when the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      const calls: Array<{
        agentName?: string
      }> = []
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
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
        ),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      ctx.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("API Keys"),
          "API Keys after agent switch",
        ),
      )
      expect(calls.length).toBeGreaterThan(0)
      expect(frame).toContain("API Keys")
      setup.renderer.destroy()
    }),
  )
  it.live("seeds startup auth gating from the initial selected agent", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
        sessionId?: string
      }> = []
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={["openai"]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("deepwork"),
          initialSession: {
            id: SessionId.make("session-a"),
            branchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("API Keys"),
          "API Keys from initial agent",
        ),
      )
      expect(calls[0]).toEqual({
        agentName: AgentName.make("deepwork"),
        sessionId: SessionId.make("test-session"),
      })
      expect(frame).toContain("API Keys")
      setup.renderer.destroy()
    }),
  )
  it.live("branch picker does not trigger auth gating before a branch is selected", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
      }> = []
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
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
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker"),
      )
      expect(calls).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt and missing auth defers the prompt until auth resolves", () =>
    Effect.gen(function* () {
      const providersDeferred = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: undefined
        }>
      >()
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () => Deferred.await(providersDeferred),
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={["openai"]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
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
        }),
      )
      // Auth is pending — prompt must not be sent yet
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      // Resolve auth — keys are required but missing
      yield* Deferred.succeed(providersDeferred, [
        {
          provider: "openai",
          hasKey: false,
          required: true,
          source: "none",
          authType: undefined,
        },
      ])
      // Auth overlay should appear
      const authFrame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (next) => next.includes("API Keys"), "auth overlay"),
      )
      expect(authFrame).toContain("API Keys")
      // Prompt still not sent while auth overlay is open
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt does not continue when auth checking fails", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
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
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => authChecks > 0, "auth check failure"),
      )
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt recovers after a transient auth check failure", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                authChecks === 1
                  ? Effect.fail(new ProviderAuthError({ message: "temporary auth lookup failed" }))
                  : Effect.succeed([]),
              ),
            ),
          listMethods: () => Effect.succeed({}),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
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
            "send after retry",
          ),
        }),
      )
      yield* Effect.promise(() => waitForMessage(setup, sentMessages, "send after retry"))
      expect(authChecks).toBeGreaterThan(1)
      setup.renderer.destroy()
    }),
  )
  it.live("enforced auth overlay can retry failed provider loads", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                authChecks < 3
                  ? Effect.fail(new ProviderAuthError({ message: "temporary auth lookup failed" }))
                  : Effect.succeed([]),
              ),
            ),
          listMethods: () => Effect.succeed({}),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App missingAuthProviders={[]} />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            branchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: 0,
            updatedAt: 0,
          },
          initialRoute: Route.session(SessionId.make("session-a"), BranchId.make("branch-a")),
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) =>
            frame.includes("temporary auth lookup failed") && frame.includes("Press r to retry"),
          "retryable auth error",
        ),
      )
      setup.mockInput.pressKey("r")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth retry resolved"),
      )
      expect(authChecks).toBe(3)
      setup.renderer.destroy()
    }),
  )
  it.live(
    "branch resume route gates auth, sends deferred prompt, and searches prompt history",
    () =>
      Effect.gen(function* () {
        let hasOpenAiKey = false
        let initialAuthCheckResolved = false
        const initialAuthCheck = yield* Deferred.make<void>()
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
        const historyPrompt = "resume prompt search route flow"
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
                metrics: {
                  turns: 0,
                  tokens: 0,
                  toolCalls: 0,
                  retries: 0,
                  durationMs: 0,
                  costUsd: 0,
                  lastInputTokens: 0,
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
              return Deferred.await(initialAuthCheck).pipe(Effect.as(providers))
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
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => (
              <>
                <App missingAuthProviders={[]} />
              </>
            ),
            {
              client,
              runtime,
              initialAgent: AgentName.make("cowork"),
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
          ),
        )
        yield* Effect.promise(() =>
          waitForRenderedFrame(
            setup,
            (frame) => frame.includes("Resume: Alpha") && frame.includes("Side (1)"),
            "branch picker",
          ),
        )
        setup.mockInput.pressArrow("down")
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        yield* Effect.yieldNow
        yield* Effect.promise(() => setup.renderOnce())
        expect(sentMessages).toEqual([])
        initialAuthCheckResolved = true
        yield* Deferred.succeed(initialAuthCheck, undefined)
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate"),
        )
        expect(sentMessages).toEqual([])
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        yield* Effect.promise(() =>
          waitForRenderedFrame(
            setup,
            (frame) => frame.includes("Enter API key for openai"),
            "openai key input",
          ),
        )
        yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
        setup.mockInput.pressEnter()
        yield* Effect.promise(() =>
          waitForRenderedFrame(
            setup,
            (frame) => !frame.includes("API Keys"),
            "auth overlay closed",
          ),
        )
        expect(hasOpenAiKey).toBe(true)
        yield* Effect.promise(() => waitForMessage(setup, sentMessages, initialPrompt))
        expect(sentMessages.find((message) => message.content === initialPrompt)).toMatchObject({
          sessionId: alphaSessionId,
          branchId: betaBranchId,
        })
        yield* Effect.promise(() => setup.mockInput.typeText(historyPrompt))
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => waitForMessage(setup, sentMessages, historyPrompt))
        setup.mockInput.pressKey("r", { ctrl: true })
        yield* Effect.promise(() =>
          waitForRenderedFrame(
            setup,
            (frame) => frame.includes("Prompt Search") && frame.includes(historyPrompt),
            "prompt search history",
          ),
        )
        setup.mockInput.pressEscape()
        yield* Effect.promise(() =>
          waitForRenderedFrame(
            setup,
            (frame) => !frame.includes("Prompt Search"),
            "prompt search closed",
          ),
        )
        setup.renderer.destroy()
      }),
  )
  it.live("stale auth checks cannot reopen the auth gate after key save", () =>
    Effect.gen(function* () {
      let ctx: ClientContextValue | undefined
      let hasOpenAiKey = false
      let sessionAuthChecks = 0
      const staleSessionCheck = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: undefined
        }>
      >()
      const sentMessages: Array<{
        content: string
      }> = []
      const initialPrompt = "stale auth race prompt"
      const client = createMockClient({
        auth: {
          listProviders: (input: {
            readonly sessionId?: SessionId
            readonly agentName?: string
          }) => {
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
              if (sessionAuthChecks === 2) return Deferred.await(staleSessionCheck)
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={["openai"]} />
              <ClientProbe onReady={(value) => (ctx = value)} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
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
        ),
      )
      if (ctx === undefined) throw new Error("client context not ready")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate"),
      )
      ctx.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          () => sessionAuthChecks >= 2,
          "stale session auth check started",
        ),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("Enter API key for openai"),
          "openai key input",
        ),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth resolved"),
      )
      yield* Effect.promise(() => waitForMessage(setup, sentMessages, initialPrompt))
      yield* Deferred.succeed(staleSessionCheck, [
        {
          provider: "openai",
          hasKey: false,
          required: true,
          source: "none",
          authType: undefined,
        },
      ])
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("API Keys")
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
      setup.renderer.destroy()
    }),
  )
})
