/**
 * ACP stop reasons must land on real `Response.FinishReason` values.
 *
 * The two vocabularies do not overlap, so a mapper written against the
 * AI-SDK spelling matches nothing and reports every ACP turn as
 * `"unknown"`. These assertions pin the whole ACP literal union.
 */

import { Effect } from "effect"
import { describe, expect, it } from "effect-bun-test"

import { toResponseFinishReason } from "../../src/acp-agents/response-finish.js"
import { StopReason } from "../../src/acp-agents/schema.js"

describe("acp finish reason mapping", () => {
  it.live("maps every ACP stop reason to its Response.FinishReason", () =>
    Effect.sync(() => {
      expect(toResponseFinishReason("end_turn")).toBe("stop")
      expect(toResponseFinishReason("max_tokens")).toBe("length")
      expect(toResponseFinishReason("max_turn_requests")).toBe("length")
      expect(toResponseFinishReason("refusal")).toBe("content-filter")
      expect(toResponseFinishReason("cancelled")).toBe("other")
    }),
  )

  it.live("never reports an ACP turn as unknown", () =>
    Effect.sync(() => {
      // The regression: the prior mapper switched on `"stop" | "length" |
      // "tool-calls" | ...`, so no ACP literal matched and every turn
      // fell through to `"unknown"`.
      for (const reason of StopReason.literals) {
        expect(toResponseFinishReason(reason)).not.toBe("unknown")
      }
    }),
  )

  it.live("covers the ACP literal union with no gaps", () =>
    Effect.sync(() => {
      // Guards against a schema literal added without a matching case.
      // `Match.exhaustive` fails typecheck; this fails the suite.
      expect([...StopReason.literals].sort()).toEqual([
        "cancelled",
        "end_turn",
        "max_tokens",
        "max_turn_requests",
        "refusal",
      ])
    }),
  )
})
