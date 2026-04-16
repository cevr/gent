import {
  defineExtension,
  modelDriverContribution,
  type ModelDriverContribution,
} from "@gent/core/extensions/api"

export const BedrockExtension = defineExtension({
  id: "@gent/provider-bedrock",
  contributions: () => {
    const bedrockProvider: ModelDriverContribution = {
      id: "bedrock",
      name: "AWS Bedrock",
      resolveModel: () => {
        throw new Error(
          "AWS Bedrock is temporarily unsupported. No @effect/ai Bedrock provider exists at beta.47. Use anthropic/ or openai/ provider instead.",
        )
      },
    }

    return [modelDriverContribution(bedrockProvider)]
  },
})
