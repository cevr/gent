import { Schema } from "effect"
import { SessionDepthLimitError } from "../domain/agent.js"
import { InvalidStateError, NotFoundError, ProviderError } from "../domain/errors.js"
import { EventStoreError } from "../domain/event.js"
import { ExtensionId } from "../domain/ids.js"
import { InteractionRequestMismatchError } from "../domain/interaction.js"
import { DriverError, ProviderAuthError } from "../domain/driver.js"
import { ConfigLoadError } from "../runtime/config.js"
import { SessionRuntimeError } from "../runtime/session.js"
import { StorageError } from "../storage/storage.js"

export { InvalidStateError, NotFoundError } from "../domain/errors.js"

export class ExtensionProtocolError extends Schema.TaggedError<ExtensionProtocolError>()(
  "ExtensionProtocolError",
  {
    extensionId: ExtensionId,
    tag: Schema.String,
    message: Schema.String,
  },
) {}

export const GentRpcError = Schema.Union([
  ConfigLoadError,
  StorageError,
  SessionRuntimeError,
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
