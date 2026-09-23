import { Effect } from "effect"

declare const error: unknown

export const warned = Effect.logWarning("request failed").pipe(
  Effect.annotateLogs({ error: String(error) }),
)
export const logged = Effect.logError("request failed")
