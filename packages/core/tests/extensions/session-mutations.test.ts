import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "@gent/core/runtime/make-extension-host-context"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids"
import { Message, Session, Branch, TextPart } from "@gent/core/domain/message"

// Minimal in-memory storage for session mutation tests
const createTestStorage = () => {
  const sessions = new Map<string, Session>()
  const branches = new Map<string, Branch>()
  const messages = new Map<string, Message[]>()

  const die = (label: string) => () => Effect.die(`${label} not implemented in test`)

  return {
    storage: {
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
  const published: Array<{ _tag: string }> = []

  const deps: MakeExtensionHostContextDeps = {
    platform: {
      cwd: "/tmp",
      home: "/tmp",
      platform: "test",
    } as MakeExtensionHostContextDeps["platform"],
    extensionStateRuntime: {
      send: die("ExtensionStateRuntime"),
      ask: die("ExtensionStateRuntime"),
      getUiSnapshots: die("ExtensionStateRuntime"),
    } as unknown as MakeExtensionHostContextDeps["extensionStateRuntime"],
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
    turnControl: {
      queueFollowUp: die("TurnControl"),
      interject: die("TurnControl"),
      bind: die("TurnControl"),
    } as MakeExtensionHostContextDeps["turnControl"],
    storage: testStorage.storage,
    searchStorage: {
      searchMessages: () => Effect.succeed([]),
    } as MakeExtensionHostContextDeps["searchStorage"],
    agentRunner: {
      run: die("AgentRunnerService"),
    } as MakeExtensionHostContextDeps["agentRunner"],
    eventPublisher: {
      publish: (event: { _tag: string }) => {
        published.push(event)
        return Effect.void
      },
      terminateSession: die("EventPublisher"),
    } as MakeExtensionHostContextDeps["eventPublisher"],
  }

  return { deps, published }
}

const SESSION_ID = "test-session" as SessionId
const BRANCH_ID = "test-branch" as BranchId

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
    const msg = new Message({
      id: `msg-${i}` as MessageId,
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
  test("listBranches returns branches for current session", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    const branches = await Effect.runPromise(ctx.session.listBranches())
    expect(branches).toHaveLength(1)
    expect(branches[0]!.id).toBe(BRANCH_ID)
  })

  test("createBranch creates a branch and publishes event", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps, published } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    const result = await Effect.runPromise(ctx.session.createBranch({ name: "feature" }))
    expect(result.branchId).toBeDefined()
    expect(testStorage.branches.get(result.branchId)?.name).toBe("feature")
    expect(published.some((e) => e._tag === "BranchCreated")).toBe(true)
  })

  test("forkBranch copies messages up to target", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const msgs = seedMessages(testStorage, 4)
    const { deps, published } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    const result = await Effect.runPromise(
      ctx.session.forkBranch({ atMessageId: msgs[1]!.id, name: "fork" }),
    )
    expect(result.branchId).toBeDefined()

    const forkedMessages = testStorage.messages.get(result.branchId) ?? []
    expect(forkedMessages).toHaveLength(2) // msg-0 and msg-1
    expect(published.some((e) => e._tag === "BranchCreated")).toBe(true)
  })

  test("switchBranch updates session activeBranchId", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps, published } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    // Create a second branch to switch to
    const newBranch = new Branch({
      id: "branch-2" as BranchId,
      sessionId: SESSION_ID,
      createdAt: new Date(),
    })
    testStorage.branches.set(newBranch.id, newBranch)

    await Effect.runPromise(ctx.session.switchBranch({ toBranchId: newBranch.id }))

    const updated = testStorage.sessions.get(SESSION_ID)!
    expect(updated.activeBranchId).toBe("branch-2")
    expect(published.some((e) => e._tag === "BranchSwitched")).toBe(true)
  })

  test("createChildSession creates session with parent pointer", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps, published } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    const result = await Effect.runPromise(
      ctx.session.createChildSession({ name: "child", cwd: "/tmp/child" }),
    )
    expect(result.sessionId).toBeDefined()
    expect(result.branchId).toBeDefined()

    const child = testStorage.sessions.get(result.sessionId)!
    expect(child.parentSessionId).toBe(SESSION_ID)
    expect(child.parentBranchId).toBe(BRANCH_ID)
    expect(child.cwd).toBe("/tmp/child")
    expect(published.some((e) => e._tag === "SessionStarted")).toBe(true)
  })

  test("getChildSessions returns children of current session", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    // Create a child session
    await Effect.runPromise(ctx.session.createChildSession({ name: "child-1" }))

    const children = await Effect.runPromise(ctx.session.getChildSessions())
    expect(children).toHaveLength(1)
    expect(children[0]!.parentSessionId).toBe(SESSION_ID)
  })

  test("deleteSession deletes a non-current session", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    // Create and delete a child session
    const { sessionId: childId } = await Effect.runPromise(
      ctx.session.createChildSession({ name: "to-delete" }),
    )
    expect(testStorage.sessions.has(childId)).toBe(true)

    await Effect.runPromise(ctx.session.deleteSession(childId))
    expect(testStorage.sessions.has(childId)).toBe(false)
  })

  test("deleteSession guards against deleting current session", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    await expect(Effect.runPromise(ctx.session.deleteSession(SESSION_ID))).rejects.toThrow(
      "Cannot delete the current session",
    )
  })

  test("deleteBranch deletes a non-current branch", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    // Create then delete a branch
    const { branchId } = await Effect.runPromise(ctx.session.createBranch({ name: "to-delete" }))
    expect(testStorage.branches.has(branchId)).toBe(true)

    await Effect.runPromise(ctx.session.deleteBranch(branchId))
    expect(testStorage.branches.has(branchId)).toBe(false)
  })

  test("deleteBranch guards against deleting current branch", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    await expect(Effect.runPromise(ctx.session.deleteBranch(BRANCH_ID))).rejects.toThrow(
      "Cannot delete the current branch",
    )
  })

  test("deleteMessages removes messages after cursor", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    seedMessages(testStorage, 4)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    await Effect.runPromise(ctx.session.deleteMessages({ afterMessageId: "msg-1" as MessageId }))

    const remaining = testStorage.messages.get(BRANCH_ID) ?? []
    expect(remaining).toHaveLength(2) // msg-0 and msg-1
  })

  test("deleteMessages without cursor removes all messages", async () => {
    const testStorage = createTestStorage()
    seedSession(testStorage)
    seedMessages(testStorage, 4)
    const { deps } = makeTestDeps(testStorage)
    const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)

    await Effect.runPromise(ctx.session.deleteMessages({}))

    const remaining = testStorage.messages.get(BRANCH_ID)
    expect(remaining).toBeUndefined()
  })
})
