/**
 * W9-1 — domain/actor.ts surface tests.
 *
 * Type-level: ServiceKey<M> infers M end-to-end through tell/ask/find;
 *             ActorAskTimeout is a Schema.TaggedErrorClass with the
 *             expected fields.
 * Value-level: ServiceKey factory yields equal-named keys; encode/decode
 *              roundtrip ActorAskTimeout.
 */
import { describe, expect, test } from "bun:test"
import { Schema, Effect, type Stream } from "effect"
import {
  ActorAskTimeout,
  ServiceKey,
  type ActorContext,
  type ActorRef,
  type Behavior,
} from "@gent/core/domain/actor"
import { ActorId } from "@gent/core/domain/ids"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

type Ping = { readonly tag: "Ping" } | { readonly tag: "Pong" }

const PingMsg = TaggedEnumClass("PingMsg", {
  Ping: {},
  Pong: {},
  GetCount: TaggedEnumClass.askVariant<number>()({}),
})
type PingMsg = Schema.Schema.Type<typeof PingMsg>

describe("ServiceKey", () => {
  test("factory builds a key with the supplied name", () => {
    const key = ServiceKey<Ping>("ping-service")
    expect(key._tag).toBe("ServiceKey")
    expect(key.name).toBe("ping-service")
  })

  test("two keys with the same name are equal by structure", () => {
    const a = ServiceKey<Ping>("ping-service")
    const b = ServiceKey<Ping>("ping-service")
    expect(a.name).toBe(b.name)
  })
})

describe("ActorAskTimeout", () => {
  test("constructs with actorId + askMs and exposes _tag", () => {
    const id = Schema.decodeUnknownSync(ActorId)("actor-1")
    const err = new ActorAskTimeout({ actorId: id, askMs: 500 })
    expect(err._tag).toBe("ActorAskTimeout")
    expect(err.askMs).toBe(500)
    expect(err.actorId).toBe(id)
  })

  test("roundtrips through Schema encode/decode", () => {
    const id = Schema.decodeUnknownSync(ActorId)("actor-2")
    const err = new ActorAskTimeout({ actorId: id, askMs: 250 })
    const encoded = Schema.encodeSync(ActorAskTimeout)(err)
    const decoded = Schema.decodeUnknownSync(ActorAskTimeout)(encoded)
    expect(decoded.actorId).toBe(id)
    expect(decoded.askMs).toBe(250)
    expect(decoded._tag).toBe("ActorAskTimeout")
  })
})

describe("type-level — ActorContext threads M end-to-end", () => {
  test("Behavior compiles with a ServiceKey<M>; tell/ask/find/subscribe respect M", () => {
    type State = { readonly count: number }

    const PingKey = ServiceKey<Ping>("ping")

    const behavior: Behavior<Ping, State, never> = {
      initialState: { count: 0 },
      serviceKey: PingKey,
      receive: (msg, state, ctx) =>
        Effect.gen(function* () {
          // ctx.tell only accepts ActorRef<Ping> + Ping payload.
          if (msg.tag === "Ping") yield* ctx.tell(ctx.self, { tag: "Pong" })
          // ctx.find returns ActorRef<Ping>[].
          const peers: ReadonlyArray<ActorRef<Ping>> = yield* ctx.find(PingKey)
          // ctx.subscribe yields ref-set snapshots.
          const stream: Stream.Stream<ReadonlyArray<ActorRef<Ping>>> = ctx.subscribe(PingKey)
          void peers
          void stream
          return { count: state.count + 1 }
        }),
    }

    expect(behavior.initialState.count).toBe(0)
    expect(behavior.serviceKey?.name).toBe("ping")
  })

  test("ctx.ask infers reply type from the AskBranded variant", () => {
    // Compile-time check: askVariant<R>()(fields) brands the variant; ctx.ask
    // pulls R off the message type without a replyKey lambda. Body never
    // executes — it's the inference pin.
    const _stub = (ctx: ActorContext<PingMsg>, target: ActorRef<PingMsg>) => {
      const reply: Effect.Effect<number, ActorAskTimeout> = ctx.ask(
        target,
        PingMsg.GetCount.make({}),
      )
      return reply
    }
    void _stub
    expect(true).toBe(true)
  })

  test("ActorRef carries S; subscribeState is Stream<S> for spawn-typed refs", () => {
    // Compile-time pin: a ref whose phantom S is fixed yields a typed
    // subscribeState stream — the consumer reads `.count` without a
    // cast. A ref with the default `S = unknown` (e.g. one returned
    // by Receptionist discovery) yields `Stream<unknown>` and the
    // caller narrows at the consumption seam. Body never executes.
    type State = { readonly count: number }
    const _typedStub = (ctx: ActorContext<Ping>, typed: ActorRef<Ping, State>) => {
      const s: Stream.Stream<State> = ctx.subscribeState(typed)
      return s
    }
    const _erasedStub = (ctx: ActorContext<Ping>, erased: ActorRef<Ping>) => {
      const s: Stream.Stream<unknown> = ctx.subscribeState(erased)
      return s
    }
    void _typedStub
    void _erasedStub
    expect(true).toBe(true)
  })
})
