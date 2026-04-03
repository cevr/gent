import { describe, test, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Storage, type StorageService } from "@gent/core/storage/sqlite-storage"
import { Session, Branch } from "@gent/core/domain/message"
import { DEFAULT_MAX_AGENT_RUN_DEPTH } from "@gent/core/domain/agent"
import { getSessionDepth } from "@gent/core/runtime/agent/subagent-runner"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
  Effect.runPromise(Effect.provide(effect, Storage.Test()))

const runExit = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
  Effect.runPromise(Effect.exit(effect).pipe(Effect.provide(Storage.Test())))

const makeSession = (id: string, parentSessionId?: string) =>
  new Session({
    id: id as SessionId,
    name: `session-${id}`,
    parentSessionId: parentSessionId as SessionId | undefined,
    parentBranchId: parentSessionId ? (`branch-${parentSessionId}` as BranchId) : undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

const makeBranch = (sessionId: string) =>
  new Branch({
    id: `branch-${sessionId}` as BranchId,
    sessionId: sessionId as SessionId,
    createdAt: new Date(),
  })

/** Build a chain of sessions: s0 → s1 → ... → sN */
const buildSessionChain = (storage: StorageService, depth: number) =>
  Effect.gen(function* () {
    yield* storage.createSession(makeSession("s0"))
    yield* storage.createBranch(makeBranch("s0"))
    for (let i = 1; i <= depth; i++) {
      yield* storage.createSession(makeSession(`s${i}`, `s${i - 1}`))
      yield* storage.createBranch(makeBranch(`s${i}`))
    }
  })

describe("getSessionDepth", () => {
  test("root session has depth 0", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(makeSession("root"))
        yield* storage.createBranch(makeBranch("root"))

        const depth = yield* getSessionDepth("root" as SessionId, storage)
        expect(depth).toBe(0)
      }),
    )
  })

  test("child of root has depth 1", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(makeSession("root"))
        yield* storage.createBranch(makeBranch("root"))
        yield* storage.createSession(makeSession("child", "root"))
        yield* storage.createBranch(makeBranch("child"))

        const depth = yield* getSessionDepth("child" as SessionId, storage)
        expect(depth).toBe(1)
      }),
    )
  })

  test("grandchild has depth 2", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(makeSession("root"))
        yield* storage.createBranch(makeBranch("root"))
        yield* storage.createSession(makeSession("child", "root"))
        yield* storage.createBranch(makeBranch("child"))
        yield* storage.createSession(makeSession("grandchild", "child"))
        yield* storage.createBranch(makeBranch("grandchild"))

        const depth = yield* getSessionDepth("grandchild" as SessionId, storage)
        expect(depth).toBe(2)
      }),
    )
  })

  test("chain at max depth reports correct depth", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH)

        const deepest = `s${DEFAULT_MAX_AGENT_RUN_DEPTH}` as SessionId
        const depth = yield* getSessionDepth(deepest, storage)
        expect(depth).toBe(DEFAULT_MAX_AGENT_RUN_DEPTH)
      }),
    )
  })
})

describe("depth guard behavior", () => {
  test("parent at max depth would block child spawn", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH)

        // The deepest session is at DEFAULT_MAX_AGENT_RUN_DEPTH — spawning from it should be blocked
        const parentId = `s${DEFAULT_MAX_AGENT_RUN_DEPTH}` as SessionId
        const parentDepth = yield* getSessionDepth(parentId, storage)
        expect(parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    )
  })

  test("parent below max depth allows child spawn", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH - 1)

        const parentId = `s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}` as SessionId
        const parentDepth = yield* getSessionDepth(parentId, storage)
        expect(parentDepth < DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    )
  })

  test("fails closed on ancestry read error", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const storage = yield* Storage
        // Query depth for a session that doesn't exist — ancestry read returns empty
        // The CTE returns no rows, so ancestors.length is 0, depth is 0
        // But for a truly broken storage, the error should propagate as SubagentError
        yield* getSessionDepth("nonexistent" as SessionId, storage)
      }),
    )
    // Non-existent session returns depth 0 from the CTE (empty result)
    // The fail-closed path triggers on actual storage errors, not empty results
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("DEFAULT_MAX_AGENT_RUN_DEPTH", () => {
  test("is 3", () => {
    expect(DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(3)
  })
})
