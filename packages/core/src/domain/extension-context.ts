/**
 * ExtensionContext — Promise-based facade over ExtensionHostContext.
 *
 * Third-party extension authors use this. Same capabilities as ExtensionHostContext,
 * but every method returns a Promise instead of an Effect.
 *
 * Created via `toExtensionContext(hostCtx)`.
 *
 * @module
 */

import { Effect } from "effect"
import type {
  AgentDefinition,
  AgentExecutionOverrides,
  AgentName,
  AgentPersistence,
  AgentRunResult,
} from "./agent.js"
import type { ExtensionUiSnapshot } from "./event.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "./extension-protocol.js"
import type { BranchId, SessionId, ToolCallId } from "./ids.js"
import type { ApprovalDecision, ApprovalRequest } from "./interaction-request.js"
import type { Branch, Message, MessageMetadata, Session } from "./message.js"
import type { ModelId } from "./model.js"
import type { SearchResult } from "../storage/search-storage.js"
import type { ExtensionHostContext } from "./extension-host-context.js"

// ---------------------------------------------------------------------------
// ExtensionContext — Promise-returning, author-facing
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly cwd: string
  readonly home: string

  readonly extension: ExtensionContext.Extension
  readonly agent: ExtensionContext.Agent
  readonly session: ExtensionContext.SessionFacet
  readonly interaction: ExtensionContext.Interaction
  readonly turn: ExtensionContext.Turn
}

export declare namespace ExtensionContext {
  interface Extension {
    readonly send: (message: AnyExtensionCommandMessage, branchId?: BranchId) => Promise<void>

    readonly ask: <M extends AnyExtensionRequestMessage>(
      message: M,
      branchId?: BranchId,
    ) => Promise<ExtractExtensionReply<M>>

    readonly getUiSnapshots: (branchId?: BranchId) => Promise<ReadonlyArray<ExtensionUiSnapshot>>

    readonly getUiSnapshot: <T>(extensionId: string, branchId?: BranchId) => Promise<T | undefined>
  }

  interface Agent {
    readonly get: (name: AgentName) => Promise<AgentDefinition | undefined>
    readonly require: (name: AgentName) => Promise<AgentDefinition>

    readonly run: (params: {
      agent: AgentDefinition
      prompt: string
      cwd?: string
      toolCallId?: ToolCallId
      overrides?: AgentExecutionOverrides
      persistence?: AgentPersistence
    }) => Promise<AgentRunResult>

    readonly resolveDualModelPair: () => Promise<readonly [ModelId, ModelId]>
  }

  interface SessionFacet {
    readonly listMessages: (branchId?: BranchId) => Promise<ReadonlyArray<Message>>

    readonly getSession: (sessionId?: SessionId) => Promise<Session | undefined>

    readonly getDetail: (sessionId: SessionId) => Promise<{
      session: Session
      branches: ReadonlyArray<{
        branch: Branch
        messages: ReadonlyArray<Message>
      }>
    }>

    readonly renameCurrent: (name: string) => Promise<{ renamed: boolean; name?: string }>

    readonly estimateContextPercent: (options?: { modelId?: string }) => Promise<number>

    readonly search: (
      query: string,
      options?: {
        sessionId?: string
        dateAfter?: number
        dateBefore?: number
        limit?: number
      },
    ) => Promise<ReadonlyArray<SearchResult>>
  }

  interface Interaction {
    readonly approve: (params: ApprovalRequest) => Promise<ApprovalDecision>

    readonly present: (params: { content: string; title?: string }) => Promise<void>

    readonly confirm: (params: { content: string; title?: string }) => Promise<"yes" | "no">

    readonly review: (params: {
      content: string
      title?: string
      fileNameSeed: string
    }) => Promise<{ decision: "yes" | "no" | "edit"; path: string; content?: string }>
  }

  interface Turn {
    readonly queueFollowUp: (params: {
      content: string
      metadata?: MessageMetadata
    }) => Promise<void>

    readonly interject: (params: { content: string }) => Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Adapter — wraps ExtensionHostContext (Effect) → ExtensionContext (Promise)
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

export const toExtensionContext = (ctx: ExtensionHostContext): ExtensionContext => ({
  sessionId: ctx.sessionId,
  branchId: ctx.branchId,
  agentName: ctx.agentName,
  cwd: ctx.cwd,
  home: ctx.home,

  extension: {
    send: (message, branchId) => run(ctx.extension.send(message, branchId)),
    ask: (message, branchId) => run(ctx.extension.ask(message, branchId)),
    getUiSnapshots: (branchId) => run(ctx.extension.getUiSnapshots(branchId)),
    getUiSnapshot: (extensionId, branchId) =>
      run(ctx.extension.getUiSnapshot(extensionId, branchId)),
  },

  agent: {
    get: (name) => run(ctx.agent.get(name)),
    require: (name) => run(ctx.agent.require(name)),
    run: (params) => run(ctx.agent.run(params)),
    resolveDualModelPair: () => run(ctx.agent.resolveDualModelPair()),
  },

  session: {
    listMessages: (branchId) => run(ctx.session.listMessages(branchId)),
    getSession: (sessionId) => run(ctx.session.getSession(sessionId)),
    getDetail: (sessionId) => run(ctx.session.getDetail(sessionId)),
    renameCurrent: (name) => run(ctx.session.renameCurrent(name)),
    estimateContextPercent: (options) => run(ctx.session.estimateContextPercent(options)),
    search: (query, options) => run(ctx.session.search(query, options)),
  },

  interaction: {
    approve: (params) => run(ctx.interaction.approve(params)),
    present: (params) => run(ctx.interaction.present(params)),
    confirm: (params) => run(ctx.interaction.confirm(params)),
    review: (params) => run(ctx.interaction.review(params)),
  },

  turn: {
    queueFollowUp: (params) => run(ctx.turn.queueFollowUp(params)),
    interject: (params) => run(ctx.turn.interject(params)),
  },
})
