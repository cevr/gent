/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { onMount } from "solid-js"
import { Clock, Deferred, Effect, Option, Schema } from "effect"
import { ProviderAuthError } from "@gent/core-internal/domain/driver"
import { AgentName, BranchId, SessionId, dateFromMillis } from "@gent/core/protocol"
import { emptyQueueSnapshot } from "@gent/sdk"
import { App } from "../src/app"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness-boundary"
import { renderFrame, waitForRenderedFrame } from "./helpers-boundary"
import { runEffectBoundary } from "./run-effect-boundary"
import { useTerminalDimensions } from "../src/terminal-dimensions"

type AppAuthRenderSetup = Awaited<ReturnType<typeof renderWithProviders>>

class MessageTimeoutError extends Schema.TaggedError<MessageTimeoutError>()("MessageTimeoutError", {
  message: Schema.String,
}) {}

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())
const apiMethod = { label: "API key", type: "api" } satisfies { label: string; type: "api" }

const authSource = (hasKey: boolean): "stored" | "none" => {
  if (hasKey) return "stored"
  return "none"
}

const requireClient = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, MessageTimeoutError> => {
  if (Option.isNone(context)) {
    return Effect.fail(new MessageTimeoutError({ message: "client context not ready" }))
  }
  return Effect.succeed(context.value)
}

const waitForMessage = (
  setup: AppAuthRenderSetup,
  messages: readonly {
    readonly content: string
  }[],
  content: string,
  timeoutMs = 2000,
): Promise<void> => {
  const poll = (startedAt: number): Effect.Effect<void, MessageTimeoutError> =>
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      if (messages.some((message) => message.content === content)) return
      const now = yield* Clock.currentTimeMillis
      if (now - startedAt >= timeoutMs) {
        return yield* new MessageTimeoutError({
          message: `timed out waiting for message: ${content}`,
        })
      }
      // gent/no-sleep: allow render-poll primitive — TUI frame must be re-rendered between observations
      yield* Effect.sleep("10 millis")
      return yield* poll(startedAt)
    })
  return runEffectBoundary(Clock.currentTimeMillis.pipe(Effect.flatMap(poll)))
}
function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

function TerminalDimensionsProbe() {
  const dimensions = useTerminalDimensions()
  return <text>{`${dimensions().width}x${dimensions().height}`}</text>
}

describe("App auth gate", () => {
  it.live("shares one terminal resize source across App and cleans it up", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <TerminalDimensionsProbe />
            </>
          ),
          {
            initialSession: {
              id: SessionId.make("session-resize"),
              activeBranchId: BranchId.make("branch-resize"),
              name: "Resize",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      expect(setup.renderer.listenerCount("resize")).toBe(1)
      expect(renderFrame(setup)).toContain("80x24")

      setup.renderer.resize(100, 30)
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("100x30")

      setup.renderer.destroy()
      expect(setup.renderer.listenerCount("resize")).toBe(0)
    }),
  )

  it.live("rechecks auth requirements when the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
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
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      clientContext.selectAgent(AgentName.make("deepwork"))
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
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
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
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
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
      // The auth check names the session that is actually mounted. It used to
      // name the route's session instead, which the harness could set to a
      // different id than the one the client held.
      expect(calls[0]).toEqual({
        agentName: AgentName.make("deepwork"),
        sessionId: SessionId.make("session-a"),
      })
      // The gate opens the auth overlay itself, and the branch picker is read
      // off that same overlay. A gate that re-ran on its own write would keep
      // checking; it settles instead. (Two checks: the agent arrives after the
      // first, which predates the overlay being the picker's owner.)
      expect(calls.length).toBe(2)
      expect(frame).toContain("API Keys")
      setup.renderer.destroy()
    }),
  )
  it.live("the startup prompt belongs to the boot session, not the next one", () =>
    Effect.gen(function* () {
      // The boot picker re-mounts the session view on the chosen branch, so
      // the prompt has to outlive one mount. A session the reader opens after
      // that is a different session and must start empty.
      const bootSessionId = SessionId.make("session-boot")
      const bootBranchId = BranchId.make("branch-boot")
      const nextSessionId = SessionId.make("session-next")
      const nextBranchId = BranchId.make("branch-next")
      const startupPrompt = "only for the boot session"
      const sentMessages: Array<{ sessionId: SessionId; content: string }> = []
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        session: {
          create: () =>
            Effect.succeed({
              sessionId: nextSessionId,
              branchId: nextBranchId,
              name: "Next",
            }),
        },
        message: {
          send: (input: { readonly sessionId: SessionId; readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App missingAuthProviders={[]} />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialPrompt: Option.some(startupPrompt),
            initialSession: {
              id: bootSessionId,
              activeBranchId: bootBranchId,
              name: "Boot",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* Effect.promise(() => waitForMessage(setup, sentMessages, startupPrompt))
      expect(sentMessages).toHaveLength(1)
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      ctx.value.createSession()
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          () => ctx.pipe(Option.exists((value) => value.session()?.sessionId === nextSessionId)),
          "next session mounted",
        ),
      )
      // Several frames for the new session's feed to settle.
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages.filter((message) => message.sessionId === nextSessionId)).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("escape in the boot branch picker quits, because no branch was chosen", () =>
    Effect.gen(function* () {
      // The picker is where a resumed multi-branch session starts. With no
      // branch chosen there is nothing behind it to fall back to, so escape
      // has to leave the program, not just close the pane.
      let shutdowns = 0
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <App
              missingAuthProviders={[]}
              initialBranches={Option.some([
                {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  name: "main",
                  createdAt: dateFromMillis(0),
                },
                {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  name: "side",
                  createdAt: dateFromMillis(1),
                },
              ])}
            />
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Resume: Session A"), "picker"),
      )
      // `useEnv().shutdown` is a no-op in the harness, so observe the renderer
      // teardown the controller performs alongside it.
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => shutdowns > 0, "quit"))
      setup.renderer.destroy = destroy
      expect(shutdowns).toBe(1)
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
              {
                branch: {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  name: "Main",
                  createdAt: dateFromMillis(0),
                },
                messageCount: 3,
                children: [],
              },
              {
                branch: {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  name: "Side",
                  createdAt: dateFromMillis(1),
                },
                messageCount: 1,
                children: [],
              },
            ]),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <App
              missingAuthProviders={[]}
              initialBranches={Option.some([
                {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  createdAt: dateFromMillis(0),
                },
                {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  createdAt: dateFromMillis(1),
                },
              ])}
            />
          ),
          {
            client,
            runtime,
            // An agent is what makes the auth check runnable at all. Without one
            // the gate short-circuits before it reads the picker, and this test
            // proves nothing.
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker"),
      )
      expect(calls).toEqual([])

      // Choosing a branch closes the picker, and only then does the gate run.
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(calls.map((call) => call.agentName)).toEqual(["cowork"])
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
          authType: typeof absent
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
              openai: [apiMethod],
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
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("build a feature"),
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
          authType: absent,
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
              openai: [apiMethod],
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
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("must not send"),
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => authChecks > 0, "auth check failure"),
      )
      // gent/no-sleep: allow real-clock gap so any spurious send fiber has time to surface (negative assertion follows)
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
                (() => {
                  if (authChecks === 1) {
                    return Effect.fail(
                      new ProviderAuthError({ message: "temporary auth lookup failed" }),
                    )
                  }
                  return Effect.succeed([])
                })(),
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
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("send after retry"),
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
                (() => {
                  if (authChecks < 3) {
                    return Effect.fail(
                      new ProviderAuthError({ message: "temporary auth lookup failed" }),
                    )
                  }
                  return Effect.succeed([])
                })(),
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
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
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
  it.live("branch resume pane gates auth, sends deferred prompt, and searches prompt history", () =>
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
              lastEventId: nullValue,
              reasoningLevel: absent,
              runtime: {
                _tag: "Idle",
                agent: "cowork",
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        branch: {
          getTree: () =>
            Effect.succeed([
              {
                branch: {
                  id: alphaBranchId,
                  sessionId: alphaSessionId,
                  name: "Main",
                  createdAt: dateFromMillis(0),
                },
                messageCount: 3,
                children: [],
              },
              {
                branch: {
                  id: betaBranchId,
                  sessionId: alphaSessionId,
                  name: "Side",
                  createdAt: dateFromMillis(1),
                },
                messageCount: 1,
                children: [],
              },
            ]),
        },
        auth: {
          listProviders: () => {
            const providers = [
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: authSource(hasOpenAiKey),
                authType: absent,
              },
            ]
            if (hasOpenAiKey || initialAuthCheckResolved) return Effect.succeed(providers)
            return Deferred.await(initialAuthCheck).pipe(Effect.as(providers))
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
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
              <App
                missingAuthProviders={[]}
                initialBranches={Option.some([
                  {
                    id: alphaBranchId,
                    sessionId: alphaSessionId,
                    name: "Main",
                    createdAt: dateFromMillis(0),
                  },
                  {
                    id: betaBranchId,
                    sessionId: alphaSessionId,
                    name: "Side",
                    createdAt: dateFromMillis(1),
                  },
                ])}
              />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: alphaSessionId,
              activeBranchId: alphaBranchId,
              name: "Alpha",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(1),
            },
            initialPrompt: Option.some(initialPrompt),
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
      yield* Deferred.succeed(initialAuthCheck, void 0)
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
        waitForRenderedFrame(setup, (frame) => !frame.includes("API Keys"), "auth overlay closed"),
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
      let ctx = Option.none<ClientContextValue>()
      let hasOpenAiKey = false
      let sessionAuthChecks = 0
      const staleSessionCheck = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: typeof absent
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
            const sessionId = Option.fromNullishOr(input.sessionId)
            if (Option.isSome(sessionId)) {
              sessionAuthChecks++
              if (sessionAuthChecks === 1) {
                return Effect.succeed([
                  {
                    provider: "openai",
                    hasKey: false,
                    required: true,
                    source: authSource(false),
                    authType: absent,
                  },
                ])
              }
              if (sessionAuthChecks === 2) return Deferred.await(staleSessionCheck)
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: hasOpenAiKey,
                  required: true,
                  source: authSource(hasOpenAiKey),
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: authSource(hasOpenAiKey),
                authType: absent,
              },
            ])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
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
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
            width: 100,
            height: 30,
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("API Keys"), "auth gate"),
      )
      clientContext.selectAgent(AgentName.make("deepwork"))
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
          authType: absent,
        },
      ])
      // gent/no-sleep: allow real-clock gap so the resumed-send fiber resolves before assertion
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("API Keys")
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
      setup.renderer.destroy()
    }),
  )
})
