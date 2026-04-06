/**
 * Factory for ExtensionHostContext — the unified capability-shaped boundary
 * that extension code (tools, interceptors) uses to access host services.
 *
 * Single wiring point: ToolRunner and agent-loop both call this.
 */

import { DateTime, Effect } from "effect"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import type { AgentRunner, AgentName } from "../domain/agent.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { ExtensionStateRuntimeService } from "./extensions/state-runtime.js"
import type { RuntimePlatformShape } from "./runtime-platform.js"
import type { ApprovalServiceShape } from "./approval-service.js"
import type { PromptPresenterService } from "../domain/prompt-presenter.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import type { ExtensionTurnControlService } from "./extensions/turn-control.js"
import type { StorageService } from "../storage/sqlite-storage.js"
import type { SearchStorageService } from "../storage/search-storage.js"
import type { Message } from "../domain/message.js"
import type { EventPublisherService } from "../domain/event-publisher.js"
import { estimateContextPercent } from "./context-estimation.js"
import { SessionNameUpdated } from "../domain/event.js"
import { Session } from "../domain/message.js"

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
}

export const makeExtensionHostContext = (
  runInfo: MakeExtensionHostContextRunInfo,
  deps: MakeExtensionHostContextDeps,
): ExtensionHostContext => ({
  sessionId: runInfo.sessionId,
  branchId: runInfo.branchId,
  agentName: runInfo.agentName,
  cwd: deps.platform.cwd,
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
        cwd: params.cwd ?? deps.platform.cwd,
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
