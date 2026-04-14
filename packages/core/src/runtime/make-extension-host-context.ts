/**
 * Factory for ExtensionHostContext — the unified capability-shaped boundary
 * that extension code (tools, interceptors) uses to access host services.
 *
 * Single wiring point: ToolRunner and agent-loop both call this.
 */

import { DateTime, Effect } from "effect"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import type { AgentRunner, AgentName } from "../domain/agent.js"
import type { BranchId, MessageId, SessionId } from "../domain/ids.js"
import type { ExtensionStateRuntimeService } from "./extensions/state-runtime.js"
import type { RuntimePlatformShape } from "./runtime-platform.js"
import type { ApprovalServiceShape } from "./approval-service.js"
import type { PromptPresenterService } from "../domain/prompt-presenter.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import type { ExtensionTurnControlService } from "./extensions/turn-control.js"
import type { StorageService } from "../storage/sqlite-storage.js"
import type { SearchStorageService } from "../storage/search-storage.js"
import { Message, Session, Branch } from "../domain/message.js"
import type { EventPublisherService } from "../domain/event-publisher.js"
import { estimateContextPercent } from "./context-estimation.js"
import {
  SessionNameUpdated,
  BranchCreated,
  BranchSwitched,
  SessionStarted,
} from "../domain/event.js"

export interface MakeExtensionHostContextDeps {
  readonly platform: RuntimePlatformShape
  readonly extensionStateRuntime: ExtensionStateRuntimeService
  readonly approvalService: ApprovalServiceShape
  readonly promptPresenter: PromptPresenterService
  readonly extensionRegistry: ExtensionRegistryService
  readonly turnControl: ExtensionTurnControlService
  readonly storage: StorageService
  readonly searchStorage: SearchStorageService
  readonly agentRunner: AgentRunner
  readonly eventPublisher: EventPublisherService
}

export interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  /** Session-scoped cwd. Falls back to RuntimePlatform.cwd when absent. */
  readonly sessionCwd?: string
}

export const makeExtensionHostContext = (
  runInfo: MakeExtensionHostContextRunInfo,
  deps: MakeExtensionHostContextDeps,
): ExtensionHostContext => ({
  sessionId: runInfo.sessionId,
  branchId: runInfo.branchId,
  agentName: runInfo.agentName,
  cwd: runInfo.sessionCwd ?? deps.platform.cwd,
  home: deps.platform.home,

  extension: {
    send: (message, branchId) =>
      deps.extensionStateRuntime.send(runInfo.sessionId, message, branchId ?? runInfo.branchId),
    ask: (message, branchId) =>
      deps.extensionStateRuntime.ask(runInfo.sessionId, message, branchId ?? runInfo.branchId),
    getUiSnapshots: (branchId) =>
      deps.extensionStateRuntime.getUiSnapshots(runInfo.sessionId, branchId ?? runInfo.branchId),
    getUiSnapshot: <T>(extensionId: string, branchId?: BranchId) =>
      deps.extensionStateRuntime
        .getUiSnapshots(runInfo.sessionId, branchId ?? runInfo.branchId)
        .pipe(
          Effect.map((snapshots) => {
            const match = snapshots.find((s) => s.extensionId === extensionId)
            return match?.model as T | undefined
          }),
        ),
  },

  agent: {
    get: (name) => deps.extensionRegistry.getAgent(name),
    require: (name) =>
      deps.extensionRegistry
        .getAgent(name)
        .pipe(
          Effect.flatMap((agent) =>
            agent !== undefined
              ? Effect.succeed(agent)
              : Effect.die(`Agent "${name}" not found in registry`),
          ),
        ),
    run: (params) =>
      deps.agentRunner.run({
        agent: params.agent,
        prompt: params.prompt,
        parentSessionId: runInfo.sessionId,
        parentBranchId: runInfo.branchId,
        toolCallId: params.toolCallId,
        cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
        overrides: params.overrides,
        persistence: params.persistence,
      }),
    resolveDualModelPair: () => deps.extensionRegistry.resolveDualModelPair(),
  },

  session: {
    listMessages: (branchId) => deps.storage.listMessages(branchId ?? runInfo.branchId),
    getSession: (sessionId) => deps.storage.getSession(sessionId ?? runInfo.sessionId),
    getDetail: (sessionId) => deps.storage.getSessionDetail(sessionId),
    renameCurrent: (name) =>
      Effect.gen(function* () {
        const trimmed = name.trim().slice(0, 80)
        if (trimmed.length === 0) return { renamed: false as const }
        const session = yield* deps.storage.getSession(runInfo.sessionId)
        if (session === undefined) return { renamed: false as const }
        if (session.name === trimmed) return { renamed: false as const }
        const updated = new Session({
          ...session,
          name: trimmed,
          updatedAt: yield* DateTime.nowAsDate,
        })
        yield* deps.storage.updateSession(updated)
        yield* deps.eventPublisher.publish(
          new SessionNameUpdated({ sessionId: runInfo.sessionId, name: trimmed }),
        )
        return { renamed: true as const, name: trimmed }
      }),
    estimateContextPercent: (options) =>
      Effect.gen(function* () {
        const messages: ReadonlyArray<Message> = yield* deps.storage.listMessages(runInfo.branchId)
        const modelId = options?.modelId ?? "anthropic/claude-opus-4-6"
        return estimateContextPercent(messages, modelId)
      }),
    search: (query, options) => deps.searchStorage.searchMessages(query, options),

    listBranches: () => deps.storage.listBranches(runInfo.sessionId),

    createBranch: (params) =>
      Effect.gen(function* () {
        const branch = new Branch({
          id: Bun.randomUUIDv7() as BranchId,
          sessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
          name: params.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* deps.storage.createBranch(branch)
        yield* deps.eventPublisher.publish(
          new BranchCreated({
            sessionId: runInfo.sessionId,
            branchId: branch.id,
            parentBranchId: runInfo.branchId,
          }),
        )
        return { branchId: branch.id }
      }),

    forkBranch: (params) =>
      Effect.gen(function* () {
        const messages = yield* deps.storage.listMessages(runInfo.branchId)
        const targetIndex = messages.findIndex((m) => m.id === params.atMessageId)
        if (targetIndex === -1) return yield* Effect.die("Message not found in current branch")

        const branch = new Branch({
          id: Bun.randomUUIDv7() as BranchId,
          sessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
          parentMessageId: params.atMessageId,
          name: params.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* deps.storage.createBranch(branch)

        for (const msg of messages.slice(0, targetIndex + 1)) {
          yield* deps.storage.createMessage(
            new Message({
              id: Bun.randomUUIDv7() as MessageId,
              sessionId: msg.sessionId,
              branchId: branch.id,
              role: msg.role,
              parts: msg.parts,
              createdAt: msg.createdAt,
              ...(msg.turnDurationMs !== undefined ? { turnDurationMs: msg.turnDurationMs } : {}),
            }),
          )
        }

        yield* deps.eventPublisher.publish(
          new BranchCreated({
            sessionId: runInfo.sessionId,
            branchId: branch.id,
            parentBranchId: runInfo.branchId,
          }),
        )
        return { branchId: branch.id }
      }),

    switchBranch: (params) =>
      Effect.gen(function* () {
        const targetBranch = yield* deps.storage.getBranch(params.toBranchId)
        if (targetBranch === undefined) {
          return yield* Effect.die(`Branch "${params.toBranchId}" not found`)
        }
        if (targetBranch.sessionId !== runInfo.sessionId) {
          return yield* Effect.die(`Branch "${params.toBranchId}" belongs to a different session`)
        }
        const session = yield* deps.storage.getSession(runInfo.sessionId)
        if (session === undefined) return yield* Effect.die("Current session not found")
        const updated = new Session({
          ...session,
          activeBranchId: params.toBranchId,
          updatedAt: yield* DateTime.nowAsDate,
        })
        yield* deps.storage.updateSession(updated)
        yield* deps.eventPublisher.publish(
          new BranchSwitched({
            sessionId: runInfo.sessionId,
            fromBranchId: runInfo.branchId,
            toBranchId: params.toBranchId,
          }),
        )
      }),

    createChildSession: (params) =>
      Effect.gen(function* () {
        const now = yield* DateTime.nowAsDate
        const sessionId = Bun.randomUUIDv7() as SessionId
        const branchId = Bun.randomUUIDv7() as BranchId
        const session = new Session({
          id: sessionId,
          name: params.name ?? "child session",
          cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
          createdAt: now,
          updatedAt: now,
          activeBranchId: branchId,
        })
        yield* deps.storage.createSession(session)
        const branch = new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        })
        yield* deps.storage.createBranch(branch)
        yield* deps.eventPublisher.publish(new SessionStarted({ sessionId, branchId }))
        return { sessionId, branchId }
      }),

    getChildSessions: () => deps.storage.getChildSessions(runInfo.sessionId),

    getSessionAncestors: (sessionId) =>
      deps.storage.getSessionAncestors(sessionId ?? runInfo.sessionId),

    deleteSession: (sessionId) =>
      Effect.gen(function* () {
        if (sessionId === runInfo.sessionId) {
          return yield* Effect.die("Cannot delete the current session from within it")
        }
        // Prefer SessionCommands for full cleanup (terminate actors, events, etc.)
        const { SessionCommands } = yield* Effect.promise(
          () => import("../server/session-commands.js"),
        )
        const cmds = yield* Effect.serviceOption(SessionCommands)
        if (cmds._tag === "Some") {
          yield* cmds.value.deleteSession(sessionId).pipe(Effect.catchEager(() => Effect.void))
        } else {
          yield* deps.storage.deleteSession(sessionId)
        }
      }),

    deleteBranch: (branchId) =>
      Effect.gen(function* () {
        if (branchId === runInfo.branchId) {
          return yield* Effect.die("Cannot delete the current branch")
        }
        yield* deps.storage.deleteBranch(branchId)
      }),

    deleteMessages: (params) =>
      deps.storage.deleteMessages(runInfo.branchId, params.afterMessageId),
  },

  interaction: {
    approve: (params) =>
      deps.approvalService.present(params, {
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
      }),
    present: (params) =>
      deps.promptPresenter.present({
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
        ...params,
      }),
    confirm: (params) =>
      deps.promptPresenter.confirm({
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
        ...params,
      }),
    review: (params) =>
      deps.promptPresenter.review({
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
        ...params,
      }),
  },

  turn: {
    queueFollowUp: (params) =>
      deps.turnControl.queueFollowUp({
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
        ...params,
      }),
    interject: (params) =>
      deps.turnControl.interject({
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
        ...params,
      }),
  },
})
