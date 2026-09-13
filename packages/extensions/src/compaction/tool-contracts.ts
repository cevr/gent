/**
 * What compaction asks of the tools on a branch.
 *
 * A tool that runs other tools inside itself records a receipt per inner
 * call; a summary then reports the files those calls touched rather than the
 * dispatcher's own arguments. A tool that holds state between calls carries
 * names the model expects to still be bound on the next turn; a summary
 * records what they hold so it does not strand them.
 *
 * Compaction defines the questions. Which tool dispatches, or holds state,
 * and how it stores the answers is that tool's business: it provides these
 * Tags from its branch layer. No implementation means nothing was dispatched
 * and nothing is retained.
 */

import { Context, type Effect, type Schema } from "effect"
import {
  type BranchId,
  type MessageId,
  type SessionId,
  type ToolCallId,
} from "@gent/core/extensions/api"
import type { StorageError, ToolBindingIdentity } from "@gent/core/extensions/branch-tools"

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
>()("@gent/extensions/src/compaction/tool-contracts/InnerOperationReceipts") {}

interface RetainedBindingsApi {
  readonly list: (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<ReadonlyArray<string>, StorageError>
}

export class RetainedBindings extends Context.Service<RetainedBindings, RetainedBindingsApi>()(
  "@gent/extensions/src/compaction/tool-contracts/RetainedBindings",
) {}
