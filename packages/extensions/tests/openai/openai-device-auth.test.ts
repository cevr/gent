/**
 * OpenAI device-code login. Stubs the three auth.openai.com endpoints
 * through `HttpClient.make` and drives polling with `TestClock`, so the
 * RFC 8628 semantics (pending, slow_down, deadline, denial) are
 * observable without network access.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Fiber, Layer, Option, SynchronizedRef } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import { authorizeOpenAIDevice, type OAuthError } from "../../src/openai/oauth.js"
import { buildOpenAIModelDriver } from "../../src/openai/index.js"
import { EMPTY_CREDENTIAL_CELL } from "../../src/openai/credential-service.js"

interface Recorded {
  readonly path: string
  readonly body: string
}

interface StubState {
  readonly calls: Array<Recorded>
  tokenPolls: number
  readonly pollResponses: Array<() => Response>
  readonly usercode: () => Response
}

const json = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })

const requestBody = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body
  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body)
  return ""
}

const stubLayer = (state: StubState) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        state.calls.push({ path: url.pathname, body: requestBody(request) })
        if (url.pathname === "/api/accounts/deviceauth/usercode") {
          return HttpClientResponse.fromWeb(request, state.usercode())
        }
        if (url.pathname === "/api/accounts/deviceauth/token") {
          const next = Option.fromNullishOr(state.pollResponses[state.tokenPolls])
          state.tokenPolls += 1
          const response = Option.match(next, {
            onNone: () => json(403, "{}"),
            onSome: (make) => make(),
          })
          return HttpClientResponse.fromWeb(request, response)
        }
        if (url.pathname === "/oauth/token") {
          return HttpClientResponse.fromWeb(
            request,
            json(
              200,
              '{"access_token":"device-access","refresh_token":"device-refresh","expires_in":3600}',
            ),
          )
        }
        return HttpClientResponse.fromWeb(request, json(500, '{"error":"unexpected"}'))
      }),
    ),
  )

const usercodeOk = () =>
  json(200, '{"device_auth_id":"device-auth-1","user_code":"ABCD-1234","interval":"1"}')

const makeState = (
  pollResponses: Array<() => Response>,
  usercode: () => Response = usercodeOk,
): StubState => ({ calls: [], tokenPolls: 0, pollResponses, usercode })

const settle = Effect.yieldNow

const run = <A, E>(state: StubState, eff: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.scoped(eff).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), stubLayer(state))))

const errorReason = (exit: Exit.Exit<unknown, OAuthError>): Option.Option<OAuthError["reason"]> => {
  if (!Exit.isFailure(exit)) return Option.none()
  return Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error.reason))
}

const causeText = (exit: Exit.Exit<unknown, OAuthError>): string => {
  if (!Exit.isFailure(exit)) return ""
  return String(exit.cause)
}

describe("OpenAI device-code login", () => {
  const approvedAfterSlowDown = () =>
    makeState([
      () => json(403, "{}"),
      () => json(400, '{"code":"slow_down"}'),
      () => json(200, '{"authorization_code":"auth-code-1","code_verifier":"verifier-1"}'),
    ])

  it.live("shows the verification URL with the user code and polls until approved", () => {
    const state = approvedAfterSlowDown()
    return run(
      state,
      Effect.gen(function* () {
        const flow = yield* authorizeOpenAIDevice
        expect(flow.authorization.method).toBe("auto")
        expect(flow.authorization.url).toBe("https://auth.openai.com/codex/device")
        expect(flow.authorization.instructions).toContain("ABCD-1234")
        expect(state.calls[0]?.body).toContain("app_EMoamEEZ73f0CkXaXp7hrann")

        const fiber = yield* Effect.forkChild(flow.callback())
        yield* settle
        expect(state.tokenPolls).toBe(0)

        yield* TestClock.adjust("1 second")
        yield* settle
        expect(state.tokenPolls).toBe(1)

        yield* TestClock.adjust("1 second")
        yield* settle
        expect(state.tokenPolls).toBe(2)

        // slow_down adds five seconds to the one-second interval.
        yield* TestClock.adjust("5 seconds")
        yield* settle
        expect(state.tokenPolls).toBe(2)

        yield* TestClock.adjust("1 second")
        const tokens = yield* Fiber.join(fiber)
        expect(state.tokenPolls).toBe(3)
        expect(tokens.access).toBe("device-access")
        expect(tokens.refresh).toBe("device-refresh")

        const exchange = state.calls.find((call) => call.path === "/oauth/token")
        expect(exchange?.body).toContain("code=auth-code-1")
        expect(exchange?.body).toContain("code_verifier=verifier-1")
        expect(exchange?.body).toContain(
          `redirect_uri=${encodeURIComponent("https://auth.openai.com/deviceauth/callback")}`,
        )
        const poll = state.calls.find((call) => call.path === "/api/accounts/deviceauth/token")
        expect(poll?.body).toContain('"device_auth_id":"device-auth-1"')
        expect(poll?.body).toContain('"user_code":"ABCD-1234"')
      }),
    )
  })

  it.live("reports device login disabled when the code endpoint returns 404", () => {
    const state = makeState([], () => json(404, "{}"))
    return run(
      state,
      Effect.gen(function* () {
        const exit = yield* Effect.exit(authorizeOpenAIDevice)
        expect(errorReason(exit)).toEqual(Option.some("device-code-failed"))
        expect(causeText(exit)).toContain("not enabled")
      }),
    )
  })

  it.live("fails with device-code-denied when the user rejects the code", () => {
    const state = makeState([() => json(400, '{"code":"access_denied"}')])
    return run(
      state,
      Effect.gen(function* () {
        const flow = yield* authorizeOpenAIDevice
        const fiber = yield* Effect.forkChild(flow.callback())
        yield* TestClock.adjust("1 second")
        const exit = yield* Fiber.await(fiber)
        expect(errorReason(exit)).toEqual(Option.some("device-code-denied"))
      }),
    )
  })

  it.live("times out after fifteen minutes of pending polls", () => {
    const state = makeState([])
    return run(
      state,
      Effect.gen(function* () {
        const flow = yield* authorizeOpenAIDevice
        const fiber = yield* Effect.forkChild(flow.callback())
        yield* TestClock.adjust("14 minutes")
        yield* settle
        expect(state.tokenPolls).toBeGreaterThan(0)
        yield* TestClock.adjust("1 minute")
        const exit = yield* Fiber.await(fiber)
        expect(errorReason(exit)).toEqual(Option.some("device-code-timeout"))
      }),
    )
  })

  it.live("registers the device-code method between the browser and API-key methods", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make(EMPTY_CREDENTIAL_CELL)
      const driver = buildOpenAIModelDriver(credentialCellRef, new Map(), Option.none())
      const methods = Option.fromNullishOr(driver.auth?.methods).pipe(Option.getOrElse(() => []))
      expect(methods.map((method) => `${method.type}:${method.label}`)).toEqual([
        "oauth:ChatGPT Pro/Plus (browser)",
        "oauth:ChatGPT Pro/Plus (device code)",
        "api:Manually enter API key",
      ])
    }),
  )
})
