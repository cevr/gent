import { describe, expect, test } from "bun:test"
import type { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method"
import type { AuthProviderInfo } from "@gent/core/domain/auth-guard"
import { ProviderId } from "@gent/core/domain/model"
import { AuthState, transitionAuth } from "../src/routes/auth-state"

const provider = {
  provider: ProviderId.make("anthropic"),
  hasKey: false,
  required: true,
} satisfies AuthProviderInfo

const methods = {
  anthropic: [
    { type: "api", label: "API Key" },
    { type: "oauth", label: "OAuth" },
  ],
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

describe("auth-state", () => {
  test("loads providers into list state and clamps selection", () => {
    const loaded = transitionAuth(AuthState.initial(), {
      _tag: "Loaded",
      providers: [provider],
      methods,
    })

    expect(loaded).toEqual({
      _tag: "List",
      providers: [provider],
      methods,
      providerIndex: 0,
      deleting: false,
      error: undefined,
    })
  })

  test("load failure preserves the list surface with error", () => {
    const failed = transitionAuth(AuthState.initial(), {
      _tag: "LoadFailed",
      error: "boom",
    })

    expect(failed).toEqual({
      _tag: "List",
      providers: [],
      methods: {},
      providerIndex: 0,
      deleting: false,
      error: "boom",
    })
  })

  test("method selection and key submit failure stay in the auth reducer", () => {
    const list = transitionAuth(AuthState.initial(), {
      _tag: "Loaded",
      providers: [provider],
      methods,
    })
    const method = transitionAuth(list, { _tag: "OpenMethod" })
    const key = transitionAuth(method, { _tag: "StartKey" })
    const submitting = transitionAuth(key, { _tag: "SubmitKeyStarted" })
    const failed = transitionAuth(submitting, {
      _tag: "ActionFailed",
      error: "bad key",
    })

    expect(method._tag).toBe("Method")
    expect(key).toMatchObject({ _tag: "Key", value: "", submitting: false })
    expect(submitting).toMatchObject({ _tag: "Key", submitting: true })
    expect(failed).toMatchObject({ _tag: "Key", submitting: false, error: "bad key" })
  })

  test("oauth auto and code flows get explicit state", () => {
    const list = transitionAuth(AuthState.initial(), {
      _tag: "Loaded",
      providers: [provider],
      methods,
    })
    const method = transitionAuth(list, { _tag: "OpenMethod" })
    const authorizing = transitionAuth(method, { _tag: "StartOAuthAuthorization" })
    const auto = transitionAuth(authorizing, {
      _tag: "StartOAuth",
      authorization: autoAuthorization,
      method: methods.anthropic[1]!,
      providerIndex: 0,
      methodIndex: 1,
    })
    const autoFailed = transitionAuth(auto, {
      _tag: "OAuthAutoFailed",
      error: "callback failed",
    })
    const code = transitionAuth(method, {
      _tag: "StartOAuth",
      authorization: codeAuthorization,
      method: methods.anthropic[1]!,
      providerIndex: 0,
      methodIndex: 1,
    })

    expect(authorizing).toMatchObject({ _tag: "Method", authorizing: true })
    expect(auto).toMatchObject({ _tag: "OAuth", phase: "waiting", submitting: false })
    expect(autoFailed).toMatchObject({ _tag: "OAuth", phase: "idle", error: "callback failed" })
    expect(code).toMatchObject({ _tag: "OAuth", phase: "idle", submitting: false })
  })

  test("cancel always returns to list with current provider selection", () => {
    const list = transitionAuth(AuthState.initial(), {
      _tag: "Loaded",
      providers: [provider],
      methods,
    })
    const method = transitionAuth(list, { _tag: "OpenMethod" })
    const canceled = transitionAuth(method, { _tag: "Cancel" })

    expect(canceled).toMatchObject({
      _tag: "List",
      providerIndex: 0,
      providers: [provider],
    })
  })
})
