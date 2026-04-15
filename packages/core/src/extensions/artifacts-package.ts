import { defineExtensionPackage } from "./api.js"
import { ArtifactsExtension } from "./artifacts/index.js"
import { ArtifactUiModel } from "./artifacts-protocol.js"

export const ArtifactsPackage = defineExtensionPackage({
  id: "@gent/artifacts",
  server: ArtifactsExtension,
  snapshot: ArtifactUiModel,
})
