/** @jsxImportSource @opentui/solid */

import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { SyntaxStyle } from "@opentui/core"
import type { ConnectionState, QueueEntryInfo, SessionInfo } from "@gent/sdk"
import { MessageList, type Message, type SessionItem } from "../src/components/message-list"
import { ConnectionWidget } from "../src/components/connection-widget"
import { QueueWidget } from "../src/components/queue-widget"
import { TaskWidget } from "../src/components/task-widget"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness"
import { useClient, type GentRuntime } from "../src/client"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const syntaxStyle = () => SyntaxStyle.create()

const testSession: SessionInfo = {
  id: SessionId.of("session-test"),
  name: "Test Session",
  cwd: "/tmp/gent-test",
  reasoningLevel: undefined,
  branchId: BranchId.of("branch-test"),
  parentSessionId: undefined,
  parentBranchId: undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

const nextSession: SessionInfo = {
  id: SessionId.of("session-next"),
  name: "Next Session",
  cwd: "/tmp/gent-next",
  reasoningLevel: undefined,
  branchId: BranchId.of("branch-next"),
  parentSessionId: undefined,
  parentBranchId: undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

const HealthControlsProbe = (props: {
  expose: (controls: {
    switchSession: () => void
    switchBranchSameSession: () => void
    clearSession: () => void
  }) => void
}) => {
  const client = useClient()
  props.expose({
    switchSession: () =>
      client.switchSession(
        nextSession.id,
        BranchId.of(nextSession.branchId),
        nextSession.name ?? "Next Session",
      ),
    switchBranchSameSession: () =>
      client.switchSession(
        testSession.id,
        BranchId.of("branch-alt"),
        testSession.name ?? "Test Session",
      ),
    clearSession: () => client.clearSession(),
  })
  return <text>{client.extensionHealth().summary.failedActors.join(",")}</text>
}

const createMutableRuntime = (initialState: ConnectionState) => {
  let state = initialState
  const listeners = new Set<(state: ConnectionState) => void>()
  const runtime: GentRuntime = {
    cast: (effect) => {
      Effect.runFork(effect)
    },
    fork: Effect.runFork as never,
    run: Effect.runPromise as never,
    lifecycle: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        listener(state)
        return () => {
          listeners.delete(listener)
        }
      },
      restart: Effect.void,
      waitForReady: Effect.void,
    },
  }

  return {
    runtime,
    emit: (nextState: ConnectionState) => {
      state = nextState
      for (const listener of listeners) listener(nextState)
    },
  }
}

describe("TUI renderer surfaces", () => {
  test("MessageList renders user labels and assistant reasoning", async () => {
    const items: SessionItem[] = [
      {
        _tag: "message",
        id: "user-1",
        role: "user",
        kind: "interjection",
        pendingMode: "steer",
        content: "Stop and switch agent",
        reasoning: "",
        images: [],
        createdAt: Date.now(),
        toolCalls: undefined,
      } satisfies Message,
      {
        _tag: "message",
        id: "assistant-1",
        role: "assistant",
        kind: "regular",
        content: "Switching now",
        reasoning: "Considering current task state",
        images: [],
        createdAt: Date.now(),
        toolCalls: undefined,
      } satisfies Message,
    ]

    const setup = await renderWithProviders(() => (
      <MessageList
        items={items}
        toolsExpanded={false}
        syntaxStyle={syntaxStyle}
        streaming={false}
      />
    ))
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(frame).toContain("[steer]")
    expect(frame).toContain("Stop and switch agent")
    expect(frame).toContain("Considering current task state")
  })

  test("QueueWidget renders steer and queued summaries", async () => {
    const steerMessages: QueueEntryInfo[] = [
      {
        _tag: "steering",
        id: "m1",
        content: "switch to deepwork",
        createdAt: Date.now(),
      },
    ]
    const queuedMessages: QueueEntryInfo[] = [
      {
        _tag: "follow-up",
        id: "m2",
        content: "line one\nline two\nline three",
        createdAt: Date.now(),
      },
    ]

    const setup = await renderWithProviders(() => (
      <QueueWidget queuedMessages={queuedMessages} steerMessages={steerMessages} />
    ))

    const frame = renderFrame(setup)
    expect(frame).toContain("queue")
    expect(frame).toContain("[steer 1] switch to deepwork")
    expect(frame).toContain("[queued 1] line one +2 lines")
    expect(frame).toContain("cmd+up restore")
  })

  test("TaskWidget preview renders summary and overflow", async () => {
    const setup = await renderWithProviders(() => (
      <TaskWidget
        previewTasks={[
          { subject: "Resolve transport DTOs", status: "completed" },
          { subject: "Add renderer coverage", status: "in_progress" },
          { subject: "Clean debug boot", status: "pending" },
          { subject: "Document final architecture", status: "failed" },
          { subject: "Overflow 1", status: "pending" },
          { subject: "Overflow 2", status: "pending" },
          { subject: "Overflow 3", status: "pending" },
          { subject: "Overflow 4", status: "pending" },
          { subject: "Overflow 5", status: "pending" },
          { subject: "Overflow 6", status: "pending" },
          { subject: "Overflow 7", status: "pending" },
        ]}
      />
    ))

    const frame = renderFrame(setup)
    expect(frame).toContain("tasks")
    expect(frame).toContain("11 tasks")
    expect(frame).toContain("Resolve transport DTOs")
    expect(frame).toContain("Add renderer coverage")
    expect(frame).toContain("+1 more")
  })

  test("ConnectionWidget renders nothing when no connection issue", async () => {
    // ConnectionWidget now self-sources from useClient() — no props.
    // Default mock client has no connection issues, so widget renders nothing.
    const setup = await renderWithProviders(() => <ConnectionWidget />)

    const frame = renderFrame(setup)
    expect(frame).not.toContain("connection")
  })

  test("ConnectionWidget surfaces failed extension activation", async () => {
    const setup = await renderWithProviders(() => <ConnectionWidget />, {
      client: createMockClient({
        extension: {
          listStatus: () =>
            Effect.succeed({
              extensions: [
                {
                  manifest: { id: "@gent/memory" },
                  scope: "builtin" as const,
                  sourcePath: "builtin",
                  status: "degraded" as const,
                  activation: {
                    status: "failed" as const,
                    phase: "startup" as const,
                    error: "startup boom",
                  },
                  scheduler: { status: "healthy" as const, failures: [] },
                },
              ],
              summary: {
                status: "degraded" as const,
                subtitle: "extension activation degraded",
                failedExtensions: ["@gent/memory"],
                failedActors: [],
                failedScheduledJobs: [],
              },
            }),
        },
      }),
    })

    const frame = renderFrame(setup)
    expect(frame).toContain("connection")
    expect(frame).toContain("failed extensions")
    expect(frame).toContain("@gent/memory")
  })

  test("ConnectionWidget surfaces failed session actors", async () => {
    const setup = await renderWithProviders(() => <ConnectionWidget />, {
      initialSession: testSession,
      client: createMockClient({
        extension: {
          listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
            expect(sessionId).toBe(testSession.id)
            return Effect.succeed({
              extensions: [
                {
                  manifest: { id: "@gent/plan" },
                  scope: "builtin" as const,
                  sourcePath: "builtin",
                  status: "degraded" as const,
                  activation: { status: "active" as const },
                  actor: {
                    extensionId: "@gent/plan",
                    sessionId: testSession.id,
                    branchId: testSession.branchId,
                    status: "failed" as const,
                    error: "actor boom",
                  },
                  scheduler: { status: "healthy" as const, failures: [] },
                },
              ],
              summary: {
                status: "degraded" as const,
                subtitle: "extension runtime degraded",
                failedExtensions: [],
                failedActors: ["@gent/plan"],
                failedScheduledJobs: [],
              },
            })
          },
        },
      }),
    })

    const frame = renderFrame(setup)
    expect(frame).toContain("connection")
    expect(frame).toContain("failed session actors")
    expect(frame).toContain("@gent/plan")
  })

  test("ConnectionWidget surfaces failed scheduled jobs", async () => {
    const setup = await renderWithProviders(() => <ConnectionWidget />, {
      client: createMockClient({
        extension: {
          listStatus: () =>
            Effect.succeed({
              extensions: [
                {
                  manifest: { id: "@gent/memory" },
                  scope: "builtin" as const,
                  sourcePath: "builtin",
                  status: "degraded" as const,
                  activation: { status: "active" as const },
                  scheduler: {
                    status: "degraded" as const,
                    failures: [{ jobId: "reflect", error: "launchd registration failed" }],
                  },
                },
              ],
              summary: {
                status: "degraded" as const,
                subtitle: "scheduled jobs degraded",
                failedExtensions: [],
                failedActors: [],
                failedScheduledJobs: ["@gent/memory:reflect"],
              },
            }),
        },
      }),
    })

    const frame = renderFrame(setup)
    expect(frame).toContain("connection")
    expect(frame).toContain("failed scheduled jobs")
    expect(frame).toContain("@gent/memory:reflect")
  })

  test("ConnectionWidget refreshes extension status after reconnect generation changes", async () => {
    const lifecycle = createMutableRuntime({ _tag: "connected", generation: 0 })
    let callCount = 0
    let currentHealth = {
      extensions: [
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin" as const,
          sourcePath: "builtin",
          status: "degraded" as const,
          activation: { status: "active" as const },
          actor: {
            extensionId: "@gent/plan",
            sessionId: testSession.id,
            branchId: testSession.branchId,
            status: "failed" as const,
            error: "actor boom",
          },
          scheduler: { status: "healthy" as const, failures: [] },
        },
      ],
      summary: {
        status: "degraded" as const,
        subtitle: "extension runtime degraded",
        failedExtensions: [],
        failedActors: ["@gent/plan"],
        failedScheduledJobs: [],
      },
    }

    const setup = await renderWithProviders(() => <ConnectionWidget />, {
      initialSession: testSession,
      runtime: lifecycle.runtime,
      client: createMockClient({
        extension: {
          listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
            callCount += 1
            expect(sessionId).toBe(testSession.id)
            return Effect.succeed(currentHealth)
          },
        },
      }),
    })

    expect(renderFrame(setup)).toContain("failed session actors")
    expect(callCount).toBe(1)

    currentHealth = {
      extensions: [],
      summary: {
        status: "healthy" as const,
        failedExtensions: [],
        failedActors: [],
        failedScheduledJobs: [],
      },
    }
    lifecycle.emit({ _tag: "reconnecting", attempt: 1, generation: 1 })
    await Promise.resolve()
    await setup.renderOnce()
    lifecycle.emit({ _tag: "connected", generation: 1 })
    await Promise.resolve()
    await setup.renderOnce()
    await Promise.resolve()
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(callCount).toBe(2)
    expect(frame).not.toContain("failed session actors")
    expect(frame).not.toContain("@gent/plan")
  })

  test("ConnectionWidget clears stale extension status when switching sessions", async () => {
    let controls!: { switchSession: () => void; clearSession: () => void }
    const setup = await renderWithProviders(
      () => (
        <>
          <ConnectionWidget />
          <HealthControlsProbe expose={(next) => (controls = next)} />
        </>
      ),
      {
        initialSession: testSession,
        client: createMockClient({
          extension: {
            listStatus: ({ sessionId }: { sessionId?: SessionId }) =>
              Effect.succeed(
                sessionId === testSession.id
                  ? {
                      extensions: [
                        {
                          manifest: { id: "@gent/plan" },
                          scope: "builtin" as const,
                          sourcePath: "builtin",
                          status: "degraded" as const,
                          activation: { status: "active" as const },
                          actor: {
                            extensionId: "@gent/plan",
                            sessionId: testSession.id,
                            branchId: testSession.branchId,
                            status: "failed" as const,
                            error: "actor boom",
                          },
                          scheduler: { status: "healthy" as const, failures: [] },
                        },
                      ],
                      summary: {
                        status: "degraded" as const,
                        subtitle: "extension runtime degraded",
                        failedExtensions: [],
                        failedActors: ["@gent/plan"],
                        failedScheduledJobs: [],
                      },
                    }
                  : {
                      extensions: [],
                      summary: {
                        status: "healthy" as const,
                        failedExtensions: [],
                        failedActors: [],
                        failedScheduledJobs: [],
                      },
                    },
              ),
          },
        }),
      },
    )

    expect(renderFrame(setup)).toContain("@gent/plan")

    controls.switchSession()
    await Promise.resolve()
    await setup.renderOnce()
    await Promise.resolve()
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(frame).not.toContain("failed session actors")
    expect(frame).not.toContain("@gent/plan")
  })

  test("same-session branch switches preserve session-scoped extension health", async () => {
    let controls:
      | {
          switchSession: () => void
          switchBranchSameSession: () => void
          clearSession: () => void
        }
      | undefined

    const setup = await renderWithProviders(
      () => (
        <>
          <HealthControlsProbe expose={(value) => (controls = value)} />
          <ConnectionWidget />
        </>
      ),
      {
        initialSession: testSession,
        client: createMockClient({
          extension: {
            listStatus: ({ sessionId }: { sessionId?: SessionId }) =>
              Effect.succeed(
                sessionId === testSession.id
                  ? {
                      extensions: [
                        {
                          manifest: { id: "@gent/plan" },
                          scope: "builtin" as const,
                          sourcePath: "builtin",
                          status: "degraded" as const,
                          activation: { status: "active" as const },
                          actor: {
                            extensionId: "@gent/plan",
                            sessionId: testSession.id,
                            branchId: testSession.branchId,
                            status: "failed" as const,
                            error: "actor boom",
                          },
                          scheduler: { status: "healthy" as const, failures: [] },
                        },
                      ],
                      summary: {
                        status: "degraded" as const,
                        subtitle: "extension runtime degraded",
                        failedExtensions: [],
                        failedActors: ["@gent/plan"],
                        failedScheduledJobs: [],
                      },
                    }
                  : {
                      extensions: [],
                      summary: {
                        status: "healthy" as const,
                        failedExtensions: [],
                        failedActors: [],
                        failedScheduledJobs: [],
                      },
                    },
              ),
          },
        }),
      },
    )

    expect(renderFrame(setup)).toContain("@gent/plan")

    controls?.switchBranchSameSession()
    await Promise.resolve()
    await setup.renderOnce()
    await Promise.resolve()
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(frame).toContain("failed session actors")
    expect(frame).toContain("@gent/plan")
  })
})

describe("uiModel schema validation", () => {
  const ArtifactUiModel = Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        sourceTool: Schema.String,
        status: Schema.Literals(["active", "resolved"]),
      }),
    ),
  })
  const decode = Schema.decodeUnknownOption(ArtifactUiModel)

  test("valid artifact snapshot decodes correctly", () => {
    const valid = {
      items: [{ id: "a1", label: "Plan: auth refactor", sourceTool: "plan", status: "active" }],
    }
    const result = decode(valid)
    expect(result._tag).toBe("Some")
  })

  test("empty items decodes correctly", () => {
    const valid = { items: [] }
    const result = decode(valid)
    expect(result._tag).toBe("Some")
  })

  test("malformed snapshot decodes to None (not crash)", () => {
    const malformed = { items: "not-an-array" }
    const result = decode(malformed)
    expect(result._tag).toBe("None")
  })

  test("missing fields decode to None", () => {
    const partial = {}
    const result = decode(partial)
    expect(result._tag).toBe("None")
  })

  test("null snapshot decodes to None", () => {
    const result = decode(null)
    expect(result._tag).toBe("None")
  })
})
