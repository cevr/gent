/**
 * Detail fetching for the agents view.
 *
 * Arrow keys move faster than a round trip, so replies can land out of order.
 * These cover the rule that only the reply for the row still selected wins —
 * without it, one row's cost renders next to another row's name.
 */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option } from "effect"
import { createRoot } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { makeAgentsController } from "../../src/extensions/builtins/agents-view.client"
import type { ExtensionAgentDetail } from "../../src/extensions/client-transport"

const row = (id: string, live = true): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "idle",
  live,
  depth: 0,
})

const detail = (turns: number): ExtensionAgentDetail => ({
  status: Option.none(),
  model: Option.none(),
  turns,
  costUsd: 0,
  durationMs: 0,
})

describe("Agents controller detail", () => {
  it.scopedLive("ignores a reply for a row the reader already moved off", () =>
    Effect.gen(function* () {
      // Stands in for the client's `cast`, which runs effects on the shell's
      // own runtime; here that is the surrounding test context.
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const slow = yield* Deferred.make<ExtensionAgentDetail>()
      const fast = yield* Deferred.make<ExtensionAgentDetail>()
      const gates = new Map([
        ["first", slow],
        ["second", fast],
      ])

      const result = createRoot((dispose) => {
        const controller = makeAgentsController(
          () => Effect.succeed([]),
          (key) =>
            Option.match(Option.fromUndefinedOr(gates.get(key.sessionId)), {
              onNone: () => Effect.never,
              onSome: (gate) => Deferred.await(gate),
            }),
          (effect) => {
            cast(effect)
          },
          () => Option.none(),
        )
        return { controller, dispose }
      })

      // Select the first row, then move on before its reply arrives.
      result.controller.select(Option.some(row("first")))
      result.controller.select(Option.some(row("second")))

      // The stale reply lands first and must not be shown.
      yield* Deferred.succeed(slow, detail(111))
      yield* Effect.yieldNow
      expect(result.controller.detail()).toEqual(Option.none())

      // The reply for the row still selected is the one that wins.
      yield* Deferred.succeed(fast, detail(222))
      yield* Effect.yieldNow
      expect(Option.map(result.controller.detail(), (value) => value.turns)).toEqual(
        Option.some(222),
      )

      result.dispose()
    }),
  )

  it.scopedLive("clears detail when the selection goes away", () =>
    Effect.gen(function* () {
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const gate = yield* Deferred.make<ExtensionAgentDetail>()

      const result = createRoot((dispose) => {
        const controller = makeAgentsController(
          () => Effect.succeed([]),
          () => Deferred.await(gate),
          (effect) => {
            cast(effect)
          },
          () => Option.none(),
        )
        return { controller, dispose }
      })

      result.controller.select(Option.some(row("only")))
      yield* Deferred.succeed(gate, detail(5))
      yield* Effect.yieldNow
      expect(Option.isSome(result.controller.detail())).toBe(true)

      result.controller.select(Option.none())
      expect(result.controller.detail()).toEqual(Option.none())

      result.dispose()
    }),
  )
})

describe("Agents controller stored rows", () => {
  it.scopedLive("never asks a stored session for detail, since the read would spawn its loop", () =>
    Effect.gen(function* () {
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const asked: Array<string> = []
      const result = createRoot((dispose) => {
        const controller = makeAgentsController(
          () => Effect.succeed([]),
          (key) => {
            asked.push(key.sessionId)
            return Effect.succeed(detail(1))
          },
          (effect) => {
            cast(effect)
          },
          () => Option.none(),
        )
        controller.select(Option.some(row("stored", false)))
        const seen = controller.detail()
        dispose()
        return seen
      })
      expect(asked).toEqual([])
      expect(result).toEqual(Option.none())
    }),
  )
})
