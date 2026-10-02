import { Effect, Option } from "effect"
import {
  defineExtension,
  ExtensionHost,
  type ModelCatalogView,
  type ModelDriverContribution,
  type ProviderAuthInfo,
  type ProviderHints,
} from "@gent/core/extensions/api"
import { resolveDriverModel } from "@gent/core/test-utils"
import { MESSAGES_CLASS } from "../../src/anthropic.js"
import { RESPONSES_CLASS } from "../../src/openai.js"
import { CHAT_COMPLETIONS_CLASS } from "../../src/providers.js"

/** The API classes the shipped extensions register, keyed by id as core holds them. */
export const SHIPPED_API_CLASSES = new Map(
  [RESPONSES_CLASS, CHAT_COMPLETIONS_CLASS, MESSAGES_CLASS].map(
    (apiClass) => [apiClass.id, apiClass] as const,
  ),
)

/**
 * The shipped API classes alone, for a profile that registers one provider
 * extension: in production the OpenAI and Anthropic extensions register them.
 */
export const ApiClassesExtension = defineExtension({
  id: "@gent/test/api-classes",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("apiClass", ...SHIPPED_API_CLASSES.values())
  }),
})

/** Resolve one model of `driver` the way core does, over the shipped classes and `catalog`. */
export const resolveShipped = (
  driver: ModelDriverContribution,
  catalog: ModelCatalogView,
  modelName: string,
  auth: Option.Option<ProviderAuthInfo> = Option.none(),
  hints: Option.Option<ProviderHints> = Option.none(),
) =>
  resolveDriverModel({
    driver,
    apiClasses: SHIPPED_API_CLASSES,
    modelName,
    auth,
    hints,
    catalog,
  })
