import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { fromIni } from "@aws-sdk/credential-providers"
import { extension } from "../api.js"
import type { ProviderContribution } from "../../domain/extension.js"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

export const BedrockExtension = extension("@gent/provider-bedrock", ({ ext }) => {
  const bedrockProvider: ProviderContribution = {
    id: "bedrock",
    name: "AWS Bedrock",
    resolveModel: (modelName) => {
      const region = readEnv("AWS_REGION") ?? "us-east-1"
      const client = createAmazonBedrock({
        region,
        credentialProvider: async () => {
          const creds = await fromIni()()
          return {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            ...(creds.sessionToken !== undefined ? { sessionToken: creds.sessionToken } : {}),
          }
        },
      })
      return client(modelName)
    },
    // No auth methods — Bedrock uses IAM credentials from AWS config/profiles
  }

  return ext.provider(bedrockProvider)
})
