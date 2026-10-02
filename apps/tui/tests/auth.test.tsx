/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import type { GentRuntime } from "@gent/sdk"
import {
  AgentName,
  type AuthAuthorization,
  type AuthMethod,
  type AuthProviderInfo,
  ProviderId,
  SessionId,
} from "@gent/core/protocol"
import { Auth, type AuthEvent, AuthState, transitionAuth } from "../src/auth"
import { BunServices } from "@effect/platform-bun"
import { App } from "../src/app"
import { LinkOpener, LinkOpenerError } from "../src/os"
import { useClient } from "../src/client"
import {
  applySnapshotAgent,
  createMockClient,
  createMockRuntime,
  destroyRenderSetup,
  mountClient,
  renderFrame,
  renderScoped,
  sessionFixture,
} from "./render-harness-boundary"
import { waitForFrame, waitUntil } from "./helpers-boundary"
import { ProviderAuthError } from "@gent/core/extensions/api"

// ── auth state ──────────────────────────────────────────────────────────────

const provider = {
  provider: ProviderId.make("anthropic"),
  hasKey: false,
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
    expect(Option.map(state.catalog, (catalog) => catalog.providers)).toEqual(
      Option.some([provider]),
    )
  })

  test("choosing a provider then an api method opens an empty key field", () => {
    const method = transitionAuth(loaded(), { _tag: "OpenMethod", provider: "anthropic" })
    const key = transitionAuth(method, { _tag: "OpenKey", provider: "anthropic" })

    expect(method.screen).toEqual({ _tag: "Method", provider: "anthropic" })
    expect(key.screen).toEqual({ _tag: "Key", provider: "anthropic", value: "" })
  })

  test("typing and erasing edit whichever screen holds text", () => {
    const key = transitionAuth(loaded(), { _tag: "OpenKey", provider: "anthropic" })
    const typed = transitionAuth(key, { _tag: "Type", text: "sk abc👍🏽" })
    const erase = (state: typeof typed, unit: "grapheme" | "word" | "line") =>
      transitionAuth(state, { _tag: "Erase", unit })

    expect(typed.screen).toMatchObject({ _tag: "Key", value: "sk abc👍🏽" })
    // Backspace takes one whole character, never half an emoji.
    expect(erase(typed, "grapheme").screen).toMatchObject({ _tag: "Key", value: "sk abc" })
    // Ctrl+W takes the last word, Ctrl+U the whole field, as in the composer.
    expect(erase(typed, "word").screen).toMatchObject({ _tag: "Key", value: "sk " })
    expect(erase(typed, "line").screen).toMatchObject({ _tag: "Key", value: "" })
  })

  test("typing into the oauth code field edits the code, not the key", () => {
    const typed = transitionAuth(openOAuth(codeAuthorization), { _tag: "Type", text: "1234" })

    expect(typed.screen).toMatchObject({ _tag: "OAuth", code: "1234" })
  })

  test("typing on the provider list changes nothing", () => {
    const state = loaded()

    expect(transitionAuth(state, { _tag: "Type", text: "x" })).toEqual(state)
    expect(transitionAuth(state, { _tag: "Erase", unit: "grapheme" })).toEqual(state)
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
    expect(Option.map(closed.catalog, (catalog) => catalog.providers)).toEqual(
      Option.some([provider]),
    )
  })

  // "esc back" goes one step: a sign-in screen to its provider's methods,
  // the methods to the provider list.
  test("back from a sign-in screen opens its provider's methods", () => {
    const key = transitionAuth(loaded(), { _tag: "OpenKey", provider: "anthropic" })
    const oauth = transitionAuth(openOAuth(autoAuthorization), {
      _tag: "OAuthAutoFailed",
      error: "callback failed",
    })

    for (const state of [key, oauth]) {
      const back = transitionAuth(state, { _tag: "Back" })
      expect(back.screen).toEqual({ _tag: "Method", provider: "anthropic" })
      expect(back.error).toEqual(Option.none())
    }
  })

  test("back from the methods opens the provider list", () => {
    const method = transitionAuth(loaded(), { _tag: "OpenMethod", provider: "anthropic" })

    expect(transitionAuth(method, { _tag: "Back" }).screen).toEqual({ _tag: "List" })
  })
})

// ── auth route ──────────────────────────────────────────────────────────────

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
// eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
const nullValue = null
const apiMethodRoute = { label: "API key", type: "api" } satisfies { label: string; type: "api" }
const oauthMethodRoute = { label: "Browser OAuth", type: "oauth" } satisfies {
  label: string
  type: "oauth"
}

/** Lands a snapshot naming `agent` before the panes after it mount, as the session view does. */
function SnapshotAgent(props: { readonly agent: AgentName }) {
  applySnapshotAgent(useClient(), props.agent)
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
  it.scopedLive("loads providers for the selected agent", () =>
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
      yield* renderScoped(
        () => (
          <>
            <SnapshotAgent agent={AgentName.make("helper:google")} />
            <Auth sessionId={activeSessionId} />
          </>
        ),
        {
          client,
          runtime,
        },
      )
      expect(calls).toEqual([{ agentName: "helper:google", sessionId: activeSessionId }])
    }),
  )
  // Esc while the key is on its way drops the save's note, not the key: the
  // list the reader stepped back to still learns the key is stored.
  it.scopedLive("esc during a key save still shows the stored key in the list", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      let source: "stored" | "none" = "none"
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => [
              {
                provider: ProviderId.make("anthropic"),
                hasKey: source === "stored",
                required: false,
                source,
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ anthropic: [apiMethodRoute] }),
          setKey: () =>
            Deferred.complete(asked, Effect.void).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.andThen(
                Effect.sync(() => {
                  source = "stored"
                }),
              ),
            ),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, { client })
      yield* waitForFrame(setup, (frame) => frame.includes("[none]"), "the list")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in · anthropic · API key"))
      yield* Effect.promise(() => setup.mockInput.typeText("new-key"))
      setup.mockInput.pressEnter()
      yield* Deferred.await(asked)
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic · method"), "one step back")
      yield* Deferred.complete(answer, Effect.void)
      yield* waitUntil(() => source === "stored", "the key stored")
      // The reader stays where they stepped back to; the list is read again under it.
      const methods = yield* waitForFrame(setup, (frame) => frame.includes("anthropic · method"))
      expect(methods).not.toContain("API key saved")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (next) => next.includes("[stored]"), "the stored key")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The success flash clears itself after a while. A pane that closes first
  // stops that clock with it, so nothing writes to the closed pane later.
  it.scopedLive("closing the pane stops its success flash", () =>
    Effect.gen(function* () {
      const forked: Array<Fiber.Fiber<unknown, unknown>> = []
      const base = createMockRuntime()
      const runtime: GentRuntime = {
        ...base,
        fork: (effect) => {
          const fiber = base.fork(effect)
          forked.push(fiber)
          return fiber
        },
      }
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: ProviderId.make("anthropic"),
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ anthropic: [apiMethodRoute] }),
          setKey: () => Effect.void,
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in · anthropic · API key"))
      yield* Effect.promise(() => setup.mockInput.typeText("new-key"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key saved for anthropic"))
      const flash = yield* Effect.fromOption(Option.fromNullishOr(forked.at(-1)))
      destroyRenderSetup(setup)
      const exit = yield* Fiber.await(flash).pipe(Effect.timeout("1 second"))
      expect(Exit.hasInterrupts(exit)).toBe(true)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Signing out is destructive, so it takes the agents pane's key and ladder:
  // ctrl+x arms the row, a second ctrl+x removes the stored key.
  it.scopedLive("a stored sign-in is removed only on a second ctrl+x", () =>
    Effect.gen(function* () {
      const deleted: Array<string> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: ProviderId.make("openai"),
                hasKey: true,
                required: false,
                source: "stored",
                authType: "api",
              },
            ]),
          listMethods: () => Effect.succeed({ openai: [apiMethodRoute] }),
          deleteKey: ({ provider }: { provider: string }) =>
            Effect.sync(() => {
              deleted.push(provider)
            }),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
      })
      const list = yield* waitForFrame(setup, (frame) => frame.includes("openai"))
      expect(list).toContain("ctrl+x delete")
      setup.mockInput.pressKey("d")
      yield* Effect.promise(() => setup.renderOnce())
      expect(deleted).toEqual([])
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again to delete openai login"))
      expect(deleted).toEqual([])
      // Any other key steps back from the armed row.
      setup.mockInput.pressKey("ESCAPE")
      yield* waitForFrame(setup, (frame) => !frame.includes("ctrl+x again"))
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again to delete openai login"))
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(deleted).toEqual(["openai"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A row with nothing stored has nothing to delete, so its hints leave
  // ctrl+x out; the hint returns on a row that stores a key.
  it.scopedLive("ctrl+x delete is offered only on a row that stores a key", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: ProviderId.make("anthropic"),
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
              {
                provider: ProviderId.make("openai"),
                hasKey: true,
                required: false,
                source: "stored",
                authType: "api",
              },
            ]),
          listMethods: () => Effect.succeed({ openai: [apiMethodRoute] }),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
      })
      const list = yield* waitForFrame(setup, (frame) => frame.includes("enter select"))
      expect(list).not.toContain("ctrl+x delete")
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x delete"), "the stored row")
    }).pipe(Effect.timeout("4 seconds")),
  )
  // The session's profile decides which driver owns a sign-in, so a typed
  // key is saved in that profile, as a sign-out is.
  it.scopedLive("a typed key is saved in the session's profile", () =>
    Effect.gen(function* () {
      const saved: Array<{ provider: string; sessionId?: string }> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: ProviderId.make("anthropic"),
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ anthropic: [apiMethodRoute] }),
          setKey: (input: { provider: string; key: string; sessionId?: string }) =>
            Effect.sync(() => {
              saved.push({ provider: input.provider, sessionId: input.sessionId })
            }),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in · anthropic · API key"))
      yield* Effect.promise(() => setup.mockInput.typeText("new-key"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key saved for anthropic"))
      expect(saved).toEqual([{ provider: "anthropic", sessionId: activeSessionId }])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("the key field ignores super and hyper keys and erases as the composer does", () =>
    Effect.gen(function* () {
      const keys: Array<string> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: ProviderId.make("anthropic"),
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ anthropic: [apiMethodRoute] }),
          setKey: (input: { provider: string; key: string; sessionId?: string }) =>
            Effect.sync(() => {
              keys.push(input.key)
            }),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        kittyKeyboard: true,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in · anthropic · API key"))
      setup.mockInput.pressKey("a", { super: true })
      setup.mockInput.pressKey("b", { hyper: true })
      yield* Effect.promise(() => setup.mockInput.typeText("old"))
      setup.mockInput.pressKey("u", { ctrl: true })
      yield* Effect.promise(() => setup.mockInput.typeText("sk junk"))
      setup.mockInput.pressKey("w", { ctrl: true })
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("x👍🏽"))
      // The mask shows one star per character the reader typed: `sk x👍🏽` is five.
      yield* waitForFrame(setup, (frame) => frame.includes("*****"))
      expect(renderFrame(setup)).not.toContain("******")
      setup.mockInput.pressBackspace()
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key saved for anthropic"))
      expect(keys).toEqual(["sk x"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a key longer than the field shows its tail after an ellipsis", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: ProviderId.make("anthropic"),
                hasKey: false,
                required: false,
                source: "none",
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ anthropic: [apiMethodRoute] }),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        width: 40,
        height: 12,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key ›"))
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("k".repeat(100)))
      yield* waitForFrame(setup, (frame) => frame.includes("API key › …"))
      const field = renderFrame(setup)
        .split("\n")
        .find((line) => line.includes("API key ›"))
      // The caret stays on screen: the cut leaves room for it inside 40 columns.
      expect(field?.trimEnd()).toMatch(/^ API key › …\*+│$/)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("reads the sign-in methods of the session's own drivers", () =>
    Effect.gen(function* () {
      const methodCalls: Array<{ sessionId?: string } | void> = []
      const client = createMockClient({
        auth: {
          listProviders: () => Effect.succeed([]),
          listMethods: (input: { sessionId?: string } | void) => {
            methodCalls.push(input)
            return Effect.succeed({})
          },
        },
      })
      yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
      })
      expect(methodCalls).toEqual([{ sessionId: activeSessionId }])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ignores stale auth loads after the selected agent changes", () =>
    Effect.gen(function* () {
      const pending: Array<{
        agentName?: string
        /** The load's own fiber: its end is the end of the pane's handling of the reply. */
        fiber: Fiber.Fiber<unknown, unknown>
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
              const fiber = yield* Effect.withFiber((current) => Effect.succeed(current))
              pending.push({ agentName: input.agentName, fiber, deferred })
              return yield* Deferred.await(deferred)
            }),
          listMethods: () => Effect.succeed({}),
        },
      })
      const runtime = createMockRuntime()
      const { setup, client: clientContext } = yield* mountClient({
        client,
        runtime,
        view: () => (
          <>
            <SnapshotAgent agent={AgentName.make("primary")} />
            <Auth sessionId={activeSessionId} />
          </>
        ),
      })
      expect(pending.map((entry) => entry.agentName)).toEqual(["primary"])
      applySnapshotAgent(clientContext, AgentName.make("secondary"))
      yield* Effect.promise(() => setup.renderOnce())
      expect(pending.map((entry) => entry.agentName)).toEqual(["primary", "secondary"])
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
        // The stale reply has been handled, dropped or not, before the frame is read.
        yield* Fiber.await(firstPending.value.fiber).pipe(Effect.timeout("2 seconds"))
      }
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("openai")
      expect(frame).not.toContain("anthropic")
    }),
  )
  it.scopedLive("ignores stale auth mutations after the selected agent changes", () =>
    Effect.gen(function* () {
      const oldKeySave = yield* Deferred.make<void>()
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            if (input.agentName === "secondary") {
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
      const { setup, client: clientContext } = yield* mountClient({
        client,
        runtime,
        view: () => (
          <>
            <Auth sessionId={activeSessionId} />
          </>
        ),
      })
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
      applySnapshotAgent(clientContext, AgentName.make("secondary"))
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
    }),
  )
  it.scopedLive("ignores stale oauth callbacks after the selected agent changes", () =>
    Effect.gen(function* () {
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
            if (input.agentName === "secondary") {
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
      const { setup, client: clientContext } = yield* mountClient({
        client,
        runtime,
        view: () => (
          <>
            <Auth sessionId={activeSessionId} />
          </>
        ),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      applySnapshotAgent(clientContext, AgentName.make("secondary"))
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
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime,
        services,
      })
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
    }),
  )
  /** One optional provider whose only method is a browser OAuth sign-in. */
  const browserSignIn = (
    callback: (input: { readonly code?: string }) => Effect.Effect<void>,
  ): Effect.Effect<ReturnType<typeof createMockClient>> =>
    Effect.succeed(
      createMockClient({
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
          listMethods: () => Effect.succeed({ anthropic: [oauthMethodRoute] }),
          authorize: () =>
            Effect.succeed({
              authorizationId: "auth-wait",
              url: "https://example.com/oauth",
              method: "auto",
            }),
          callback,
        },
      }),
    )

  // A browser that cannot reach the loopback redirect (ssh, a devbox) leaves
  // the code in the address bar; the reader pastes it while the wait runs.
  it.scopedLive("a code pasted while a browser sign-in waits signs in with it", () =>
    Effect.gen(function* () {
      const sent: Array<string> = []
      const client = yield* browserSignIn((input) => {
        const code = Option.fromUndefinedOr(input.code)
        sent.push(Option.getOrElse(code, () => "<browser wait>"))
        // The redirect never comes; only a pasted code finishes the sign-in.
        if (Option.isNone(code)) return Effect.never
        return Effect.void
      })
      const services = yield* servicesWithLinkOpener(() => Effect.void)
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        services,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Waiting for sign-in") && sent.length === 1,
        "the browser wait",
      )
      // A bare Enter while the browser wait runs starts no second wait.
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.mockInput.typeText("pasted-code"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Authenticated anthropic via OAuth"),
        "the pasted code signs in",
      )
      expect(sent).toEqual(["<browser wait>", "pasted-code"])
    }).pipe(Effect.timeout("4 seconds")),
  )

  // The server holds the login (and its loopback port) while a browser wait
  // is in flight, so a wait the reader left must end with the screen.
  it.scopedLive("Esc on a waiting browser sign-in interrupts its wait", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const client = yield* browserSignIn(() =>
        Deferred.done(waiting, Exit.void).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.done(interrupted, Exit.void)),
        ),
      )
      const services = yield* servicesWithLinkOpener(() => Effect.void)
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        services,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Deferred.await(waiting)
      setup.mockInput.pressEscape()
      yield* Deferred.await(interrupted)
    }).pipe(Effect.timeout("4 seconds")),
  )

  // A code trades once. A browser wait that took the redirect may be
  // exchanging it when the reader pastes a code: the server holds the paste
  // behind that exchange, so the wait must run on to store the credential.
  it.scopedLive(
    "a code pasted while the browser exchanges its grant lets the exchange finish",
    () =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>()
        const redirect = yield* Deferred.make<void>()
        const exchanging = yield* Deferred.make<void>()
        const stored = yield* Deferred.make<void>()
        const client = yield* browserSignIn((input) => {
          // The pasted code waits behind the exchange, then takes its outcome.
          if (Option.isSome(Option.fromUndefinedOr(input.code))) return Deferred.await(stored)
          return Deferred.done(waiting, Exit.void).pipe(
            Effect.andThen(Deferred.await(redirect)),
            Effect.andThen(Deferred.done(exchanging, Exit.void)),
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Deferred.done(stored, Exit.void)),
          )
        })
        const services = yield* servicesWithLinkOpener(() => Effect.void)
        const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
          client,
          runtime: createMockRuntime(),
          services,
        })
        yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        yield* Deferred.await(waiting)
        yield* Effect.promise(() => setup.mockInput.typeText("pasted-code"))
        yield* Effect.promise(() => setup.renderOnce())
        yield* Deferred.done(redirect, Exit.void)
        yield* Deferred.await(exchanging)
        setup.mockInput.pressEnter()
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("Authenticated anthropic via OAuth"),
          "the exchange stores the credential and the paste takes its outcome",
        )
      }).pipe(Effect.timeout("4 seconds")),
  )

  // The pane reloads its catalog after a browser sign-in. A code sent in
  // that window would ask the server for a login it already finished.
  it.scopedLive("a code typed after the browser signed in sends no second callback", () =>
    Effect.gen(function* () {
      const callbacks: Array<string> = []
      const reload = yield* Deferred.make<void>()
      let loads = 0
      const provider = {
        provider: "anthropic",
        hasKey: false,
        required: false,
        source: "none" as const,
        authType: absent,
      }
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.suspend(() => {
              loads++
              // The reload after the sign-in waits until the test lets it go.
              if (loads === 1) return Effect.succeed([provider])
              return Deferred.await(reload).pipe(Effect.as([provider]))
            }),
          listMethods: () => Effect.succeed({ anthropic: [oauthMethodRoute] }),
          authorize: () =>
            Effect.succeed({
              authorizationId: "auth-wait",
              url: "https://example.com/oauth",
              method: "auto",
            }),
          callback: (input: { readonly code?: string }) => {
            const code = Option.fromUndefinedOr(input.code)
            callbacks.push(Option.getOrElse(code, () => "<browser wait>"))
            if (Option.isNone(code)) return Effect.void
            return Effect.fail(
              new ProviderAuthError({ message: "callback state is missing or expired" }),
            )
          },
        },
      })
      const services = yield* servicesWithLinkOpener(() => Effect.void)
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        services,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Authenticated anthropic via OAuth") && loads === 2,
        "the browser signs in and the reload starts",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("late-code"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Deferred.done(reload, Exit.void)
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Authenticated anthropic via OAuth") && loads === 2,
        "the reload lands",
      )
      expect(frame).not.toContain("expired")
      expect(callbacks).toEqual(["<browser wait>"])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("ignores stale oauth opener failures after the selected agent changes", () =>
    Effect.gen(function* () {
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
              if (input.agentName === "secondary") {
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
      const { setup, client: clientContext } = yield* mountClient({
        client,
        runtime,
        services,
        view: () => (
          <>
            <Auth sessionId={activeSessionId} />
          </>
        ),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(setup, (frame) => frame.includes("Open the URL below"))
      applySnapshotAgent(clientContext, AgentName.make("secondary"))
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(calls.at(-1)).toEqual({ agentName: "secondary", sessionId: activeSessionId })
      if (Option.isSome(rejectOpen))
        rejectOpen.value(new LinkOpenerError({ message: "open failed" }))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("openai") && !next.includes("Could not open a browser"),
      )
      expect(frame).toContain("openai")
      expect(frame).not.toContain("Could not open a browser")
      expect(authorizeCalls).toEqual([
        { provider: "anthropic", method: 0, sessionId: activeSessionId },
      ])
    }),
  )
  // Flow A's browser open fails late, after the reader cancelled A and
  // started B: the failure belongs to A, so B keeps its URL screen.
  it.scopedLive("a cancelled oauth flow's late opener failure never lands on the next flow", () =>
    Effect.gen(function* () {
      const rejectOpen: Array<(error: LinkOpenerError) => void> = []
      // Opener calls that ended: the flow reads the failure right after.
      let settled = 0
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
          rejectOpen.push((error) => resume(Effect.fail(error)))
        }).pipe(Effect.ensuring(Effect.sync(() => settled++))),
      )
      const runtime = createMockRuntime()
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime,
        services,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("anthropic"))
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Open the URL below") && rejectOpen.length === 1,
        "flow A waits on its browser",
      )
      setup.mockInput.pressEscape()
      // "esc back" lands on the provider's methods, one step back.
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("· method") && !frame.includes("Open the URL below"),
        "flow A cancelled",
      )
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Open the URL below") && rejectOpen.length === 2,
        "flow B waits on its browser",
      )
      rejectOpen[0]?.(new LinkOpenerError({ message: "open failed" }))
      yield* waitUntil(() => settled === 1, "flow A's opener ended")
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("Open the URL below")
      expect(frame).not.toContain("Could not open a browser")
      expect(authorizeCalls).toHaveLength(2)
      // B's own failure still shows: the test can see the note.
      rejectOpen[1]?.(new LinkOpenerError({ message: "open failed" }))
      yield* waitForFrame(
        setup,
        (next) => next.includes("Could not open a browser"),
        "flow B's own failure",
      )
    }).pipe(Effect.timeout("4 seconds")),
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
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        services,
      })
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
        const { setup, client: clientContext } = yield* mountClient({
          client,
          runtime: createMockRuntime(),
          services,
          view: () => (
            <>
              <SnapshotAgent agent={AgentName.make("primary")} />
              <Auth sessionId={activeSessionId} />
            </>
          ),
        })
        yield* waitForFrame(setup, (frame) => frame.includes("openai"))
        setup.mockInput.pressEnter()
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        yield* waitForFrame(
          setup,
          (next) => next.includes("WXYZ-1234") && callbackCalls.length === 1,
          "device flow waits for the poll",
        )

        applySnapshotAgent(clientContext, AgentName.make("primary"))
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
      const setup = yield* renderScoped(() => <Auth sessionId={activeSessionId} />, {
        client,
        runtime: createMockRuntime(),
        services,
      })
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
    }).pipe(Effect.timeout("8 seconds")),
  )

  // ── oauth rows on a short terminal ────────────────────────────────
  //
  // The rows go in order of need. The user code and the URL are what the
  // reader came for; the title and, while the flow waits, the optional paste
  // line give way before any of them.

  /** The App with the enforced sign-in docked, on its OAuth screen. */
  const mountOAuth = (authorization: AuthAuthorization) =>
    Effect.gen(function* () {
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: "none",
                authType: absent,
              },
            ]),
          listMethods: () =>
            Effect.succeed({ openai: [{ label: "ChatGPT sign-in", type: "oauth" }] }),
          authorize: () => Effect.succeed(authorization),
          // The flow waits: the poll or the browser callback has not finished.
          callback: () => Effect.never,
        },
      })
      const services = yield* servicesWithLinkOpener(() => Effect.void)
      const setup = yield* renderScoped(() => <App />, {
        client,
        runtime: createMockRuntime(),
        services,
        initialSession: sessionFixture("session-oauth", "branch-oauth", "A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ChatGPT sign-in"), "the methods")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Paste code"), "the OAuth screen")
      return setup
    })

  /** Each row of the frame, trimmed, joined: a wrapped URL reads whole. */
  const joinedRows = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.trim())
      .join("")

  const shortHeights: ReadonlyArray<number> = [16, 14, 12, 11, 10, 9, 8]

  it.scopedLive("a waiting device flow keeps the code and url over the optional paste line", () =>
    Effect.gen(function* () {
      const setup = yield* mountOAuth({
        authorizationId: "auth-device",
        url: "https://auth.openai.com/codex/device",
        method: "auto",
        instructions: "Open the URL and enter this code:\nWXYZ-1234",
      })
      for (const height of shortHeights) {
        setup.resize(80, height)
        yield* waitForFrame(setup, () => setup.renderer.terminalHeight === height, `${height} rows`)
        for (let draw = 0; draw < 6; draw++) yield* Effect.promise(() => setup.renderOnce())
        const frame = renderFrame(setup)
        const needs = frame.includes("WXYZ-1234") && frame.includes("codex/device")
        // Down to 8 rows the pane still holds the code and the URL.
        expect({ height, needs }).toEqual({ height, needs: true })
      }
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("a long waiting url keeps its rows before the title and the paste line", () =>
    Effect.gen(function* () {
      const url = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&state=${"s".repeat(60)}-END`
      const setup = yield* mountOAuth({
        authorizationId: "auth-long",
        url,
        method: "auto",
        instructions: "Complete authorization in your browser.",
      })
      for (const height of shortHeights) {
        setup.resize(80, height)
        yield* waitForFrame(setup, () => setup.renderer.terminalHeight === height, `${height} rows`)
        for (let draw = 0; draw < 6; draw++) yield* Effect.promise(() => setup.renderOnce())
        const frame = renderFrame(setup)
        const urlWhole = joinedRows(frame).includes(url)
        const titled = frame.includes("Sign in · openai ·")
        const paste = frame.includes("Paste code")
        // Neither the title nor the optional paste line keeps a row the URL needs.
        expect({ height, titled: titled && !urlWhole, paste: paste && !urlWhole }).toEqual({
          height,
          titled: false,
          paste: false,
        })
      }
    }).pipe(Effect.timeout("20 seconds")),
  )
})

// ── provider names ──────────────────────────────────────────────────────────

describe("Auth provider names", () => {
  const named = (provider: string, name: string) => ({
    provider: ProviderId.make(provider),
    name,
    hasKey: false,
    required: false,
    source: "none" as const,
    authType: absent,
  })

  // The server names each provider by its driver. The pane shows the name; a
  // name two providers share shows each one's id beside it.
  it.scopedLive("the list and the method screen name each provider by its driver", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              named("opencode", "OpenCode Zen"),
              named("opencode-go", "OpenCode Go"),
              named("mirror-a", "Mirror"),
              named("mirror-b", "Mirror"),
            ]),
          listMethods: () => Effect.succeed({ "opencode-go": [apiMethodRoute] }),
        },
      })
      const setup = yield* renderScoped(() => <Auth sessionId={SessionId.make("s")} />, {
        client,
        runtime: createMockRuntime(),
      })
      const list = yield* waitForFrame(setup, (frame) => frame.includes("OpenCode Zen"), "names")
      expect(list).toContain("OpenCode Go [none]")
      expect(list).toContain("Mirror (mirror-a) [none]")
      expect(list).toContain("Mirror (mirror-b) [none]")
      expect(list).not.toContain("opencode-go")

      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sign in · OpenCode Go · method"),
        "the method screen",
      )
    }).pipe(Effect.timeout("8 seconds")),
  )
})
