/**
 * Host facet survivor regression suite.
 *
 * After deleting 9 unused `ExtensionSession` CRUD methods in W33-C9.5,
 * `ctx.agent.require` and `ctx.session.listBranches` remain as the two
 * non-trivial host-wired behaviors with no other direct test coverage.
 * The RPC suites exercise the durable mutation surface from the public
 * RPC angle; these tests pin the host-facet shape from the extension
 * angle.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Option, Schema } from "effect"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "../../src/runtime/make-extension-host-context.js"
import { BranchId, SessionId } from "../../src/domain/ids.js"
import { AgentName } from "../../src/domain/agent.js"
import { ExtensionHostError } from "../../src/domain/extension-host-context.js"
import { dateFromMillis, Branch, Session } from "../../src/domain/message.js"
import { testExtensionHostContext } from "../../src/test-utils/index.js"

const SESSION_ID = SessionId.make("test-session")
const BRANCH_ID = BranchId.make("test-branch")
const FIXTURE_DATE = dateFromMillis(0)

const die = (label: string) => () => Effect.die(`${label} not wired in test`)

const baseDeps = (overrides: {
  getAgent: MakeExtensionHostContextDeps["extensionRegistry"]["getAgent"]
  listBranches: MakeExtensionHostContextDeps["branchStorage"]["listBranches"]
}): MakeExtensionHostContextDeps => ({
  platform: {
    cwd: "/tmp",
    home: "/tmp",
    platform: "test",
  } as MakeExtensionHostContextDeps["platform"],
  host: testExtensionHostContext().host,
  approvalService: {
    present: die("ApprovalService.present"),
    pendingRequestId: () => Effect.void,
    storeResolution: die("ApprovalService.storeResolution"),
    respond: die("ApprovalService.respond"),
    rehydrate: die("ApprovalService.rehydrate"),
  } as MakeExtensionHostContextDeps["approvalService"],
  promptPresenter: {
    present: die("PromptPresenter.present"),
    confirm: die("PromptPresenter.confirm"),
    review: die("PromptPresenter.review"),
  } as MakeExtensionHostContextDeps["promptPresenter"],
  extensionRegistry: {
    getAgent: overrides.getAgent,
    listAgents: die("listAgents"),
  } as unknown as MakeExtensionHostContextDeps["extensionRegistry"],
  sessionStorage: {
    getSession: die("getSession"),
    updateSession: die("updateSession"),
    createSession: die("createSession"),
    deleteSession: die("deleteSession"),
    getLastSessionByCwd: die("getLastSessionByCwd"),
    listSessions: die("listSessions"),
  } as MakeExtensionHostContextDeps["sessionStorage"],
  branchStorage: {
    listBranches: overrides.listBranches,
    createBranch: die("createBranch"),
    getBranch: die("getBranch"),
    deleteBranch: die("deleteBranch"),
    updateBranchSummary: die("updateBranchSummary"),
    countMessages: die("countMessages"),
    countMessagesByBranches: die("countMessagesByBranches"),
  } as MakeExtensionHostContextDeps["branchStorage"],
  messageStorage: {
    listMessages: die("listMessages"),
    createMessage: die("createMessage"),
    createMessageIfAbsent: die("createMessageIfAbsent"),
    getMessage: die("getMessage"),
    deleteMessages: die("deleteMessages"),
    updateMessageTurnDuration: die("updateMessageTurnDuration"),
  } as MakeExtensionHostContextDeps["messageStorage"],
  relationshipStorage: {
    getChildSessions: die("getChildSessions"),
    getSessionAncestors: die("getSessionAncestors"),
    getSessionDetail: die("getSessionDetail"),
  } as MakeExtensionHostContextDeps["relationshipStorage"],
  searchStorage: {
    searchMessages: () => Effect.succeed([]),
  } as MakeExtensionHostContextDeps["searchStorage"],
  agentRunner: {
    run: die("agentRunner.run"),
  } as MakeExtensionHostContextDeps["agentRunner"],
  sessionMutations: {
    renameSession: die("renameSession"),
    createSessionBranch: die("createSessionBranch"),
    forkSessionBranch: die("forkSessionBranch"),
    switchActiveBranch: die("switchActiveBranch"),
    createChildSession: die("createChildSession"),
    deleteSession: die("deleteSession"),
    deleteBranch: die("deleteBranch"),
    deleteMessages: die("deleteMessages"),
    updateReasoningLevel: die("updateReasoningLevel"),
  } as MakeExtensionHostContextDeps["sessionMutations"],
  sessionControl: {
    queueFollowUp: die("queueFollowUp"),
  } as MakeExtensionHostContextDeps["sessionControl"],
})

describe("host facet survivors after C9.5 prune", () => {
  it.live("ctx.agent.require returns typed ExtensionHostError when the agent is missing", () =>
    Effect.gen(function* () {
      const deps = baseDeps({
        getAgent: () => Effect.sync(() => undefined),
        listBranches: die("listBranches"),
      })
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const exit = yield* Effect.exit(ctx.agent.require(AgentName.make("missing-agent")))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(ExtensionHostError)(error.value)).toBe(true)
      if (!Schema.is(ExtensionHostError)(error.value)) return
      expect(error.value.operation).toBe("agent.require")
      expect(error.value.message).toBe('Agent "missing-agent" not found in registry')
    }),
  )

  it.live("ctx.session.listBranches returns branches for the current session", () =>
    Effect.gen(function* () {
      const session = new Session({
        id: SESSION_ID,
        name: "test",
        cwd: "/tmp",
        activeBranchId: BRANCH_ID,
        createdAt: FIXTURE_DATE,
        updatedAt: FIXTURE_DATE,
      })
      void session
      const branch = new Branch({
        id: BRANCH_ID,
        sessionId: SESSION_ID,
        createdAt: FIXTURE_DATE,
      })
      const deps = baseDeps({
        getAgent: die("getAgent"),
        listBranches: (id) => (id === SESSION_ID ? Effect.succeed([branch]) : Effect.succeed([])),
      })
      const ctx = makeExtensionHostContext({ sessionId: SESSION_ID, branchId: BRANCH_ID }, deps)
      const branches = yield* ctx.session.listBranches()
      expect(branches).toHaveLength(1)
      expect(branches[0]!.id).toBe(BRANCH_ID)
    }),
  )
})
