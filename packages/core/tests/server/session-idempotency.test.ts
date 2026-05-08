import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { Deferred } from "effect"
import { Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Branch, Message } from "@gent/core-internal/domain/message"
import { EventStore } from "@gent/core-internal/domain/event"
import { EventPublisher } from "@gent/core-internal/domain/event-publisher"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { dedupRequest, SessionCommands } from "../../src/server/session-commands"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import {
  FIXED_NOW,
  createActiveSessionFixture,
  sessionCommandsLayer,
  sessionRuntimeLayer,
} from "./session-commands/helpers"

describe("requestId idempotency", () => {
  it.live("duplicate createSession requestId converges on a single session id", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const first = yield* commands.createSession({
        cwd: "/tmp/idem",
        requestId: "req-create-1",
      })
      const second = yield* commands.createSession({
        cwd: "/tmp/idem",
        requestId: "req-create-1",
      })
      const third = yield* commands.createSession({
        cwd: "/tmp/idem",
        requestId: "req-create-1",
      })
      expect(second.sessionId).toBe(first.sessionId)
      expect(second.branchId).toBe(first.branchId)
      expect(third.sessionId).toBe(first.sessionId)
      const all = yield* sessions.listSessions()
      expect(all).toHaveLength(1)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("distinct createSession requestIds create distinct sessions", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const a = yield* commands.createSession({ cwd: "/tmp/a", requestId: "req-a" })
      const b = yield* commands.createSession({ cwd: "/tmp/b", requestId: "req-b" })
      expect(a.sessionId).not.toBe(b.sessionId)
      expect((yield* sessions.listSessions()).length).toBe(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate createSession requestIds converge on one session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      // Fire three parallel creates with the same requestId. Before the
      // Deferred-based claim this would race two `Ref.get` misses through
      // storage and leave two sessions. Under the atomic claim the first
      // fiber wins the write; the others `Deferred.await` its outcome.
      const results = yield* Effect.all(
        [
          commands.createSession({ cwd: "/tmp/conc", requestId: "req-conc-1" }),
          commands.createSession({ cwd: "/tmp/conc", requestId: "req-conc-1" }),
          commands.createSession({ cwd: "/tmp/conc", requestId: "req-conc-1" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].sessionId).toBe(results[1].sessionId)
      expect(results[0].sessionId).toBe(results[2].sessionId)
      expect((yield* sessions.listSessions()).length).toBe(1)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("duplicate sendMessage requestId sends to runtime only once", () =>
    Effect.gen(function* () {
      let dispatchCount = 0
      const countingRuntime = sessionRuntimeLayer({
        sendUserMessage: () =>
          Effect.sync(() => {
            dispatchCount++
          }),
      })
      const storageLayer = SqliteStorage.MemoryWithSql()
      const deps = Layer.mergeAll(
        storageLayer,
        countingRuntime,
        EventStore.Memory,
        EventPublisher.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        GentPlatform.Test(),
      )
      const layer = Layer.provideMerge(
        SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
        deps,
      )

      const probe = Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.sendMessage({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          content: "hi",
          requestId: "req-send-1",
        })
        yield* commands.sendMessage({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          content: "hi",
          requestId: "req-send-1",
        })
        yield* commands.sendMessage({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          content: "hi (distinct)",
          requestId: "req-send-2",
        })
      }).pipe(Effect.provide(layer))

      yield* probe
      expect(dispatchCount).toBe(2)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate sendMessage requestIds dispatch only once", () =>
    Effect.gen(function* () {
      let dispatchCount = 0
      const countingRuntime = sessionRuntimeLayer({
        sendUserMessage: () =>
          Effect.sync(() => {
            dispatchCount++
          }),
      })
      const storageLayer = SqliteStorage.MemoryWithSql()
      const deps = Layer.mergeAll(
        storageLayer,
        countingRuntime,
        EventStore.Memory,
        EventPublisher.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        GentPlatform.Test(),
      )
      const layer = Layer.provideMerge(
        SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
        deps,
      )

      yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* Effect.all(
          [
            commands.sendMessage({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content: "hi",
              requestId: "req-conc-send",
            }),
            commands.sendMessage({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content: "hi",
              requestId: "req-conc-send",
            }),
            commands.sendMessage({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content: "hi",
              requestId: "req-conc-send",
            }),
          ],
          { concurrency: "unbounded" },
        )
      }).pipe(Effect.provide(layer))

      expect(dispatchCount).toBe(1)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("duplicate createBranch requestId converges on a single branch id", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const branches = yield* BranchStorage
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-branch-dedup")
      const branchId = BranchId.make("branch-branch-dedup")
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: FIXED_NOW,
      })

      const first = yield* commands.createBranch({
        sessionId,
        name: "feat",
        requestId: "req-branch-1",
      })
      const second = yield* commands.createBranch({
        sessionId,
        name: "feat",
        requestId: "req-branch-1",
      })

      expect(second.branchId).toBe(first.branchId)
      // 1 from fixture + 1 from the deduped create
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate createBranch requestIds converge on one branch", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const branches = yield* BranchStorage
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-branch-conc")
      const branchId = BranchId.make("branch-branch-conc")
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: FIXED_NOW,
      })

      const results = yield* Effect.all(
        [
          commands.createBranch({ sessionId, name: "x", requestId: "req-bconc" }),
          commands.createBranch({ sessionId, name: "x", requestId: "req-bconc" }),
          commands.createBranch({ sessionId, name: "x", requestId: "req-bconc" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].branchId).toBe(results[1].branchId)
      expect(results[0].branchId).toBe(results[2].branchId)
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("duplicate switchBranch requestId activates the target only once", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-dedup")
      const fromBranchId = BranchId.make("branch-switch-dedup-from")
      const toBranchId = BranchId.make("branch-switch-dedup-to")
      const now = FIXED_NOW
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
      })
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      yield* commands.switchBranch({
        sessionId,
        fromBranchId,
        toBranchId,
        summarize: false,
        requestId: "req-switch-1",
      })
      yield* commands.switchBranch({
        sessionId,
        fromBranchId,
        toBranchId,
        summarize: false,
        requestId: "req-switch-1",
      })

      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(toBranchId)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("duplicate forkBranch requestId converges on a single new branch", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-fork-dedup")
      const branchId = BranchId.make("branch-fork-dedup")
      const messageId = MessageId.make("message-fork-dedup")
      const now = FIXED_NOW
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
      })
      yield* messages.createMessage(
        Message.Regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "seed" })],
          createdAt: now,
        }),
      )

      const first = yield* commands.forkBranch({
        sessionId,
        fromBranchId: branchId,
        atMessageId: messageId,
        name: "fork",
        requestId: "req-fork-1",
      })
      const second = yield* commands.forkBranch({
        sessionId,
        fromBranchId: branchId,
        atMessageId: messageId,
        name: "fork",
        requestId: "req-fork-1",
      })

      expect(second.branchId).toBe(first.branchId)
      // origin + 1 forked branch
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  // Dedup-cache TTL eviction. The cache schedules a delayed
  // eviction via `Effect.forkDetach(Effect.sleep(60s))` after each
  // success. Beyond the TTL window, a retry of the same `requestId`
  // must NOT collide with the prior outcome — it must execute fresh.
  // Drive `Effect.sleep` deterministically via `TestClock` so the test
  // does not actually wait 60s.
  it.effect(
    "dedup cache evicts success entry past TTL — retried requestId creates a new session",
    () =>
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const sessions = yield* SessionStorage
        const first = yield* commands.createSession({
          cwd: "/tmp/ttl",
          requestId: "req-ttl-1",
        })
        // Advance past the 60s TTL so the detached eviction fork wakes
        // up and removes the cache entry.
        yield* TestClock.adjust("61 seconds")
        const second = yield* commands.createSession({
          cwd: "/tmp/ttl",
          requestId: "req-ttl-1",
        })
        expect(second.sessionId).not.toBe(first.sessionId)
        expect((yield* sessions.listSessions()).length).toBe(2)
      }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  // Companion to the TTL eviction test: prove the bound is the bound.
  // Within the 60s window, a retry MUST collapse onto the cached outcome
  // — otherwise "evict past TTL" would be vacuous.
  it.effect("dedup cache retains success entry within TTL — retried requestId collapses", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const first = yield* commands.createSession({
        cwd: "/tmp/ttl-mid",
        requestId: "req-ttl-mid",
      })
      // Advance well inside the 60s window — should still hit the cache.
      yield* TestClock.adjust("30 seconds")
      const second = yield* commands.createSession({
        cwd: "/tmp/ttl-mid",
        requestId: "req-ttl-mid",
      })
      expect(second.sessionId).toBe(first.sessionId)
      expect((yield* sessions.listSessions()).length).toBe(1)
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.effect("dedup cache hard cap evicts the oldest requestId", () =>
    Effect.gen(function* () {
      const cache = yield* Ref.make(new Map<string, Deferred.Deferred<number, never>>())
      let value = 0
      const run = (requestId: string) =>
        dedupRequest({
          cache,
          requestId,
          body: Effect.sync(() => {
            value += 1
            return value
          }),
          maxEntries: 2,
          successTtl: "60 seconds",
        })

      const first = yield* run("req-cap-first")
      expect(yield* run("req-cap-second")).toBe(2)
      expect(yield* run("req-cap-third")).toBe(3)

      const retry = yield* run("req-cap-first")
      expect(retry).not.toBe(first)
      expect(retry).toBe(4)
      expect(Array.from((yield* Ref.get(cache)).keys())).toEqual(["req-cap-third", "req-cap-first"])
    }),
  )
})
