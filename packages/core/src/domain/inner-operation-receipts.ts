/**
 * What a dispatching tool's inner calls did, read back after the fact.
 *
 * A tool that runs other tools inside itself records a receipt per inner call.
 * Compaction reads those receipts so a summary reports the files the inner
 * calls touched rather than the dispatcher's own arguments, which describe the
 * dispatch and not the work.
 *
 * Core defines the question; it does not know which tools dispatch or how they
 * store their receipts. A tool that records none — the common case — simply
 * returns an empty list.
 */

import { Context, type Effect, type Schema } from "effect"
import type { StorageError } from "./storage-error.js"
import type { ToolBindingIdentity } from "./tool-binding.js"
import type { BranchId, MessageId, SessionId, ToolCallId } from "./ids.js"

/** One inner call, as its receipt recorded it. */
export interface InnerOperation {
  readonly binding: ToolBindingIdentity
  readonly input: Schema.Json
}

interface InnerOperationReceiptsApi {
  /**
   * The inner calls one tool call dispatched, in no guaranteed order.
   * Empty when the call dispatched nothing, or failed before running.
   */
  readonly listForToolCall: (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly assistantMessageId: MessageId
    readonly toolCallId: ToolCallId
  }) => Effect.Effect<ReadonlyArray<InnerOperation>, StorageError>
}

export class InnerOperationReceipts extends Context.Service<
  InnerOperationReceipts,
  InnerOperationReceiptsApi
>()("@gent/core/src/domain/inner-operation-receipts/InnerOperationReceipts") {}
