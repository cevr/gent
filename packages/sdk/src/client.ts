import { Effect, Layer } from "effect"
import type { Stream, ServiceMap, Scope } from "effect"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import type { RpcGroup } from "effect/unstable/rpc"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { GentRpcs, RpcHandlersLive, type GentRpcsClient, type GentRpcError } from "@gent/server"
import { stringifyOutput, summarizeOutput } from "@gent/core"
import type {
  AgentName,
  AuthAuthorization,
  AuthMethod,
  AuthProviderInfo,
  BranchId,
  EventEnvelope,
  MessageId,
  MessagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  Model,
  PermissionDecision,
  PlanDecision,
  HandoffDecision,
  PermissionRule,
  SessionId,
} from "@gent/core"

export type {
  MessagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
  AuthProviderInfo,
  AuthAuthorization,
  AuthMethod,
  SessionId,
  BranchId,
  MessageId,
}

// Re-export RPC types
export type { GentRpcsClient, GentRpcError }

// RPC client type alias
export type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// Auth provider info
export function extractText(parts: readonly MessagePart[]): string {
  const textPart = parts.find((p): p is TextPart => p.type === "text")
  return textPart?.text ?? ""
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

// Message type returned from RPC (readonly)
export interface MessageInfoReadonly {
  readonly id: MessageId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly kind?: "regular" | "interjection"
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly parts: readonly MessagePart[]
  readonly createdAt: number
  readonly turnDurationMs?: number
}

// Steer command types
export type SteerCommand =
  | { _tag: "Cancel"; sessionId: SessionId; branchId: BranchId }
  | { _tag: "Interrupt"; sessionId: SessionId; branchId: BranchId }
  | { _tag: "Interject"; sessionId: SessionId; branchId: BranchId; message: string }
  | { _tag: "SwitchAgent"; sessionId: SessionId; branchId: BranchId; agent: AgentName }

// Session info (minimal for client)
export interface SessionInfo {
  id: SessionId
  name?: string
  cwd?: string
  bypass?: boolean
  branchId?: BranchId
  parentSessionId?: SessionId
  parentBranchId?: BranchId
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: BranchId
  sessionId: SessionId
  parentBranchId?: BranchId
  parentMessageId?: MessageId
  name?: string
  summary?: string
  createdAt: number
}

export interface BranchTreeNode {
  id: BranchId
  name?: string
  summary?: string
  parentMessageId?: MessageId
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

export interface SessionState {
  sessionId: SessionId
  branchId: BranchId
  messages: readonly MessageInfoReadonly[]
  lastEventId: number | null
  isStreaming: boolean
  agent: AgentName
  bypass?: boolean
}

export interface CreateSessionResult {
  sessionId: SessionId
  branchId: BranchId
  name: string
  bypass: boolean
}

// =============================================================================
// GentClient - Returns Effects for all operations
// =============================================================================

export interface GentClient {
  /** Send a message to active session */
  sendMessage: (input: {
    sessionId: SessionId
    branchId: BranchId
    content: string
  }) => Effect.Effect<void, GentRpcError>

  /** Create a new session */
  createSession: (input?: {
    firstMessage?: string
    cwd?: string
    bypass?: boolean
  }) => Effect.Effect<CreateSessionResult, GentRpcError>

  /** List messages for a branch */
  listMessages: (branchId: BranchId) => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>

  /** Get session state snapshot */
  getSessionState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<SessionState, GentRpcError>

  /** Get a session by ID */
  getSession: (sessionId: SessionId) => Effect.Effect<SessionInfo | null, GentRpcError>

  /** List all sessions */
  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>

  /** List available model metadata (pricing) */
  listModels: () => Effect.Effect<readonly Model[], GentRpcError>

  /** List branches for a session */
  listBranches: (sessionId: SessionId) => Effect.Effect<readonly BranchInfo[], GentRpcError>

  /** Get branch tree for a session */
  getBranchTree: (sessionId: SessionId) => Effect.Effect<readonly BranchTreeNode[], GentRpcError>

  /** Create a new branch */
  createBranch: (sessionId: SessionId, name?: string) => Effect.Effect<BranchId, GentRpcError>

  /** Switch branches within a session */
  switchBranch: (input: {
    sessionId: SessionId
    fromBranchId: BranchId
    toBranchId: BranchId
    summarize?: boolean
  }) => Effect.Effect<void, GentRpcError>

  /** Fork a new branch from a message */
  forkBranch: (input: {
    sessionId: SessionId
    fromBranchId: BranchId
    atMessageId: MessageId
    name?: string
  }) => Effect.Effect<{ branchId: string }, GentRpcError>

  /** Subscribe to events - returns Stream */
  subscribeEvents: (input: {
    sessionId: SessionId
    branchId?: BranchId
    after?: number
  }) => Stream.Stream<EventEnvelope, GentRpcError>

  /** Send steering command */
  steer: (command: SteerCommand) => Effect.Effect<void, GentRpcError>

  /** Respond to questions from agent */
  respondQuestions: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void, GentRpcError>

  /** Respond to permission request */
  respondPermission: (
    requestId: string,
    decision: PermissionDecision,
    persist?: boolean,
  ) => Effect.Effect<void, GentRpcError>

  /** Respond to plan prompt */
  respondPlan: (
    requestId: string,
    decision: PlanDecision,
    reason?: string,
  ) => Effect.Effect<void, GentRpcError>

  /** Respond to handoff prompt */
  respondHandoff: (
    requestId: string,
    decision: HandoffDecision,
    reason?: string,
  ) => Effect.Effect<{ childSessionId?: SessionId }, GentRpcError>

  /** Update session bypass */
  updateSessionBypass: (
    sessionId: SessionId,
    bypass: boolean,
  ) => Effect.Effect<{ bypass: boolean }, GentRpcError>

  /** Get permission rules */
  getPermissionRules: () => Effect.Effect<readonly PermissionRule[], GentRpcError>

  /** Delete permission rule */
  deletePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void, GentRpcError>

  /** List auth providers with their key status */
  listAuthProviders: () => Effect.Effect<readonly AuthProviderInfo[], GentRpcError>

  /** Set auth key for a provider */
  setAuthKey: (provider: string, key: string) => Effect.Effect<void, GentRpcError>

  /** Delete auth key for a provider */
  deleteAuthKey: (provider: string) => Effect.Effect<void, GentRpcError>

  /** List auth methods per provider */
  listAuthMethods: () => Effect.Effect<Record<string, ReadonlyArray<AuthMethod>>, GentRpcError>

  /** Begin OAuth flow for provider + method */
  authorizeAuth: (
    sessionId: string,
    provider: string,
    method: number,
  ) => Effect.Effect<AuthAuthorization | null, GentRpcError>

  /** Complete OAuth flow */
  callbackAuth: (
    sessionId: string,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, GentRpcError>

  /** Get the services for this client */
  services: ServiceMap.ServiceMap<unknown>
}

/**
 * Creates a GentClient from an RPC client.
 * Returns Effects for all operations - caller decides how to run.
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

    listModels: () => rpcClient.listModels(),

    listBranches: (sessionId) => rpcClient.listBranches({ sessionId }),

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

    respondQuestions: (requestId, answers) =>
      rpcClient.respondQuestions({ requestId, answers: [...answers.map((a) => [...a])] }),

    respondPermission: (requestId, decision, persist) =>
      rpcClient.respondPermission({
        requestId,
        decision,
        ...(persist !== undefined ? { persist } : {}),
      }),

    respondPlan: (requestId, decision, reason) =>
      rpcClient.respondPlan({
        requestId,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      }),

    respondHandoff: (requestId, decision, reason) =>
      rpcClient.respondHandoff({
        requestId,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      }),

    updateSessionBypass: (sessionId, bypass) =>
      rpcClient.updateSessionBypass({ sessionId, bypass }),

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

    services,
  }
}

// =============================================================================
// makeClient - protocol-based client creation
// =============================================================================

/**
 * Creates a GentClient from RPC protocol layers.
 * Use with HttpTransport or other protocol layers.
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
 * - GentCore
 * - AskUserHandler
 * - PermissionHandler
 * - PlanHandler
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
