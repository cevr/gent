/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Context, Deferred, Effect, Layer, Option, Scope } from "effect"
import {
  AgentName,
  type AuthAuthorization,
  type AuthMethod,
  type AuthProviderInfo,
  ProviderId,
  SessionId,
} from "@gent/core/protocol"
import {
  Auth,
  type AuthEvent,
  AuthState,
  catalogOf,
  methodsFor,
  missingRequired,
  providerFor,
  transitionAuth,
} from "../src/auth"
import { BunServices } from "@effect/platform-bun"
import { LinkOpener, LinkOpenerError } from "../src/os"
import { type ClientContextValue, useClient } from "../src/client"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"
import { onMount } from "solid-js"

// ── auth-state.test ─────────────────────────────────────────────────────────

const provider = {
  provider: ProviderId.make("anthropic"),
  hasKey: false,
  required: true,
} satisfies AuthProviderInfo

const satisfied = {
  provider: ProviderId.make("openai"),
  hasKey: true,
  source: "stored",
  authType: "api",
  required: true,
} satisfies AuthProviderInfo

const apiMethod = { type: "api", label: "API Key" } satisfies AuthMethod
const oauthMethod = { type: "oauth", label: "OAuth" } satisfies AuthMethod

const methods = {
  anthropic: [apiMethod, oauthMethod],
} satisfies Record<string, ReadonlyArray<AuthMethod>>

const codeAuthorization = {
  url: "https://example.com/auth",
  method: "code",
  authorizationId: "auth-1",
} satisfies AuthAuthorization

const autoAuthorization = {
  ...codeAuthorization,
  method: "auto",
} satisfies AuthAuthorization

const loaded = (providers: ReadonlyArray<AuthProviderInfo> = [provider]) =>
  transitionAuth(AuthState.initial(), {
    _tag: "Loaded",
    providers,
    methods,
  } satisfies AuthEvent)

const openOAuth = (authorization: AuthAuthorization) =>
  transitionAuth(loaded(), {
    _tag: "OpenOAuth",
    provider: "anthropic",
    methodIndex: 1,
    method: oauthMethod,
    authorization,
  } satisfies AuthEvent)

describe("auth-state", () => {
  test("a load replaces the catalog and shows the provider list", () => {
    const state = loaded()

    expect(state.screen).toEqual({ _tag: "List" })
    expect(state.catalog).toEqual(Option.some({ providers: [provider], methods }))
    expect(state.error).toEqual(Option.none())
  })

  // The enforced-auth gate closes itself when no required provider is
  // missing. An unloaded pane has none missing only because it has none at
  // all, so the two must stay distinguishable: collapsing the absent catalog
  // to an empty one closes the gate before its first answer arrives.
  test("an unloaded catalog is absent, not an empty one", () => {
    const initial = AuthState.initial()

    expect(initial.catalog).toEqual(Option.none())
    expect(loaded([]).catalog).toEqual(Option.some({ providers: [], methods }))
  })

  test("a load clears an error left by the attempt before it", () => {
    const failed = transitionAuth(AuthState.initial(), { _tag: "Failed", error: "boom" })
    const recovered = transitionAuth(failed, { _tag: "Loaded", providers: [provider], methods })

    expect(failed.error).toEqual(Option.some("boom"))
    expect(recovered.error).toEqual(Option.none())
  })

  test("a failure falls back to the provider list and keeps the catalog", () => {
    const state = transitionAuth(loaded(), { _tag: "Failed", error: "bad key" })

    expect(state.screen).toEqual({ _tag: "List" })
    expect(state.error).toEqual(Option.some("bad key"))
    expect(catalogOf(state).providers).toEqual([provider])
  })

  test("choosing a provider then an api method opens an empty key field", () => {
    const method = transitionAuth(loaded(), { _tag: "OpenMethod", provider: "anthropic" })
    const key = transitionAuth(method, { _tag: "OpenKey", provider: "anthropic" })

    expect(method.screen).toEqual({ _tag: "Method", provider: "anthropic" })
    expect(key.screen).toEqual({ _tag: "Key", provider: "anthropic", value: "" })
  })

  test("typing and backspace edit whichever screen holds text", () => {
    const key = transitionAuth(loaded(), { _tag: "OpenKey", provider: "anthropic" })
    const typed = transitionAuth(key, { _tag: "Type", text: "sk-abc" })
    const trimmed = transitionAuth(typed, { _tag: "Backspace" })

    expect(typed.screen).toMatchObject({ _tag: "Key", value: "sk-abc" })
    expect(trimmed.screen).toMatchObject({ _tag: "Key", value: "sk-ab" })
  })

  test("typing into the oauth code field edits the code, not the key", () => {
    const typed = transitionAuth(openOAuth(codeAuthorization), { _tag: "Type", text: "1234" })

    expect(typed.screen).toMatchObject({ _tag: "OAuth", code: "1234" })
  })

  test("typing on the provider list changes nothing", () => {
    const state = loaded()

    expect(transitionAuth(state, { _tag: "Type", text: "x" })).toEqual(state)
    expect(transitionAuth(state, { _tag: "Backspace" })).toEqual(state)
  })

  test("an auto authorization waits for the browser, a code one does not", () => {
    const auto = openOAuth(autoAuthorization)
    const code = openOAuth(codeAuthorization)

    expect(auto.screen).toMatchObject({ _tag: "OAuth", waiting: true, code: "" })
    expect(code.screen).toMatchObject({ _tag: "OAuth", waiting: false, code: "" })
  })

  test("a failed browser callback stops waiting and asks for a code", () => {
    const state = transitionAuth(openOAuth(autoAuthorization), {
      _tag: "OAuthAutoFailed",
      error: "callback failed",
    })

    expect(state.screen).toMatchObject({ _tag: "OAuth", waiting: false })
    expect(state.error).toEqual(Option.some("callback failed"))
  })

  test("a failed browser callback on another screen changes nothing", () => {
    const key = transitionAuth(loaded(), { _tag: "OpenKey", provider: "anthropic" })

    expect(transitionAuth(key, { _tag: "OAuthAutoFailed", error: "late" })).toEqual(key)
  })

  test("closing a screen returns to the list and clears the error", () => {
    const failed = transitionAuth(loaded(), { _tag: "Failed", error: "bad key" })
    const closed = transitionAuth(failed, { _tag: "Close" })

    expect(closed.screen).toEqual({ _tag: "List" })
    expect(closed.error).toEqual(Option.none())
    expect(catalogOf(closed).providers).toEqual([provider])
  })

  test("the catalog answers which methods, which provider, and what is missing", () => {
    const state = loaded([provider, satisfied])

    expect(methodsFor(catalogOf(state), "anthropic")).toEqual([apiMethod, oauthMethod])
    expect(methodsFor(catalogOf(state), "unknown")).toEqual([])
    expect(providerFor(catalogOf(state), "openai")).toEqual(Option.some(satisfied))
    expect(providerFor(catalogOf(state), "unknown")).toEqual(Option.none())
    expect(missingRequired(catalogOf(state))).toEqual([provider])
  })
})

// ── auth-route.test ─────────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())
const apiMethodRoute = { label: "API key", type: "api" } satisfies { label: string; type: "api" }
const oauthMethodRoute = { label: "Browser OAuth", type: "oauth" } satisfies {
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
): Effect.Effect<Context.Context<unknown>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const built = yield* Layer.build(Layer.merge(BunServices.layer, LinkOpener.Test({ open })))
    const scope = yield* Scope.Scope
    return Context.makeUnsafe<unknown>(Context.add(built, Scope.Scope, scope).mapUnsafe)
  })
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
      clientContext.selectAgent(AgentName.make("deepwork"))
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
              anthropic: [apiMethodRoute],
              openai: [apiMethodRoute],
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
      clientContext.selectAgent(AgentName.make("deepwork"))
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
              anthropic: [oauthMethodRoute],
              openai: [apiMethodRoute],
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
      clientContext.selectAgent(AgentName.make("deepwork"))
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
  it.scopedLive("threads the active session through successful auto OAuth callbacks", () =>
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
              anthropic: [oauthMethodRoute],
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
      const services = yield* servicesWithLinkOpener(() => Effect.void)
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
  it.scopedLive("ignores stale oauth opener failures after the selected agent changes", () =>
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
              anthropic: [oauthMethodRoute],
              openai: [apiMethodRoute],
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
      const services = yield* servicesWithLinkOpener(() =>
        Effect.callback<void, LinkOpenerError>((resume) => {
          rejectOpen = Option.some((error) => resume(Effect.fail(error)))
        }),
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
      clientContext.selectAgent(AgentName.make("deepwork"))
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
  it.scopedLive("ignores stale oauth opener failures after cancelling the same auth flow", () =>
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
              anthropic: [oauthMethodRoute],
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
      const services = yield* servicesWithLinkOpener(() =>
        Effect.callback<void, LinkOpenerError>((resume) => {
          rejectOpen = Option.some((error) => resume(Effect.fail(error)))
        }),
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
