/**
 * The tool call that dispatched the call running right now, if any.
 *
 * A tool that runs other tools inside itself sets this for the duration of an
 * inner call, so events raised by that call can name their parent and attach
 * to the assistant message that holds the dispatching part. Absent means the
 * call came straight from the model.
 *
 * Host-owned: never set from tool code.
 */

import { Context } from "effect"
import type { MessageId, ToolCallId } from "../../domain/ids.js"

export interface DispatchingCall {
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
}

export class CurrentDispatchingCall extends Context.Service<
  CurrentDispatchingCall,
  DispatchingCall
>()("@gent/core/src/runtime/agent/current-dispatching-call/CurrentDispatchingCall") {}
