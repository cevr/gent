/**
 * Docked panes must not write a previous session's rows, and must not write an
 * older query's rows either.
 *
 * Both panes refetch across a session switch — the agents tray on `current()`
 * changing plus a 2 s poll, the thread pane on a compaction event — so a reply
 * can land after the shell has already moved. The key the fetch was made for
 * is re-read when it lands; a reply for any other key is dropped.
 *
 * The filter fires one fetch per keystroke, so replies also race each other
 * within one session. Only the newest refresh may write, and every reply that
 * reaches the query clears the load state, even the ones it drops.
 */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option } from "effect"
import { createRoot } from "solid-js"
import { BranchId, SessionId, dateFromMillis, Session } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { makeAgentsController } from "../../src/extensions/builtins/agents-view.client"
import { makeThreadController } from "../../src/extensions/builtins/thread-view.client"

const key = (id: string) => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
})

const row = (id: string): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "idle",
  live: true,
  depth: 0,
})

describe("Agents controller across a session switch", () => {
  it.scopedLive("drops a reply that lands after the shell moved to another session", () =>
    Effect.gen(function* () {
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const gate = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()

      // The shell starts on "first"; the test moves it while the fetch is out.
      let active = Option.some(key("first"))

      const result = createRoot((dispose) => {
        const controller = makeAgentsController(
          () => Deferred.await(gate),
          () => Effect.never,
          (effect) => {
            cast(effect)
          },
          () => active,
        )
        return { controller, dispose }
      })

      // Fetch for "first" goes out, then the shell switches to "second".
      result.controller.refresh("")
      active = Option.some(key("second"))

      // The in-flight reply carries the previous session's rows.
      yield* Deferred.succeed(gate, [row("first")])
      yield* Effect.yieldNow

      expect(result.controller.rows()).toEqual([])
      result.dispose()
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("keeps the newest filter's rows when an older one replies last", () =>
    Effect.gen(function* () {
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const first = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
      const second = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
      const gates = new Map([
        ["a", first],
        ["ab", second],
      ])

      const active = Option.some(key("only"))
      const result = createRoot((dispose) => {
        const controller = makeAgentsController(
          (query) =>
            Option.match(Option.fromUndefinedOr(gates.get(query)), {
              onNone: () => Effect.never,
              onSome: (gate) => Deferred.await(gate),
            }),
          () => Effect.never,
          (effect) => {
            cast(effect)
          },
          () => active,
        )
        return { controller, dispose }
      })

      // One fetch per keystroke; the shorter query is still out when the
      // longer one replies.
      result.controller.refresh("a")
      result.controller.refresh("ab")

      yield* Deferred.succeed(second, [row("ab-match")])
      yield* Effect.yieldNow
      yield* Deferred.succeed(first, [row("a-match")])
      yield* Effect.yieldNow

      expect(result.controller.rows().map((entry) => String(entry.sessionId))).toEqual(["ab-match"])
      result.dispose()
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("stops loading even when the reply is for the session the shell left", () =>
    Effect.gen(function* () {
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const gate = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()

      let active = Option.some(key("first"))
      const result = createRoot((dispose) => {
        const controller = makeAgentsController(
          () => Deferred.await(gate),
          () => Effect.never,
          (effect) => {
            cast(effect)
          },
          () => active,
        )
        return { controller, dispose }
      })

      result.controller.refresh("")
      expect(result.controller.loading()).toBe(true)
      active = Option.some(key("second"))

      yield* Deferred.succeed(gate, [row("first")])
      yield* Effect.yieldNow

      // The rows are dropped, but the pane must not draw "loading" forever.
      expect(result.controller.rows()).toEqual([])
      expect(result.controller.loading()).toBe(false)
      result.dispose()
    }).pipe(Effect.timeout("20 seconds")),
  )
})

describe("Thread controller across a session switch", () => {
  it.scopedLive("drops windows fetched for the session the shell just left", () =>
    Effect.gen(function* () {
      const cast = Effect.runForkWith(yield* Effect.context<never>())
      const gate = yield* Deferred.make<ReadonlyArray<Session>>()

      let active = Option.some(key("first"))

      const result = createRoot((dispose) => {
        const controller = makeThreadController(
          () => Deferred.await(gate),
          () => Effect.succeed([]),
          () => Effect.succeed(0),
          (effect) => {
            cast(effect)
          },
          () => active,
        )
        return { controller, dispose }
      })

      result.controller.refresh()
      active = Option.some(key("second"))

      yield* Deferred.succeed(gate, [
        new Session({
          id: SessionId.make("first"),
          name: "First",
          activeBranchId: BranchId.make("first-branch"),
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(1),
        }),
      ])
      yield* Effect.yieldNow

      expect(result.controller.sessions()).toBe(0)
      result.dispose()
    }).pipe(Effect.timeout("20 seconds")),
  )
})
