import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/extensions/api"

export const AUTO_EXTENSION_ID = "@gent/auto"

export const AutoProtocol = {
  StartAuto: ExtensionMessage(AUTO_EXTENSION_ID, "StartAuto", {
    goal: Schema.String,
    maxIterations: Schema.optional(Schema.Number),
  }),
  CancelAuto: ExtensionMessage(AUTO_EXTENSION_ID, "CancelAuto", {}),
  ToggleAuto: ExtensionMessage(AUTO_EXTENSION_ID, "ToggleAuto", {
    goal: Schema.optional(Schema.String),
    maxIterations: Schema.optional(Schema.Number),
  }),
  IsActive: ExtensionMessage.reply(AUTO_EXTENSION_ID, "IsActive", {}, Schema.Boolean),
}
