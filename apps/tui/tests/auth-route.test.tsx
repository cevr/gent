/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Context, Deferred, Effect, Layer, Option, Scope } from "effect"
import { LinkOpener, LinkOpenerError } from "../src/services/link-opener"
import { Auth } from "../src/routes/auth"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { AgentName } from "@gent/core-internal/domain/agent"
import { SessionId } from "@gent/core-internal/domain/ids"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"
import { runEffectBoundary } from "./run-effect-boundary"
import { onMount } from "solid-js"

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())
const apiMethod = { label: "API key", type: "api" } satisfies { label: string; type: "api" }
const oauthMethod = { label: "Browser OAuth", type: "oauth" } satisfies {
  label: string
  type: "oauth"
}

const requireClient = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, never> =>
  Option.match(context, {
    onNone: () => Effect.die("client context not ready"),
    onSome: Effect.succeed,
  })

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
const servicesWithLinkOpener = (
  open: (url: string) => Effect.Effect<void, LinkOpenerError>,
): Promise<Context.Context<unknown>> => {
  const layer = Layer.merge(BunServices.layer, LinkOpener.Test({ open }))
  return runEffectBoundary(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const built = yield* Layer.buildWithScope(layer, scope)
      return Context.makeUnsafe<unknown>(Context.add(built, Scope.Scope, scope).mapUnsafe)
    }),
  )
}
describe("Auth route", () => {
  const activeSessionId = SessionId.make("session-auth")
  it.live("loads providers for the selected agent", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
        sessionId?: string
      }> = []
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
          client,
          runtime,
          initialAgent: AgentName.make("helper:google"),
        }),
      )
      expect(calls).toEqual([{ agentName: "helper:google", sessionId: activeSessionId }])
      setup.renderer.destroy()
    }),
  )
  it.live("ignores stale auth loads after the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const pending: Array<{
        agentName?: string
        deferred: Deferred.Deferred<
          ReadonlyArray<{
            provider: string
            hasKey: boolean
            required: boolean
          }>
        >
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) =>
            Effect.gen(function* () {
              const deferred =
                yield* Deferred.make<
                  ReadonlyArray<{ provider: string; hasKey: boolean; required: boolean }>
                >()
              pending.push({ agentName: input.agentName, deferred })
              return yield* Deferred.await(deferred)
            }),
          listMethods: () => Effect.succeed({}),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ClientProbe onReady={(c) => (ctx = Option.some(c))} />
              <Auth sessionId={activeSessionId} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
          },
        ),
      )
      expect(pending.map((entry) => entry.agentName)).toEqual(["cowork"])
      const clientContext = yield* requireClient(ctx)
      clientContext.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
      yield* Effect.promise(() => setup.renderOnce())
      expect(pending.map((entry) => entry.agentName)).toEqual(["cowork", "deepwork"])
      const secondPending = Option.fromNullishOr(pending[1])
      if (Option.isSome(secondPending)) {
        yield* Deferred.succeed(secondPending.value.deferred, [
          { provider: "openai", hasKey: false, required: false },
        ])
      }
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("openai") && !frame.includes("anthropic"),
        ),
      )
      const firstPending = Option.fromNullishOr(pending[0])
      if (Option.isSome(firstPending)) {
        yield* Deferred.succeed(firstPending.value.deferred, [
          { provider: "anthropic", hasKey: false, required: false },
        ])
      }
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("openai") && !next.includes("anthropic"),
        ),
      )
      expect(frame).toContain("openai")
      expect(frame).not.toContain("anthropic")
      setup.renderer.destroy()
    }),
  )
  it.live("ignores stale auth mutations after the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const oldKeySave = yield* Deferred.make<void>()
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            if (input.agentName === "deepwork") {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: false,
                  source: "none",
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([
              {
                provider: "anthropic",
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
            ])
          },
          listMethods: () =>
            Effect.succeed({
              anthropic: [apiMethod],
              openai: [apiMethod],
            }),
          setKey: ({ provider }: { provider: string; key: string }) => {
            if (provider === "anthropic") {
              return Deferred.await(oldKeySave)
            }
            return Effect.void
          },
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ClientProbe onReady={(c) => (ctx = Option.some(c))} />
              <Auth sessionId={activeSessionId} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("anthropic")),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Enter API key for anthropic")),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("old-key"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      const clientContext = yield* requireClient(ctx)
      clientContext.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
      const reloaded = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("openai")),
      )
      expect(reloaded).toContain("openai")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Enter API key for openai")),
      )
      yield* Deferred.succeed(oldKeySave, void 0)
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) =>
            next.includes("Enter API key for openai") &&
            !next.includes("API key saved for anthropic"),
        ),
      )
      expect(frame).toContain("Enter API key for openai")
      expect(frame).not.toContain("API key saved for anthropic")
      setup.renderer.destroy()
    }),
  )
  it.live("ignores stale oauth callbacks after the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const authorizeDeferred = yield* Deferred.make<
        | {
            authorizationId: string
            url: string
            method: "auto"
            instructions?: string
          }
        | typeof nullValue
      >()
      const authorizeCalls: Array<{
        provider: string
        method: number
        sessionId: string
      }> = []
      const callbackCalls: Array<{
        provider: string
        method: number
        authorizationId: string
        sessionId: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            if (input.agentName === "deepwork") {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: false,
                  source: "none",
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([
              {
                provider: "anthropic",
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
            ])
          },
          listMethods: () =>
            Effect.succeed({
              anthropic: [oauthMethod],
              openai: [apiMethod],
            }),
          authorize: (input: { provider: string; method: number; sessionId: string }) => {
            authorizeCalls.push(input)
            const { provider } = input
            if (provider !== "anthropic") return Effect.succeed(nullValue)
            return Deferred.await(authorizeDeferred)
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ClientProbe onReady={(c) => (ctx = Option.some(c))} />
              <Auth sessionId={activeSessionId} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("anthropic")),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      const clientContext = yield* requireClient(ctx)
      clientContext.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
      yield* Effect.promise(() => waitForRenderedFrame(setup, (frame) => frame.includes("openai")))
      yield* Deferred.succeed(authorizeDeferred, {
        authorizationId: "auth-old",
        url: "https://example.com/oauth",
        method: "auto",
      })
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(authorizeCalls).toEqual([
        { provider: "anthropic", method: 0, sessionId: activeSessionId },
      ])
      expect(callbackCalls).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("threads the active session through successful auto OAuth callbacks", () =>
    Effect.gen(function* () {
      const authorizeCalls: Array<{
        provider: string
        method: number
        sessionId: string
      }> = []
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
                authType: absent,
              },
            ]),
          listMethods: () =>
            Effect.succeed({
              anthropic: [oauthMethod],
            }),
          authorize: (input: { provider: string; method: number; sessionId: string }) =>
            Effect.sync(() => {
              authorizeCalls.push(input)
              return {
                authorizationId: "auth-active",
                url: "https://example.com/oauth",
                method: "auto",
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
      const services = yield* Effect.promise(() => servicesWithLinkOpener(() => Effect.void))
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
          client,
          runtime,
          services,
          initialAgent: AgentName.make("cowork"),
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("anthropic")),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => callbackCalls.length === 1, "successful OAuth callback"),
      )
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
    }),
  )
  it.live("ignores stale oauth opener failures after the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let rejectOpen = Option.none<(error: LinkOpenerError) => void>()
      const calls: Array<{
        agentName?: string
        sessionId?: string
      }> = []
      const authorizeCalls: Array<{
        provider: string
        method: number
        sessionId: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string; sessionId?: string }) =>
            Effect.sync(() => {
              calls.push(input)
              if (input.agentName === "deepwork") {
                return [
                  {
                    provider: "openai",
                    hasKey: false,
                    required: false,
                    source: "none",
                    authType: absent,
                  },
                ]
              }
              return [
                {
                  provider: "anthropic",
                  hasKey: false,
                  required: false,
                  source: "none",
                  authType: absent,
                },
              ]
            }),
          listMethods: () =>
            Effect.succeed({
              anthropic: [oauthMethod],
              openai: [apiMethod],
            }),
          authorize: (input: { provider: string; method: number; sessionId: string }) => {
            authorizeCalls.push(input)
            const { provider } = input
            if (provider !== "anthropic") return Effect.succeed(nullValue)
            return Effect.succeed({
              authorizationId: "auth-old",
              url: "https://example.com/oauth",
              method: "code",
            })
          },
        },
      })
      const services = yield* Effect.promise(() =>
        servicesWithLinkOpener(() =>
          Effect.callback<void, LinkOpenerError>((resume) => {
            rejectOpen = Option.some((error) => resume(Effect.fail(error)))
          }),
        ),
      )
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ClientProbe onReady={(c) => (ctx = Option.some(c))} />
              <Auth sessionId={activeSessionId} />
            </>
          ),
          {
            client,
            runtime,
            services,
            initialAgent: AgentName.make("cowork"),
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("anthropic")),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Open the URL below")),
      )
      const clientContext = yield* requireClient(ctx)
      clientContext.steer({ _tag: "SwitchAgent", agent: AgentName.make("deepwork") })
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(calls.at(-1)).toEqual({ agentName: "deepwork", sessionId: activeSessionId })
      if (Option.isSome(rejectOpen))
        rejectOpen.value(new LinkOpenerError({ message: "open failed" }))
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("openai") && !next.includes("open failed"),
        ),
      )
      expect(frame).toContain("openai")
      expect(frame).not.toContain("open failed")
      expect(authorizeCalls).toEqual([
        { provider: "anthropic", method: 0, sessionId: activeSessionId },
      ])
      setup.renderer.destroy()
    }),
  )
  it.live("ignores stale oauth opener failures after cancelling the same auth flow", () =>
    Effect.gen(function* () {
      let rejectOpen = Option.none<(error: LinkOpenerError) => void>()
      const authorizeCalls: Array<{
        provider: string
        method: number
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
                authType: absent,
              },
            ]),
          listMethods: () =>
            Effect.succeed({
              anthropic: [oauthMethod],
            }),
          authorize: (input: { provider: string; method: number; sessionId: string }) => {
            authorizeCalls.push(input)
            const { provider } = input
            if (provider !== "anthropic") return Effect.succeed(nullValue)
            return Effect.succeed({
              authorizationId: "auth-cancelled",
              url: "https://example.com/oauth",
              method: "code",
            })
          },
        },
      })
      const services = yield* Effect.promise(() =>
        servicesWithLinkOpener(() =>
          Effect.callback<void, LinkOpenerError>((resume) => {
            rejectOpen = Option.some((error) => resume(Effect.fail(error)))
          }),
        ),
      )
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
          client,
          runtime,
          services,
          initialAgent: AgentName.make("cowork"),
        }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("anthropic")),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("Open the URL below")),
      )
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) =>
            frame.includes("anthropic") &&
            !frame.includes("Open the URL below") &&
            !frame.includes("open failed"),
        ),
      )
      if (Option.isSome(rejectOpen))
        rejectOpen.value(new LinkOpenerError({ message: "open failed" }))
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("anthropic") && !next.includes("open failed"),
        ),
      )
      expect(frame).toContain("anthropic")
      expect(frame).not.toContain("open failed")
      expect(authorizeCalls).toEqual([
        { provider: "anthropic", method: 0, sessionId: activeSessionId },
      ])
      setup.renderer.destroy()
    }),
  )
})
