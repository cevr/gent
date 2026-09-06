/** Named adapters for Promise contracts owned by the Claude Agent SDK. */

import { Effect, Option } from "effect"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

const NO_PARENT_TOOL_USE_ID = Option.getOrNull(Option.none<string>())
const ITERATOR_DONE_VALUE = Option.getOrUndefined(Option.none<SDKMessage>())

/** Adapt a gent user prompt to the Claude SDK wire shape. */
export const makeClaudeUserMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: NO_PARENT_TOOL_USE_ID,
})

export const closeClaudeQuery = (query: Query): Effect.Effect<void> =>
  Effect.sync(() => query.close()).pipe(Effect.asVoid)

export const interruptClaudeQuery = (query: Query): void => {
  Effect.runFork(Effect.promise(() => query.interrupt()).pipe(Effect.ignore))
}

export const nextClaudeMessage = (
  iterator: AsyncIterator<SDKMessage>,
  done: boolean,
): Promise<IteratorResult<SDKMessage>> => {
  if (done) {
    return Effect.runPromise(Effect.succeed({ value: ITERATOR_DONE_VALUE, done: true }))
  }
  return Effect.runPromise(Effect.promise(() => iterator.next()))
}
