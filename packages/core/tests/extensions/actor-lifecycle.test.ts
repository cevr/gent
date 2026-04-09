/**
 * Actor lifecycle canary — exercises real extension actors through per-request
 * RPC scopes. This is the test that would have caught the ambient scope bug
 * (actors dying when the RPC request scope closed).
 *
 * Each `client.*` call goes through RpcServer, which allocates a fresh Scope
 * per request and closes it on exit. Pre-fix, actors spawned under that scope
 * died between requests.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import type { LoadedExtension, ReduceResult, RequestResult } from "@gent/core/domain/extension"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import { textStep, createSequenceProvider } from "@gent/core/debug/provider"
import { reducerActor } from "./helpers/reducer-actor"
import { createRpcHarness } from "./helpers/rpc-harness"

// ============================================================================
// Counter extension — stateful actor with request support + protocol
// ============================================================================

const EXTENSION_ID = "lifecycle-counter"

interface CounterState {
  readonly count: number
}

const CounterReply = Schema.Struct({ count: Schema.Number })

const CounterProtocol = {
  Increment: ExtensionMessage.reply(
    EXTENSION_ID,
    "Increment",
    { delta: Schema.Number },
    CounterReply,
  ),
  GetCount: ExtensionMessage.reply(EXTENSION_ID, "GetCount", {}, CounterReply),
}

type CounterRequest =
  | ReturnType<typeof CounterProtocol.Increment>
  | ReturnType<typeof CounterProtocol.GetCount>

const counterActor = reducerActor<CounterState, never, CounterRequest>({
  id: EXTENSION_ID,
  initial: { count: 0 },
  stateSchema: Schema.Struct({ count: Schema.Number }),
  reduce: (state, event): ReduceResult<CounterState> =>
    event._tag === "TurnCompleted" ? { state: { count: state.count + 100 } } : { state },
  request: (state, message): Effect.Effect<RequestResult<CounterState, unknown>> => {
    if (message._tag === "Increment") {
      const m = message as CounterRequest & { _tag: "Increment"; delta: number }
      const next = { count: state.count + m.delta }
      return Effect.succeed({ state: next, reply: next })
    }
    return Effect.succeed({ state, reply: { count: state.count } })
  },
  derive: (state) => ({ uiModel: state }),
})

// Attach protocol definitions so ExtensionStateRuntime validates ask() calls
const counterActorWithProtocol = { ...counterActor, protocols: CounterProtocol }

const counterExtension: LoadedExtension = {
  manifest: { id: EXTENSION_ID },
  kind: "builtin",
  sourcePath: "builtin",
  setup: { actor: counterActorWithProtocol },
}

// ============================================================================
// Tests
// ============================================================================

describe("Actor lifecycle across RPC boundaries", () => {
  it.live(
    "actor survives RPC request boundaries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [counterExtension],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          // First RPC call — spawns actor under request scope
          const r1 = yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.Increment({ delta: 1 }),
          })
          expect(r1).toEqual({ count: 1 })

          // Second RPC call — first request scope has closed.
          // Pre-fix: actor is dead. Post-fix: actor is alive.
          const r2 = yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.GetCount(),
          })
          expect(r2).toEqual({ count: 1 })
        }),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "actor state accumulates across requests",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [counterExtension],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.Increment({ delta: 3 }),
          })

          yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.Increment({ delta: 7 }),
          })

          const r = yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.GetCount(),
          })
          expect(r).toEqual({ count: 10 })
        }),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "actor survives event publishing from message.send",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([
            textStep("session reply"),
            textStep("message reply"),
          ])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [counterExtension],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          // Increment via ask to establish baseline
          yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.Increment({ delta: 1 }),
          })

          // message.send triggers agent loop → events → actor.publish
          // The agent loop runs asynchronously; we don't wait for TurnCompleted.
          // The key assertion: actor survives the event publishing path.
          yield* client.message.send({ sessionId, branchId, content: "hello" })

          // Actor must still be alive and respond after message.send's
          // event publishing ran through ExtensionStateRuntime.publish
          const r = yield* client.extension.ask({
            sessionId,
            branchId,
            message: CounterProtocol.GetCount(),
          })
          // Count is at least 1 from the Increment; may be higher if TurnCompleted
          // published before this ask. The assertion proves liveness, not exact timing.
          expect((r as { count: number }).count).toBeGreaterThanOrEqual(1)
        }),
      ),
    { timeout: 15_000 },
  )
})
