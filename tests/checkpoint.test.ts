import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Storage } from "@gent/storage"
import {
  Session,
  Branch,
  Message,
  TextPart,
  CompactionCheckpoint,
  PlanCheckpoint,
  EventBus,
  PlanConfirmed,
} from "@gent/core"
import { CheckpointService, estimateTokens } from "@gent/runtime"
import { SequenceRecorder, createRecordingTestLayer, assertSequence } from "@gent/test-utils"
import { Provider } from "@gent/providers"

const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
  Effect.runPromise(Effect.provide(effect, Storage.Test()))

describe("Checkpoints", () => {
  describe("Storage - Checkpoint CRUD", () => {
    test("creates and retrieves CompactionCheckpoint", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "cp-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "cp-branch",
              sessionId: "cp-session",
              createdAt: new Date(),
            }),
          )

          const checkpoint = new CompactionCheckpoint({
            id: "cp-1",
            branchId: "cp-branch",
            summary: "User discussed authentication. Decision: use JWT.",
            firstKeptMessageId: "msg-10",
            messageCount: 20,
            tokenCount: 50000,
            createdAt: new Date(),
          })

          yield* storage.createCheckpoint(checkpoint)
          const retrieved = yield* storage.getLatestCheckpoint("cp-branch")

          expect(retrieved).toBeDefined()
          expect(retrieved?._tag).toBe("CompactionCheckpoint")
          expect((retrieved as CompactionCheckpoint).summary).toBe(
            "User discussed authentication. Decision: use JWT.",
          )
          expect((retrieved as CompactionCheckpoint).firstKeptMessageId).toBe("msg-10")
          expect(retrieved?.messageCount).toBe(20)
          expect(retrieved?.tokenCount).toBe(50000)
        }),
      )
    })

    test("creates and retrieves PlanCheckpoint", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "plan-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "plan-branch",
              sessionId: "plan-session",
              createdAt: new Date(),
            }),
          )

          const checkpoint = new PlanCheckpoint({
            id: "plan-cp-1",
            branchId: "plan-branch",
            planPath: "/Users/test/project/plan.md",
            messageCount: 15,
            tokenCount: 30000,
            createdAt: new Date(),
          })

          yield* storage.createCheckpoint(checkpoint)
          const retrieved = yield* storage.getLatestCheckpoint("plan-branch")

          expect(retrieved).toBeDefined()
          expect(retrieved?._tag).toBe("PlanCheckpoint")
          expect((retrieved as PlanCheckpoint).planPath).toBe("/Users/test/project/plan.md")
          expect(retrieved?.messageCount).toBe(15)
        }),
      )
    })

    test("getLatestCheckpoint returns most recent", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "multi-cp-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "multi-cp-branch",
              sessionId: "multi-cp-session",
              createdAt: new Date(),
            }),
          )

          // Create older checkpoint
          yield* storage.createCheckpoint(
            new CompactionCheckpoint({
              id: "old-cp",
              branchId: "multi-cp-branch",
              summary: "Old summary",
              firstKeptMessageId: "msg-5",
              messageCount: 10,
              tokenCount: 20000,
              createdAt: new Date(Date.now() - 10000),
            }),
          )

          // Create newer checkpoint
          yield* storage.createCheckpoint(
            new PlanCheckpoint({
              id: "new-cp",
              branchId: "multi-cp-branch",
              planPath: "/plan.md",
              messageCount: 25,
              tokenCount: 60000,
              createdAt: new Date(),
            }),
          )

          const retrieved = yield* storage.getLatestCheckpoint("multi-cp-branch")

          expect(retrieved?._tag).toBe("PlanCheckpoint")
          expect(retrieved?.id).toBe("new-cp")
        }),
      )
    })

    test("getLatestCheckpoint returns undefined for branch without checkpoints", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const retrieved = yield* storage.getLatestCheckpoint("nonexistent-branch")
          expect(retrieved).toBeUndefined()
        }),
      )
    })

    test("CompactionCheckpoint with empty summary is valid", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "empty-sum-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "empty-sum-branch",
              sessionId: "empty-sum-session",
              createdAt: new Date(),
            }),
          )

          const checkpoint = new CompactionCheckpoint({
            id: "empty-cp",
            branchId: "empty-sum-branch",
            summary: "", // Empty is valid (no messages to summarize)
            firstKeptMessageId: "msg-1",
            messageCount: 5,
            tokenCount: 1000,
            createdAt: new Date(),
          })

          yield* storage.createCheckpoint(checkpoint)
          const retrieved = yield* storage.getLatestCheckpoint("empty-sum-branch")

          expect(retrieved?._tag).toBe("CompactionCheckpoint")
          expect((retrieved as CompactionCheckpoint).summary).toBe("")
        }),
      )
    })
  })

  describe("Storage - listMessagesAfter", () => {
    test("returns messages after specified message", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "after-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "after-branch",
              sessionId: "after-session",
              createdAt: new Date(),
            }),
          )

          const baseTime = Date.now()

          // Create messages with incrementing timestamps
          yield* storage.createMessage(
            new Message({
              id: "m1",
              sessionId: "after-session",
              branchId: "after-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "First" })],
              createdAt: new Date(baseTime),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "m2",
              sessionId: "after-session",
              branchId: "after-branch",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Second" })],
              createdAt: new Date(baseTime + 1000),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "m3",
              sessionId: "after-session",
              branchId: "after-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Third" })],
              createdAt: new Date(baseTime + 2000),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "m4",
              sessionId: "after-session",
              branchId: "after-branch",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Fourth" })],
              createdAt: new Date(baseTime + 3000),
            }),
          )

          // Get messages after m2
          const messages = yield* storage.listMessagesAfter("after-branch", "m2")

          expect(messages.length).toBe(2)
          expect(messages[0]?.id).toBe("m3")
          expect(messages[1]?.id).toBe("m4")
        }),
      )
    })

    test("returns empty array for nonexistent afterMessageId", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const messages = yield* storage.listMessagesAfter("some-branch", "nonexistent")
          expect(messages.length).toBe(0)
        }),
      )
    })
  })

  describe("Storage - listMessagesSince", () => {
    test("returns messages since timestamp", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "since-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "since-branch",
              sessionId: "since-session",
              createdAt: new Date(),
            }),
          )

          const baseTime = Date.now()
          const cutoffTime = new Date(baseTime + 1500)

          yield* storage.createMessage(
            new Message({
              id: "s1",
              sessionId: "since-session",
              branchId: "since-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Before" })],
              createdAt: new Date(baseTime),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "s2",
              sessionId: "since-session",
              branchId: "since-branch",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Also before" })],
              createdAt: new Date(baseTime + 1000),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "s3",
              sessionId: "since-session",
              branchId: "since-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "After" })],
              createdAt: new Date(baseTime + 2000),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "s4",
              sessionId: "since-session",
              branchId: "since-branch",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Also after" })],
              createdAt: new Date(baseTime + 3000),
            }),
          )

          const messages = yield* storage.listMessagesSince("since-branch", cutoffTime)

          expect(messages.length).toBe(2)
          expect(messages[0]?.id).toBe("s3")
          expect(messages[1]?.id).toBe("s4")
        }),
      )
    })

    test("returns empty for future timestamp", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "future-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "future-branch",
              sessionId: "future-session",
              createdAt: new Date(),
            }),
          )

          yield* storage.createMessage(
            new Message({
              id: "f1",
              sessionId: "future-session",
              branchId: "future-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Test" })],
              createdAt: new Date(),
            }),
          )

          const futureDate = new Date(Date.now() + 100000)
          const messages = yield* storage.listMessagesSince("future-branch", futureDate)

          expect(messages.length).toBe(0)
        }),
      )
    })
  })

  describe("Checkpoint Schema - Discriminated Union", () => {
    test("CompactionCheckpoint has correct _tag", () => {
      const checkpoint = new CompactionCheckpoint({
        id: "test",
        branchId: "branch",
        summary: "summary",
        firstKeptMessageId: "msg",
        messageCount: 10,
        tokenCount: 5000,
        createdAt: new Date(),
      })

      expect(checkpoint._tag).toBe("CompactionCheckpoint")
    })

    test("PlanCheckpoint has correct _tag", () => {
      const checkpoint = new PlanCheckpoint({
        id: "test",
        branchId: "branch",
        planPath: "/path/to/plan.md",
        messageCount: 10,
        tokenCount: 5000,
        createdAt: new Date(),
      })

      expect(checkpoint._tag).toBe("PlanCheckpoint")
    })

    test("pattern matching on checkpoint type works", () => {
      const compaction = new CompactionCheckpoint({
        id: "c",
        branchId: "b",
        summary: "s",
        firstKeptMessageId: "m",
        messageCount: 1,
        tokenCount: 100,
        createdAt: new Date(),
      })

      const plan = new PlanCheckpoint({
        id: "p",
        branchId: "b",
        planPath: "/plan.md",
        messageCount: 1,
        tokenCount: 100,
        createdAt: new Date(),
      })

      const getType = (cp: CompactionCheckpoint | PlanCheckpoint): string => {
        if (cp._tag === "CompactionCheckpoint") {
          return `compaction: ${cp.summary.substring(0, 10)}`
        } else {
          return `plan: ${cp.planPath}`
        }
      }

      expect(getType(compaction)).toBe("compaction: s")
      expect(getType(plan)).toBe("plan: /plan.md")
    })
  })

  describe("CheckpointService", () => {
    test("shouldCompact returns false below threshold", async () => {
      // Create layer with low token messages
      const BaseLayer = Layer.mergeAll(Storage.Test(), Provider.Test([[]]))
      const CheckpointLayer = Layer.provide(
        CheckpointService.Live("test/model", {
          threshold: 1000,
          pruneProtect: 100,
          pruneMinimum: 50,
        }),
        BaseLayer,
      )
      const TestLayer = Layer.merge(BaseLayer, CheckpointLayer)

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const service = yield* CheckpointService

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )
          // Small message - well under 1000 token threshold
          yield* storage.createMessage(
            new Message({
              id: "m1",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Hello" })],
              createdAt: new Date(),
            }),
          )

          const result = yield* service.shouldCompact("b")
          expect(result).toBe(false)
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    test("shouldCompact returns true above threshold", async () => {
      const BaseLayer = Layer.mergeAll(Storage.Test(), Provider.Test([[]]))
      const CheckpointLayer = Layer.provide(
        CheckpointService.Live("test/model", {
          threshold: 10, // Very low threshold
          pruneProtect: 5,
          pruneMinimum: 2,
        }),
        BaseLayer,
      )
      const TestLayer = Layer.merge(BaseLayer, CheckpointLayer)

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const service = yield* CheckpointService

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )
          // Message with >40 chars = >10 tokens
          yield* storage.createMessage(
            new Message({
              id: "m1",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [
                new TextPart({
                  type: "text",
                  text: "This is a longer message that exceeds the threshold",
                }),
              ],
              createdAt: new Date(),
            }),
          )

          const result = yield* service.shouldCompact("b")
          expect(result).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    test("createPlanCheckpoint creates and stores checkpoint", async () => {
      const BaseLayer = Layer.mergeAll(Storage.Test(), Provider.Test([[]]))
      const CheckpointLayer = Layer.provide(CheckpointService.Live("test/model"), BaseLayer)
      const TestLayer = Layer.merge(BaseLayer, CheckpointLayer)

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const service = yield* CheckpointService

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )
          yield* storage.createMessage(
            new Message({
              id: "m1",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Test message" })],
              createdAt: new Date(),
            }),
          )

          const checkpoint = yield* service.createPlanCheckpoint("b", "/path/to/plan.md")

          expect(checkpoint._tag).toBe("PlanCheckpoint")
          expect(checkpoint.planPath).toBe("/path/to/plan.md")
          expect(checkpoint.branchId).toBe("b")

          // Verify stored in storage
          const retrieved = yield* storage.getLatestCheckpoint("b")
          expect(retrieved?._tag).toBe("PlanCheckpoint")
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    test("estimateTokens calculates correctly", () => {
      const messages = [
        new Message({
          id: "m1",
          sessionId: "s",
          branchId: "b",
          role: "user",
          parts: [new TextPart({ type: "text", text: "x".repeat(100) })], // 100 chars = 25 tokens
          createdAt: new Date(),
        }),
        new Message({
          id: "m2",
          sessionId: "s",
          branchId: "b",
          role: "assistant",
          parts: [new TextPart({ type: "text", text: "y".repeat(200) })], // 200 chars = 50 tokens
          createdAt: new Date(),
        }),
      ]

      const tokens = estimateTokens(messages)
      expect(tokens).toBe(75) // (100 + 200) / 4 = 75
    })
  })

  describe("CheckpointService - Recording", () => {
    test("records createPlanCheckpoint calls", async () => {
      const TestLayer = createRecordingTestLayer({})

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const service = yield* CheckpointService
          const recorder = yield* SequenceRecorder

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )

          yield* service.createPlanCheckpoint("b", "/plan.md")

          const calls = yield* recorder.getCalls()
          assertSequence(calls, [{ service: "CheckpointService", method: "createPlanCheckpoint" }])
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    test("records getLatestCheckpoint calls", async () => {
      const existingCheckpoint = new CompactionCheckpoint({
        id: "existing",
        branchId: "b",
        summary: "Previous context",
        firstKeptMessageId: "msg-5",
        messageCount: 10,
        tokenCount: 5000,
        createdAt: new Date(),
      })

      const TestLayer = createRecordingTestLayer({
        checkpoint: { latestCheckpoint: existingCheckpoint },
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* CheckpointService
          const recorder = yield* SequenceRecorder

          const checkpoint = yield* service.getLatestCheckpoint("b")

          expect(checkpoint?._tag).toBe("CompactionCheckpoint")
          expect((checkpoint as CompactionCheckpoint).summary).toBe("Previous context")

          const calls = yield* recorder.getCalls()
          assertSequence(calls, [{ service: "CheckpointService", method: "getLatestCheckpoint" }])
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })

  describe("GentCore.approvePlan Integration", () => {
    test("approvePlan creates checkpoint and emits event", async () => {
      const TestLayer = createRecordingTestLayer({})

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const service = yield* CheckpointService
          const eventBus = yield* EventBus
          const recorder = yield* SequenceRecorder

          // Setup
          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )

          // Simulate approvePlan behavior (what GentCore.approvePlan does)
          yield* service.createPlanCheckpoint("b", "/workspace/plan.md")
          yield* eventBus.publish(
            new PlanConfirmed({
              sessionId: "s",
              branchId: "b",
              requestId: "plan-req-1",
              planPath: "/workspace/plan.md",
            }),
          )

          // Verify checkpoint created
          const checkpoint = yield* storage.getLatestCheckpoint("b")
          expect(checkpoint?._tag).toBe("PlanCheckpoint")
          expect((checkpoint as PlanCheckpoint).planPath).toBe("/workspace/plan.md")

          // Verify event sequence
          const calls = yield* recorder.getCalls()
          assertSequence(calls, [
            { service: "CheckpointService", method: "createPlanCheckpoint" },
            { service: "EventBus", method: "publish", match: { _tag: "PlanConfirmed" } },
          ])
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })

  describe("Checkpoint Context Loading", () => {
    test("no checkpoint loads all messages", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )

          const baseTime = Date.now()
          yield* storage.createMessage(
            new Message({
              id: "m1",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "First" })],
              createdAt: new Date(baseTime),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "m2",
              sessionId: "s",
              branchId: "b",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Second" })],
              createdAt: new Date(baseTime + 1000),
            }),
          )

          // No checkpoint - should get all messages
          const checkpoint = yield* storage.getLatestCheckpoint("b")
          expect(checkpoint).toBeUndefined()

          const messages = yield* storage.listMessages("b")
          expect(messages.length).toBe(2)
        }),
      )
    })

    test("CompactionCheckpoint loads messages after firstKeptMessageId", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )

          const baseTime = Date.now()

          // Create messages
          yield* storage.createMessage(
            new Message({
              id: "old-1",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Old message 1" })],
              createdAt: new Date(baseTime),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "kept-1",
              sessionId: "s",
              branchId: "b",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Kept message 1" })],
              createdAt: new Date(baseTime + 1000),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "kept-2",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Kept message 2" })],
              createdAt: new Date(baseTime + 2000),
            }),
          )

          // Create compaction checkpoint pointing to kept-1
          yield* storage.createCheckpoint(
            new CompactionCheckpoint({
              id: "cp-1",
              branchId: "b",
              summary: "User asked about X, assistant explained Y",
              firstKeptMessageId: "kept-1",
              messageCount: 3,
              tokenCount: 100,
              createdAt: new Date(baseTime + 500),
            }),
          )

          const checkpoint = yield* storage.getLatestCheckpoint("b")
          expect(checkpoint?._tag).toBe("CompactionCheckpoint")

          // Should only get messages AFTER kept-1
          const messages = yield* storage.listMessagesAfter(
            "b",
            (checkpoint as CompactionCheckpoint).firstKeptMessageId,
          )
          expect(messages.length).toBe(1)
          expect(messages[0]?.id).toBe("kept-2")
        }),
      )
    })

    test("PlanCheckpoint loads messages after checkpoint creation", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({ id: "s", createdAt: new Date(), updatedAt: new Date() }),
          )
          yield* storage.createBranch(
            new Branch({ id: "b", sessionId: "s", createdAt: new Date() }),
          )

          const baseTime = Date.now()

          // Messages before plan approval
          yield* storage.createMessage(
            new Message({
              id: "pre-plan",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Let me think about the plan" })],
              createdAt: new Date(baseTime),
            }),
          )

          // Plan checkpoint created at baseTime + 1000
          const checkpointTime = new Date(baseTime + 1000)
          yield* storage.createCheckpoint(
            new PlanCheckpoint({
              id: "plan-cp",
              branchId: "b",
              planPath: "/workspace/plan.md",
              messageCount: 1,
              tokenCount: 50,
              createdAt: checkpointTime,
            }),
          )

          // Message after plan approval
          yield* storage.createMessage(
            new Message({
              id: "post-plan",
              sessionId: "s",
              branchId: "b",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Now execute the plan" })],
              createdAt: new Date(baseTime + 2000),
            }),
          )

          const checkpoint = yield* storage.getLatestCheckpoint("b")
          expect(checkpoint?._tag).toBe("PlanCheckpoint")

          // Should only get messages AFTER checkpoint creation
          const messages = yield* storage.listMessagesSince("b", checkpoint!.createdAt)
          expect(messages.length).toBe(1)
          expect(messages[0]?.id).toBe("post-plan")
        }),
      )
    })
  })
})
