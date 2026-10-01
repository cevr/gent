import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Option } from "effect"
import { ModelId, ProviderAuthError, ProviderAuthInfo } from "@gent/core/extensions/api"
import { makeFakeFetchState } from "@gent/core/test-utils"
import { buildTypeSafeModelDriver } from "../src/typesafe.js"
import { decideTicket, systemOneBody, TICKET, TICKET_QUESTIONS } from "./helpers/decision-wire.js"

/**
 * The TypeSafe driver: Jev classifier models only, posted to TypeSafe's own
 * API with a stored key or `TYPESAFE_API_KEY`. Every request goes to a
 * captured fake `fetch`; no test reaches TypeSafe.
 */

const STORED_KEY = "ts-stored-key"
const ENV_KEY = "ts-env-key"
const storedAuth = ProviderAuthInfo.cases.Api.make({ key: STORED_KEY })

const resolveDecision = (
  driver: ReturnType<typeof buildTypeSafeModelDriver>,
  modelName: string,
  authInfo?: ProviderAuthInfo,
) => Option.getOrThrow(Option.fromUndefinedOr(driver.resolveDecisionModel))(modelName, authInfo)

describe("TypeSafe request wiring", () => {
  it.live("a decide posts the questions to TypeSafe's System One with the stored key", () =>
    Effect.gen(function* () {
      const driver = buildTypeSafeModelDriver(Option.some(ENV_KEY))
      const state = makeFakeFetchState()
      const response = yield* decideTicket(
        yield* resolveDecision(driver, "jev-latest", storedAuth),
        state,
      )
      expect(state.captured.map((request) => request.url)).toEqual([
        "https://api.typesafe.ai/v1/systemone",
      ])
      const request = Option.getOrThrow(Option.fromUndefinedOr(state.captured[0]))
      // A stored key wins over TYPESAFE_API_KEY.
      expect(request.headers["authorization"]).toBe(`Bearer ${STORED_KEY}`)
      expect(yield* systemOneBody(request)).toEqual({
        model: "jev-latest",
        state: TICKET,
        questions: TICKET_QUESTIONS,
      })
      expect(response.answers.topic.label).toBe("billing")
      expect(response.answers.urgency.label).toBe("now")
      expect(response.answers.urgent.probability).toBe(0.25)
      expect(response.usage.inputTokens).toBe(30)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("without a stored key the request carries TYPESAFE_API_KEY", () =>
    Effect.gen(function* () {
      const driver = buildTypeSafeModelDriver(Option.some(ENV_KEY))
      const state = makeFakeFetchState()
      yield* decideTicket(yield* resolveDecision(driver, "jev-preview"), state)
      const request = Option.getOrThrow(Option.fromUndefinedOr(state.captured[0]))
      expect(request.headers["authorization"]).toBe(`Bearer ${ENV_KEY}`)
      expect((yield* systemOneBody(request))["model"]).toBe("jev-preview")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("without a stored key or TYPESAFE_API_KEY, resolving fails and names the variable", () =>
    Effect.gen(function* () {
      const driver = buildTypeSafeModelDriver(Option.none())
      const error = yield* Effect.flip(resolveDecision(driver, "jev-latest"))
      expect(error).toBeInstanceOf(ProviderAuthError)
      expect(error.message).toContain("TYPESAFE_API_KEY")
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

describe("TypeSafe catalog", () => {
  it.live("lists the Jev models as classifiers, jev-latest first, and runs no turn", () =>
    Effect.gen(function* () {
      const driver = buildTypeSafeModelDriver(Option.some(ENV_KEY))
      const listModels = Option.getOrThrow(Option.fromUndefinedOr(driver.listModels))
      const models = yield* listModels()
      expect(models.map((model) => model.id)).toEqual([
        ModelId.make("typesafe/jev-latest"),
        ModelId.make("typesafe/jev-preview"),
        ModelId.make("typesafe/jev-1.13.0"),
      ])
      expect(models.every((model) => model.kind === "classifier")).toBe(true)
      const exit = yield* Effect.exit(driver.resolveModel("jev-latest", storedAuth))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.pretty(exit.cause)).toContain(
        "typesafe/jev-latest is a classifier model: it runs no turn",
      )
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})
