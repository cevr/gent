import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "../../src/runtime/make-extension-host-context"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { EventStoreError } from "@gent/core/domain/event"
import { Message, Session, Branch, TextPart, copyMessageToBranch } from "@gent/core/domain/message"
// Minimal in-memory storage for session mutation tests
const createTestStorage = () => {
  const sessions = new Map<string, Session>()
  const branches = new Map<string, Branch>()
  const messages = new Map<string, Message[]>()
  const die = (label: string) => () => Effect.die(`${label} not implemented in test`)
  return {
    storage: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const sessionsSnapshot = new Map(sessions)
          const branchesSnapshot = new Map(branches)
          const messagesSnapshot = new Map(messages)
          return yield* effect.pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                sessions.clear()
                for (const [key, value] of sessionsSnapshot) sessions.set(key, value)
                branches.clear()
                for (const [key, value] of branchesSnapshot) branches.set(key, value)
                messages.clear()
                for (const [key, value] of messagesSnapshot) messages.set(key, value)
              }),
            ),
          )
        }),
      listMessages: (branchId: BranchId) => Effect.succeed(messages.get(branchId) ?? []),
      getSession: (id: SessionId) => Effect.succeed(sessions.get(id)),
      getSessionDetail: die("getSessionDetail"),
      updateSession: (session: Session) => {
        sessions.set(session.id, session)
        return Effect.succeed(session)
      },
      createSession: (session: Session) => {
        sessions.set(session.id, session)
        return Effect.succeed(session)
      },
      deleteSession: (id: SessionId) => {
        sessions.delete(id)
        return Effect.void
      },
      listBranches: (sessionId: SessionId) =>
        Effect.succeed([...branches.values()].filter((b) => b.sessionId === sessionId)),
      createBranch: (branch: Branch) => {
        branches.set(branch.id, branch)
        return Effect.succeed(branch)
      },
      getBranch: (id: BranchId) => Effect.succeed(branches.get(id)),
      deleteBranch: (id: BranchId) => {
        branches.delete(id)
        messages.delete(id)
        return Effect.void
      },
      createMessage: (msg: Message) => {
        const list = messages.get(msg.branchId) ?? []
        list.push(msg)
        messages.set(msg.branchId, list)
        return Effect.succeed(msg)
      },
      createMessageIfAbsent: die("createMessageIfAbsent"),
      deleteMessages: (branchId: BranchId, afterMessageId?: MessageId) => {
        if (afterMessageId === undefined) {
          messages.delete(branchId)
        } else {
          const list = messages.get(branchId) ?? []
          const idx = list.findIndex((m) => m.id === afterMessageId)
          if (idx !== -1) messages.set(branchId, list.slice(0, idx + 1))
        }
        return Effect.void
      },
      getChildSessions: (parentSessionId: SessionId) =>
        Effect.succeed([...sessions.values()].filter((s) => s.parentSessionId === parentSessionId)),
      updateBranchSummary: die("updateBranchSummary"),
      countMessages: die("countMessages"),
      countMessagesByBranches: die("countMessagesByBranches"),
      updateMessageTurnDuration: die("updateMessageTurnDuration"),
      listSessions: die("listSessions"),
    } as unknown as MakeExtensionHostContextDeps["storage"],
    sessions,
    branches,
    messages,
  }
}
const makeTestDeps = (testStorage: ReturnType<typeof createTestStorage>) => {
  const die = (label: string) => () => Effect.die(`${label} not available`)
  const published: Array<{
    _tag: string
  }> = []
  const publish = (event: { _tag: string }) =>
    Effect.sync(() => {
      published.push(event)
    })
  const sessionMutations: MakeExtensionHostContextDeps["sessionMutations"] = {
    renameSession: ({ sessionId, name }) =>
      Effect.gen(function* () {
        const trimmed = name.trim().slice(0, 80)
        if (trimmed.length === 0) return { renamed: false as const }
        const session = testStorage.sessions.get(sessionId)
        if (session === undefined) return { renamed: false as const }
        if (session.name === trimmed) return { renamed: false as const }
        testStorage.sessions.set(sessionId, new Session({ ...session, name: trimmed }))
        yield* publish({ _tag: "SessionNameUpdated" })
        return { renamed: true as const, name: trimmed }
      }),
    createSessionBranch: ({ sessionId, parentBranchId, name }) =>
      Effect.gen(function* () {
        const branch = new Branch({
          id: BranchId.make(Bun.randomUUIDv7()),
          sessionId,
          parentBranchId,
          name,
          createdAt: new Date(),
        })
        testStorage.branches.set(branch.id, branch)
        yield* publish({ _tag: "BranchCreated" })
        return { branchId: branch.id }
      }),
    forkSessionBranch: ({ sessionId, fromBranchId, atMessageId, name }) =>
      testStorage.storage.withTransaction(
        Effect.gen(function* () {
          const messages = testStorage.messages.get(fromBranchId) ?? []
          const targetIndex = messages.findIndex((message) => message.id === atMessageId)
          if (targetIndex === -1) return yield* Effect.die("Message not found in current branch")
          const branch = new Branch({
            id: BranchId.make(Bun.randomUUIDv7()),
            sessionId,
            parentBranchId: fromBranchId,
            parentMessageId: atMessageId,
            name,
            createdAt: new Date(),
          })
          testStorage.branches.set(branch.id, branch)
          for (const message of messages.slice(0, targetIndex + 1)) {
            yield* testStorage.storage.createMessage(
              copyMessageToBranch(message, {
                id: MessageId.make(Bun.randomUUIDv7()),
                branchId: branch.id,
              }),
            )
          }
          yield* publish({ _tag: "BranchCreated" })
          return { branchId: branch.id }
        }),
      ),
    switchActiveBranch: ({ sessionId, fromBranchId, toBranchId }) =>
      Effect.gen(function* () {
        const targetBranch = testStorage.branches.get(toBranchId)
        if (targetBranch === undefined) return yield* Effect.die(`Branch "${toBranchId}" not found`)
        if (targetBranch.sessionId !== sessionId) {
          return yield* Effect.die(`Branch "${toBranchId}" belongs to a different session`)
        }
        const session = testStorage.sessions.get(sessionId)
        if (session === undefined) return yield* Effect.die("Current session not found")
        testStorage.sessions.set(sessionId, new Session({ ...session, activeBranchId: toBranchId }))
        void fromBranchId
        yield* publish({ _tag: "BranchSwitched" })
      }),
    createChildSession: ({ parentSessionId, parentBranchId, name, cwd }) =>
      testStorage.storage.withTransaction(
        Effect.gen(function* () {
          const sessionId = SessionId.make(Bun.randomUUIDv7())
          const branchId = BranchId.make(Bun.randomUUIDv7())
          const session = new Session({
            id: sessionId,
            name: name ?? "child session",
            cwd,
            parentSessionId,
            parentBranchId,
            activeBranchId: branchId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          testStorage.sessions.set(sessionId, session)
          testStorage.branches.set(
            branchId,
            new Branch({ id: branchId, sessionId, createdAt: new Date() }),
          )
          yield* publish({ _tag: "SessionStarted" })
          return { sessionId, branchId }
        }),
      ),
    deleteSession: (sessionId) => testStorage.storage.deleteSession(sessionId),
    deleteBranch: ({ sessionId, currentBranchId, branchId }) =>
      Effect.gen(function* () {
        if (branchId === currentBranchId)
          return yield* Effect.die("Cannot delete the current branch")
        const branch = testStorage.branches.get(branchId)
        if (branch === undefined || branch.sessionId !== sessionId) {
          return yield* Effect.die(`Branch "${branchId}" not found in current session`)
        }
        yield* testStorage.storage.deleteBranch(branchId)
      }),
    deleteMessages: ({ sessionId, branchId, afterMessageId }) =>
      Effect.gen(function* () {
        const branch = testStorage.branches.get(branchId)
        if (branch === undefined || branch.sessionId !== sessionId) {
          return yield* Effect.die(`Branch "${branchId}" not found in current session`)
        }
        yield* testStorage.storage.deleteMessages(branchId, afterMessageId)
      }),
    updateReasoningLevel: ({ reasoningLevel }) => Effect.succeed({ reasoningLevel }),
  }
  const deps: MakeExtensionHostContextDeps = {
    platform: {
      cwd: "/tmp",
      home: "/tmp",
      platform: "test",
    } as MakeExtensionHostContextDeps["platform"],
    extensionStateRuntime: {
      send: die("ActorRouter"),
      execute: die("ActorRouter"),
    } as unknown as MakeExtensionHostContextDeps["extensionStateRuntime"],
    actorEngine: {
      spawn: die("ActorEngine"),
      tell: die("ActorEngine"),
      ask: die("ActorEngine"),
      snapshot: die("ActorEngine"),
    } as unknown as MakeExtensionHostContextDeps["actorEngine"],
    receptionist: {
      register: die("Receptionist"),
      unregister: die("Receptionist"),
      find: die("Receptionist"),
      subscribe: die("Receptionist"),
    } as unknown as MakeExtensionHostContextDeps["receptionist"],
    approvalService: {
      present: die("ApprovalService"),
      storeResolution: die("ApprovalService"),
      respond: die("ApprovalService"),
      rehydrate: die("ApprovalService"),
    } as MakeExtensionHostContextDeps["approvalService"],
    promptPresenter: {
      present: die("PromptPresenter"),
      confirm: die("PromptPresenter"),
      review: die("PromptPresenter"),
    } as MakeExtensionHostContextDeps["promptPresenter"],
    extensionRegistry: {
      getAgent: die("ExtensionRegistry"),
      resolveDualModelPair: die("ExtensionRegistry"),
    } as unknown as MakeExtensionHostContextDeps["extensionRegistry"],
    storage: testStorage.storage,
    searchStorage: {
      searchMessages: () => Effect.succeed([]),
    } as MakeExtensionHostContextDeps["searchStorage"],
    agentRunner: {
      run: die("AgentRunnerService"),
    } as MakeExtensionHostContextDeps["agentRunner"],
    sessionMutations,
    turnControl: {
      queueFollowUp: die("ExtensionTurnControl"),
    } as unknown as MakeExtensionHostContextDeps["turnControl"],
  }
  return { deps, published }
}
const SESSION_ID = SessionId.make("test-session")
const BRANCH_ID = BranchId.make("test-branch")
const failingSessionMutations = (): MakeExtensionHostContextDeps["sessionMutations"] => {
  const fail = () => Effect.fail(new EventStoreError({ message: "publish failed" }))
  return {
    renameSession: fail,
    createSessionBranch: fail,
    forkSessionBranch: fail,
    switchActiveBranch: fail,
    createChildSession: fail,
    deleteSession: fail,
    deleteBranch: fail,
    deleteMessages: fail,
    updateReasoningLevel: fail,
  }
}
const seedSession = (testStorage: ReturnType<typeof createTestStorage>) => {
  const session = new Session({
    id: SESSION_ID,
    name: "test",
    cwd: "/tmp",
    activeBranchId: BRANCH_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  testStorage.sessions.set(SESSION_ID, session)
  const branch = new Branch({
    id: BRANCH_ID,
    sessionId: SESSION_ID,
    createdAt: new Date(),
  })
  testStorage.branches.set(BRANCH_ID, branch)
  return { session, branch }
}
const seedMessages = (testStorage: ReturnType<typeof createTestStorage>, count: number) => {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    const msg = Message.Regular.make({
      id: MessageId.make(`msg-${i}`),
      sessionId: SESSION_ID,
      branchId: BRANCH_ID,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [new TextPart({ type: "text", text: `message ${i}` })],
      createdAt: new Date(Date.now() + i * 1000),
    })
    msgs.push(msg)
  }
  testStorage.messages.set(BRANCH_ID, msgs)
  return msgs
}
describe("session mutation primitives", () => {
  it.live("listBranches returns branches for current session", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const branches = yield* ctx.session.listBranches()
      expect(branches).toHaveLength(1)
      expect(branches[0]!.id).toBe(BRANCH_ID)
    }),
  )
  it.live("createBranch creates a branch and publishes event", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps, published } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const result = yield* ctx.session.createBranch({ name: "feature" })
      expect(result.branchId).toBeDefined()
      expect(testStorage.branches.get(result.branchId)?.name).toBe("feature")
      expect(published.some((e) => e._tag === "BranchCreated")).toBe(true)
    }),
  )
  it.live("forkBranch copies messages up to target", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const msgs = seedMessages(testStorage, 4)
      msgs[1] = Message.Interjection.make({
        id: msgs[1]!.id,
        sessionId: SESSION_ID,
        branchId: BRANCH_ID,
        role: "user",
        parts: [new TextPart({ type: "text", text: "steer" })],
        createdAt: msgs[1]!.createdAt,
      })
      testStorage.messages.set(BRANCH_ID, msgs)
      const { deps, published } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const result = yield* ctx.session.forkBranch({ atMessageId: msgs[1]!.id, name: "fork" })
      expect(result.branchId).toBeDefined()
      const forkedMessages = testStorage.messages.get(result.branchId) ?? []
      expect(forkedMessages).toHaveLength(2) // msg-0 and msg-1
      expect(forkedMessages[1]?._tag).toBe("interjection")
      expect(published.some((e) => e._tag === "BranchCreated")).toBe(true)
    }),
  )
  it.live("forkBranch rolls back copied messages when publishing fails", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const msgs = seedMessages(testStorage, 2)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext(
        { sessionId: SESSION_ID, branchId: BRANCH_ID },
        {
          ...deps,
          sessionMutations: failingSessionMutations(),
        },
      )
      const exit = yield* Effect.exit(
        ctx.session.forkBranch({ atMessageId: msgs[1]!.id, name: "fork" }),
      )
      expect(String(exit)).toContain("publish failed")
      expect(testStorage.branches.size).toBe(1)
      expect(testStorage.messages.size).toBe(1)
      expect(testStorage.messages.get(BRANCH_ID)).toHaveLength(2)
    }),
  )
  it.live("switchBranch updates session activeBranchId", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps, published } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      // Create a second branch to switch to
      const newBranch = new Branch({
        id: BranchId.make("branch-2"),
        sessionId: SESSION_ID,
        createdAt: new Date(),
      })
      testStorage.branches.set(newBranch.id, newBranch)
      yield* ctx.session.switchBranch({ toBranchId: newBranch.id })
      const updated = testStorage.sessions.get(SESSION_ID)!
      expect(updated.activeBranchId).toBe(BranchId.make("branch-2"))
      expect(published.some((e) => e._tag === "BranchSwitched")).toBe(true)
    }),
  )
  it.live("createChildSession creates session with parent pointer", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps, published } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const result = yield* ctx.session.createChildSession({ name: "child", cwd: "/tmp/child" })
      expect(result.sessionId).toBeDefined()
      expect(result.branchId).toBeDefined()
      const child = testStorage.sessions.get(result.sessionId)!
      expect(child.parentSessionId).toBe(SESSION_ID)
      expect(child.parentBranchId).toBe(BRANCH_ID)
      expect(child.cwd).toBe("/tmp/child")
      expect(published.some((e) => e._tag === "SessionStarted")).toBe(true)
    }),
  )
  it.live("createChildSession rolls back session and branch when publishing fails", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext(
        { sessionId: SESSION_ID, branchId: BRANCH_ID },
        {
          ...deps,
          sessionMutations: failingSessionMutations(),
        },
      )
      const exit = yield* Effect.exit(
        ctx.session.createChildSession({ name: "child", cwd: "/tmp/child" }),
      )
      expect(String(exit)).toContain("publish failed")
      expect(testStorage.sessions.size).toBe(1)
      expect(testStorage.branches.size).toBe(1)
    }),
  )
  it.live("getChildSessions returns children of current session", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      // Create a child session
      yield* ctx.session.createChildSession({ name: "child-1" })
      const children = yield* ctx.session.getChildSessions()
      expect(children).toHaveLength(1)
      expect(children[0]!.parentSessionId).toBe(SESSION_ID)
    }),
  )
  it.live("deleteSession deletes a non-current session", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      // Create and delete a child session
      const { sessionId: childId } = yield* ctx.session.createChildSession({ name: "to-delete" })
      expect(testStorage.sessions.has(childId)).toBe(true)
      yield* ctx.session.deleteSession(childId)
      expect(testStorage.sessions.has(childId)).toBe(false)
    }),
  )
  it.live("deleteSession propagates command facade failure without storage fallback", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const childContext = makeExtensionHostContext(
        { sessionId: SESSION_ID, branchId: BRANCH_ID },
        deps,
      )
      const { sessionId: childId } = yield* childContext.session.createChildSession({
        name: "delete failure should surface",
      })
      expect(testStorage.sessions.has(childId)).toBe(true)
      const ctx = makeExtensionHostContext(
        { sessionId: SESSION_ID, branchId: BRANCH_ID },
        {
          ...deps,
          sessionMutations: {
            ...deps.sessionMutations,
            deleteSession: () => Effect.fail(new EventStoreError({ message: "delete failed" })),
          },
        },
      )
      const exit = yield* Effect.exit(ctx.session.deleteSession(childId))
      expect(String(exit)).toContain("delete failed")
      expect(testStorage.sessions.has(childId)).toBe(true)
    }),
  )
  it.live("deleteSession routes through command facade", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const { sessionId: childId } = yield* ctx.session.createChildSession({
        name: "to-delete-fallback",
      })
      expect(testStorage.sessions.has(childId)).toBe(true)
      yield* ctx.session.deleteSession(childId)
      expect(testStorage.sessions.has(childId)).toBe(false)
    }),
  )
  it.live("deleteSession guards against deleting current session", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const exit = yield* Effect.exit(ctx.session.deleteSession(SESSION_ID))
      expect(String(exit)).toContain("Cannot delete the current session")
    }),
  )
  it.live("deleteBranch deletes a non-current branch", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      // Create then delete a branch
      const { branchId } = yield* ctx.session.createBranch({ name: "to-delete" })
      expect(testStorage.branches.has(branchId)).toBe(true)
      yield* ctx.session.deleteBranch(branchId)
      expect(testStorage.branches.has(branchId)).toBe(false)
    }),
  )
  it.live("deleteBranch guards against deleting current branch", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const exit = yield* Effect.exit(ctx.session.deleteBranch(BRANCH_ID))
      expect(String(exit)).toContain("Cannot delete the current branch")
    }),
  )
  it.live("deleteMessages removes messages after cursor", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      seedMessages(testStorage, 4)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      yield* ctx.session.deleteMessages({ afterMessageId: MessageId.make("msg-1") })
      const remaining = testStorage.messages.get(BRANCH_ID) ?? []
      expect(remaining).toHaveLength(2) // msg-0 and msg-1
    }),
  )
  it.live("deleteMessages without cursor removes all messages", () =>
    Effect.gen(function* () {
      const testStorage = createTestStorage()
      seedSession(testStorage)
      seedMessages(testStorage, 4)
      const { deps } = makeTestDeps(testStorage)
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      yield* ctx.session.deleteMessages({})
      const remaining = testStorage.messages.get(BRANCH_ID)
      expect(remaining).toBeUndefined()
    }),
  )
})
