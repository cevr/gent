/** @jsxImportSource @opentui/solid */
import { describe, it, test, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { SyntaxStyle } from "@opentui/core"
import type {
  ConnectionState,
  ExtensionHealthSnapshot,
  QueueEntryInfo,
  SessionInfo,
} from "@gent/sdk"
import { MessageList, type Message, type SessionItem } from "../../src/components/message-list"
import { ConnectionWidget } from "../../src/components/connection-widget"
import { QueueWidget } from "../../src/components/queue-widget"
import { TaskWidget } from "../../src/components/task-widget"
import {
  createMockClient,
  renderFrame,
  renderWithProviders,
} from "../../src/../tests/render-harness"
import { useClient, type GentRuntime } from "../../src/client"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
const syntaxStyle = () => SyntaxStyle.create()
const testSession: SessionInfo = {
  id: SessionId.make("session-test"),
  name: "Test Session",
  cwd: "/tmp/gent-test",
  reasoningLevel: undefined,
  branchId: BranchId.make("branch-test"),
  parentSessionId: undefined,
  parentBranchId: undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
const nextSession: SessionInfo = {
  id: SessionId.make("session-next"),
  name: "Next Session",
  cwd: "/tmp/gent-next",
  reasoningLevel: undefined,
  branchId: BranchId.make("branch-next"),
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
        nextSession.branchId ?? BranchId.make("branch-next"),
        nextSession.name ?? "Next Session",
      ),
    switchBranchSameSession: () =>
      client.switchSession(
        testSession.id,
        BranchId.make("branch-alt"),
        testSession.name ?? "Test Session",
      ),
    clearSession: () => client.clearSession(),
  })
  const failedActors = () => {
    const health = client.extensionHealth()
    return health._tag === "degraded"
      ? health.degradedExtensions
          .filter((extension) => extension.issues.some((issue) => issue._tag === "actor-failed"))
          .map((extension) => extension.manifest.id)
      : []
  }
  return <text>{failedActors().join(",")}</text>
}
const createMutableRuntime = (initialState: ConnectionState) => {
  let state = initialState
  const listeners = new Set<(state: ConnectionState) => void>()
  const runtime: GentRuntime = {
    cast: (effect) => {
      Effect.runFork(effect as Effect.Effect<unknown, unknown, never>)
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
  it.live("MessageList renders user labels and assistant reasoning", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        {
          _tag: "interjection-message",
          id: "user-1",
          role: "user",
          pendingMode: "steer",
          content: "Stop and switch agent",
          reasoning: "",
          images: [],
          createdAt: Date.now(),
          toolCalls: undefined,
        } satisfies Message,
        {
          _tag: "regular-message",
          id: "assistant-1",
          role: "assistant",
          content: "Switching now",
          reasoning: "Considering current task state",
          images: [],
          createdAt: Date.now(),
          toolCalls: undefined,
        } satisfies Message,
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={items}
            toolsExpanded={false}
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("[steer]")
      expect(frame).toContain("Stop and switch agent")
      expect(frame).toContain("Considering current task state")
    }),
  )
  it.live("QueueWidget renders steer and queued summaries", () =>
    Effect.gen(function* () {
      const steerMessages: QueueEntryInfo[] = [
        {
          _tag: "steering",
          id: MessageId.make("m1"),
          content: "switch to deepwork",
          createdAt: Date.now(),
        },
      ]
      const queuedMessages: QueueEntryInfo[] = [
        {
          _tag: "follow-up",
          id: MessageId.make("m2"),
          content: "line one\nline two\nline three",
          createdAt: Date.now(),
        },
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <QueueWidget queuedMessages={queuedMessages} steerMessages={steerMessages} />
        )),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("queue")
      expect(frame).toContain("[steer 1] switch to deepwork")
      expect(frame).toContain("[queued 1] line one +2 lines")
      expect(frame).toContain("cmd+up restore")
    }),
  )
  it.live("TaskWidget preview renders summary and overflow", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
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
        )),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("tasks")
      expect(frame).toContain("11 tasks")
      expect(frame).toContain("Resolve transport DTOs")
      expect(frame).toContain("Add renderer coverage")
      expect(frame).toContain("+1 more")
    }),
  )
  it.live("ConnectionWidget renders nothing when no connection issue", () =>
    Effect.gen(function* () {
      // ConnectionWidget now self-sources from useClient() — no props.
      // Default mock client has no connection issues, so widget renders nothing.
      const setup = yield* Effect.promise(() => renderWithProviders(() => <ConnectionWidget />))
      const frame = renderFrame(setup)
      expect(frame).not.toContain("connection")
    }),
  )
  it.live("ConnectionWidget surfaces failed extension activation", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          client: createMockClient({
            extension: {
              listStatus: () =>
                Effect.succeed({
                  _tag: "degraded" as const,
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/memory" },
                      scope: "builtin" as const,
                      sourcePath: "builtin",
                      _tag: "degraded" as const,
                      issues: [
                        {
                          _tag: "activation-failed" as const,
                          phase: "startup" as const,
                          error: "startup boom",
                        },
                      ],
                    },
                  ],
                }),
            },
          }),
        }),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("failed extensions")
      expect(frame).toContain("@gent/memory")
    }),
  )
  it.live("ConnectionWidget surfaces failed session actors", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          initialSession: testSession,
          client: createMockClient({
            extension: {
              listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                expect(sessionId).toBe(testSession.id)
                return Effect.succeed({
                  _tag: "degraded" as const,
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/plan" },
                      scope: "builtin" as const,
                      sourcePath: "builtin",
                      _tag: "degraded" as const,
                      issues: [
                        {
                          _tag: "actor-failed" as const,
                          sessionId: testSession.id,
                          branchId: testSession.branchId,
                          error: "actor boom",
                          failurePhase: "runtime" as const,
                        },
                      ],
                    },
                  ],
                })
              },
            },
          }),
        }),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("failed session actors")
      expect(frame).toContain("@gent/plan")
    }),
  )
  it.live("ConnectionWidget surfaces failed scheduled jobs", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          client: createMockClient({
            extension: {
              listStatus: () =>
                Effect.succeed({
                  _tag: "degraded" as const,
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/memory" },
                      scope: "builtin" as const,
                      sourcePath: "builtin",
                      _tag: "degraded" as const,
                      issues: [
                        {
                          _tag: "scheduled-job-failed" as const,
                          jobId: "reflect",
                          error: "launchd registration failed",
                        },
                      ],
                    },
                  ],
                }),
            },
          }),
        }),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("failed scheduled jobs")
      expect(frame).toContain("@gent/memory:reflect")
    }),
  )
  it.live("ConnectionWidget refreshes extension status after reconnect generation changes", () =>
    Effect.gen(function* () {
      const lifecycle = createMutableRuntime({ _tag: "connected", generation: 0 })
      let callCount = 0
      let currentHealth: ExtensionHealthSnapshot = {
        _tag: "degraded",
        healthyExtensions: [],
        degradedExtensions: [
          {
            manifest: { id: "@gent/plan" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            _tag: "degraded" as const,
            issues: [
              {
                _tag: "actor-failed" as const,
                sessionId: testSession.id,
                branchId: testSession.branchId,
                error: "actor boom",
                failurePhase: "runtime" as const,
              },
            ],
          },
        ],
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
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
        }),
      )
      expect(renderFrame(setup)).toContain("failed session actors")
      expect(callCount).toBe(1)
      currentHealth = {
        _tag: "healthy",
        extensions: [],
      }
      lifecycle.emit({ _tag: "reconnecting", attempt: 1, generation: 1 })
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      lifecycle.emit({ _tag: "connected", generation: 1 })
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(callCount).toBe(2)
      expect(frame).not.toContain("failed session actors")
      expect(frame).not.toContain("@gent/plan")
    }),
  )
  it.live("ConnectionWidget clears stale extension status when switching sessions", () =>
    Effect.gen(function* () {
      let controls!: {
        switchSession: () => void
        clearSession: () => void
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
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
                          _tag: "degraded" as const,
                          healthyExtensions: [],
                          degradedExtensions: [
                            {
                              manifest: { id: "@gent/plan" },
                              scope: "builtin" as const,
                              sourcePath: "builtin",
                              _tag: "degraded" as const,
                              issues: [
                                {
                                  _tag: "actor-failed" as const,
                                  sessionId: testSession.id,
                                  branchId: testSession.branchId,
                                  error: "actor boom",
                                  failurePhase: "runtime" as const,
                                },
                              ],
                            },
                          ],
                        }
                      : {
                          _tag: "healthy" as const,
                          extensions: [],
                        },
                  ),
              },
            }),
          },
        ),
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      controls.switchSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).not.toContain("failed session actors")
      expect(frame).not.toContain("@gent/plan")
    }),
  )
  it.live("same-session branch switches preserve session-scoped extension health", () =>
    Effect.gen(function* () {
      let controls:
        | {
            switchSession: () => void
            switchBranchSameSession: () => void
            clearSession: () => void
          }
        | undefined
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
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
                          _tag: "degraded" as const,
                          healthyExtensions: [],
                          degradedExtensions: [
                            {
                              manifest: { id: "@gent/plan" },
                              scope: "builtin" as const,
                              sourcePath: "builtin",
                              _tag: "degraded" as const,
                              issues: [
                                {
                                  _tag: "actor-failed" as const,
                                  sessionId: testSession.id,
                                  branchId: testSession.branchId,
                                  error: "actor boom",
                                  failurePhase: "runtime" as const,
                                },
                              ],
                            },
                          ],
                        }
                      : {
                          _tag: "healthy" as const,
                          extensions: [],
                        },
                  ),
              },
            }),
          },
        ),
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      controls?.switchBranchSameSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("failed session actors")
      expect(frame).toContain("@gent/plan")
    }),
  )
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
