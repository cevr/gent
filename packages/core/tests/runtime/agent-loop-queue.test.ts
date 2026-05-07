import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  type LanguageModelStreamPart,
} from "@gent/core/test-utils/language-model"
import { dateFromMillis, Message } from "@gent/core/domain/message"
import { EventStore } from "@gent/core/domain/event"
import { EventPublisherLive } from "@gent/core/domain/event-publisher"
import { SqliteStorage } from "@gent/core/storage/sqlite-storage"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { AgentLoopTestActor } from "../../src/runtime/agent/agent-loop.actor"
import { AgentLoopBehaviorDeps } from "../../src/runtime/agent/agent-loop.behavior-deps"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent/agent-loop.session-governance"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { ConfigService } from "../../src/runtime/config-service"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ModelResolver } from "@gent/core/providers/model-resolver"
import {
  makeAgentLoopService,
  makeExtRegistry,
  submitAgentLoop,
  waitForPhase,
} from "./agent-loop/helpers"

describe("queue drain regression", () => {
  it.live(
    "multiple submits during a Running turn drain in submission order after TurnDone",
    () =>
      Effect.gen(function* () {
        const drainSessionId = SessionId.make("session-loop-drain")
        const drainBranchId = BranchId.make("branch-loop-drain")
        // Provider gates each turn on a per-turn Deferred so the test can
        // serialize "submit while Running" semantics deterministically.
        // First model stream call is gated by gates[0], second by gates[1], etc.
        // Each call records its index into `streamOrder` and returns a
        // simple text+stop response when its gate resolves.
        const gates = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const streamOrder = yield* Ref.make<readonly number[]>([])
        const streamCallRef = yield* Ref.make(0)
        const gatedProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const idx = yield* Ref.getAndUpdate(streamCallRef, (n) => n + 1)
            yield* Ref.update(streamOrder, (arr) => [...arr, idx])
            const gate = gates[idx]
            if (gate !== undefined) {
              yield* Deferred.await(gate)
            }
            return Stream.fromIterable([
              textDeltaPart(`turn-${idx}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(),
          gatedProvider,
          ModelResolver.fromLanguageModel(gatedProvider),
          makeExtRegistry(),
          RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          BunServices.layer,
          ResourceManagerLive,
          ModelRegistry.Test(),
          GentPlatform.Test(),
        )
        const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
        const layer = AgentLoopTestActor.pipe(
          Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] })),
          Layer.provideMerge(
            Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            // `interactive: true` disables follow-up batching in
            // `canBatchQueuedFollowUp` — without it, multiple plain-text
            // user submits collapse into a single combined turn before
            // they ever hit the queue drain.
            const submitOne = (id: string, text: string) =>
              submitAgentLoop(
                agentLoop,
                Message.Regular.make({
                  id: MessageId.make(id),
                  sessionId: drainSessionId,
                  branchId: drainBranchId,
                  role: "user",
                  parts: [Prompt.textPart({ text })],
                  createdAt: dateFromMillis(1_767_225_600_000),
                }),
                { interactive: true },
              )
            // Submit turn #0; wait until the provider's model stream has
            // actually been entered (parked on gate[0]). Phase transitions
            // to Running before model streaming starts, so we poll on
            // streamCallRef instead.
            yield* submitOne("msg-drain-0", "first")
            for (let i = 0; i < 200; i++) {
              if ((yield* Ref.get(streamCallRef)) >= 1) break
              yield* Effect.sleep("1 millis")
            }
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Submit #1, #2, #3 while #0 is still parked. They MUST
            // enqueue (Running → Running re-enter) — they cannot start
            // a new model stream until #0's gate releases.
            yield* submitOne("msg-drain-1", "second")
            yield* submitOne("msg-drain-2", "third")
            yield* submitOne("msg-drain-3", "fourth")
            // Confirm model streaming was not re-entered.
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Release all gates. Drain proceeds: #0 → #1 → #2 → #3.
            yield* Deferred.succeed(gates[0]!, void 0)
            yield* Deferred.succeed(gates[1]!, void 0)
            yield* Deferred.succeed(gates[2]!, void 0)
            yield* Deferred.succeed(gates[3]!, void 0)
            // Wait for full drain: stream call count must reach 4 and
            // loop returns to Idle.
            yield* waitForPhase(
              agentLoop,
              { sessionId: drainSessionId, branchId: drainBranchId },
              "Idle",
            )
            const finalCount = yield* Ref.get(streamCallRef)
            expect(finalCount).toBe(4)
            const order = yield* Ref.get(streamOrder)
            expect(order).toEqual([0, 1, 2, 3])
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )
})
