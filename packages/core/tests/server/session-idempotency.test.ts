import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { TestClock } from "effect/testing"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Branch, Message } from "@gent/core-internal/domain/message"
import { EventStore } from "@gent/core-internal/domain/event"
import { EventPublisher } from "@gent/core-internal/domain/event-publisher"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { Gent } from "@gent/sdk"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { SessionRuntimeError } from "../../src/runtime/session-runtime"
import { makeRequestDeduper, SessionCommands } from "../../src/server/session-commands"
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
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"

describe("requestId idempotency", () => {
  const makePersistentSessionCommandsLayer = (dbPath: string) => {
    const storageLayer = SqliteStorage.LiveWithSql(dbPath).pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(GentPlatform.Test()),
    )
    const deps = Layer.mergeAll(
      storageLayer,
      sessionRuntimeLayer(),
      EventStore.Memory,
      EventPublisher.Test(),
      LanguageModelLayers.debug(),
      ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
      GentPlatform.Test(),
    )
    return Layer.provideMerge(
      SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
      deps,
    )
  }

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
      const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
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
      const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
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
        Message.cases.regular.make({
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

  it.live("duplicate public branch.create requestId converges through RPC handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/tmp/rpc-branch-create-idem" })

        const first = yield* client.branch.create({
          sessionId: created.sessionId,
          name: "rpc durable branch",
          requestId: "req-rpc-create-branch",
        })
        const second = yield* client.branch.create({
          sessionId: created.sessionId,
          name: "retry name should not win",
          requestId: "req-rpc-create-branch",
        })
        const branches = yield* client.branch.list({ sessionId: created.sessionId })

        expect(second.branchId).toBe(first.branchId)
        expect(branches).toHaveLength(2)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public branch.switch requestId converges through RPC handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/tmp/rpc-branch-switch-idem" })
        const target = yield* client.branch.create({
          sessionId: created.sessionId,
          name: "target",
          requestId: "req-rpc-switch-target-create",
        })

        yield* client.branch.switch({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          toBranchId: target.branchId,
          summarize: false,
          requestId: "req-rpc-switch-branch",
        })
        yield* client.branch.switch({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          toBranchId: target.branchId,
          summarize: true,
          requestId: "req-rpc-switch-branch",
        })
        const session = yield* client.session.get({ sessionId: created.sessionId })

        expect(session?.activeBranchId).toBe(target.branchId)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public branch.fork requestId converges through RPC handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/tmp/rpc-branch-fork-idem" })
        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "seed public fork",
          requestId: "req-rpc-fork-seed-message",
        })
        const snapshot = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        const userMessage = snapshot.messages.find((message) => message.role === "user")
        if (userMessage === undefined) {
          return yield* Effect.die("expected seeded user message")
        }

        const first = yield* client.branch.fork({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          atMessageId: userMessage.id,
          name: "rpc durable fork",
          requestId: "req-rpc-fork-branch",
        })
        const second = yield* client.branch.fork({
          sessionId: created.sessionId,
          fromBranchId: created.branchId,
          atMessageId: userMessage.id,
          name: "retry fork name should not win",
          requestId: "req-rpc-fork-branch",
        })
        const branches = yield* client.branch.list({ sessionId: created.sessionId })

        expect(second.branchId).toBe(first.branchId)
        expect(branches).toHaveLength(2)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public steer Interject requestId queues at most once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/tmp/rpc-steer-idem" })

        const command = {
          _tag: "Interject" as const,
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-steer-interject",
          message: "steer once",
        }
        yield* client.steer.command({ command })
        yield* client.steer.command({ command })

        const queued = yield* waitFor(
          client.queue.get({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (snapshot) => snapshot.steering.length === 1,
          1_000,
          "public steer command enqueue",
        )
        expect(queued.steering.map((entry) => entry.content)).toEqual(["steer once"])

        yield* client.queue.drain({
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-steer-drain",
        })
        yield* client.steer.command({ command })
        const afterRetry = yield* client.queue.get({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(afterRetry.steering).toEqual([])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("duplicate public queue.drain requestId replays the original snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
        )
        const created = yield* client.session.create({ cwd: "/tmp/rpc-drain-idem" })
        yield* client.steer.command({
          command: {
            _tag: "Interject",
            sessionId: created.sessionId,
            branchId: created.branchId,
            requestId: "req-rpc-drain-steer",
            message: "drain me",
          },
        })

        const first = yield* client.queue.drain({
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-drain-queue",
        })
        const second = yield* client.queue.drain({
          sessionId: created.sessionId,
          branchId: created.branchId,
          requestId: "req-rpc-drain-queue",
        })
        const current = yield* client.queue.get({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })

        expect(first.steering.map((entry) => entry.content)).toEqual(["drain me"])
        expect(second).toEqual(first)
        expect(current.steering).toEqual([])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  // Dedup-cache TTL eviction. The cache schedules a delayed
  // eviction via `Effect.forkDetach(Effect.sleep(60s))`, but createSession
  // now has a durable operation result underneath the process cache. Beyond
  // the TTL window, a retry of the same `requestId` still returns the
  // original session/branch ids.
  it.effect("durable createSession result survives process-cache TTL eviction", () =>
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
      expect(second.sessionId).toBe(first.sessionId)
      expect(second.branchId).toBe(first.branchId)
      expect((yield* sessions.listSessions()).length).toBe(1)
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
      let value = 0
      const run = yield* makeRequestDeduper<{ requestId: string }, number, never>({
        body: () =>
          Effect.sync(() => {
            value += 1
            return value
          }),
        keyOf: (input) => input.requestId,
        maxEntries: 2,
        successTtl: "60 seconds",
      })

      const first = yield* run({ requestId: "req-cap-first" })
      expect(yield* run({ requestId: "req-cap-second" })).toBe(2)
      expect(yield* run({ requestId: "req-cap-third" })).toBe(3)

      // Past the 2-entry cap, "req-cap-first" was evicted to make room for
      // "req-cap-third", so this call is a fresh lookup, not a cache hit.
      const retry = yield* run({ requestId: "req-cap-first" })
      expect(retry).not.toBe(first)
      expect(retry).toBe(4)
    }),
  )

  // Regression: a same-key retry inside the TTL window must collapse onto
  // the cached outcome AND must not let a stale body leak into pending such
  // that a post-eviction retry runs the wrong body.
  it.effect("dedup cache post-eviction retry runs the fresh body, not a stale one", () =>
    Effect.gen(function* () {
      // The body's identity is captured in `lastSeen` so we can prove which
      // input arg triggered the lookup. If the post-eviction call ran a
      // stale closure, `lastSeen` would show input1's marker, not input3's.
      let lastSeen = ""
      const run = yield* makeRequestDeduper<{ requestId: string; marker: string }, string, never>({
        body: (input) =>
          Effect.sync(() => {
            lastSeen = input.marker
            return input.marker
          }),
        keyOf: (input) => input.requestId,
        successTtl: "60 seconds",
      })

      // F1 populates the cache with key="K", body uses marker="m1".
      const first = yield* run({ requestId: "K", marker: "m1" })
      expect(first).toBe("m1")
      expect(lastSeen).toBe("m1")

      // F2 retries the same key inside the TTL window — must hit the cache
      // and observe F1's outcome. F2's body (marker="m2") must NOT run.
      const second = yield* run({ requestId: "K", marker: "m2" })
      expect(second).toBe("m1")
      expect(lastSeen).toBe("m1")

      // Advance past the TTL so F1's cache entry is gone. F3 must run a
      // fresh lookup with ITS OWN body (marker="m3"). If F2's body leaked
      // into pending, this would observe "m2" instead of "m3".
      yield* TestClock.adjust("61 seconds")
      const third = yield* run({ requestId: "K", marker: "m3" })
      expect(third).toBe("m3")
      expect(lastSeen).toBe("m3")
    }),
  )

  it.scoped("createSession requestId replays durable result after command layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const deliveredPrompts: string[] = []
      const deliveredPromptRequestIds = new Set<string>()

      const makeLayer = (failPrompt: boolean) => {
        const storageLayer = SqliteStorage.LiveWithSql(dbPath).pipe(
          Layer.provide(BunServices.layer),
          Layer.provide(GentPlatform.Test()),
        )
        const runtimeLayer = sessionRuntimeLayer({
          sendUserMessage: (input) => {
            if (failPrompt) {
              return Effect.fail(new SessionRuntimeError({ message: "prompt dispatch failed" }))
            }
            return Effect.sync(() => {
              const key = input.requestId ?? ""
              if (deliveredPromptRequestIds.has(key)) return
              deliveredPromptRequestIds.add(key)
              deliveredPrompts.push(`${input.content}:${key}`)
            })
          },
        })
        const deps = Layer.mergeAll(
          storageLayer,
          runtimeLayer,
          EventStore.Memory,
          EventPublisher.Test(),
          LanguageModelLayers.debug(),
          ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
          GentPlatform.Test(),
        )
        return Layer.provideMerge(
          SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
          deps,
        )
      }

      const firstExit = yield* Effect.exit(
        Effect.gen(function* () {
          const commands = yield* SessionCommands
          yield* commands.createSession({
            cwd: "/tmp/restart-create",
            requestId: "req-create-restart",
            initialPrompt: "stored prompt",
          })
        }).pipe(Effect.provide(makeLayer(true))),
      )
      expect(firstExit._tag).toBe("Failure")

      const second = yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        return yield* commands.createSession({
          cwd: "/tmp/restart-create",
          requestId: "req-create-restart",
          initialPrompt: "retry prompt should not win",
        })
      }).pipe(Effect.provide(makeLayer(false)))

      const sessions = yield* Effect.gen(function* () {
        const storage = yield* SessionStorage
        return yield* storage.listSessions()
      }).pipe(Effect.provide(makeLayer(false)))

      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.id).toBe(second.sessionId)
      expect(sessions[0]?.activeBranchId).toBe(second.branchId)
      expect(deliveredPrompts).toEqual(["stored prompt:session.create:req-create-restart:initial"])
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scoped("createBranch requestId replays durable result after command layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionCommandsLayer(dbPath)
      const sessionId = SessionId.make("session-create-branch-restart")
      const branchId = BranchId.make("branch-create-branch-restart")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: FIXED_NOW,
        })
      }).pipe(Effect.provide(layer))

      const first = yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        return yield* commands.createBranch({
          sessionId,
          name: "durable branch",
          requestId: "req-create-branch-restart",
        })
      }).pipe(Effect.provide(layer))

      const second = yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        return yield* commands.createBranch({
          sessionId,
          name: "retry name should not win",
          requestId: "req-create-branch-restart",
        })
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      const branches = yield* Effect.gen(function* () {
        const storage = yield* BranchStorage
        return yield* storage.listBranches(sessionId)
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      expect(second.branchId).toBe(first.branchId)
      expect(branches).toHaveLength(2)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scoped("switchBranch requestId replays durable result after command layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionCommandsLayer(dbPath)
      const sessionId = SessionId.make("session-switch-branch-restart")
      const fromBranchId = BranchId.make("branch-switch-branch-restart-from")
      const toBranchId = BranchId.make("branch-switch-branch-restart-to")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId: fromBranchId,
          now: FIXED_NOW,
        })
        yield* branches.createBranch(
          new Branch({ id: toBranchId, sessionId, createdAt: FIXED_NOW }),
        )
      }).pipe(Effect.provide(layer))

      yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          summarize: false,
          requestId: "req-switch-branch-restart",
        })
      }).pipe(Effect.provide(layer))

      yield* Effect.gen(function* () {
        const branches = yield* BranchStorage
        yield* branches.deleteBranch(fromBranchId)
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          summarize: false,
          requestId: "req-switch-branch-restart",
        })
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      const session = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        return yield* sessions.getSession(sessionId)
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      expect(session?.activeBranchId).toBe(toBranchId)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scoped("forkBranch requestId replays durable result after command layer restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const dbPath = path.join(dir, "gent.db")
      const layer = makePersistentSessionCommandsLayer(dbPath)
      const sessionId = SessionId.make("session-fork-branch-restart")
      const branchId = BranchId.make("branch-fork-branch-restart")
      const messageId = MessageId.make("message-fork-branch-restart")

      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const messages = yield* MessageStorage
        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: FIXED_NOW,
        })
        yield* messages.createMessage(
          Message.cases.regular.make({
            id: messageId,
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "seed" })],
            createdAt: FIXED_NOW,
          }),
        )
      }).pipe(Effect.provide(layer))

      const first = yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        return yield* commands.forkBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
          requestId: "req-fork-branch-restart",
        })
      }).pipe(Effect.provide(layer))

      yield* Effect.gen(function* () {
        const messages = yield* MessageStorage
        yield* messages.deleteMessages(branchId)
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      const second = yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        return yield* commands.forkBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "retry fork should not allocate",
          requestId: "req-fork-branch-restart",
        })
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      const branches = yield* Effect.gen(function* () {
        const storage = yield* BranchStorage
        return yield* storage.listBranches(sessionId)
      }).pipe(Effect.provide(makePersistentSessionCommandsLayer(dbPath)))

      expect(second.branchId).toBe(first.branchId)
      expect(branches).toHaveLength(2)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )
})
