import { Effect, Layer } from "effect"
import type { ServiceMap, Scope } from "effect"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import type { RpcGroup } from "effect/unstable/rpc"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { GentRpcs, type GentRpcsClient } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import type {
  GentClient,
  GentClientInternal,
  SkillInfo,
  SkillContent,
  MessageInfoReadonly,
  SteerCommand,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  QueueEntryInfoReadonly,
  QueueSnapshotReadonly,
  SessionSnapshot,
  SessionRuntime,
  SessionTreeNode,
  CreateSessionResult,
} from "@gent/core/server/transport-contract.js"
import type { GentRpcError } from "@gent/core/server/errors.js"
import { stringifyOutput, summarizeOutput } from "@gent/core/domain/tool-output.js"
import type { AuthProviderInfo } from "@gent/core/domain/auth-guard.js"
import type { PermissionRule } from "@gent/core/domain/permission.js"
import type { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method.js"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids.js"
import type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
import type { QueueEntryInfo, QueueSnapshot } from "@gent/core/domain/queue.js"
import type { SkillScope } from "@gent/core/domain/skills.js"

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
  SessionSnapshot,
  SessionRuntime,
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
): GentClientInternal {
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

    getSessionSnapshot: (input) =>
      rpcClient.getSessionSnapshot({ sessionId: input.sessionId, branchId: input.branchId }),

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

    streamEvents: ({ sessionId, branchId, after }) =>
      rpcClient.streamEvents({
        sessionId,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(after !== undefined ? { after } : {}),
      }),
    watchRuntime: ({ sessionId, branchId }) => rpcClient.watchRuntime({ sessionId, branchId }),

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
export const makeClient: Effect.Effect<
  GentClientInternal,
  never,
  RpcClient.Protocol | Scope.Scope
> = Effect.gen(function* () {
  const rpcClient = yield* RpcClient.make(GentRpcs)
  const services = yield* Effect.services<never>()
  // SAFETY: RpcClient.make returns RpcClientError in error types, but GentRpcs
  // defines GentRpcError as the error schema. The cast narrows to our specific error type.
  return createClient(
    rpcClient as unknown as GentRpcClient,
    services as ServiceMap.ServiceMap<unknown>,
  )
})

/**
 * Creates a Gent client over the shared RPC-over-HTTP transport.
 */
export const makeHttpGentClient = (
  config: HttpTransportConfig,
): Effect.Effect<GentClientInternal, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const transport = yield* Layer.buildWithScope(HttpTransport(config), scope)
    return yield* makeClient.pipe(Effect.provide(transport))
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
 * Requires a layer that provides the split app-service handlers and their dependencies.
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
): Effect.Effect<GentClientInternal, E, R> =>
  Effect.gen(function* () {
    const rpcClient = yield* makeInProcessRpcClient(handlersLayer)
    const services = yield* Effect.services<never>()
    return createClient(rpcClient, services as ServiceMap.ServiceMap<unknown>)
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
