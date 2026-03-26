import { Effect, Layer } from "effect"
import type { Fiber, ServiceMap, Scope } from "effect"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import type { RpcGroup } from "effect/unstable/rpc"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { GentRpcs, type GentRpcsClient } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import {
  GentConnectionError,
  type GentClient,
  type GentLifecycle,
  type ConnectionState,
  type SkillInfo,
  type SkillContent,
  type MessageInfoReadonly,
  type SteerCommand,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type QueueEntryInfoReadonly,
  type QueueSnapshotReadonly,
  type SessionSnapshot,
  type SessionRuntime,
  type SessionTreeNode,
  type CreateSessionResult,
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
import { startWorkerSupervisor, waitForWorkerRunning, type WorkerSupervisor } from "./supervisor.js"

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
  GentLifecycle,
  ConnectionState,
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
export { GentConnectionError }

// Re-export RPC types
export type { GentRpcsClient, GentRpcError }
export type { SkillScope }

// RPC client type alias
export type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// ---------------------------------------------------------------------------
// Utility functions (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal: build a GentClient from an RPC adapter
// ---------------------------------------------------------------------------

function buildClient(
  rpcClient: GentRpcClient,
  services: ServiceMap.ServiceMap<unknown>,
  lifecycle: GentLifecycle,
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

    sendExtensionIntent: (sessionId, extensionId, intent, epoch, branchId) =>
      rpcClient.sendExtensionIntent({ sessionId, extensionId, intent, epoch, branchId }),

    // @effect-diagnostics-next-line *:off
    runFork: (effect) => {
      // @effect-diagnostics-next-line *:off
      const fiber = Effect.runForkWith(services)(effect)
      return fiber as Fiber.Fiber<unknown, unknown> as never
    },

    // @effect-diagnostics-next-line *:off
    runPromise: (effect) => Effect.runPromiseWith(services)(effect) as never,

    lifecycle,
  }
}

// ---------------------------------------------------------------------------
// Static lifecycle for non-supervised connections
// ---------------------------------------------------------------------------

const staticLifecycle = (state: ConnectionState): GentLifecycle => ({
  getState: () => state,
  subscribe: (listener) => {
    listener(state)
    return () => {}
  },
  restart: Effect.fail(
    new GentConnectionError({ message: "restart not supported on this transport" }),
  ),
  waitForReady: Effect.void,
})

// ---------------------------------------------------------------------------
// Supervisor → GentLifecycle adapter
// ---------------------------------------------------------------------------

const supervisorLifecycle = (supervisor: WorkerSupervisor): GentLifecycle => ({
  getState: () => {
    const s = supervisor.getState()
    switch (s._tag) {
      case "starting":
        return { _tag: "connecting" }
      case "running":
        return { _tag: "connected", pid: s.pid, generation: s.restartCount }
      case "restarting":
        return { _tag: "reconnecting", attempt: s.restartCount, generation: s.restartCount }
      case "stopped":
        return { _tag: "disconnected", reason: "stopped" }
      case "failed":
        return { _tag: "disconnected", reason: s.message }
    }
  },
  subscribe: (listener) =>
    supervisor.subscribe((s) => {
      switch (s._tag) {
        case "starting":
          return listener({ _tag: "connecting" })
        case "running":
          return listener({ _tag: "connected", pid: s.pid, generation: s.restartCount })
        case "restarting":
          return listener({
            _tag: "reconnecting",
            attempt: s.restartCount,
            generation: s.restartCount,
          })
        case "stopped":
          return listener({ _tag: "disconnected", reason: "stopped" })
        case "failed":
          return listener({ _tag: "disconnected", reason: s.message })
      }
    }),
  restart: supervisor.restart.pipe(
    Effect.mapError((e) => new GentConnectionError({ message: e.message })),
  ),
  waitForReady: waitForWorkerRunning(supervisor),
})

// ---------------------------------------------------------------------------
// HTTP transport (internal)
// ---------------------------------------------------------------------------

interface HttpTransportConfig {
  url: string
  headers?: Record<string, string>
}

const HttpTransport = (config: HttpTransportConfig): Layer.Layer<RpcClient.Protocol> => {
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

// ---------------------------------------------------------------------------
// RPC client assembly (internal)
// ---------------------------------------------------------------------------

const makeRpcClient: Effect.Effect<GentRpcClient, never, RpcClient.Protocol | Scope.Scope> =
  Effect.gen(function* () {
    const rpcClient = yield* RpcClient.make(GentRpcs)
    // SAFETY: RpcClient.make returns RpcClientError in error types, but GentRpcs
    // defines GentRpcError as the error schema. The cast narrows to our specific error type.
    return rpcClient as unknown as GentRpcClient
  })

// ---------------------------------------------------------------------------
// Gent — unified client constructors
// ---------------------------------------------------------------------------

export interface GentSpawnOptions {
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
  readonly mode?: "default" | "debug"
}

export interface GentConnectOptions {
  readonly url: string
  readonly headers?: Record<string, string>
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type LayerContext<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
export type RpcHandlersContext = LayerContext<typeof RpcHandlersLive>

export const Gent = {
  /** Spawn a supervised child process server and connect to it */
  spawn: (options: GentSpawnOptions): Effect.Effect<GentClient, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const supervisor = yield* startWorkerSupervisor(options).pipe(
        Effect.mapError((e) => new GentConnectionError({ message: e.message })),
      )
      const scope = yield* Effect.scope
      const transport = yield* Layer.buildWithScope(HttpTransport({ url: supervisor.url }), scope)
      const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
      const services = yield* Effect.services<never>()
      return buildClient(
        rpcClient,
        services as ServiceMap.ServiceMap<unknown>,
        supervisorLifecycle(supervisor),
      )
    }),

  /** Connect to an already-running server */
  connect: (
    options: GentConnectOptions,
  ): Effect.Effect<GentClient, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const transport = yield* Layer.buildWithScope(
        HttpTransport({ url: options.url, headers: options.headers }),
        scope,
      )
      const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
      const services = yield* Effect.services<never>()
      return buildClient(
        rpcClient,
        services as ServiceMap.ServiceMap<unknown>,
        staticLifecycle({ _tag: "connected", generation: 0 }),
      )
    }),

  /** In-process client for tests and embedding. Fast, less isolation than spawn. */
  test: <E, R>(
    handlersLayer: Layer.Layer<RpcHandlersContext, E, R>,
  ): Effect.Effect<GentClient, E, R | Scope.Scope> =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provide(RpcHandlersLive, handlersLayer))
      const rpcClient = yield* RpcTest.makeClient(GentRpcs).pipe(
        Effect.provide(context),
      ) as Effect.Effect<GentRpcClient>
      const services = yield* Effect.services<never>()
      return buildClient(
        rpcClient,
        services as ServiceMap.ServiceMap<unknown>,
        staticLifecycle({ _tag: "connected", generation: 0 }),
      )
    }),
} as const
