/**
 * ACP `StopReason` → Effect AI `Response.FinishReason`.
 *
 * The two vocabularies do not overlap. ACP names its reasons
 * `end_turn | max_tokens | max_turn_requests | refusal | cancelled`
 * (`schema.ts`); `Response.FinishReason` names them
 * `stop | length | content-filter | tool-calls | error | pause | other |
 * unknown`. Matching on the AI-SDK spelling therefore never hit, and
 * every ACP turn finished as `"unknown"`.
 *
 * `Match.exhaustive` over the ACP literal union is the guard: a new ACP
 * stop reason added to `schema.ts` fails typecheck here instead of
 * silently degrading to `"unknown"` again.
 *
 * @module
 */
import { Match } from "effect"
import type * as Response from "effect/unstable/ai/Response"

import type { StopReason } from "./schema.js"

export const toResponseFinishReason: (stopReason: StopReason) => Response.FinishReason =
  Match.type<StopReason>().pipe(
    // The agent ended its turn on its own — a normal stop.
    Match.when("end_turn", (): Response.FinishReason => "stop"),
    // Both ACP budget stops are ceilings the agent hit; `length` is the
    // only FinishReason for "ran out of budget".
    Match.when("max_tokens", (): Response.FinishReason => "length"),
    Match.when("max_turn_requests", (): Response.FinishReason => "length"),
    // ACP has no separate safety reason; a refusal is the model
    // declining to produce the content.
    Match.when("refusal", (): Response.FinishReason => "content-filter"),
    // An interrupted turn is neither an error nor a stop sequence;
    // `other` is FinishReason's "stopped for a reason not in this
    // protocol".
    Match.when("cancelled", (): Response.FinishReason => "other"),
    Match.exhaustive,
  )
