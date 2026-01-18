import { Effect, Runtime, Stream } from "effect"
import { GentServer } from "@gent/server"
import type { AgentEvent, MessagePart, TextPart } from "@gent/core"

export type { MessagePart, TextPart }

export function extractText(parts: readonly MessagePart[]): string {
  const textPart = parts.find((p): p is TextPart => p.type === "text")
  return textPart?.text ?? ""
}

export interface GentClient {
  sendMessage: (input: {
    sessionId: string
    branchId: string
    content: string
  }) => Promise<void>

  listMessages: (branchId: string) => Promise<
    Array<{
      id: string
      sessionId: string
      branchId: string
      role: "user" | "assistant" | "system" | "tool"
      parts: readonly MessagePart[]
      createdAt: number
    }>
  >

  subscribeEvents: (
    sessionId: string,
    onEvent: (event: AgentEvent) => void
  ) => () => void
}

export function createClient(
  runtime: Runtime.Runtime<GentServer>
): GentClient {
  const runPromise = Runtime.runPromise(runtime)

  return {
    sendMessage: (input) =>
      runPromise(
        Effect.gen(function* () {
          const server = yield* GentServer
          yield* server.sendMessage(input)
        })
      ).catch((err) => {
        console.error("sendMessage error:", err)
        throw err
      }),

    listMessages: (branchId) =>
      runPromise(
        Effect.gen(function* () {
          const server = yield* GentServer
          const msgs = yield* server.listMessages(branchId)
          return msgs.map((m) => ({
            id: m.id,
            sessionId: m.sessionId,
            branchId: m.branchId,
            role: m.role,
            parts: m.parts,
            createdAt: m.createdAt,
          }))
        })
      ),

    subscribeEvents: (sessionId, onEvent) => {
      let cancelled = false

      void Effect.gen(function* () {
        const server = yield* GentServer
        const events = server.subscribeEvents(sessionId)

        yield* Stream.runForEach(events, (event) =>
          Effect.sync(() => {
            if (!cancelled) {
              onEvent(event)
            }
          })
        )
      }).pipe(
        runPromise
      ).catch(() => {
        // Stream ended
      })

      return () => {
        cancelled = true
      }
    },
  }
}
