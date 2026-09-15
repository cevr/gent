import { Schema } from "effect"
import { SessionDepthLimitError } from "../domain/agent.js"
import { InvalidStateError, NotFoundError } from "../domain/business-errors.js"
import { EventStoreError } from "../domain/event.js"
import { ExtensionId } from "../domain/ids.js"
import { InteractionRequestMismatchError } from "../domain/interaction-request.js"
import { DriverError, ProviderAuthError } from "../domain/driver.js"
import { ProviderError } from "../domain/provider-error.js"
import { SessionRuntimeErrorSchema } from "../runtime/session-runtime.js"
import { StorageError } from "../storage/sqlite-storage.js"

export { InvalidStateError, NotFoundError } from "../domain/business-errors.js"

export class ExtensionProtocolError extends Schema.TaggedError<ExtensionProtocolError>()(
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

export const GentRpcError = Schema.Union([
  StorageError,
  SessionRuntimeErrorSchema,
  ProviderError,
  ProviderAuthError,
  DriverError,
  ExtensionProtocolError,
  EventStoreError,
  InteractionRequestMismatchError,
  NotFoundError,
  InvalidStateError,
  SessionDepthLimitError,
]).pipe(Schema.toTaggedUnion("_tag"))

export type GentRpcError = typeof GentRpcError.Type
