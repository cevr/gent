/**
 * BusEmit dispatch — locks the seam between an actor's `BusEmit` effect
 * and the host pub/sub engine.
 *
 * Pre-C3.6 this lived against `ExtensionEventBus`; C3.6 unifies onto
 * `SubscriptionEngine` (the engine inside `resource-host/`). The
 * `interpretEffects` wiring takes a `busEmit` callback — this test
 * proves the callback delivers to a `SubscriptionEngine` listener.
 *
 * Wildcard / exact / unsubscribe / error-isolation / withSubscriptions
 * coverage lives in `resource-host.test.ts`'s `SubscriptionEngine`
 * describe block.
 */

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { SubscriptionEngine } from "@gent/core/runtime/extensions/resource-host"
import { interpretEffects } from "@gent/core/runtime/extensions/extension-actor-shared"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import type { ExtensionEffect } from "../../src/domain/extension.js"
import type { ResourceBusEnvelope } from "@gent/core/domain/resource"
import { SessionId, BranchId } from "@gent/core/domain/ids"

describe("BusEmit dispatch", () => {
  test("BusEmit effect flows through interpretEffects to a SubscriptionEngine listener", async () => {
    const received: ResourceBusEnvelope[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* SubscriptionEngine
        const turnControl = yield* ExtensionTurnControl

        yield* bus.on("ext:test-emit", (env) => {
          received.push(env)
          return Effect.void
        })

        const effects: ReadonlyArray<ExtensionEffect> = [
          { _tag: "BusEmit", channel: "ext:test-emit", payload: { from: "hook" } },
        ]

        yield* interpretEffects(effects, SessionId.of("s1"), BranchId.of("b1"), {
          turnControl,
          busEmit: (channel, payload) =>
            bus.emit({
              channel,
              payload,
              sessionId: SessionId.of("s1"),
              branchId: BranchId.of("b1"),
            }),
        })
      }).pipe(Effect.provide(SubscriptionEngine.Live), Effect.provide(ExtensionTurnControl.Test())),
    )

    expect(received.length).toBe(1)
    expect(received[0]!.channel).toBe("ext:test-emit")
    expect(received[0]!.payload).toEqual({ from: "hook" })
    expect(received[0]!.sessionId).toBe("s1")
    expect(received[0]!.branchId).toBe("b1")
  })
})
