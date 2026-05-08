import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Schema } from "effect"
import { finishPart, toolCallPart } from "@gent/core-internal/test-utils/language-model"
import { dateFromMillis, Branch, Session } from "@gent/core-internal/domain/message"
import { AgentName } from "@gent/core-internal/domain/agent"
import { tool } from "@gent/core/extensions/api"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { makeAgentLoopService, makeLiveToolLayer, scriptedProvider } from "./agent-loop/helpers"

describe("concurrency", () => {
  it.live("independent tool calls may overlap", () =>
    Effect.gen(function* () {
      const events: string[] = []
      let running = 0
      let maxRunning = 0
      const bothStarted = yield* Deferred.make<void>()
      const makeSerialTool = (name: string) =>
        tool({
          id: name,
          description: `Serial tool ${name}`,
          params: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                running += 1
                maxRunning = Math.max(maxRunning, running)
                events.push(`start:${name}`)
              })
              if (running > 1) yield* Deferred.succeed(bothStarted, undefined)
              yield* Deferred.await(bothStarted).pipe(Effect.timeout("1 second"))
              yield* Effect.sync(() => {
                events.push(`end:${name}`)
                running -= 1
              })
              return { ok: true }
            }),
        })
      const toolA = makeSerialTool("serial-a")
      const toolB = makeSerialTool("serial-b")
      const layer = makeLiveToolLayer(
        scriptedProvider([
          [
            toolCallPart("serial-a", {}, { toolCallId: ToolCallId.make("tc-1") }),
            toolCallPart("serial-b", {}, { toolCallId: ToolCallId.make("tc-2") }),
            finishPart({ finishReason: "tool-calls" }),
          ],
          [finishPart({ finishReason: "stop" })],
        ]),
        [toolA, toolB],
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const branchStorage = yield* BranchStorage
        const loop = yield* makeAgentLoopService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("serial-session"),
          name: "Serial Test",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("serial-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessionStorage.createSession(session)
        yield* branchStorage.createBranch(branch)
        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: AgentName.make("cowork"),
          prompt: "run serial tools",
        })
      }).pipe(Effect.provide(layer))
      expect(maxRunning).toBeGreaterThan(1)
      expect(events.length).toBe(4)
      expect(events[0]?.startsWith("start:")).toBe(true)
      expect(events[1]?.startsWith("start:")).toBe(true)
      expect(events[2]?.startsWith("end:")).toBe(true)
      expect(events[3]?.startsWith("end:")).toBe(true)
      expect(new Set(events.map((event) => event.split(":")[1])).size).toBe(2)
    }),
  )
})
// ============================================================================
