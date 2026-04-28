import { Schema } from "effect"
import { ExtensionId } from "./ids.js"

export class ExtensionProtocolError extends Schema.TaggedErrorClass<ExtensionProtocolError>()(
  "ExtensionProtocolError",
  {
    extensionId: ExtensionId,
    tag: Schema.String,
    phase: Schema.Literals([
      "command",
      "request",
      "reply",
      "client-reply",
      "registration",
      "lifecycle",
    ]),
    message: Schema.String,
  },
) {}
