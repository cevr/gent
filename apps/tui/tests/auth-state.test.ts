import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  ProviderId,
  type AuthAuthorization,
  type AuthMethod,
  type AuthProviderInfo,
} from "@gent/core/protocol"
import {
  AuthState,
  catalogOf,
  methodsFor,
  missingRequired,
  providerFor,
  transitionAuth,
  type AuthEvent,
} from "../src/routes/auth-state"

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
