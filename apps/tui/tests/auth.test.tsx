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
import {
  applySnapshotAgent,
  createMockClient,
  createMockRuntime,
  renderWithProviders,
} from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"
import { onMount } from "solid-js"

// ── auth state ──────────────────────────────────────────────────────────────

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

  test("a missing browser keeps the oauth screen waiting and says so", () => {
    const state = transitionAuth(openOAuth(autoAuthorization), { _tag: "BrowserUnavailable" })

    expect(state.screen).toMatchObject({ _tag: "OAuth", waiting: true, browserUnavailable: true })
    expect(state.error).toEqual(Option.none())
  })

  test("a missing browser reported on another screen changes nothing", () => {
    const state = loaded()

    expect(transitionAuth(state, { _tag: "BrowserUnavailable" })).toEqual(state)
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

// ── auth route ──────────────────────────────────────────────────────────────

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
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      yield* Effect.promise(() => setup.renderOnce())
      expect(pending.map((entry) => entry.agentName)).toEqual(["cowork", "deepwork"])
      const secondPending = Option.fromNullishOr(pending[1])
      if (Option.isSome(secondPending)) {
        yield* Deferred.succeed(secondPending.value.deferred, [
          { provider: "openai", hasKey: false, required: false },
        ])
      }
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("openai") && !frame.includes("anthropic"),
      )
      const firstPending = Option.fromNullishOr(pending[0])
      if (Option.isSome(firstPending)) {
        yield* Deferred.succeed(firstPending.value.deferred, [
          { provider: "anthropic", hasKey: false, required: false },
        ])
      }
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("openai") && !next.includes("anthropic"),
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
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in · anthropic · API key"))
      yield* Effect.promise(() => setup.mockInput.typeText("old-key"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      const clientContext = yield* requireClient(ctx)
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      const reloaded = yield* waitForFrame(setup, (frame) => frame.includes("openai"))
      expect(reloaded).toContain("openai")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in · openai · API key"))
      yield* Deferred.succeed(oldKeySave, void 0)
      const frame = yield* waitForFrame(
        setup,
        (next) =>
          next.includes("Sign in · openai · API key") &&
          !next.includes("API key saved for anthropic"),
      )
      expect(frame).toContain("Sign in · openai · API key")
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
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      const clientContext = yield* requireClient(ctx)
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      yield* waitForFrame(setup, (frame) => frame.includes("openai"))
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
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => callbackCalls.length === 1, "successful OAuth callback")
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
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(setup, (frame) => frame.includes("Open the URL below"))
      const clientContext = yield* requireClient(ctx)
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(calls.at(-1)).toEqual({ agentName: "deepwork", sessionId: activeSessionId })
      if (Option.isSome(rejectOpen))
        rejectOpen.value(new LinkOpenerError({ message: "open failed" }))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("openai") && !next.includes("open failed"),
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
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(setup, (frame) => frame.includes("Open the URL below"))
      setup.mockInput.pressEscape()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes("anthropic") &&
          !frame.includes("Open the URL below") &&
          !frame.includes("open failed"),
      )
      if (Option.isSome(rejectOpen))
        rejectOpen.value(new LinkOpenerError({ message: "open failed" }))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("anthropic") && !next.includes("open failed"),
      )
      expect(frame).toContain("anthropic")
      expect(frame).not.toContain("open failed")
      expect(authorizeCalls).toEqual([
        { provider: "anthropic", method: 0, sessionId: activeSessionId },
      ])
      setup.renderer.destroy()
    }),
  )

  // ── browser unavailable ───────────────────────────────────────────
  //
  // Opening a browser is a convenience. On a machine without one (a
  // headless box, where the device-code flow exists for exactly this) a
  // failed open keeps the flow: the pane shows what to open and keeps
  // waiting.

  const noBrowser = (url: string) =>
    Effect.fail(
      new LinkOpenerError({
        message: `Failed to open URL: ${url}: /usr/bin/xdg-open: no method available`,
      }),
    )

  const openaiOnly = [
    { provider: "openai", hasKey: false, required: false, source: "none", authType: absent },
  ]

  /** The frame's panel text, borders and padding removed, lines joined. */
  const panelText = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.replace(/[│┃║|]/g, "").trim())
      .join("")

  it.scopedLive("a device-code flow without a browser shows the url and the user code", () =>
    Effect.gen(function* () {
      const callbackCalls: Array<{ provider: string; authorizationId: string }> = []
      const client = createMockClient({
        auth: {
          listProviders: () => Effect.succeed(openaiOnly),
          listMethods: () =>
            Effect.succeed({
              openai: [{ label: "ChatGPT Pro/Plus (device code)", type: "oauth" }],
            }),
          authorize: () =>
            Effect.succeed({
              authorizationId: "auth-device",
              url: "https://auth.openai.com/codex/device",
              method: "auto",
              instructions: "Open the URL and enter this code:\nWXYZ-1234",
            }),
          // The device poll is still pending: the user has not entered the code.
          callback: (input: { provider: string; authorizationId: string }) =>
            Effect.sync(() => callbackCalls.push(input)).pipe(Effect.andThen(Effect.never)),
        },
      })
      const services = yield* servicesWithLinkOpener(noBrowser)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
          client,
          runtime: createMockRuntime(),
          services,
          initialAgent: AgentName.make("cowork"),
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("openai"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Could not open a browser") && callbackCalls.length === 1,
        "device flow keeps waiting without a browser",
      )
      expect(frame).toContain("Sign in · openai ·")
      expect(frame).toContain("WXYZ-1234")
      expect(panelText(frame)).toContain("https://auth.openai.com/codex/device")
      expect(frame).not.toContain("Failed to open URL")
      expect(frame).not.toContain("r retry")
      expect(callbackCalls).toEqual([
        expect.objectContaining({ provider: "openai", authorizationId: "auth-device" }),
      ])
      setup.renderer.destroy()
    }).pipe(Effect.timeout("8 seconds")),
  )

  // A reconnect refetches the session snapshot, and the snapshot names the
  // agent the pane already loaded for. The catalog follows the agent's name,
  // so that snapshot leaves an open sign-in alone: the code stays on screen
  // and the device poll still finishes the flow.
  it.scopedLive(
    "a reconnect snapshot keeps a device-code flow on screen and its poll running",
    () =>
      Effect.gen(function* () {
        let ctx = Option.none<ClientContextValue>()
        const signedIn = yield* Deferred.make<void>()
        const callbackCalls: Array<{ provider: string; authorizationId: string }> = []
        let providerLoads = 0
        const client = createMockClient({
          auth: {
            listProviders: () =>
              Effect.sync(() => {
                providerLoads += 1
                return openaiOnly
              }),
            listMethods: () =>
              Effect.succeed({
                openai: [{ label: "ChatGPT Pro/Plus (device code)", type: "oauth" }],
              }),
            authorize: () =>
              Effect.succeed({
                authorizationId: "auth-device",
                url: "https://auth.openai.com/codex/device",
                method: "auto",
                instructions: "Open the URL and enter this code:\nWXYZ-1234",
              }),
            // The device poll ends when the user enters the code.
            callback: (input: { provider: string; authorizationId: string }) =>
              Effect.sync(() => callbackCalls.push(input)).pipe(
                Effect.andThen(Deferred.await(signedIn)),
              ),
          },
        })
        const services = yield* servicesWithLinkOpener(noBrowser)
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
              runtime: createMockRuntime(),
              services,
              initialAgent: AgentName.make("cowork"),
            },
          ),
        )
        yield* waitForFrame(setup, (frame) => frame.includes("openai"))
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        yield* waitForFrame(
          setup,
          (next) => next.includes("WXYZ-1234") && callbackCalls.length === 1,
          "device flow waits for the poll",
        )

        applySnapshotAgent(yield* requireClient(ctx), AgentName.make("cowork"))
        yield* Effect.yieldNow
        const reconnected = yield* waitForFrame(setup, () => true)
        expect(reconnected).toContain("Sign in · openai ·")
        expect(reconnected).toContain("WXYZ-1234")
        expect(panelText(reconnected)).toContain("https://auth.openai.com/codex/device")
        expect(providerLoads).toBe(1)

        yield* Deferred.succeed(signedIn, void 0)
        yield* waitForFrame(
          setup,
          (next) => next.includes("Authenticated openai via OAuth"),
          "the device poll finishes the flow",
        )
        expect(callbackCalls).toHaveLength(1)
        setup.renderer.destroy()
      }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a browser flow without a browser shows its whole url to copy", () =>
    Effect.gen(function* () {
      const longUrl = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&state=${"s".repeat(43)}`
      const client = createMockClient({
        auth: {
          listProviders: () => Effect.succeed(openaiOnly),
          listMethods: () =>
            Effect.succeed({ openai: [{ label: "ChatGPT (browser)", type: "oauth" }] }),
          authorize: () =>
            Effect.succeed({ authorizationId: "auth-browser", url: longUrl, method: "code" }),
        },
      })
      const services = yield* servicesWithLinkOpener(noBrowser)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Auth sessionId={activeSessionId} />, {
          client,
          runtime: createMockRuntime(),
          services,
          initialAgent: AgentName.make("cowork"),
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("openai"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Could not open a browser"),
        "browser flow keeps its code field without a browser",
      )
      expect(panelText(frame)).toContain(longUrl)
      expect(frame).toContain("Paste code:")
      expect(frame).not.toContain("Failed to open URL")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("8 seconds")),
  )
})
