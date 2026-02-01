/**
 * Direct in-process client that calls GentCore directly without RPC layer.
 *
 * This avoids the scope issues with RpcTest.makeClient by directly invoking
 * the core service methods. Use this for embedded TUI where client and server
 * are in the same process.
 */

import { Effect, type Stream, type Runtime } from "effect"
import { GentCore, type GentCoreError } from "@gent/server"
import { AskUserHandler } from "@gent/tools"
import {
  AuthApi,
  Permission,
  PermissionHandler,
  PermissionRule,
  PlanHandler,
  AuthStore,
  AuthGuard,
  type AuthAuthorization,
  type AuthMethod,
  type ProviderId,
  type AgentName,
  type AuthProviderInfo,
  type EventEnvelope,
  type Model,
  type PermissionDecision,
  type PlanDecision,
} from "@gent/core"
import { ConfigService, ModelRegistry, type SteerCommand } from "@gent/runtime"
import { ProviderAuth } from "@gent/providers"

export interface MessageInfoReadonly {
  readonly id: string
  readonly sessionId: string
  readonly branchId: string
  readonly kind?: "regular" | "interjection"
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly parts: readonly unknown[]
  readonly createdAt: number
  readonly turnDurationMs?: number
}

export interface SessionInfo {
  id: string
  name?: string
  cwd?: string
  bypass?: boolean
  branchId?: string
  parentSessionId?: string
  parentBranchId?: string
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: string
  sessionId: string
  parentBranchId?: string
  parentMessageId?: string
  name?: string
  summary?: string
  createdAt: number
}

export interface BranchTreeNode {
  id: string
  name?: string
  summary?: string
  parentMessageId?: string
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

export interface SessionState {
  sessionId: string
  branchId: string
  messages: readonly MessageInfoReadonly[]
  lastEventId: number | null
  isStreaming: boolean
  agent: AgentName
  bypass?: boolean
}

export interface CreateSessionResult {
  sessionId: string
  branchId: string
  name: string
  bypass: boolean
}

/**
 * Direct client interface - same shape as GentRpcClient but with GentCoreError
 */
export interface DirectClient {
  createSession: (input?: {
    name?: string
    firstMessage?: string
    cwd?: string
    bypass?: boolean
  }) => Effect.Effect<CreateSessionResult, GentCoreError>

  listSessions: () => Effect.Effect<readonly SessionInfo[], GentCoreError>

  listModels: () => Effect.Effect<readonly Model[], GentCoreError>

  getSession: (sessionId: string) => Effect.Effect<SessionInfo | null, GentCoreError>

  deleteSession: (sessionId: string) => Effect.Effect<void, GentCoreError>

  listBranches: (sessionId: string) => Effect.Effect<readonly BranchInfo[], GentCoreError>

  createBranch: (
    sessionId: string,
    name?: string,
  ) => Effect.Effect<{ branchId: string }, GentCoreError>

  getBranchTree: (sessionId: string) => Effect.Effect<readonly BranchTreeNode[], GentCoreError>

  switchBranch: (input: {
    sessionId: string
    fromBranchId: string
    toBranchId: string
    summarize?: boolean
  }) => Effect.Effect<void, GentCoreError>

  forkBranch: (input: {
    sessionId: string
    fromBranchId: string
    atMessageId: string
    name?: string
  }) => Effect.Effect<{ branchId: string }, GentCoreError>

  sendMessage: (input: {
    sessionId: string
    branchId: string
    content: string
  }) => Effect.Effect<void, GentCoreError>

  listMessages: (branchId: string) => Effect.Effect<readonly MessageInfoReadonly[], GentCoreError>

  getSessionState: (input: {
    sessionId: string
    branchId: string
  }) => Effect.Effect<SessionState, GentCoreError>

  steer: (command: SteerCommand) => Effect.Effect<void, GentCoreError>

  subscribeEvents: (input: {
    sessionId: string
    branchId?: string
    after?: number
  }) => Stream.Stream<EventEnvelope, GentCoreError>

  respondQuestions: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void, GentCoreError>

  respondPermission: (
    requestId: string,
    decision: PermissionDecision,
    persist?: boolean,
  ) => Effect.Effect<void, GentCoreError>

  respondPlan: (
    requestId: string,
    decision: PlanDecision,
    reason?: string,
  ) => Effect.Effect<void, GentCoreError>

  compactBranch: (input: {
    sessionId: string
    branchId: string
  }) => Effect.Effect<void, GentCoreError>

  updateSessionBypass: (
    sessionId: string,
    bypass: boolean,
  ) => Effect.Effect<{ bypass: boolean }, GentCoreError>

  getPermissionRules: () => Effect.Effect<readonly PermissionRule[], GentCoreError>

  deletePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void, GentCoreError>

  listAuthProviders: () => Effect.Effect<readonly AuthProviderInfo[], GentCoreError>

  setAuthKey: (provider: string, key: string) => Effect.Effect<void, GentCoreError>

  deleteAuthKey: (provider: string) => Effect.Effect<void, GentCoreError>

  listAuthMethods: () => Effect.Effect<Record<string, ReadonlyArray<AuthMethod>>, GentCoreError>

  authorizeAuth: (
    sessionId: string,
    provider: string,
    method: number,
  ) => Effect.Effect<AuthAuthorization | null, GentCoreError>

  callbackAuth: (
    sessionId: string,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, GentCoreError>

  runtime: Runtime.Runtime<unknown>
}

/**
 * Context required to create a DirectClient
 */
export type DirectClientContext =
  | GentCore
  | AskUserHandler
  | PermissionHandler
  | PlanHandler
  | Permission
  | ConfigService
  | ModelRegistry
  | AuthStore
  | AuthGuard
  | ProviderAuth

/**
 * Creates a direct in-process client.
 * Must be run in a context that provides all required services.
 */
export const makeDirectClient: Effect.Effect<DirectClient, never, DirectClientContext> = Effect.gen(
  function* () {
    const core = yield* GentCore
    const askUserHandler = yield* AskUserHandler
    const permissionHandler = yield* PermissionHandler
    const planHandler = yield* PlanHandler
    const permission = yield* Permission
    const configService = yield* ConfigService
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const runtime = yield* Effect.runtime<never>()

    return {
      createSession: (input) =>
        core.createSession({
          ...(input?.name !== undefined ? { name: input.name } : {}),
          ...(input?.firstMessage !== undefined ? { firstMessage: input.firstMessage } : {}),
          ...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input?.bypass !== undefined ? { bypass: input.bypass } : {}),
        }),

      listSessions: () => core.listSessions(),

      listModels: () => modelRegistry.list(),

      getSession: (sessionId) => core.getSession(sessionId),

      deleteSession: (sessionId) => core.deleteSession(sessionId),

      listBranches: (sessionId) => core.listBranches(sessionId),

      createBranch: (sessionId, name) =>
        core.createBranch({
          sessionId,
          ...(name !== undefined ? { name } : {}),
        }),

      getBranchTree: (sessionId) => core.getBranchTree(sessionId),

      switchBranch: (input) =>
        core.switchBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
          ...(input.summarize !== undefined ? { summarize: input.summarize } : {}),
        }),

      forkBranch: (input) =>
        core.forkBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          atMessageId: input.atMessageId,
          ...(input.name !== undefined ? { name: input.name } : {}),
        }),

      sendMessage: (input) =>
        core.sendMessage({
          sessionId: input.sessionId,
          branchId: input.branchId,
          content: input.content,
        }),

      listMessages: (branchId) => core.listMessages(branchId),

      getSessionState: (input) =>
        core.getSessionState({ sessionId: input.sessionId, branchId: input.branchId }),

      steer: (command) => core.steer(command),

      subscribeEvents: (input) =>
        core.subscribeEvents({
          sessionId: input.sessionId,
          ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
        }),

      respondQuestions: (requestId, answers) => askUserHandler.respond(requestId, answers),

      respondPermission: (requestId, decision, persist) =>
        Effect.gen(function* () {
          const request = yield* permissionHandler.respond(requestId, decision)
          if (persist === true && request !== undefined) {
            const rule = new PermissionRule({
              tool: request.toolName,
              action: decision,
            })
            yield* configService.addPermissionRule(rule)
            yield* permission.addRule(rule)
          }
        }),

      respondPlan: (requestId, decision, reason) =>
        planHandler.respond(requestId, decision, reason),

      compactBranch: (input) =>
        core.compactBranch({ sessionId: input.sessionId, branchId: input.branchId }),

      updateSessionBypass: (sessionId, bypass) => core.updateSessionBypass({ sessionId, bypass }),

      getPermissionRules: () => configService.getPermissionRules(),

      deletePermissionRule: (tool, pattern) =>
        Effect.gen(function* () {
          yield* configService.removePermissionRule(tool, pattern)
          yield* permission.removeRule(tool, pattern)
        }),

      listAuthProviders: () => authGuard.listProviders(),

      setAuthKey: (provider, key) =>
        authStore
          .set(provider, new AuthApi({ type: "api", key }))
          .pipe(Effect.catchAll((e) => Effect.logWarning("setAuthKey failed", e))),

      deleteAuthKey: (provider) =>
        authStore
          .remove(provider)
          .pipe(Effect.catchAll((e) => Effect.logWarning("deleteAuthKey failed", e))),

      listAuthMethods: () => providerAuth.listMethods(),

      authorizeAuth: (sessionId, provider, method) =>
        providerAuth
          .authorize(sessionId, provider as ProviderId, method)
          .pipe(Effect.map((result) => result ?? null)),

      callbackAuth: (sessionId, provider, method, authorizationId, code) =>
        providerAuth.callback(sessionId, provider as ProviderId, method, authorizationId, code),

      runtime: runtime as Runtime.Runtime<unknown>,
    }
  },
)
