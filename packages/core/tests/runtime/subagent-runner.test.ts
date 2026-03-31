import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { InProcessRunner } from "@gent/core/runtime/agent/subagent-runner"
import { Session, Branch } from "@gent/core/domain/message"
import {
  Agents,
  resolveAgentModel,
  SubagentRunnerService,
  SubagentError,
} from "@gent/core/domain/agent"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import type { ModelId } from "@gent/core/domain/model"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/core/test-utils"
import { AgentActor } from "@gent/core/runtime/agent/agent-loop"

describe("AgentExecutionOverrides", () => {
  test("resolveDualModelPair returns cowork/deepwork models from registry", () => {
    const registry = resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents) },
      },
    ])
    const impl = ExtensionRegistry.fromResolved(registry)
    return Effect.gen(function* () {
      const reg = yield* ExtensionRegistry
      const [a, b] = yield* reg.resolveDualModelPair()
      expect(a).toBe(resolveAgentModel(Agents.cowork))
      expect(b).toBe(resolveAgentModel(Agents.deepwork))
      expect(a).not.toBe(b)
    }).pipe(Effect.provide(impl), Effect.runPromise)
  })

  test("overrides thread through SubagentRunner to AgentActor", async () => {
    let capturedInput: Record<string, unknown> | undefined
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      Layer.succeed(AgentActor, {
        run: (input) => {
          capturedInput = input as unknown as Record<string, unknown>
          return Effect.void
        },
      }),

      recorderLayer,
      eventStoreLayer,
    )
    const runnerLayer = InProcessRunner({ systemPrompt: "test" }).pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService

        const now = new Date()
        yield* storage.createSession(
          new Session({ id: "s1", name: "S", bypass: true, createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(new Branch({ id: "b1", sessionId: "s1", createdAt: now }))

        yield* runner.run({
          agent: Agents.explore,
          prompt: "test",
          parentSessionId: "s1" as SessionId,
          parentBranchId: "b1" as BranchId,
          cwd: "/tmp",
          overrides: {
            modelId: "custom/model" as ModelId,
            allowedActions: ["read", "edit"],
            allowedTools: ["bash", "grep"],
            reasoningEffort: "high",
            systemPromptAddendum: "Extra instructions",
          },
        })

        expect(capturedInput).toBeDefined()
        expect(capturedInput!.modelId).toBe("custom/model")
        expect(capturedInput!.overrideAllowedActions).toEqual(["read", "edit"])
        expect(capturedInput!.overrideAllowedTools).toEqual(["bash", "grep"])
        expect(capturedInput!.overrideReasoningEffort).toBe("high")
        expect(capturedInput!.overrideSystemPromptAddendum).toBe("Extra instructions")
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("Subagent Runner", () => {
  test("publishes spawn and complete events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      Layer.succeed(AgentActor, {
        run: () => Effect.void,
      }),

      recorderLayer,
      eventStoreLayer,
    )
    const runnerLayer = InProcessRunner({ systemPrompt: "" }).pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService
        const recorder = yield* SequenceRecorder

        const now = new Date()
        const session = new Session({
          id: "parent-session",
          name: "Parent",
          bypass: true,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* runner.run({
          agent: Agents.explore,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })

        const calls = yield* recorder.getCalls()
        assertSequence(calls, [
          { service: "EventStore", method: "publish", match: { _tag: "SubagentSpawned" } },
          { service: "EventStore", method: "publish", match: { _tag: "SubagentSucceeded" } },
        ])
      }).pipe(Effect.provide(layer)),
    )
  })

  test("propagates failures without retry (no maxAttempts)", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      Layer.succeed(AgentActor, {
        run: () => Effect.fail(new SubagentError({ message: "permanent failure" })),
      }),

      recorderLayer,
      eventStoreLayer,
    )
    const runnerLayer = InProcessRunner({ systemPrompt: "" }).pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-noretr",
          name: "Parent",
          bypass: true,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-noretr",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        const result = yield* runner.run({
          agent: Agents.explore,
          prompt: "fail test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })

        // Without retry, failure propagates as error result
        expect(result._tag).toBe("error")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("fails with timeout", async () => {
    const deps = Layer.mergeAll(
      Storage.Test(),
      Layer.succeed(AgentActor, {
        run: () => Effect.sleep("50 millis"),
      }),
      EventStore.Test(),
    )
    const runnerLayer = InProcessRunner({ systemPrompt: "", timeoutMs: 5 }).pipe(
      Layer.provide(deps),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-timeout",
          name: "Parent",
          bypass: true,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-timeout",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        return yield* runner.run({
          agent: Agents.explore,
          prompt: "timeout test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("error")
    expect(result.error).toContain("timed out")
  })
})
