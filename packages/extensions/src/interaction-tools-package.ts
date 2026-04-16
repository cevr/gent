import { defineExtensionPackage } from "@gent/core/extensions/api"
import { InteractionToolsExtension } from "./interaction-tools/index.js"

export const InteractionToolsPackage = defineExtensionPackage({
  id: "@gent/interaction-tools",
  server: InteractionToolsExtension,
})
