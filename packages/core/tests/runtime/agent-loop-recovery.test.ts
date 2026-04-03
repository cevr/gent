import { describe, expect, test } from "bun:test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Agents } from "@gent/core/domain/agent"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { Branch, Message, TextPart, ToolResultPart } from "@gent/core/domain/message"
import { defineTool } from "@gent/core/domain/tool"
import { Provider, FinishChunk, TextChunk, type StreamChunk } from "@gent/core/providers/provider"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import {
  buildLoopCheckpointRecord,
  type AgentLoopCheckpointRecord,
} from "@gent/core/runtime/agent/agent-loop.checkpoint"
import {
  appendFollowUpQueueState,
  buildRunningState,
  emptyLoopQueueState,
  type LoopState,
} from "@gent/core/runtime/agent/agent-loop.state"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { EventStoreLive } from "@gent/core/server/event-store"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { CheckpointStorage } from "@gent/core/storage/checkpoint-storage"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"

const systemPrompt = "System prompt"

const idempotentTestTool = defineTool({
  name: "test-idempotent",
  action: "read",
  description: "Test idempotent tool",
  concurrency: "parallel",
  idempotent: true,
  params: Schema.Unknown,
  execute: () => Effect.succeed({ ok: true }),
})

const createSessionState = () => {
  const sessionId = "session-loop-recovery" as SessionId
  const branchId = "branch-loop-recovery" as BranchId
  const message = new Message({
    id: "message-loop-recovery" as MessageId,
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text: "Recover this turn" })],
    createdAt: new Date(),
  })

  return {
    sessionId,
    branchId,
    session: {
      id: sessionId,
      name: "Loop Recovery",
      cwd: process.cwd(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    branch: new Branch({
      id: branchId,
      sessionId,
      createdAt: new Date(),
    }),
    message,
  }
}

const makeRecoveryLayer = (params: {
  dbPath: string
  providerChunks?: ReadonlyArray<StreamChunk>
  providerCalls?: Ref.Ref<number>
}) => {
  const storageLayer = Storage.LiveWithSql(params.dbPath).pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer),
  )
  const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
  const extensionLayer = ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-recovery" },
        kind: "builtin",
        sourcePath: "test",
        setup: {
          agents: Object.values(Agents),
          tools: [idempotentTestTool],
        },
      },
    ]),
  )
  const providerLayer = Layer.succeed(Provider, {
    stream: () =>
      Ref.update(params.providerCalls ?? Ref.makeUnsafe(0), (count) => count + 1).pipe(
        Effect.as(
          Stream.fromIterable(
            params.providerChunks ?? [
              new TextChunk({ text: "recovered assistant" }),
              new FinishChunk({ finishReason: "stop" }),
            ],
          ),
        ),
      ),
    generate: () => Effect.succeed("generated"),
  })
  const toolRunnerLayer = Layer.succeed(ToolRunner, {
    run: (input) =>
      Effect.succeed(
        new ToolResultPart({
          type: "tool-result",
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          output: { type: "json", value: { ok: true } },
        }),
      ),
  })
  const handoffLayer = Layer.succeed(HandoffHandler, {
    present: () => Effect.succeed("confirm" as const),
  })

  const base = Layer.mergeAll(
    storageLayer,
    eventStoreLayer,
    extensionLayer,
    ExtensionStateRuntime.Test(),
    providerLayer,
    toolRunnerLayer,
    handoffLayer,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, base)

  return Layer.mergeAll(
    base,
    eventPublisherLayer,
    Layer.provide(
      AgentLoop.Live({ baseSections: [{ id: "base", content: systemPrompt, priority: 0 }] }),
      Layer.merge(base, eventPublisherLayer),
    ),
  )
}

const waitFor = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  attempts = 50,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep("10 millis")
    }
    throw new Error("timed out waiting for recovery")
  })

const seedCheckpoint = (params: {
  state: LoopState
  checkpointRecord?: AgentLoopCheckpointRecord
}) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const cs = yield* CheckpointStorage
    const { session, branch, message } = createSessionState()

    yield* storage.createSession(session)
    yield* storage.createBranch(branch)
    yield* storage.createMessageIfAbsent(message)

    const record =
      params.checkpointRecord ??
      (yield* buildLoopCheckpointRecord({
        sessionId: session.id,
        branchId: branch.id,
        state: params.state,
      }))
    yield* cs.upsert(record)

    return { session, branch, message }
  })

describe("AgentLoop recovery", () => {
  test("recovers from Running checkpoint and completes the turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-running-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message } = createSessionState()
      const running = buildRunningState(
        { queue: emptyLoopQueueState(), currentAgent: "cowork" },
        { message },
      )

      const providerCalls = Ref.makeUnsafe(0)
      const layer = makeRecoveryLayer({ dbPath, providerCalls })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedCheckpoint({ state: running })
            const agentLoop = yield* AgentLoop

            // getState triggers checkpoint restore → Running task re-runs
            const state = yield* waitFor(
              agentLoop.getState({
                sessionId: running.message.sessionId,
                branchId: running.message.branchId,
              }),
              (s) => s.phase === "idle",
            )

            expect(state.phase).toBe("idle")
            // Provider was called during recovery (turn re-ran)
            expect(yield* Ref.get(providerCalls)).toBeGreaterThanOrEqual(1)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("recovers from Idle with queued follow-up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-idle-queue-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message } = createSessionState()
      const queuedMessage = new Message({
        id: "queued-msg" as MessageId,
        sessionId: message.sessionId,
        branchId: message.branchId,
        role: "user",
        parts: [new TextPart({ type: "text", text: "queued" })],
        createdAt: new Date(),
      })

      const idleWithQueue = {
        _tag: "Idle" as const,
        queue: appendFollowUpQueueState(emptyLoopQueueState(), {
          message: queuedMessage,
        }),
        currentAgent: "cowork" as const,
      } as LoopState

      const providerCalls = Ref.makeUnsafe(0)
      const layer = makeRecoveryLayer({ dbPath, providerCalls })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedCheckpoint({ state: idleWithQueue })
            const agentLoop = yield* AgentLoop

            const state = yield* waitFor(
              agentLoop.getState({
                sessionId: message.sessionId,
                branchId: message.branchId,
              }),
              (s) => s.phase === "idle",
            )

            expect(state.phase).toBe("idle")
            // The queued follow-up triggered a turn
            expect(yield* Ref.get(providerCalls)).toBeGreaterThanOrEqual(1)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("discards incompatible checkpoint version and starts fresh", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-stale-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message } = createSessionState()
      const running = buildRunningState(
        { queue: emptyLoopQueueState(), currentAgent: "cowork" },
        { message },
      )

      // Build a checkpoint with a bogus version
      const record = await Effect.runPromise(
        buildLoopCheckpointRecord({
          sessionId: running.message.sessionId,
          branchId: running.message.branchId,
          state: running,
        }),
      )
      const staleRecord = { ...record, version: 999 }

      const providerCalls = Ref.makeUnsafe(0)
      const layer = makeRecoveryLayer({ dbPath, providerCalls })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedCheckpoint({ state: running, checkpointRecord: staleRecord })
            const agentLoop = yield* AgentLoop

            // Stale checkpoint discarded — loop starts idle, no provider calls
            const state = yield* agentLoop.getState({
              sessionId: running.message.sessionId,
              branchId: running.message.branchId,
            })

            expect(state.phase).toBe("idle")
            expect(yield* Ref.get(providerCalls)).toBe(0)

            // Checkpoint should be cleaned up
            const cs = yield* CheckpointStorage
            const checkpoint = yield* cs.get({
              sessionId: running.message.sessionId,
              branchId: running.message.branchId,
            })
            expect(checkpoint).toBeUndefined()
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
