/** @jsxImportSource @opentui/solid */
import { describe, it, test, expect } from "effect-bun-test"
import { Context, Effect, Option, Schema } from "effect"
import { SyntaxStyle } from "@opentui/core"
import { ConnectionState } from "@gent/sdk"
import type { ExtensionHealthSnapshot, GentRuntime, QueueEntryInfo, Session } from "@gent/sdk"
import { MessageList, type Message, type SessionItem } from "../src/message-list"
import { ConnectionWidget } from "../src/extensions/builtins"
import { QueueWidget } from "../src/app"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness-boundary"
import { runEffectBoundary } from "./run-effect-boundary"
import { useClient } from "../src/client"
import { BranchId, MessageId, SessionId, dateFromMillis } from "@gent/core/protocol"

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())

const syntaxStyle = () => SyntaxStyle.create()
const testSession: Session = {
  id: SessionId.make("session-test"),
  name: "Test Session",
  cwd: "/tmp/gent-test",
  reasoningLevel: absent,
  activeBranchId: BranchId.make("branch-test"),
  parentSessionId: absent,
  parentBranchId: absent,
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
}
const nextSession: Session = {
  id: SessionId.make("session-next"),
  name: "Next Session",
  cwd: "/tmp/gent-next",
  reasoningLevel: absent,
  activeBranchId: BranchId.make("branch-next"),
  parentSessionId: absent,
  parentBranchId: absent,
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
}

const scheduledFailureHealth = (id: string, error: string): ExtensionHealthSnapshot => ({
  _tag: "Degraded",
  healthyExtensions: [],
  degradedExtensions: [
    {
      manifest: { id },
      scope: "builtin",
      sourcePath: "builtin",
      _tag: "Degraded",
      issues: [{ _tag: "ActivationFailed", phase: "startup", error }],
    },
  ],
})

const healthyHealth: ExtensionHealthSnapshot = { _tag: "Healthy", extensions: [] }

const runWithEmptyContext = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runEffectBoundary(Effect.provideContext(effect, Context.makeUnsafe<R>(new Map<string, never>())))

const HealthControlsProbe = (props: {
  expose: (controls: {
    switchSession: () => void
    switchBranchSameSession: () => void
    clearSession: () => void
  }) => void
}) => {
  const client = useClient()
  const nextBranchId = Option.getOrElse(Option.fromNullishOr(nextSession.activeBranchId), () =>
    BranchId.make("branch-next"),
  )
  const nextName = Option.getOrElse(Option.fromNullishOr(nextSession.name), () => "Next Session")
  const testName = Option.getOrElse(Option.fromNullishOr(testSession.name), () => "Test Session")
  props.expose({
    switchSession: () => client.switchSession(nextSession.id, nextBranchId, nextName),
    switchBranchSameSession: () =>
      client.switchSession(testSession.id, BranchId.make("branch-alt"), testName),
    clearSession: () => client.clearSession(),
  })
  const failedActivation = () => {
    const health = client.extensionHealth()
    if (health._tag !== "Degraded") return []
    return health.degradedExtensions
      .filter((extension) => extension.issues.some((issue) => issue._tag === "ActivationFailed"))
      .map((extension) => extension.manifest.id)
  }
  return <text>{failedActivation().join(",")}</text>
}
const createMutableRuntime = (initialState: ConnectionState) => {
  let state = initialState
  const listeners = new Set<(state: ConnectionState) => void>()
  const runtime: GentRuntime = {
    cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      Effect.runForkWith(Context.makeUnsafe<R>(new Map<string, never>()))(effect)
    },
    fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runForkWith(Context.makeUnsafe<R>(new Map<string, never>()))(effect),
    run: runWithEmptyContext,
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
          createdAt: 0,
          toolCalls: absent,
        } satisfies Message,
        {
          _tag: "regular-message",
          id: "assistant-1",
          role: "assistant",
          content: "Switching now",
          reasoning: "Considering current todo state",
          images: [],
          createdAt: 0,
          toolCalls: absent,
          // The feed spells an assistant answer as segments in part order,
          // with the flat fields alongside for readers that want the whole
          // text at once.
          segments: [
            { _tag: "reasoning", content: "Considering current todo state" },
            { _tag: "text", content: "Switching now" },
          ],
        } satisfies Message,
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={items}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("[steer]")
      expect(frame).toContain("Stop and switch agent")
      expect(frame).toContain("Considering current todo state")
    }),
  )
  it.live("QueueWidget renders steer and queued summaries", () =>
    Effect.gen(function* () {
      const steerMessages: QueueEntryInfo[] = [
        {
          _tag: "Steering",
          id: MessageId.make("m1"),
          content: "switch to deepwork",
          createdAt: 0,
        },
      ]
      const queuedMessages: QueueEntryInfo[] = [
        {
          _tag: "FollowUp",
          id: MessageId.make("m2"),
          content: "line one\nline two\nline three",
          createdAt: 0,
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
                  _tag: "Degraded",
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/memory" },
                      scope: "builtin",
                      sourcePath: "builtin",
                      _tag: "Degraded",
                      issues: [
                        {
                          _tag: "ActivationFailed",
                          phase: "startup",
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
  it.live("ConnectionWidget surfaces failed extensions for the active session", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ConnectionWidget />, {
          initialSession: testSession,
          client: createMockClient({
            extension: {
              listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                expect(sessionId).toBe(testSession.id)
                return Effect.succeed({
                  _tag: "Degraded",
                  healthyExtensions: [],
                  degradedExtensions: [
                    {
                      manifest: { id: "@gent/plan" },
                      scope: "builtin",
                      sourcePath: "builtin",
                      _tag: "Degraded",
                      issues: [
                        {
                          _tag: "ActivationFailed",
                          phase: "startup",
                          error: "launchd boom",
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
      expect(frame).toContain("failed extensions")
      expect(frame).toContain("@gent/plan")
    }),
  )
  it.live("ConnectionWidget refreshes extension status after reconnect generation changes", () =>
    Effect.gen(function* () {
      const lifecycle = createMutableRuntime(
        ConnectionState.cases.Connected.make({ generation: 0 }),
      )
      let callCount = 0
      let currentHealth: ExtensionHealthSnapshot = {
        _tag: "Degraded",
        healthyExtensions: [],
        degradedExtensions: [
          {
            manifest: { id: "@gent/plan" },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "Degraded",
            issues: [
              {
                _tag: "ActivationFailed",
                phase: "startup",
                error: "launchd boom",
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
      expect(renderFrame(setup)).toContain("failed extensions")
      expect(callCount).toBe(1)
      currentHealth = {
        _tag: "Healthy",
        extensions: [],
      }
      lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(callCount).toBe(2)
      expect(frame).not.toContain("failed extensions")
      expect(frame).not.toContain("@gent/plan")
    }),
  )
  it.live("ConnectionWidget clears stale extension status when switching sessions", () =>
    Effect.gen(function* () {
      let controls = Option.none<{
        switchSession: () => void
        clearSession: () => void
      }>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <ConnectionWidget />
              <HealthControlsProbe expose={(next) => (controls = Option.some(next))} />
            </>
          ),
          {
            initialSession: testSession,
            client: createMockClient({
              extension: {
                listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                  if (sessionId === testSession.id) {
                    return Effect.succeed(scheduledFailureHealth("@gent/plan", "launchd boom"))
                  }
                  return Effect.succeed(healthyHealth)
                },
              },
            }),
          },
        ),
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      if (Option.isNone(controls)) return yield* Effect.die("health controls not ready")
      controls.value.switchSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).not.toContain("failed extensions")
      expect(frame).not.toContain("@gent/plan")
    }),
  )
  it.live("same-session branch switches preserve session-scoped extension health", () =>
    Effect.gen(function* () {
      let controls = Option.none<{
        switchSession: () => void
        switchBranchSameSession: () => void
        clearSession: () => void
      }>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <HealthControlsProbe expose={(value) => (controls = Option.some(value))} />
              <ConnectionWidget />
            </>
          ),
          {
            initialSession: testSession,
            client: createMockClient({
              extension: {
                listStatus: ({ sessionId }: { sessionId?: SessionId }) => {
                  if (sessionId === testSession.id) {
                    return Effect.succeed(scheduledFailureHealth("@gent/plan", "launchd boom"))
                  }
                  return Effect.succeed(healthyHealth)
                },
              },
            }),
          },
        ),
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      if (Option.isNone(controls)) return yield* Effect.die("health controls not ready")
      controls.value.switchBranchSameSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("failed extensions")
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
    const result = decode(nullValue)
    expect(result._tag).toBe("None")
  })
})
