/**
 * MessageStorage — focused service for message CRUD.
 *
 * Split from the `Storage` god-interface (B11.7).
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { Message } from "../domain/message.js"
import type { BranchId, MessageId } from "../domain/ids.js"
import type { StorageError } from "./sqlite-storage.js"

export interface MessageStorageService {
  readonly createMessage: (message: Message) => Effect.Effect<Message, StorageError>
  readonly createMessageIfAbsent: (message: Message) => Effect.Effect<Message, StorageError>
  readonly getMessage: (id: MessageId) => Effect.Effect<Message | undefined, StorageError>
  readonly listMessages: (branchId: BranchId) => Effect.Effect<ReadonlyArray<Message>, StorageError>
  readonly deleteMessages: (
    branchId: BranchId,
    afterMessageId?: MessageId,
  ) => Effect.Effect<void, StorageError>
  readonly updateMessageTurnDuration: (
    messageId: MessageId,
    durationMs: number,
  ) => Effect.Effect<void, StorageError>
}

export class MessageStorage extends Context.Service<MessageStorage, MessageStorageService>()(
  "@gent/core/src/storage/message-storage/MessageStorage",
) {
  static fromStorage = (s: MessageStorageService): Layer.Layer<MessageStorage> =>
    Layer.succeed(MessageStorage, s)
}
