import {
  defineExtension,
  ProviderAuthError,
  type ModelDriverContribution,
} from "@gent/core/extensions/api"

const bedrockProvider: ModelDriverContribution = {
  id: "bedrock",
  name: "AWS Bedrock",
  resolveModel: () => {
    // Fail closed via `ProviderAuthError` so the resolver does not wrap
    // the throw as a transient `ProviderError` and retry it. There is no
    // `@effect/ai` Bedrock provider at beta.47, so the contribution stays
    // registered (so list/auth surfaces still see "bedrock" as a known id)
    // but every resolveModel call surfaces the unsupported-state cleanly.
    throw new ProviderAuthError({
      message:
        "AWS Bedrock is temporarily unsupported. No @effect/ai Bedrock provider exists at beta.47. Use anthropic/ or openai/ provider instead.",
    })
  },
}

export const BedrockExtension = defineExtension({
  id: "@gent/provider-bedrock",
  modelDrivers: [bedrockProvider],
})
