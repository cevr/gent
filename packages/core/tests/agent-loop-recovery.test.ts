import { describe, expect, test } from "bun:test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Agents, resolveAgentModel } from "@gent/core/domain/agent"
import type { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { Branch, Message, TextPart, ToolCallPart, ToolResultPart } from "@gent/core/domain/message"
import { defineTool } from "@gent/core/domain/tool"
import { Provider, FinishChunk, TextChunk, type StreamChunk } from "@gent/core/providers/provider"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import {
  buildLoopCheckpointRecord,
  type AgentLoopCheckpointRecord,
} from "@gent/core/runtime/agent/agent-loop.checkpoint"
import {
  appendFollowUpQueueState,
  buildResolvingState,
  emptyLoopQueueState,
  toExecutingToolsState,
  toFinalizingState,
  toStreamingState,
  type LoopState,
} from "@gent/core/runtime/agent/agent-loop.state"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "@gent/core/runtime/agent/agent-loop.utils"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { EventStoreLive } from "@gent/core/server/event-store"
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

const nonIdempotentTestTool = defineTool({
  name: "test-non-idempotent",
  action: "exec",
  description: "Test non-idempotent tool",
  concurrency: "serial",
  params: Schema.Unknown,
  execute: () => Effect.succeed({ ok: true }),
})

const toolCall = new ToolCallPart({
  type: "tool-call",
  toolCallId: "tool-call-1" as ToolCallId,
  toolName: idempotentTestTool.name,
  input: { path: "/tmp/test" },
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
      bypass: true,
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

const makeResolvedTurn = (message: Message) => ({
  currentTurnAgent: "cowork" as const,
  messages: [message],
  systemPrompt,
  modelId: resolveAgentModel(Agents.cowork),
  ...(Agents.cowork.reasoningEffort !== undefined
    ? { reasoning: Agents.cowork.reasoningEffort }
    : {}),
  ...(Agents.cowork.temperature !== undefined ? { temperature: Agents.cowork.temperature } : {}),
})

const makeRecoveryLayer = (params: {
  dbPath: string
  providerChunks?: ReadonlyArray<StreamChunk>
  providerCalls?: Ref.Ref<number>
  toolRunnerCalls?: Ref.Ref<number>
  tools?: ReadonlyArray<typeof idempotentTestTool | typeof nonIdempotentTestTool>
}) => {
  const storageLayer = Storage.LiveWithSql(params.dbPath).pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer),
  )
  const checkpointStorageLayer = Layer.provide(CheckpointStorage.Live, storageLayer)
  const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
  const extensionLayer = ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-recovery" },
        kind: "builtin",
        sourcePath: "test",
        setup: {
          agents: Object.values(Agents),
          tools: params.tools ?? [idempotentTestTool],
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
      Ref.update(params.toolRunnerCalls ?? Ref.makeUnsafe(0), (count) => count + 1).pipe(
        Effect.as(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            output: { type: "json", value: { ok: true } },
          }),
        ),
      ),
  })
  const handoffLayer = Layer.succeed(HandoffHandler, {
    present: () => Effect.succeed("confirm" as const),
  })

  const base = Layer.mergeAll(
    storageLayer,
    checkpointStorageLayer,
    eventStoreLayer,
    extensionLayer,
    ExtensionStateRuntime.Test(),
    providerLayer,
    toolRunnerLayer,
    handoffLayer,
  )

  return Layer.mergeAll(
    base,
    Layer.provide(
      AgentLoop.Live({ baseSections: [{ id: "base", content: systemPrompt, priority: 0 }] }),
      base,
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
    yield* storage.upsertAgentLoopCheckpoint(record)

    return { session, branch, message }
  })

describe("AgentLoop recovery", () => {
  test("resolves a restoring turn from a resolving checkpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-resolving-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message, session, branch } = createSessionState()
      const resolving = buildResolvingState(
        {
          queue: emptyLoopQueueState(),
          currentAgent: "cowork",
        },
        { message, bypass: true },
      )

      await Effect.runPromise(
        seedCheckpoint({ state: resolving }).pipe(Effect.provide(makeRecoveryLayer({ dbPath }))),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          yield* agentLoop.isRunning({ sessionId: session.id, branchId: branch.id })

          const assistantMessage = yield* waitFor(
            storage.getMessage(assistantMessageIdForTurn(message.id)),
            (value) => value !== undefined,
          )
          const recoveryTag = yield* waitFor(
            storage.getLatestEventTag({
              sessionId: session.id,
              branchId: branch.id,
              tags: ["TurnRecoveryApplied"],
            }),
            (value) => value === "TurnRecoveryApplied",
          )
          const checkpoint = yield* waitFor(
            storage.getAgentLoopCheckpoint({
              sessionId: session.id,
              branchId: branch.id,
            }),
            (value) => value === undefined,
          )

          expect(assistantMessage?.parts.some((part) => part.type === "text")).toBe(true)
          expect(recoveryTag).toBe("TurnRecoveryApplied")
          expect(checkpoint).toBeUndefined()
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath }))),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips provider replay when streaming checkpoint already persisted the assistant turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-streaming-"))
    const dbPath = path.join(dir, "data.db")
    const providerCalls = Ref.makeUnsafe(0)

    try {
      const { session, branch, message } = createSessionState()
      const resolving = buildResolvingState(
        {
          queue: emptyLoopQueueState(),
          currentAgent: "cowork",
        },
        { message, bypass: true },
      )
      const streaming = toStreamingState({
        state: resolving,
        resolved: makeResolvedTurn(message),
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          yield* seedCheckpoint({ state: streaming })
          yield* storage.createMessageIfAbsent(
            new Message({
              id: assistantMessageIdForTurn(message.id),
              sessionId: session.id,
              branchId: branch.id,
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "already persisted" })],
              createdAt: new Date(),
            }),
          )
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath, providerCalls }))),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          yield* agentLoop.getQueue({ sessionId: session.id, branchId: branch.id })

          const checkpoint = yield* waitFor(
            storage.getAgentLoopCheckpoint({ sessionId: session.id, branchId: branch.id }),
            (value) => value === undefined,
          )
          const recoveryTag = yield* waitFor(
            storage.getLatestEventTag({
              sessionId: session.id,
              branchId: branch.id,
              tags: ["TurnRecoveryApplied"],
            }),
            (value) => value === "TurnRecoveryApplied",
          )
          const providerCount = yield* Ref.get(providerCalls)

          expect(checkpoint).toBeUndefined()
          expect(recoveryTag).toBe("TurnRecoveryApplied")
          expect(providerCount).toBe(0)
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath, providerCalls }))),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips tool rerun when executing-tools checkpoint already persisted tool results", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-tools-"))
    const dbPath = path.join(dir, "data.db")
    const toolRunnerCalls = Ref.makeUnsafe(0)

    try {
      const { session, branch, message } = createSessionState()
      const resolving = buildResolvingState(
        {
          queue: emptyLoopQueueState(),
          currentAgent: "cowork",
        },
        { message, bypass: true },
      )
      const streaming = toStreamingState({
        state: resolving,
        resolved: makeResolvedTurn(message),
      })
      const executing = toExecutingToolsState({
        state: streaming,
        currentTurnAgent: "cowork",
        draft: {
          text: "",
          reasoning: "",
          toolCalls: [toolCall],
        },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          yield* seedCheckpoint({ state: executing })
          yield* storage.createMessageIfAbsent(
            new Message({
              id: toolResultMessageIdForTurn(message.id),
              sessionId: session.id,
              branchId: branch.id,
              role: "tool",
              parts: [
                new ToolResultPart({
                  type: "tool-result",
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  output: { type: "json", value: { ok: true } },
                }),
              ],
              createdAt: new Date(),
            }),
          )
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath, toolRunnerCalls }))),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          yield* agentLoop.isRunning({ sessionId: session.id, branchId: branch.id })

          const checkpoint = yield* waitFor(
            storage.getAgentLoopCheckpoint({ sessionId: session.id, branchId: branch.id }),
            (value) => value === undefined,
          )
          const callCount = yield* Ref.get(toolRunnerCalls)

          expect(checkpoint).toBeUndefined()
          expect(callCount).toBe(0)
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath, toolRunnerCalls }))),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("aborts non-idempotent tool replay and continues draining the queued turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-non-idempotent-"))
    const dbPath = path.join(dir, "data.db")
    const toolRunnerCalls = Ref.makeUnsafe(0)

    try {
      const { session, branch, message } = createSessionState()
      const followUpMessage = new Message({
        id: "message-loop-follow-up" as MessageId,
        sessionId: session.id,
        branchId: branch.id,
        role: "user",
        parts: [new TextPart({ type: "text", text: "queued follow-up" })],
        createdAt: new Date(),
      })
      const resolving = buildResolvingState(
        {
          queue: appendFollowUpQueueState(emptyLoopQueueState(), {
            message: followUpMessage,
            bypass: true,
          }),
          currentAgent: "cowork",
        },
        { message, bypass: true },
      )
      const streaming = toStreamingState({
        state: resolving,
        resolved: makeResolvedTurn(message),
      })
      const executing = toExecutingToolsState({
        state: streaming,
        currentTurnAgent: "cowork",
        draft: {
          text: "",
          reasoning: "",
          toolCalls: [
            new ToolCallPart({
              type: "tool-call",
              toolCallId: "tool-call-2" as ToolCallId,
              toolName: nonIdempotentTestTool.name,
              input: { cmd: "mutate" },
            }),
          ],
        },
      })

      await Effect.runPromise(
        seedCheckpoint({ state: executing }).pipe(
          Effect.provide(
            makeRecoveryLayer({
              dbPath,
              toolRunnerCalls,
              tools: [idempotentTestTool, nonIdempotentTestTool],
            }),
          ),
        ),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          yield* agentLoop.isRunning({ sessionId: session.id, branchId: branch.id })

          const recoveryTag = yield* waitFor(
            storage.getLatestEventTag({
              sessionId: session.id,
              branchId: branch.id,
              tags: ["TurnRecoveryApplied"],
            }),
            (value) => value === "TurnRecoveryApplied",
          )
          const followUpAssistant = yield* waitFor(
            storage.getMessage(assistantMessageIdForTurn(followUpMessage.id)),
            (value) => value !== undefined,
          )
          const callCount = yield* Ref.get(toolRunnerCalls)

          expect(recoveryTag).toBe("TurnRecoveryApplied")
          expect(followUpAssistant?.parts.some((part) => part.type === "text")).toBe(true)
          expect(callCount).toBe(0)
        }).pipe(
          Effect.provide(
            makeRecoveryLayer({
              dbPath,
              toolRunnerCalls,
              tools: [idempotentTestTool, nonIdempotentTestTool],
            }),
          ),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("replays finalizing checkpoint to completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-finalizing-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { session, branch, message } = createSessionState()
      const resolving = buildResolvingState(
        {
          queue: emptyLoopQueueState(),
          currentAgent: "cowork",
        },
        { message, bypass: true },
      )
      const streaming = toStreamingState({
        state: resolving,
        resolved: makeResolvedTurn(message),
      })
      const finalizing = toFinalizingState({
        state: streaming,
        currentTurnAgent: "cowork",
        streamFailed: false,
        turnInterrupted: false,
      })

      await Effect.runPromise(
        seedCheckpoint({ state: finalizing }).pipe(Effect.provide(makeRecoveryLayer({ dbPath }))),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          yield* agentLoop.getQueue({ sessionId: session.id, branchId: branch.id })

          const latestTag = yield* waitFor(
            storage.getLatestEventTag({
              sessionId: session.id,
              branchId: branch.id,
              tags: ["TurnCompleted"],
            }),
            (value) => value === "TurnCompleted",
          )
          const checkpoint = yield* waitFor(
            storage.getAgentLoopCheckpoint({
              sessionId: session.id,
              branchId: branch.id,
            }),
            (value) => value === undefined,
          )

          expect(latestTag).toBe("TurnCompleted")
          expect(checkpoint).toBeUndefined()
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath }))),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("startup checkpoint wake: isRunning triggers restore for all checkpointed sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-wake-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { session, branch, message } = createSessionState()
      const resolving = buildResolvingState(
        {
          queue: emptyLoopQueueState(),
          currentAgent: "cowork",
        },
        { message, bypass: true },
      )

      // Seed checkpoint
      await Effect.runPromise(
        seedCheckpoint({ state: resolving }).pipe(Effect.provide(makeRecoveryLayer({ dbPath }))),
      )

      // Simulate startup wake: list checkpoints → isRunning for each
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const agentLoop = yield* AgentLoop

          // Verify checkpoint exists
          const checkpoints = yield* storage.listAgentLoopCheckpoints()
          expect(checkpoints.length).toBe(1)
          expect(checkpoints[0]!.sessionId).toBe(session.id)

          // Wake via isRunning (same as startup sweep in dependencies.ts)
          yield* agentLoop.isRunning({ sessionId: session.id, branchId: branch.id })

          // Wait for turn to complete
          const completed = yield* waitFor(
            storage.getLatestEventTag({
              sessionId: session.id,
              branchId: branch.id,
              tags: ["TurnCompleted"],
            }),
            (value) => value === "TurnCompleted",
          )
          expect(completed).toBe("TurnCompleted")

          // Checkpoint should be cleaned up after idle
          const remaining = yield* waitFor(
            storage.getAgentLoopCheckpoint({
              sessionId: session.id,
              branchId: branch.id,
            }),
            (value) => value === undefined,
          )
          expect(remaining).toBeUndefined()
        }).pipe(Effect.provide(makeRecoveryLayer({ dbPath }))),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
