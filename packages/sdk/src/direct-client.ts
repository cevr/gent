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
  Permission,
  PermissionHandler,
  PermissionRule,
  PlanHandler,
  AuthStorage,
  type AgentMode,
  type EventEnvelope,
  type PermissionDecision,
  type PlanDecision,
  type Model,
} from "@gent/core"
import { ConfigService, type SteerCommand } from "@gent/runtime"
import { ProviderFactory } from "@gent/providers"

// Known providers for auth listing
const KNOWN_PROVIDERS = ["anthropic", "openai", "bedrock", "google", "mistral"] as const
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
}

export interface AuthProviderInfo {
  provider: string
  hasKey: boolean
  source?: "env" | "stored"
}

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
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: string
  sessionId: string
  parentBranchId?: string
  parentMessageId?: string
  name?: string
  model?: string
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
  mode: AgentMode
  model?: string
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
    mode?: AgentMode
    model?: string
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

  listModels: () => Effect.Effect<readonly Model[], GentCoreError>

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
  | AuthStorage
  | ProviderFactory

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
    const authStorage = yield* AuthStorage
    const providerFactory = yield* ProviderFactory
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
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
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
          if (persist && request) {
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

      listAuthProviders: () =>
        Effect.gen(function* () {
          const storedKeys = yield* authStorage
            .list()
            .pipe(Effect.catchAll(() => Effect.succeed([] as readonly string[])))
          const storedSet = new Set(storedKeys)

          const providers: AuthProviderInfo[] = KNOWN_PROVIDERS.map((provider) => {
            const envVar = PROVIDER_ENV_VARS[provider]
            const hasEnv = envVar ? !!process.env[envVar] : false
            const hasStored = storedSet.has(provider)

            if (hasEnv) {
              return { provider, hasKey: true, source: "env" as const }
            }
            if (hasStored) {
              return { provider, hasKey: true, source: "stored" as const }
            }
            return { provider, hasKey: false }
          })

          return providers
        }),

      setAuthKey: (provider, key) =>
        authStorage.set(provider, key).pipe(Effect.catchAll(() => Effect.void)),

      deleteAuthKey: (provider) =>
        authStorage.delete(provider).pipe(Effect.catchAll(() => Effect.void)),

      listModels: () => providerFactory.listModels(),

      runtime: runtime as Runtime.Runtime<unknown>,
    }
  },
)
