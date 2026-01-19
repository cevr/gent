import { Effect, Stream, Runtime } from "effect"
import type { RpcClient } from "@effect/rpc"
import type { RpcGroup } from "@effect/rpc"
import type { GentRpcs } from "@gent/api"
import type { AgentEvent, MessagePart, TextPart } from "@gent/core"

export type { MessagePart, TextPart }

export function extractText(parts: readonly MessagePart[]): string {
  const textPart = parts.find((p): p is TextPart => p.type === "text")
  return textPart?.text ?? ""
}

// RPC client type from GentRpcs
export type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// Message type returned from RPC (readonly)
export interface MessageInfoReadonly {
  readonly id: string
  readonly sessionId: string
  readonly branchId: string
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly parts: readonly MessagePart[]
  readonly createdAt: number
}

// GentClient interface - adapts RPC client to callback-based subscriptions
export interface GentClient {
  sendMessage: (input: {
    sessionId: string
    branchId: string
    content: string
  }) => Promise<void>

  listMessages: (branchId: string) => Promise<readonly MessageInfoReadonly[]>

  subscribeEvents: (
    sessionId: string,
    onEvent: (event: AgentEvent) => void
  ) => () => void
}

/**
 * Creates a GentClient from an RPC client.
 * Uses provided runtime for all Effect execution.
 * RPC methods return Effect<T, E, never> so runtime context is unused.
 */
export function createClient(
  rpcClient: GentRpcClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime context unused by RPC calls
  runtime: Runtime.Runtime<any>
): GentClient {
  return {
    sendMessage: (input) =>
      Runtime.runPromise(runtime)(rpcClient.sendMessage(input)).catch((err) => {
        console.error("sendMessage error:", err)
        throw err
      }),

    listMessages: (branchId) =>
      Runtime.runPromise(runtime)(rpcClient.listMessages({ branchId })) as Promise<readonly MessageInfoReadonly[]>,

    subscribeEvents: (sessionId, onEvent) => {
      let cancelled = false

      // subscribeEvents returns a Stream directly (not Effect<Stream>)
      const events = rpcClient.subscribeEvents({ sessionId })

      // Run the stream
      const streamEffect = Stream.runForEach(events, (event: AgentEvent) =>
        Effect.sync(() => {
          if (!cancelled) {
            onEvent(event)
          }
        })
      )

      void Runtime.runPromise(runtime)(streamEffect).catch(() => {
        // Stream ended or cancelled
      })

      return () => {
        cancelled = true
      }
    },
  }
}
