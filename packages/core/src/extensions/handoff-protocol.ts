import { Schema } from "effect"
import { ExtensionMessage } from "../domain/extension-protocol.js"

export const HANDOFF_EXTENSION_ID = "@gent/handoff"

export const HandoffProtocol = {
  Suppress: ExtensionMessage(HANDOFF_EXTENSION_ID, "Suppress", {
    count: Schema.Number,
  }),
}
