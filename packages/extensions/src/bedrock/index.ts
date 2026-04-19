import { defineExtension, type ModelDriverContribution } from "@gent/core/extensions/api"

const bedrockProvider: ModelDriverContribution = {
  id: "bedrock",
  name: "AWS Bedrock",
  resolveModel: () => {
    throw new Error(
      "AWS Bedrock is temporarily unsupported. No @effect/ai Bedrock provider exists at beta.47. Use anthropic/ or openai/ provider instead.",
    )
  },
}

export const BedrockExtension = defineExtension({
  id: "@gent/provider-bedrock",
  modelDrivers: [bedrockProvider],
})
