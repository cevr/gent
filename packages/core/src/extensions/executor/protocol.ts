import { Schema } from "effect"
import { ExtensionMessage } from "../../domain/extension-protocol.js"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"

export const ExecutorProtocol = {
  Connect: ExtensionMessage(EXECUTOR_EXTENSION_ID, "Connect", {
    cwd: Schema.optional(Schema.String),
  }),
  Disconnect: ExtensionMessage(EXECUTOR_EXTENSION_ID, "Disconnect", {}),
}
