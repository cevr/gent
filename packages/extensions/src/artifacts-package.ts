import { defineExtensionPackage } from "@gent/core/extensions/api"
import { ArtifactsExtension } from "./artifacts/index.js"
import { ArtifactProtocol } from "./artifacts-protocol.js"

export const ArtifactsPackage = defineExtensionPackage({
  id: "@gent/artifacts",
  server: ArtifactsExtension,
  // Widget reads the artifact list per pulse — branch filter happens
  // client-side from `ctx.branchId`.
  snapshotRequest: () => ArtifactProtocol.List({}),
})
