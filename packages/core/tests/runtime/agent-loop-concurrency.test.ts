import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { Provider, ToolCallChunk, FinishChunk } from "@gent/core/providers/provider"
import { Session, Branch } from "@gent/core/domain/message"
import { Agents } from "@gent/core/domain/agent"
import { defineTool, type AnyToolDefinition } from "@gent/core/domain/tool"
import { Permission } from "@gent/core/domain/permission"
import { EventStore } from "@gent/core/domain/event"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { BunServices } from "@effect/platform-bun"

const makeTestExtRegistry = (tools: AnyToolDefinition[] = []) =>
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        setup: { agents: Object.values(Agents) },
      },
      ...(tools.length > 0
        ? [
            {
              manifest: { id: "tools" },
              kind: "builtin" as const,
              sourcePath: "test",
              setup: { tools },
            },
          ]
        : []),
    ]),
  )

describe("Tool concurrency", () => {
  test("serial tool calls do not overlap", async () => {
    const events: string[] = []
    let running = 0
    let maxRunning = 0

    const makeSerialTool = (name: string) =>
      defineTool({
        name,
        concurrency: "serial",
        description: `Serial tool ${name}`,
        params: Schema.Struct({}),
        execute: () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              running += 1
              maxRunning = Math.max(maxRunning, running)
              events.push(`start:${name}`)
            })

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  setTimeout(resolve, 20)
                }),
            )

            yield* Effect.sync(() => {
              events.push(`end:${name}`)
              running -= 1
            })

            return { ok: true }
          }),
      })

    const toolA = makeSerialTool("serial-a")
    const toolB = makeSerialTool("serial-b")

    const providerResponses = [
      [
        new ToolCallChunk({ toolCallId: "tc-1", toolName: "serial-a", input: {} }),
        new ToolCallChunk({ toolCallId: "tc-2", toolName: "serial-b", input: {} }),
        new FinishChunk({ finishReason: "tool_calls" }),
      ],
      [new FinishChunk({ finishReason: "stop" })],
    ]

    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      Provider.Test(providerResponses),
      makeTestExtRegistry([toolA, toolB]),
      ExtensionStateRuntime.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      EventStore.Test(),
      Permission.Test(),
      ApprovalService.Test(),
      BunServices.layer,
    )
    const toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const actorDeps = Layer.mergeAll(deps, toolRunnerLayer)
    const eventPublisherLayer = Layer.provide(EventPublisherLive, actorDeps)
    const loopLayer = AgentLoop.Live({ baseSections: [] }).pipe(
      Layer.provide(Layer.merge(actorDeps, eventPublisherLayer)),
    )
    const layer = Layer.mergeAll(actorDeps, eventPublisherLayer, loopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const loop = yield* AgentLoop

        const now = new Date()
        const session = new Session({
          id: "serial-session",
          name: "Serial Test",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "serial-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: "cowork",
          prompt: "run serial tools",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(maxRunning).toBe(1)
    expect(events.length).toBe(4)
    expect(events[0]?.startsWith("start:")).toBe(true)
    expect(events[1]?.startsWith("end:")).toBe(true)
    expect(events[2]?.startsWith("start:")).toBe(true)
    expect(events[3]?.startsWith("end:")).toBe(true)
    expect(events[0]?.slice("start:".length)).toBe(events[1]?.slice("end:".length))
    expect(events[2]?.slice("start:".length)).toBe(events[3]?.slice("end:".length))
  })
})
