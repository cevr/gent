import { extension, type ProviderContribution } from "../api.js"

export const BedrockExtension = extension("@gent/provider-bedrock", ({ ext }) => {
  const bedrockProvider: ProviderContribution = {
    id: "bedrock",
    name: "AWS Bedrock",
    resolveModel: () => {
      throw new Error(
        "AWS Bedrock is temporarily unsupported. No @effect/ai Bedrock provider exists at beta.47. Use anthropic/ or openai/ provider instead.",
      )
    },
  }

  return ext.provider(bedrockProvider)
})
