import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import type { ModelDriverContribution, ProviderAuthInfo } from "@gent/core/extensions/api"
import { collectTestContributions } from "@gent/core-internal/test-utils/index"
import {
  type FakeFetchState,
  makeFakeFetchState,
  oneGenerate,
} from "@gent/core-internal/test-utils/language-model"
import { GoogleExtension, MistralExtension } from "../src/providers.js"
import { encodeExternalJson } from "./helpers/external-wire.js"

// ── openai-compatible-providers.test ────────────────────────────────────────

const makeApiAuthInfo = (key: string): ProviderAuthInfo => ({
  type: "api",
  key,
})

const chatHappyResponse = (model: string) => ({
  status: 200,
  body: encodeExternalJson({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }),
})

const onlyDriver = (drivers: ReadonlyArray<ModelDriverContribution>): ModelDriverContribution => {
  expect(drivers).toHaveLength(1)
  return drivers[0]!
}

const runOne = (model: Parameters<typeof oneGenerate>[0], state: FakeFetchState) =>
  oneGenerate(model, state, () => chatHappyResponse("compat-model")).pipe(Effect.orDie)

describe("OpenAI-compatible provider drivers", () => {
  it.live("Google uses the Gemini OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(GoogleExtension.setup)
      const driver = onlyDriver(contributions.modelDrivers ?? [])
      const model = yield* driver.resolveModel("gemini-2.5-pro", makeApiAuthInfo("google-key"), {
        cacheKey: "session-cache-key",
      })
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const request = fetchState.captured.at(-1)!
      expect(request.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      )
      expect(request.headers["authorization"]).toBe("Bearer google-key")
      expect(request.body).not.toContain("prompt_cache_key")
    }),
  )

  it.live("Mistral uses the Mistral OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(MistralExtension.setup)
      const driver = onlyDriver(contributions.modelDrivers ?? [])
      const model = yield* driver.resolveModel(
        "mistral-large-latest",
        makeApiAuthInfo("mistral-key"),
        { cacheKey: "session-cache-key" },
      )
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const request = fetchState.captured.at(-1)!
      expect(request.url).toBe("https://api.mistral.ai/v1/chat/completions")
      expect(request.headers["authorization"]).toBe("Bearer mistral-key")
      expect(request.body).not.toContain("prompt_cache_key")
    }),
  )
})
