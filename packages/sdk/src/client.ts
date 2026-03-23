import { Effect, Layer } from "effect"
import type { Stream, ServiceMap, Scope } from "effect"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import type { RpcGroup } from "effect/unstable/rpc"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { GentRpcs, type GentRpcsClient } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import type {
  GentClient,
  SkillInfo,
  SkillContent,
  MessageInfoReadonly,
  SteerCommand,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  QueueEntryInfoReadonly,
  QueueSnapshotReadonly,
  SessionState,
  SessionTreeNode,
  CreateSessionResult,
} from "@gent/core/server/transport-contract.js"
import { SessionQueries } from "@gent/core/server/session-queries.js"
import { SessionCommands } from "@gent/core/server/session-commands.js"
import { InteractionCommands } from "@gent/core/server/interaction-commands.js"
import { SessionEvents } from "@gent/core/server/session-events.js"
import { AskUserHandler } from "@gent/core/tools/ask-user.js"
import { ActorProcess } from "@gent/core/runtime/actor-process.js"
import type { GentRpcError } from "@gent/core/server/errors.js"
import { stringifyOutput, summarizeOutput } from "@gent/core/domain/tool-output.js"
import { AuthApi, AuthStore, type AuthInfo } from "@gent/core/domain/auth-store.js"
import { AuthGuard, type AuthProviderInfo } from "@gent/core/domain/auth-guard.js"
import { Permission, type PermissionRule } from "@gent/core/domain/permission.js"
import { Model, type ProviderId } from "@gent/core/domain/model.js"
import type { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method.js"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids.js"
import type { EventEnvelope } from "@gent/core/domain/event.js"
import type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
import type { QueueEntryInfo, QueueSnapshot } from "@gent/core/domain/queue.js"
import { Skills, type SkillScope } from "@gent/core/domain/skills.js"
import { ConfigService } from "@gent/core/runtime/config-service.js"
import { ModelRegistry } from "@gent/core/runtime/model-registry.js"
import { ProviderAuth } from "@gent/core/providers/provider-auth.js"
import { OPENAI_OAUTH_ALLOWED_MODELS } from "@gent/core/providers/oauth/openai-oauth.js"

export type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
  AuthProviderInfo,
  AuthAuthorization,
  AuthMethod,
  SessionId,
  BranchId,
  MessageId,
  QueueEntryInfo,
  QueueSnapshot,
}
export type {
  GentClient,
  SkillInfo,
  SkillContent,
  MessageInfoReadonly,
  SteerCommand,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  QueueEntryInfoReadonly,
  QueueSnapshotReadonly,
  SessionState,
  SessionTreeNode,
  CreateSessionResult,
}

// Re-export RPC types
export type { GentRpcsClient, GentRpcError }
export type { SkillScope }

// RPC client type alias
export type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// Auth provider info
export function extractText(parts: readonly MessagePart[]): string {
  const textPart = parts.find((p): p is TextPart => p.type === "text")
  return textPart?.text ?? ""
}

export function extractReasoning(parts: readonly MessagePart[]): string {
  const reasoningPart = parts.find((p): p is ReasoningPart => p.type === "reasoning")
  return reasoningPart?.text ?? ""
}

export interface ImageInfo {
  mediaType: string
}

export function extractImages(parts: readonly MessagePart[]): ImageInfo[] {
  return parts
    .filter((p): p is ImagePart => p.type === "image")
    .map((p) => ({ mediaType: p.mediaType ?? "image" }))
}

type ImagePart = { type: "image"; image: string; mediaType?: string }

export interface ExtractedToolCall {
  id: string
  toolName: string
  status: "completed" | "error"
  input: unknown | undefined
  summary: string | undefined
  output: string | undefined
}

// Extract tool calls from a single message's parts (no result joining)
export function extractToolCalls(parts: readonly MessagePart[]): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => ({
      id: tc.toolCallId,
      toolName: tc.toolName,
      status: "completed" as const,
      input: tc.input,
      summary: undefined,
      output: undefined,
    }))
}

// Build tool result map from all messages for joining
export function buildToolResultMap(
  messages: readonly MessageInfoReadonly[],
): Map<string, { summary: string; output: string; isError: boolean }> {
  const resultMap = new Map<string, { summary: string; output: string; isError: boolean }>()

  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool-result") {
          const result = part as ToolResultPart
          resultMap.set(result.toolCallId, {
            summary: summarizeOutput(result.output),
            output: stringifyOutput(result.output.value),
            isError: result.output.type === "error-json",
          })
        }
      }
    }
  }

  return resultMap
}

// Extract tool calls with results joined from result map
export function extractToolCallsWithResults(
  parts: readonly MessagePart[],
  resultMap: Map<string, { summary: string; output: string; isError: boolean }>,
): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => {
      const result = resultMap.get(tc.toolCallId)
      return {
        id: tc.toolCallId,
        toolName: tc.toolName,
        status: result?.isError === true ? ("error" as const) : ("completed" as const),
        input: tc.input,
        summary: result?.summary,
        output: result?.output,
      }
    })
}

/**
 * Creates the shared Gent transport contract from an RPC adapter.
 */
export function createClient(
  rpcClient: GentRpcClient,
  services: ServiceMap.ServiceMap<unknown>,
): GentClient {
  return {
    sendMessage: (input) => rpcClient.sendMessage(input),

    createSession: (input) =>
      rpcClient.createSession(input ?? {}).pipe(
        Effect.map((result) => ({
          sessionId: result.sessionId,
          branchId: result.branchId,
          name: result.name,
          bypass: result.bypass,
        })),
      ),

    listMessages: (branchId) => rpcClient.listMessages({ branchId }),

    getSessionState: (input) =>
      rpcClient.getSessionState({ sessionId: input.sessionId, branchId: input.branchId }),

    getSession: (sessionId) => rpcClient.getSession({ sessionId }),

    listSessions: () => rpcClient.listSessions(),

    getChildSessions: (parentSessionId) => rpcClient.getChildSessions({ parentSessionId }),

    getSessionTree: (sessionId) => rpcClient.getSessionTree({ sessionId }),

    listModels: () => rpcClient.listModels(),

    listBranches: (sessionId) => rpcClient.listBranches({ sessionId }),

    listTasks: (sessionId, branchId) =>
      rpcClient.listTasks({
        sessionId,
        ...(branchId !== undefined ? { branchId } : {}),
      }),

    getBranchTree: (sessionId) => rpcClient.getBranchTree({ sessionId }),

    createBranch: (sessionId, name) =>
      rpcClient
        .createBranch({ sessionId, ...(name !== undefined ? { name } : {}) })
        .pipe(Effect.map((result) => result.branchId)),

    switchBranch: (input) =>
      rpcClient.switchBranch({
        sessionId: input.sessionId,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        ...(input.summarize !== undefined ? { summarize: input.summarize } : {}),
      }),

    forkBranch: (input) =>
      rpcClient.forkBranch({
        sessionId: input.sessionId,
        fromBranchId: input.fromBranchId,
        atMessageId: input.atMessageId,
        ...(input.name !== undefined ? { name: input.name } : {}),
      }),

    subscribeEvents: ({ sessionId, branchId, after }) =>
      rpcClient.subscribeEvents({
        sessionId,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(after !== undefined ? { after } : {}),
      }),

    steer: (command) => rpcClient.steer({ command }),
    drainQueuedMessages: (input) => rpcClient.drainQueuedMessages(input),
    getQueuedMessages: (input) => rpcClient.getQueuedMessages(input),

    invokeTool: (input) => rpcClient.actorInvokeTool(input),

    respondQuestions: (requestId, answers) =>
      rpcClient.respondQuestions({ requestId, answers: [...answers.map((a) => [...a])] }),

    respondPermission: (requestId, decision, persist) =>
      rpcClient.respondPermission({
        requestId,
        decision,
        ...(persist !== undefined ? { persist } : {}),
      }),

    respondPrompt: (requestId, decision, content) =>
      rpcClient.respondPrompt({
        requestId,
        decision,
        ...(content !== undefined ? { content } : {}),
      }),

    respondHandoff: (requestId, decision, reason) =>
      rpcClient.respondHandoff({
        requestId,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      }),

    updateSessionBypass: (sessionId, bypass) =>
      rpcClient.updateSessionBypass({ sessionId, bypass }),

    updateSessionReasoningLevel: (sessionId, reasoningLevel) =>
      rpcClient.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

    getPermissionRules: () => rpcClient.getPermissionRules(),

    deletePermissionRule: (tool, pattern) =>
      rpcClient.deletePermissionRule({
        tool,
        ...(pattern !== undefined ? { pattern } : {}),
      }),

    listAuthProviders: () => rpcClient.listAuthProviders(),

    setAuthKey: (provider, key) => rpcClient.setAuthKey({ provider, key }),

    deleteAuthKey: (provider) => rpcClient.deleteAuthKey({ provider }),

    listAuthMethods: () => rpcClient.listAuthMethods(),

    authorizeAuth: (sessionId, provider, method) =>
      rpcClient.authorizeAuth({ sessionId, provider, method }),

    callbackAuth: (sessionId, provider, method, authorizationId, code) =>
      rpcClient.callbackAuth({
        sessionId,
        provider,
        method,
        authorizationId,
        ...(code !== undefined ? { code } : {}),
      }),

    listSkills: () => rpcClient.listSkills(),

    getSkillContent: (name) => rpcClient.getSkillContent({ name }),

    services,
  }
}

// =============================================================================
// makeClient - protocol-based client creation
// =============================================================================

/**
 * Creates the shared Gent transport contract from RPC protocol layers.
 * Use with HTTP or other RPC transport adapters.
 *
 * @example
 * ```ts
 * const client = await Effect.runPromise(
 *   makeClient.pipe(
 *     Effect.provide(HttpTransport({ url: "http://localhost:3000/rpc" })),
 *     Effect.scoped,
 *   )
 * )
 * ```
 */
export const makeClient: Effect.Effect<GentClient, never, RpcClient.Protocol | Scope.Scope> =
  Effect.gen(function* () {
    const rpcClient = yield* RpcClient.make(GentRpcs)
    const services = yield* Effect.services<never>()
    // SAFETY: RpcClient.make returns RpcClientError in error types, but GentRpcs
    // defines GentRpcError as the error schema. The cast narrows to our specific error type.
    return createClient(
      rpcClient as unknown as GentRpcClient,
      services as ServiceMap.ServiceMap<unknown>,
    )
  })

// =============================================================================
// In-process transport helpers
// =============================================================================

/**
 * Context required by RpcHandlersLive.
 * Layer must provide these services for the RPC handlers to work.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type LayerContext<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
export type RpcHandlersContext = LayerContext<typeof RpcHandlersLive>

/**
 * Creates an in-process RPC client for testing or embedded use.
 * Requires a layer that provides all handler dependencies (GentCore, etc).
 *
 * The layer must provide RpcHandlersContext, which includes:
 * - SessionQueries
 * - SessionCommands
 * - InteractionCommands
 * - SessionEvents
 * - AskUserHandler
 * - PermissionHandler
 * - PromptHandler
 * - Permission
 * - ConfigService
 * - AuthStore
 * - ProviderFactory
 * - ProviderAuth
 */
export const makeInProcessRpcClient = <E, R>(
  handlersLayer: Layer.Layer<RpcHandlersContext, E, R>,
): Effect.Effect<GentRpcClient, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provide(RpcHandlersLive, handlersLayer))
      const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
      // SAFETY: RpcTest.makeClient types include RpcClientError, but in-process
      // transport eliminates network errors. Cast narrows to GentRpcError.
      return client as unknown as GentRpcClient
    }),
  )

/**
 * Creates a full GentClient for in-process use.
 * Includes runtime for synchronous execution.
 */
export const makeInProcessClient = <E, R>(
  handlersLayer: Layer.Layer<RpcHandlersContext, E, R>,
): Effect.Effect<GentClient, E, R> =>
  Effect.gen(function* () {
    const rpcClient = yield* makeInProcessRpcClient(handlersLayer)
    const services = yield* Effect.services<never>()
    return createClient(rpcClient, services as ServiceMap.ServiceMap<unknown>)
  })

// =============================================================================
// Direct in-process transport adapter
// =============================================================================

/**
 * Context required to create an in-process transport adapter.
 */
export type DirectGentClientContext =
  | SessionQueries
  | SessionCommands
  | InteractionCommands
  | SessionEvents
  | ActorProcess
  | AskUserHandler
  | Permission
  | ConfigService
  | ModelRegistry
  | AuthStore
  | AuthGuard
  | ProviderAuth
  | Skills

/**
 * Creates the shared Gent transport contract using direct in-process calls.
 * Same contract as RPC/HTTP clients. Only the transport adapter differs.
 */
export const makeDirectGentClient: Effect.Effect<GentClient, never, DirectGentClientContext> =
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    const interactions = yield* InteractionCommands
    const events = yield* SessionEvents
    const actorProcess = yield* ActorProcess
    const askUserHandler = yield* AskUserHandler
    const permission = yield* Permission
    const configService = yield* ConfigService
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const skillsService = yield* Skills
    const services = yield* Effect.services<never>()

    // Error mapping: GentCoreError → GentRpcError (structurally compatible)
    const mapErr = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, GentRpcError> =>
      effect as Effect.Effect<A, GentRpcError>

    const client: GentClient = {
      sendMessage: (input) => mapErr(commands.sendMessage(input)),

      createSession: (input) =>
        mapErr(
          commands.createSession({
            ...(input?.firstMessage !== undefined ? { firstMessage: input.firstMessage } : {}),
            ...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input?.bypass !== undefined ? { bypass: input.bypass } : {}),
            ...(input?.parentSessionId !== undefined
              ? { parentSessionId: input.parentSessionId }
              : {}),
            ...(input?.parentBranchId !== undefined
              ? { parentBranchId: input.parentBranchId }
              : {}),
          }),
        ),

      listMessages: (branchId) => mapErr(queries.listMessages(branchId)),

      getSessionState: (input) => mapErr(queries.getSessionState(input)),

      getSession: (sessionId) => mapErr(queries.getSession(sessionId)),

      listSessions: () => mapErr(queries.listSessions()),

      getChildSessions: (parentSessionId) => mapErr(queries.getChildSessions(parentSessionId)),

      getSessionTree: (sessionId) =>
        mapErr(
          queries.getSessionTree(sessionId).pipe(
            Effect.map(function toFlat(node): SessionTreeNode {
              return {
                id: node.session.id,
                name: node.session.name,
                cwd: node.session.cwd,
                bypass: node.session.bypass,
                parentSessionId: node.session.parentSessionId,
                parentBranchId: node.session.parentBranchId,
                createdAt: node.session.createdAt.getTime(),
                updatedAt: node.session.updatedAt.getTime(),
                children: node.children.map(toFlat),
              }
            }),
          ),
        ),

      listModels: () =>
        mapErr(
          Effect.gen(function* () {
            const models = yield* modelRegistry.list()
            const authInfo = yield* authStore
              .get("openai")
              .pipe(Effect.catchEager(() => Effect.sync(() => undefined as AuthInfo | undefined)))
            if (authInfo?.type !== "oauth") return models

            return models
              .filter((model) => {
                if (model.provider !== "openai") return true
                const [, modelName] = String(model.id).split("/", 2)
                return modelName !== undefined && OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)
              })
              .map((model) => {
                if (model.provider !== "openai") return model
                return new Model({
                  id: model.id,
                  name: model.name,
                  provider: model.provider,
                  ...(model.contextLength !== undefined
                    ? { contextLength: model.contextLength }
                    : {}),
                  pricing: { input: 0, output: 0 },
                })
              })
          }),
        ),

      listBranches: (sessionId) => mapErr(queries.listBranches(sessionId)),

      listTasks: (sessionId, branchId) => mapErr(queries.listTasks(sessionId, branchId)),

      getBranchTree: (sessionId) => mapErr(queries.getBranchTree(sessionId)),

      createBranch: (sessionId, name) =>
        mapErr(
          commands
            .createBranch({ sessionId, ...(name !== undefined ? { name } : {}) })
            .pipe(Effect.map((r) => r.branchId)),
        ),

      switchBranch: (input) => mapErr(commands.switchBranch(input)),

      forkBranch: (input) => mapErr(commands.forkBranch(input)),

      subscribeEvents: (input) =>
        events.subscribeEvents(input) as Stream.Stream<EventEnvelope, GentRpcError>,

      steer: (command) => mapErr(commands.steer(command)),
      drainQueuedMessages: ({ sessionId, branchId }) =>
        mapErr(commands.drainQueuedMessages({ sessionId, branchId })),
      getQueuedMessages: ({ sessionId, branchId }) =>
        mapErr(queries.getQueuedMessages({ sessionId, branchId })),

      invokeTool: (input) => mapErr(actorProcess.invokeTool(input)),

      respondQuestions: (requestId, answers) => mapErr(askUserHandler.respond(requestId, answers)),

      respondPermission: (requestId, decision, persist) =>
        mapErr(interactions.respondPermission({ requestId, decision, persist })),

      respondPrompt: (requestId, decision, content) =>
        mapErr(
          interactions.respondPrompt({
            requestId,
            decision,
            ...(content !== undefined ? { content } : {}),
          }),
        ),

      respondHandoff: (requestId, decision, reason) =>
        mapErr(
          interactions.respondHandoff({
            requestId,
            decision,
            ...(reason !== undefined ? { reason } : {}),
          }),
        ),

      updateSessionBypass: (sessionId, bypass) =>
        mapErr(commands.updateSessionBypass({ sessionId, bypass })),

      updateSessionReasoningLevel: (sessionId, reasoningLevel) =>
        mapErr(commands.updateSessionReasoningLevel({ sessionId, reasoningLevel })),

      getPermissionRules: () => mapErr(configService.getPermissionRules()),

      deletePermissionRule: (tool, pattern) =>
        mapErr(
          Effect.gen(function* () {
            yield* configService.removePermissionRule(tool, pattern)
            yield* permission.removeRule(tool, pattern)
          }),
        ),

      listAuthProviders: () => mapErr(authGuard.listProviders()),

      setAuthKey: (provider, key) =>
        mapErr(
          authStore
            .set(provider, new AuthApi({ type: "api", key }))
            .pipe(Effect.catchEager((e) => Effect.logWarning("setAuthKey failed", e))),
        ),

      deleteAuthKey: (provider) =>
        mapErr(
          authStore
            .remove(provider)
            .pipe(Effect.catchEager((e) => Effect.logWarning("deleteAuthKey failed", e))),
        ),

      listAuthMethods: () => mapErr(providerAuth.listMethods()),

      authorizeAuth: (sessionId, provider, method) =>
        mapErr(
          providerAuth
            .authorize(sessionId, provider as ProviderId, method)
            .pipe(Effect.map((result) => result ?? null)),
        ),

      callbackAuth: (sessionId, provider, method, authorizationId, code) =>
        mapErr(
          providerAuth.callback(sessionId, provider as ProviderId, method, authorizationId, code),
        ),

      listSkills: () =>
        mapErr(
          skillsService.list().pipe(
            Effect.map((list) =>
              list.map((s) => ({
                name: s.name,
                description: s.description,
                scope: s.scope,
                filePath: s.filePath,
                content: s.content,
              })),
            ),
          ),
        ),

      getSkillContent: (name) =>
        mapErr(
          skillsService.get(name).pipe(
            Effect.map((s) =>
              s !== undefined
                ? {
                    name: s.name,
                    description: s.description,
                    scope: s.scope,
                    filePath: s.filePath,
                    content: s.content,
                  }
                : null,
            ),
          ),
        ),

      services: services as ServiceMap.ServiceMap<unknown>,
    }

    return client
  })

// =============================================================================
// HTTP transport
// =============================================================================

export interface HttpTransportConfig {
  /** Base URL for RPC endpoint (e.g., "http://localhost:3000/rpc") */
  url: string
  /** Optional headers to include with requests */
  headers?: Record<string, string>
}

/**
 * Creates an HTTP transport layer for RPC-over-HTTP.
 * Uses ndjson serialization for streaming support.
 */
export const HttpTransport = (config: HttpTransportConfig): Layer.Layer<RpcClient.Protocol> => {
  const headers = config.headers
  const clientLayer =
    headers !== undefined
      ? Layer.effect(
          HttpClient.HttpClient,
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient
            return client.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)))
          }),
        ).pipe(Layer.provide(FetchHttpClient.layer))
      : FetchHttpClient.layer

  return RpcClient.layerProtocolHttp({ url: config.url }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(clientLayer),
  )
}
