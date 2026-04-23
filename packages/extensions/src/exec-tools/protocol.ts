import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/extensions/api"

export const EXEC_TOOLS_EXTENSION_ID = "@gent/exec-tools"

export const ExecToolsProtocol = {
  BackgroundCompleted: ExtensionMessage.command(EXEC_TOOLS_EXTENSION_ID, "BackgroundCompleted", {
    content: Schema.String,
  }),
}
