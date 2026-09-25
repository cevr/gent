/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Logger,
  Option,
  Queue,
  References,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { SocketCloseError } from "effect/unstable/socket/Socket"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentName,
  BranchId,
  dateFromMillis,
  DEFAULT_AGENT_NAME,
  GentRpcError,
  MessageId,
  ModelId,
  ProviderId,
  Message as StoredMessage,
  Session,
  SessionId,
  ConnectionState,
  type ExtensionHealthSnapshot,
  type GentClientRpcError,
  type QueueEntryInfo,
} from "@gent/core/protocol"
import { emptyQueueSnapshot } from "@gent/core/test-utils"
import { Gent, type GentRuntime } from "@gent/sdk"
import {
  App,
  AppBootstrapError,
  ConnectionWidget,
  type InitialState,
  QueueWidget,
  resolveInitialState,
  resolveHeadlessMissingProviders,
  resolveStartupAgent,
} from "../src/app"
import {
  createMockClient,
  createMockRuntime,
  renderFrame,
  renderWithProviders,
  applySnapshotAgent,
} from "./render-harness-boundary"
import { createSignal, onMount, type Signal } from "solid-js"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { type ClientContextValue, useClient } from "../src/client"
import { type RenderWaitTimeoutError, waitForFrame, waitUntilAdvancing } from "./helpers-boundary"
import { useTerminalDimensions } from "../src/terminal"
import { SyntaxStyle } from "@opentui/core"
import { type Message, MessageList, type SessionItem } from "../src/message-list"
import { useExtensionUI } from "../src/extensions/host"
import { builtinClientModules } from "../src/extensions/builtins"
import {
  ClientContext,
  clientCommandContribution,
  clientContributions,
  defineClientExtension,
  type AnyExtensionClientModule,
  type NoticeRow,
  noticeRowContribution,
  widgetContribution,
} from "../src/extensions/client-facets"
import { NOTICE_ROWS_BOUND, useSessionController } from "../src/session"

// ── app bootstrap ───────────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())
const idleTag = "Idle" satisfies "Idle"
const refusedInA = Schema.decodeSync(GentRpcError)({
  _tag: "InvalidStateError",
  message: "send refused in A",
})
const noAuthSource = "none" satisfies "none"

const expectAppBootstrapFailure = (
  effect: Effect.Effect<unknown, AppBootstrapError | GentClientRpcError>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return yield* Effect.die("expected app bootstrap failure")
    const reason = Option.fromUndefinedOr(exit.cause.reasons.find(Cause.isFailReason))
    if (Option.isNone(reason) || !Schema.is(AppBootstrapError)(reason.value.error)) {
      return yield* Effect.die("expected AppBootstrapError")
    }
    return reason.value.error
  })

describe("startup agent and headless auth", () => {
  it.live("interactive startup uses the session snapshot agent and lists no providers", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("deepwork"),
              runtime: {
                _tag: idleTag,
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
            ])
          },
        },
      })
      const state: InitialState = {
        _tag: "session",
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
      }
      const agent = yield* resolveStartupAgent({ client, state })
      expect(agent).toEqual(Option.some(AgentName.make("deepwork")))
      // The session view's auth gate checks the providers itself, once mounted.
      expect(calls).toEqual([])
    }),
  )
  it.live("a headless session checks auth for the agent it was created with", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("deepwork"),
              runtime: {
                _tag: idleTag,
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
            ])
          },
        },
      })
      const state: InitialState = {
        _tag: "headless",
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
        prompt: "hi",
      }
      const missing = yield* resolveHeadlessMissingProviders({ client, state })
      expect(missing).toEqual([ProviderId.make("openai")])
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("a session with no branch yet starts as the default agent", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
      })
      const state: InitialState = {
        _tag: "session",
        session: {
          id: SessionId.make("session-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
      }
      const agent = yield* resolveStartupAgent({ client, state })
      expect(agent).toEqual(Option.some(DEFAULT_AGENT_NAME))
      expect(calls).toEqual([])
    }),
  )
  it.live("names no agent while the user is choosing a branch", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) =>
            Effect.sync(() => {
              calls.push(input)
              return []
            }),
        },
      })
      const state: InitialState = {
        _tag: "branchPicker",
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
        branches: [
          {
            id: BranchId.make("branch-a"),
            sessionId: SessionId.make("session-a"),
            createdAt: dateFromMillis(0),
          },
          {
            id: BranchId.make("branch-b"),
            sessionId: SessionId.make("session-a"),
            createdAt: dateFromMillis(1),
          },
        ],
      }
      const agent = yield* resolveStartupAgent({ client, state })
      expect(agent).toEqual(Option.none())
      expect(calls).toEqual([])
    }),
  )
})

describe("resolveInitialState", () => {
  it.live("fails with typed bootstrap error when headless prompt is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.none(),
          continue_: false,
          headless: true,
          prompt: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }),
  )

  // The composer sends nothing for a blank draft; headless holds the same line.
  it.live("a whitespace-only headless prompt is a missing prompt", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.none(),
          continue_: false,
          headless: true,
          prompt: Option.none(),
          promptArg: Option.some(" \n\t "),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }),
  )

  it.live("a new headless session is created as the requested agent and run spec", () =>
    Effect.gen(function* () {
      const created: Array<{ readonly admission?: unknown }> = []
      const session = new Session({
        id: SessionId.make("session-test"),
        activeBranchId: BranchId.make("branch-test"),
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(0),
      })
      const admission = {
        agent: AgentName.make("deepwork"),
        runSpec: { overrides: { maxSteps: 3 } },
      }
      const state = yield* resolveInitialState({
        client: createMockClient({
          session: {
            create: (input: { readonly admission?: unknown }) =>
              Effect.sync(() => {
                created.push(input)
                return {
                  sessionId: session.id,
                  branchId: BranchId.make("branch-test"),
                  name: "Test Session",
                }
              }),
            get: () => Effect.succeed(session),
          },
        }),
        cwd: "/tmp",
        session: Option.none(),
        continue_: false,
        headless: true,
        prompt: Option.none(),
        promptArg: Option.some("hi"),
        admission,
      })
      expect(state).toMatchObject({ _tag: "headless", session: { id: "session-test" } })
      // The agent is fixed on the session; the prompt's turn carries none.
      expect(created.map((input) => input.admission)).toEqual([admission])
    }),
  )

  it.live("fails with typed bootstrap error when requested session is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.some("missing-session"),
          continue_: false,
          headless: false,
          prompt: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("session-not-found")
      expect(error.sessionId).toBe(SessionId.make("missing-session"))
    }),
  )
  it.live("resume opens the user's last session, not a child a delegate spawned later", () =>
    Effect.gen(function* () {
      const at = (ms: number) => dateFromMillis(1_767_225_600_000 + ms)
      const root = new Session({
        id: SessionId.make("root"),
        cwd: "/work",
        threadId: SessionId.make("root"),
        createdAt: at(0),
        updatedAt: at(10),
      })
      // A handoff continues the user's thread, so it is the session to reopen.
      const handoff = new Session({
        id: SessionId.make("handoff"),
        cwd: "/work",
        parentSessionId: root.id,
        threadId: root.id,
        createdAt: at(20),
        updatedAt: at(30),
      })
      // A delegate child starts its own thread and finishes last.
      const child = new Session({
        id: SessionId.make("child"),
        cwd: "/work",
        parentSessionId: handoff.id,
        threadId: SessionId.make("child"),
        createdAt: at(40),
        updatedAt: at(50),
      })
      const state = yield* resolveInitialState({
        client: createMockClient({
          session: { list: () => Effect.succeed([child, root, handoff]) },
        }),
        cwd: "/work",
        session: Option.none(),
        continue_: true,
        headless: false,
        prompt: Option.none(),
        promptArg: Option.none(),
      })
      expect(state).toMatchObject({ _tag: "session", session: { id: "handoff" } })
    }),
  )
})

// ── app auth ────────────────────────────────────────────────────────────────

class MessageTimeoutError extends Schema.TaggedError<MessageTimeoutError>()("MessageTimeoutError", {
  message: Schema.String,
}) {}

const apiMethod = { label: "API key", type: "api" } satisfies { label: string; type: "api" }

const authSource = (hasKey: boolean): "stored" | "none" => {
  if (hasKey) return "stored"
  return "none"
}

const requireClient = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, MessageTimeoutError> => {
  if (Option.isNone(context)) {
    return Effect.fail(new MessageTimeoutError({ message: "client context not ready" }))
  }
  return Effect.succeed(context.value)
}

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

/**
 * The session view over a turn that runs, on a terminal `height` rows tall.
 * The runtime stream says Running once and then stays quiet, as it does
 * through a long generation or a long tool call.
 */
const mountRunningTurn = (height = 24, extensions: ReadonlyArray<AnyExtensionClientModule> = []) =>
  Effect.gen(function* () {
    const sessionId = SessionId.make("session-running")
    const branchId = BranchId.make("branch-running")
    const running = { _tag: "Running" satisfies "Running", queue: emptyQueueSnapshot() }
    const steers: Array<string> = []
    const sent: Array<string> = []
    let shutdowns = 0
    let readActivity = () => "unmounted"
    const activityProbe = defineClientExtension("@test/activity-probe", {
      setup: Effect.gen(function* () {
        const { activity } = yield* ClientContext
        readActivity = () => activity.snapshot().state
        return clientContributions()
      }),
    })
    const client = createMockClient({
      auth: { listProviders: () => Effect.succeed([]) },
      branch: { getTree: () => Effect.succeed([]) },
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId,
            branchId,
            messages: [],
            lastEventId: nullValue,
            reasoningLevel: absent,
            resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
            agent: AgentName.make("main"),
            runtime: running,
            metrics: { turns: 1, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
          }),
        watchRuntime: () => Stream.concat(Stream.make(running), Stream.never),
      },
      steer: {
        command: (input: { readonly command: { readonly _tag: string } }) =>
          Effect.sync(() => {
            steers.push(input.command._tag)
          }),
      },
      message: {
        send: (input: { readonly content: string }) =>
          Effect.sync(() => {
            sent.push(input.content)
          }),
      },
    })
    let ctx = Option.none<ClientContextValue>()
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <>
            <App />
            <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
          </>
        ),
        {
          client,
          runtime: createMockRuntime(),
          builtins: [...builtinClientModules, activityProbe, ...extensions],
          height,
          initialSession: {
            id: sessionId,
            activeBranchId: branchId,
            name: "Running",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      ),
    )
    setup.renderer.destroy = () => {
      shutdowns += 1
    }
    yield* waitForFrame(
      setup,
      () => ctx.pipe(Option.exists((value) => value.isStreaming())),
      "running turn",
    )
    yield* waitForFrame(setup, () => readActivity() !== "unmounted", "activity probe loaded")
    const clientValue = yield* requireClient(ctx)
    return {
      setup,
      client: clientValue,
      steers,
      sent,
      shutdowns: () => shutdowns,
      activity: () => readActivity(),
    }
  })

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

/** Type a slash command and press Enter. */
const typeCommand = (command: string) => (setup: TestSetup) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => setup.mockInput.typeText(command))
    setup.mockInput.pressEnter()
  })

/** `mountRunningTurn` with an error on screen from a `/model` that matched nothing. */
const mountRunningTurnWithError = Effect.gen(function* () {
  const view = yield* mountRunningTurn()
  yield* Effect.promise(() => view.setup.mockInput.typeText("/model typo"))
  view.setup.mockInput.pressEnter()
  yield* waitForFrame(view.setup, (frame) => frame.includes("No model matches"), "error shown")
  return view
})

/**
 * A running session on a short terminal whose trays are full: four working
 * children and an alarm. The btw requests answer with a fork whose reply ends
 * in ANSWER-TAIL. `messages` is what the branch stores, the one read `/thread`
 * draws its windows from.
 */
const mountShortTerminalWithTrays = (
  height: number,
  messages: ReadonlyArray<StoredMessage> = [],
  options: {
    readonly width?: number
    readonly onClient?: (client: ClientContextValue) => void
  } = {},
) =>
  Effect.gen(function* () {
    const sessionId = SessionId.make("session-btw")
    const branchId = BranchId.make("branch-btw")
    const answer =
      "**Task 5** looks hardest: adding the API integration test requires starting and stopping the HTTP server, importing the CSV fixture over HTTP, managing temporary database state, and verifying the monthly report response. The other tasks are isolated logic fixes or a small query refactor. ANSWER-TAIL"
    const child = (n: number) => {
      const row = {
        sessionId: SessionId.make(`child-${n}`),
        branchId: BranchId.make(`child-${n}-branch`),
        section: "running" satisfies "running",
        name: `delegate: task ${n}`,
        live: true,
        depth: 1,
        parentSessionId: sessionId,
        sideThread: false,
      }
      // Tasks 3 and 4 report no activity line: their row names the detail
      // status only while the cursor is on it, which marks the cursor row.
      if (n <= 4) return row
      return { ...row, activity: "bash" }
    }
    const running = { _tag: "Running" satisfies "Running", queue: emptyQueueSnapshot() }
    const client = createMockClient({
      auth: { listProviders: () => Effect.succeed([]) },
      branch: { getTree: () => Effect.succeed([]) },
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId,
            branchId,
            messages: [],
            lastEventId: nullValue,
            reasoningLevel: absent,
            agent: AgentName.make("main"),
            runtime: running,
            resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
            metrics: { turns: 1, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
          }),
        watchRuntime: () => Stream.concat(Stream.make(running), Stream.never),
        thread: () =>
          Effect.succeed([
            new Session({
              id: sessionId,
              name: "Session BTW",
              activeBranchId: branchId,
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            }),
          ]),
      },
      message: { list: () => Effect.succeed(messages) },
      extension: {
        request: (input: { capabilityId: string }) =>
          Effect.sync(() => {
            if (input.capabilityId === "list-agents") return { rows: [3, 4, 5, 6].map(child) }
            if (input.capabilityId === "wake.pending") {
              return {
                now: 0,
                entries: [{ _tag: "alarm", wakeId: "w1", dueAt: 120_000, note: "check tests" }],
              }
            }
            if (input.capabilityId === "btw.ask") return { asked: true }
            if (input.capabilityId === "btw.fork") {
              return { sessionId: SessionId.make("fork"), branchId: BranchId.make("fork-b") }
            }
            if (input.capabilityId === "btw.progress") {
              return {
                fork: {
                  sessionId: SessionId.make("fork"),
                  branchId: BranchId.make("fork-b"),
                  name: "btw: which task is hardest?",
                  turns: [{ question: "which task is hardest?", answer }],
                  replying: false,
                },
              }
            }
            return {}
          }),
      },
    })
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <>
            <App />
            <ClientProbe onReady={options.onClient ?? (() => {})} />
          </>
        ),
        {
          client,
          runtime: createMockRuntime(),
          builtins: builtinClientModules,
          height,
          width: options.width,
          initialSession: {
            id: sessionId,
            activeBranchId: branchId,
            name: "Session BTW",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      ),
    )
    yield* waitForFrame(
      setup,
      (frame) => frame.includes("Generating") && frame.includes("delegate: task 3"),
      "a running turn over the trays",
    )
    return setup
  })

function ExtensionUIProbe(props: {
  readonly onReady: (ext: ReturnType<typeof useExtensionUI>) => void
}) {
  const ext = useExtensionUI()
  onMount(() => {
    props.onReady(ext)
  })
  return <box />
}

function TerminalDimensionsProbe() {
  const dimensions = useTerminalDimensions()
  return <text>{`${dimensions().width}x${dimensions().height}`}</text>
}

/**
 * The app on a test clock with one client extension whose notice-row sources
 * are `ids`, each answering its own signal (`None` until set). The session
 * view's casts and forks run on the clock and log into `warnings`, as
 * `<message> source=<id>`.
 */
const mountNoticeSources = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make()
    const warnings: Array<string> = []
    const capture = Logger.make(({ message, fiber }) => {
      const text = [message].flat().map(String).join(" ")
      const source = fiber.getRef(References.CurrentLogAnnotations)["source"]
      warnings.push(`${text} source=${String(source)}`)
    })
    // Only the session view's casts read this clock: the bound sleeps on it.
    // The test preload turns logs off; these casts log again, into `capture`.
    const withClock = <R,>() =>
      Context.makeUnsafe<R>(
        new Map<string, unknown>([
          [Clock.Clock.key, clock],
          [Logger.CurrentLoggers.key, new Set([capture])],
          [References.MinimumLogLevel.key, "All"],
        ]),
      )
    const runtime: GentRuntime = {
      ...createMockRuntime(),
      cast: (effect) => {
        Effect.runForkWith(withClock())(effect)
      },
      fork: (effect) => Effect.runForkWith(withClock())(effect),
    }
    const answers = new Map<string, Signal<Option.Option<ReadonlyArray<NoticeRow>>>>(
      ids.map((id) => [id, createSignal(Option.none<ReadonlyArray<NoticeRow>>())]),
    )
    const answer = (id: string, rows: ReadonlyArray<NoticeRow>) => {
      const entry = Option.fromNullishOr(answers.get(id))
      if (Option.isSome(entry)) entry.value[1](Option.some(rows))
    }
    let settled = () => false
    // A widget inside the session view reads the hold native history obeys.
    function SettledProbe() {
      settled = useSessionController().itemsSettled
      return <box />
    }
    const extension = defineClientExtension("@test/silent-notices", {
      setup: Effect.succeed(
        clientContributions(
          ...[...answers].map(([id, [rows]]) => noticeRowContribution({ id, rows: () => rows() })),
          widgetContribution({
            id: "settled-probe",
            slot: "below-input",
            component: SettledProbe,
          }),
        ),
      ),
    })
    let ext = Option.none<ReturnType<typeof useExtensionUI>>()
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <>
            <App />
            <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
          </>
        ),
        {
          client: createMockClient({
            auth: { listProviders: () => Effect.succeed([]) },
            branch: { getTree: () => Effect.succeed([]) },
          }),
          runtime,
          builtins: [...builtinClientModules, extension],
          initialSession: {
            id: SessionId.make("session-silent"),
            activeBranchId: BranchId.make("branch-silent"),
            name: "Silent",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      ),
    )
    const loaded = () => Option.exists(ext, (value) => value.loaded())
    yield* waitForFrame(setup, (frame) => frame.includes("ready ·") && loaded(), "loaded")
    const sources = (): ReadonlyArray<string> =>
      Option.match(ext, {
        onNone: () => [],
        onSome: (value) => value.noticeRows().map((source) => source.id),
      })
    const failed = () =>
      Option.exists(ext, (value) =>
        value.failures().some((failure) => failure.id === "@test/silent-notices"),
      )
    yield* waitForFrame(setup, () => ids.every((id) => sources().includes(id)), "the sources")
    return { setup, clock, warnings, answer, settled: () => settled(), sources, failed }
  })

describe("notice rows", () => {
  // Native history waits for every notice-row source; one that never answers
  // would hold it for good. The bound is on the hold: the source stays, and a
  // late answer still draws its rows.
  it.scopedLive("history stops waiting at the bound, and a late answer still draws its rows", () =>
    Effect.gen(function* () {
      const { setup, clock, answer, settled, sources, failed } = yield* mountNoticeSources([
        "silent",
      ])
      expect(settled()).toBe(false)
      // Inside the bound, history still waits for the source.
      yield* clock.adjust(Duration.subtract(NOTICE_ROWS_BOUND, Duration.millis(1)))
      yield* Effect.promise(() => setup.renderOnce())
      expect(settled()).toBe(false)
      yield* waitUntilAdvancing(clock.adjust("1 second"), settled, "history stopped waiting")
      // The source did not fail: it stays, and its late answer draws.
      expect(sources()).toContain("silent")
      expect(failed()).toBe(false)
      answer("silent", [
        { key: "late", createdAt: 1, glyph: "◌", color: "warning", text: "LATE-NOTICE-ROW" },
      ])
      yield* waitForFrame(setup, (frame) => frame.includes("LATE-NOTICE-ROW"), "the late row")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The bound warning names a source that held history to the end. A source
  // that answered inside the bound is not stuck and draws no warning.
  it.scopedLive("the bound warns only for a source still deriving at the bound", () =>
    Effect.gen(function* () {
      const { setup, clock, warnings, answer, settled } = yield* mountNoticeSources([
        "prompt",
        "stuck",
      ])
      yield* clock.adjust("1 second")
      answer("prompt", [
        { key: "on-time", createdAt: 1, glyph: "◌", color: "info", text: "ON-TIME-ROW" },
      ])
      yield* waitForFrame(setup, (frame) => frame.includes("ON-TIME-ROW"), "the on-time row")
      // Both holds end at the same instant; the stuck source's warning lands
      // after its release, so wait on the warning, then give every hold one
      // more step before reading the whole log.
      yield* waitUntilAdvancing(
        clock.adjust("1 second"),
        () => settled() && warnings.length > 0,
        "the bound warning",
      )
      yield* clock.adjust("1 second")
      yield* Effect.promise(() => setup.renderOnce())
      expect(warnings).toEqual(["tui.notice-rows.bound source=stuck"])
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App auth gate", () => {
  it.live("shares one terminal resize source across App and cleans it up", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <TerminalDimensionsProbe />
            </>
          ),
          {
            initialSession: {
              id: SessionId.make("session-resize"),
              activeBranchId: BranchId.make("branch-resize"),
              name: "Resize",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      expect(setup.renderer.listenerCount("resize")).toBe(1)
      expect(renderFrame(setup)).toContain("80x24")

      setup.renderer.resize(100, 30)
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("100x30")

      setup.renderer.destroy()
      expect(setup.renderer.listenerCount("resize")).toBe(0)
    }),
  )

  it.live("rechecks auth requirements when the selected agent changes", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const calls: Array<{
        agentName?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            calls.push(input)
            if (input.agentName === "deepwork") {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: true,
                  source: "none",
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Sign in ·"),
        "API Keys after agent switch",
      )
      expect(calls.length).toBeGreaterThan(0)
      expect(frame).toContain("Sign in ·")
      setup.renderer.destroy()
    }),
  )
  it.live("seeds startup auth gating from the initial selected agent", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string; sessionId?: string }) => {
            calls.push(input)
            if (input.agentName === "deepwork") {
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: true,
                  source: "none",
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime,
          initialAgent: AgentName.make("deepwork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Sign in ·"),
        "API Keys from initial agent",
      )
      // The auth check names the session that is actually mounted. It used to
      // name the route's session instead, which the harness could set to a
      // different id than the one the client held.
      expect(calls[0]).toEqual({
        agentName: AgentName.make("deepwork"),
        sessionId: SessionId.make("session-a"),
      })
      // The gate opens the auth overlay itself, and the branch picker is read
      // off that same overlay. A gate that re-ran on its own write would keep
      // checking; it settles instead. (Two checks: the agent arrives after the
      // first, which predates the overlay being the picker's owner.)
      expect(calls.length).toBe(2)
      expect(frame).toContain("Sign in ·")
      setup.renderer.destroy()
    }),
  )
  /**
   * The enforced sign-in on a `height`-row terminal: openai is required and
   * has no key, zzprovider is optional. The gate opens the pane on openai's
   * sign-in methods.
   */
  const mountSignIn = (height = 24, savedKeys: Array<string> = []) =>
    Effect.gen(function* () {
      const client = createMockClient({
        auth: {
          setKey: (input: { readonly provider: string; readonly key: string }) =>
            Effect.sync(() => {
              savedKeys.push(input.key)
            }),
          listProviders: () =>
            Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
              {
                provider: "zzprovider",
                hasKey: false,
                required: false,
                source: noAuthSource,
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ openai: [apiMethod] }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime: createMockRuntime(),
          initialAgent: AgentName.make("main"),
          height,
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("API key [api]"), "openai's methods")
      return setup
    })
  // The method screen is its own pane: the provider list it came from is gone,
  // so its rows never read as the choice. The key screen draws no list at all.
  it.live("the sign-in method and key screens draw no provider rows", () =>
    Effect.gen(function* () {
      const setup = yield* mountSignIn()
      const methods = renderFrame(setup)
      expect(methods).not.toContain("zzprovider")
      expect(methods).not.toContain("openai [none]")
      setup.mockInput.pressEnter()
      const key = yield* waitForFrame(setup, (frame) => frame.includes("API key ›"), "key line")
      expect(key).not.toContain("zzprovider")
      expect(key).not.toContain("API key [api]")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Docked, not modal: the sign-in draws under the composer's status row like
  // every pane, and a short terminal keeps its cursor row.
  it.live("the sign-in docks under the composer and keeps its cursor row at 10 rows", () =>
    Effect.gen(function* () {
      const setup = yield* mountSignIn()
      const lines = renderFrame(setup).split("\n")
      const input = lines.findIndex((line) => line.startsWith("┃"))
      const method = lines.findIndex((line) => line.includes("API key [api]"))
      expect(input).toBeGreaterThanOrEqual(0)
      expect(method).toBeGreaterThan(input)
      expect(renderFrame(setup)).not.toContain("╭")
      setup.resize(setup.renderer.terminalWidth, 10)
      yield* waitForFrame(
        setup,
        (frame) => setup.renderer.terminalHeight === 10 && frame.includes("API key [api]"),
        "the cursor row at 10 rows",
      )
      // Pasted text reaches the key line through the pane's own scope.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key ›"), "key line")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("sk-abc\n"))
      yield* waitForFrame(setup, (frame) => frame.includes("API key › ******"), "masked key")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A paste can carry terminal escape sequences (a colour code copied out of
  // another terminal) and C1 controls. The key keeps only its text: whole
  // sequences drop, not just their escape byte.
  it.live("a pasted key drops whole escape sequences and C1 controls", () =>
    Effect.gen(function* () {
      const saved: Array<string> = []
      const setup = yield* mountSignIn(24, saved)
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key ›"), "key line")
      yield* Effect.promise(() =>
        setup.mockInput.pasteBracketedText(
          "sk-a\u001b[31mb\u001b[0m\u0085c\u001b]0;title\u0007d\u009b1me",
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("API key › *"), "masked key")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => saved.length === 1, "the key saved")
      expect(saved).toEqual(["sk-abcde"])
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A key longer than the row shows the tail of its mask, so the caret the
  // reader types at stays on screen.
  it.live("a long key keeps the caret on screen", () =>
    Effect.gen(function* () {
      const setup = yield* mountSignIn()
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("API key ›"), "key line")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("sk-" + "x".repeat(200)))
      const frame = yield* waitForFrame(
        setup,
        (current) => current.includes("API key › …*"),
        "the mask's tail",
      )
      const line = frame.split("\n").find((row) => row.includes("API key ›")) ?? ""
      expect(line.trimEnd().endsWith("*│")).toBe(true)
      expect(line.length).toBeLessThanOrEqual(setup.renderer.terminalWidth)
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a send refused after a switch waits in its own session, draft and reason both", () =>
    Effect.gen(function* () {
      // The reader sends in A and moves to B before A's server answers. The
      // refusal belongs to A: B shows none of it, and A has both on return.
      const sessionA = SessionId.make("session-a")
      const branchA = BranchId.make("branch-a")
      const sessionB = SessionId.make("session-b")
      const branchB = BranchId.make("branch-b")
      const sentOut = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
        session: {
          getSnapshot: (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
            Effect.succeed({
              sessionId: input.sessionId,
              branchId: input.branchId,
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("cowork"),
              runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
              metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
            }),
        },
        message: {
          send: () =>
            Deferred.complete(sentOut, Effect.void).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.andThen(Effect.fail(refusedInA)),
              Effect.ensuring(Deferred.complete(answered, Effect.void)),
            ),
        },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialSession: {
              id: sessionA,
              activeBranchId: branchA,
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session A")
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      const clientCtx = ctx.value
      yield* Effect.promise(() => setup.mockInput.typeText("keep me in A"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Deferred.await(sentOut)
      clientCtx.switchSession(sessionB, branchB, "Session B")
      yield* waitForFrame(
        setup,
        () => Option.exists(clientCtx.sessionIdentity(), (s) => s.sessionId === sessionB),
        "session B",
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session B view")
      yield* Deferred.complete(answer, Effect.void)
      yield* Deferred.await(answered)
      // A few frames for anything the refusal would draw in B.
      for (let frame = 0; frame < 3; frame++) {
        yield* Effect.yieldNow
        yield* Effect.promise(() => setup.renderOnce())
      }
      const inB = renderFrame(setup)
      expect(inB).not.toContain("send refused in A")
      expect(inB).not.toContain("keep me in A")
      expect(clientCtx.error()).toBeNull()
      clientCtx.switchSession(sessionA, branchA, "Session A")
      yield* waitForFrame(setup, (frame) => frame.includes("keep me in A"), "draft back in A")
      yield* waitForFrame(setup, (frame) => frame.includes("send refused in A"), "reason in A")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("the startup prompt belongs to the boot session, not the next one", () =>
    Effect.gen(function* () {
      // The boot picker re-mounts the session view on the chosen branch, so
      // the prompt has to outlive one mount. A session the reader opens after
      // that is a different session and must start empty.
      const bootSessionId = SessionId.make("session-boot")
      const bootBranchId = BranchId.make("branch-boot")
      const nextSessionId = SessionId.make("session-next")
      const nextBranchId = BranchId.make("branch-next")
      const startupPrompt = "only for the boot session"
      const sentMessages: Array<{ sessionId: SessionId; content: string }> = []
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        session: {
          create: () =>
            Effect.succeed({
              sessionId: nextSessionId,
              branchId: nextBranchId,
              name: "Next",
            }),
        },
        message: {
          send: (input: { readonly sessionId: SessionId; readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialPrompt: Option.some(startupPrompt),
            initialSession: {
              id: bootSessionId,
              activeBranchId: bootBranchId,
              name: "Boot",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === startupPrompt),
        "sent message",
      )
      expect(sentMessages).toHaveLength(1)
      if (Option.isNone(ctx)) return yield* Effect.die("client context not ready")
      ctx.value.createSession()
      yield* waitForFrame(
        setup,
        () => ctx.pipe(Option.exists((value) => value.session()?.sessionId === nextSessionId)),
        "next session mounted",
      )
      // Several frames for the new session's feed to settle.
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages.filter((message) => message.sessionId === nextSessionId)).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("opening the palette between two escapes does not quit", () =>
    Effect.gen(function* () {
      let shutdowns = 0
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime: createMockRuntime(),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "Session A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      // One escape arms the quit; the palette keybind disarms it, and an escape closes the palette.
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("Commands"), "palette")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !frame.includes("Commands"), "palette closed")
      // The quit is disarmed, so this escape only arms it again.
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow the escape must be parsed and handled before the negative assertion
      yield* Effect.sleep("100 millis")
      expect(shutdowns).toBe(0)
      // A second escape in the window quits.
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, () => shutdowns > 0, "quit")
      setup.renderer.destroy = destroy
      expect(shutdowns).toBe(1)
      setup.renderer.destroy()
    }),
  )
  it.live("an error shown during a running turn leaves the turn running", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      expect(view.client.isStreaming()).toBe(true)
      expect(view.client.error()).toBe('No model matches "typo"')
      expect(view.activity()).toBe("working")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("escape cancels a running turn while an error shows, and never quits", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "first cancel")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, () => view.steers.length === 2, "second cancel")
      expect(view.steers).toEqual(["Cancel", "Cancel"])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("ctrl+c with an empty draft cancels a running turn while an error shows", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      expect(view.steers).toEqual(["Cancel"])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Keybinds run before the ctrl+c ladder: an extension that bound ctrl+c
  // would take the turn cancel and the quit. The loader refuses the keybind,
  // so ctrl+c cancels the turn and the command keeps its palette row.
  it.live("an extension keybind on ctrl+c is refused, and ctrl+c cancels the turn", () =>
    Effect.gen(function* () {
      let fired = 0
      const grabber = defineClientExtension("@test/ctrl-c-grabber", {
        setup: Effect.succeed(
          clientCommandContribution({
            id: "grabber.ctrl-c",
            title: "Grab ctrl+c",
            keybind: "ctrl+c",
            onSelect: () => {
              fired += 1
            },
          }),
        ),
      })
      const view = yield* mountRunningTurn(24, [grabber])
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      expect(view.steers).toEqual(["Cancel"])
      expect(fired).toBe(0)
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes('keybind "ctrl+c"'),
        "the refused keybind listed with the failed extensions",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Children that keep waking the parent start a new turn after each cancel;
  // the second ctrl+c in the quit window still leaves.
  it.live("a second ctrl+c after one that cancelled a turn quits while a turn runs", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      expect(view.shutdowns()).toBe(0)
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
      expect(view.steers).toEqual(["Cancel"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A docked pane leaves ctrl+c to the session: the btw ask line reads keys,
  // and a turn runs behind it.
  it.live("a second ctrl+c quits while the btw pane is open and a turn runs", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      yield* Effect.promise(() => view.setup.mockInput.typeText("/btw"))
      view.setup.mockInput.pressEnter()
      yield* waitForFrame(view.setup, (frame) => frame.includes("btw · fork"), "btw pane")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
      expect(view.steers).toEqual(["Cancel"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A pane the session docks over the composer is the nearest thing: ctrl+c
  // closes it as Esc does, and the ladder goes on from there.
  const heldPanes: ReadonlyArray<{
    readonly name: string
    readonly title: string
    readonly open: (setup: TestSetup) => Effect.Effect<void>
    /** A draft typed before the pane opens; a slash pane opens from an empty one. */
    readonly draft: Option.Option<string>
  }> = [
    { name: "/model", title: "Model ·", open: typeCommand("/model"), draft: Option.none() },
    { name: "/think", title: "Reasoning ·", open: typeCommand("/think"), draft: Option.none() },
    {
      name: "prompt search",
      title: "Prompt search",
      open: (setup) => Effect.sync(() => setup.mockInput.pressKey("r", { ctrl: true })),
      draft: Option.some("kept draft"),
    },
  ]
  for (const pane of heldPanes) {
    it.live(`ctrl+c closes the ${pane.name} pane before it cancels the turn`, () =>
      Effect.gen(function* () {
        const view = yield* mountRunningTurn()
        if (Option.isSome(pane.draft)) {
          const draft = pane.draft.value
          yield* Effect.promise(() => view.setup.mockInput.typeText(draft))
          yield* waitForFrame(view.setup, (frame) => frame.includes(draft), "the draft")
        }
        yield* pane.open(view.setup)
        yield* waitForFrame(view.setup, (frame) => frame.includes(pane.title), "the pane")
        view.setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(view.setup, (frame) => !frame.includes(pane.title), "the pane closed")
        expect(view.shutdowns()).toBe(0)
        expect(view.steers).toEqual([])
        if (Option.isSome(pane.draft)) {
          const draft = pane.draft.value
          // The composer holds the draft it had when the pane opened.
          expect(renderFrame(view.setup)).toContain(draft)
          view.setup.mockInput.pressKey("c", { ctrl: true })
          yield* waitForFrame(view.setup, (frame) => !frame.includes(draft), "the draft cleared")
        }
        view.setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(view.setup, () => view.steers.length === 1, "the turn cancelled")
        expect(view.shutdowns()).toBe(0)
        view.setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // Each render has its own home: no prompt an earlier test or run sent is
  // in its history.
  // Prompt search holds the composer: a paste while it previews an entry
  // does not land in the draft behind it.
  it.live("a paste during prompt search does not reach the composer", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      for (const prompt of ["first prompt", "second prompt"]) {
        yield* Effect.promise(() => view.setup.mockInput.typeText(prompt))
        view.setup.mockInput.pressEnter()
        yield* waitForFrame(view.setup, () => view.sent.includes(prompt), `sent ${prompt}`)
      }
      view.setup.mockInput.pressKey("r", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("Prompt search · 2"), "search")
      view.setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => view.setup.renderOnce())
      yield* Effect.promise(() => view.setup.mockInput.pasteBracketedText("PASTED-ZQ"))
      yield* waitForFrame(view.setup, () => true, "the paste taken")
      yield* waitForFrame(view.setup, () => true, "the paste taken")
      expect(renderFrame(view.setup)).not.toContain("PASTED-ZQ")
      view.setup.mockInput.pressEnter()
      const frame = yield* waitForFrame(
        view.setup,
        (next) => !next.includes("Prompt search"),
        "the entry accepted",
      )
      expect(frame).toContain("┃ first prompt")
      expect(frame).not.toContain("PASTED-ZQ")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a render starts with an empty prompt history", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressKey("r", { ctrl: true })
      const frame = yield* waitForFrame(
        view.setup,
        (next) => next.includes("Prompt search"),
        "prompt search",
      )
      expect(frame).toContain("Prompt search · 0")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A key the btw ask line takes never reaches the session scope, and it is
  // still another gesture: the second ctrl+c cancels the next turn.
  it.live("a key the btw ask line takes between two ctrl+c presses makes the second cancel", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      yield* Effect.promise(() => view.setup.mockInput.typeText("/btw"))
      view.setup.mockInput.pressEnter()
      yield* waitForFrame(view.setup, (frame) => frame.includes("btw · fork"), "btw pane")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "first cancel")
      yield* Effect.promise(() => view.setup.mockInput.typeText("w"))
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 2, "second cancel")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A paste the btw ask line takes is another gesture too.
  it.live("a paste the btw ask line takes between two ctrl+c presses makes the second cancel", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      yield* Effect.promise(() => view.setup.mockInput.typeText("/btw"))
      view.setup.mockInput.pressEnter()
      yield* waitForFrame(view.setup, (frame) => frame.includes("btw · fork"), "btw pane")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "first cancel")
      yield* Effect.promise(() => view.setup.mockInput.pasteBracketedText("why"))
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 2, "second cancel")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The quit window is for a press that follows the cancel; a draft made in
  // between is nearer, so the next ctrl+c clears it and never quits over it.
  // A paste reaches the composer without a key event, so no key disarms it.
  it.live("a ctrl+c after a cancel and a new draft clears the draft, and does not quit", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      yield* Effect.promise(() => view.setup.mockInput.pasteBracketedText("keep me"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("keep me"), "draft pasted")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => !frame.includes("keep me"), "draft cleared")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A transcript toggle between two ctrl+c presses is another gesture: the
  // second press collapses the transcript and never quits.
  it.live("a transcript toggle between two ctrl+c presses disarms the quit", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      view.setup.mockInput.pressKey("o", { ctrl: true, shift: true })
      // gent/no-sleep: allow the toggle must be parsed and handled before the next press
      yield* Effect.sleep("50 millis")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      // gent/no-sleep: allow the press must be parsed and handled before the negative assertion
      yield* Effect.sleep("100 millis")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // ctrl+o changes only how tool groups draw, so nothing nearer is left for
  // the next press to undo: the key itself has to disarm the quit.
  it.live("a disclosure key between two ctrl+c presses makes the second cancel, not quit", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "first cancel")
      view.setup.mockInput.pressKey("o", { ctrl: true })
      // gent/no-sleep: allow the key must be parsed and handled before the next press
      yield* Effect.sleep("50 millis")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 2, "second cancel")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The quit arm is per key: a ctrl+c that cancelled a turn, then an escape
  // on the idle session, is two gestures and does not quit.
  it.live("escape after a ctrl+c that cancelled a turn does not quit", () =>
    Effect.gen(function* () {
      let shutdowns = 0
      const sessionId = SessionId.make("session-cancel")
      const branchId = BranchId.make("branch-cancel")
      const running = { _tag: "Running" satisfies "Running", queue: emptyQueueSnapshot() }
      const idle = { _tag: idleTag, queue: emptyQueueSnapshot() }
      const runtime = yield* Queue.unbounded<typeof running | typeof idle>()
      yield* Queue.offer(runtime, running)
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId,
              branchId,
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: AgentName.make("main"),
              runtime: running,
              metrics: { turns: 1, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
            }),
          watchRuntime: () => Stream.fromQueue(runtime),
        },
        steer: { command: () => Queue.offer(runtime, idle).pipe(Effect.asVoid) },
      })
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            initialSession: {
              id: sessionId,
              activeBranchId: branchId,
              name: "Cancel",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      const streaming = () => ctx.pipe(Option.exists((value) => value.isStreaming()))
      yield* waitForFrame(setup, streaming, "running turn")
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => !streaming(), "turn cancelled")
      setup.mockInput.pressEscape()
      // gent/no-sleep: allow the escape must be parsed and handled before the negative assertion
      yield* Effect.sleep("100 millis")
      expect(shutdowns).toBe(0)
      setup.renderer.destroy = destroy
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("ctrl+c quits an idle session while the btw pane is open", () =>
    Effect.gen(function* () {
      let shutdowns = 0
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        branch: { getTree: () => Effect.succeed([]) },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime: createMockRuntime(),
          builtins: builtinClientModules,
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "Session A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* Effect.promise(() => setup.mockInput.typeText("/btw"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("btw · fork"), "btw pane")
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => shutdowns > 0, "quit")
      setup.renderer.destroy = destroy
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a slash command typed before the client extensions load runs once they do", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const held = defineClientExtension("@test/held-load", {
        setup: Deferred.await(release).pipe(Effect.as(clientContributions())),
      })
      let ext = Option.none<ReturnType<typeof useExtensionUI>>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
            </>
          ),
          {
            client: createMockClient({
              auth: { listProviders: () => Effect.succeed([]) },
              branch: { getTree: () => Effect.succeed([]) },
            }),
            runtime: createMockRuntime(),
            builtins: [...builtinClientModules, held],
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      expect(Option.exists(ext, (value) => value.loaded())).toBe(false)
      yield* Effect.promise(() => setup.mockInput.typeText("/btw"))
      yield* waitForFrame(setup, (frame) => frame.includes("/btw"), "the typed command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Unknown command") || !frame.includes("/btw"),
        "the command sent",
      )
      expect(renderFrame(setup)).not.toContain("Unknown command")
      // A command no extension names waits too, and reports once the load settles.
      yield* Effect.promise(() => setup.mockInput.typeText("/nonesuch"))
      yield* waitForFrame(setup, (frame) => frame.includes("/nonesuch"), "the unknown command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Unknown command") || !frame.includes("/nonesuch"),
        "the unknown command sent",
      )
      expect(renderFrame(setup)).not.toContain("Unknown command")
      yield* Deferred.complete(release, Effect.void)
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("btw · fork") && frame.includes("Unknown command: /nonesuch"),
        "btw pane and the settled unknown command",
      )
      expect(renderFrame(setup)).not.toContain("Unknown command: /btw")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a pane that opens over a previewing prompt search gives the draft back", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client: createMockClient({
            auth: { listProviders: () => Effect.succeed([]) },
            branch: { getTree: () => Effect.succeed([]) },
          }),
          runtime: createMockRuntime(),
          builtins: builtinClientModules,
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "Session A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* Effect.promise(() => setup.mockInput.typeText("older prompt"))
      yield* waitForFrame(setup, (frame) => frame.includes("┃ older prompt"), "typed prompt")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("┃ older prompt"), "prompt sent")
      yield* Effect.promise(() => setup.mockInput.typeText("mine"))
      yield* waitForFrame(setup, (frame) => frame.includes("┃ mine"), "the draft")
      setup.mockInput.pressKey("r", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("Prompt search"), "prompt search")
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("up")
      yield* waitForFrame(setup, (frame) => frame.includes("┃ older prompt"), "the preview")
      setup.mockInput.pressKey("t", { ctrl: true })
      yield* waitForFrame(setup, (frame) => !frame.includes("Prompt search"), "search replaced")
      yield* waitForFrame(setup, (frame) => frame.includes("┃ mine"), "the draft back")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("an unknown slash command comes back to the draft with its reason", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client: createMockClient({
            auth: { listProviders: () => Effect.succeed([]) },
            branch: { getTree: () => Effect.succeed([]) },
          }),
          runtime: createMockRuntime(),
          builtins: builtinClientModules,
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "Session A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* Effect.promise(() => setup.mockInput.typeText("/modle sonnet"))
      yield* waitForFrame(setup, (frame) => frame.includes("/modle sonnet"), "the typed command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Unknown command: /modle"),
        "the command refused",
      )
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("┃ /modle sonnet"),
        "the command back in the draft",
      )
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a slash command typed before the session's server commands list waits for them", () =>
    Effect.gen(function* () {
      const listed = yield* Deferred.make<void>()
      const requests: Array<unknown> = []
      let ext = Option.none<ReturnType<typeof useExtensionUI>>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
            </>
          ),
          {
            client: createMockClient({
              auth: { listProviders: () => Effect.succeed([]) },
              branch: { getTree: () => Effect.succeed([]) },
              extension: {
                listSlashCommands: () =>
                  Deferred.await(listed).pipe(
                    Effect.as([
                      {
                        name: "probe",
                        extensionId: "@test/server-probe",
                        capabilityId: "probe",
                      },
                    ]),
                  ),
                request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
                  Effect.sync(() => {
                    if (input.capabilityId === "probe") requests.push(input.input)
                  }),
              },
            }),
            runtime: createMockRuntime(),
            builtins: builtinClientModules,
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* waitForFrame(
        setup,
        () => Option.exists(ext, (value) => value.loaded()),
        "client extensions loaded",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("/probe now"))
      yield* waitForFrame(setup, (frame) => frame.includes("/probe now"), "the typed command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Unknown command") || !frame.includes("/probe now"),
        "the command sent",
      )
      expect(renderFrame(setup)).not.toContain("Unknown command")
      expect(requests).toHaveLength(0)
      yield* Deferred.complete(listed, Effect.void)
      yield* waitForFrame(setup, () => requests.length === 1, "the server command ran")
      expect(requests).toEqual(["now"])
      expect(renderFrame(setup)).not.toContain("Unknown command")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A connection drop while the list is in flight is not an answer: the held
  // command waits, and the reconnect lists the server commands again.
  // The failed reply may reach the client before or after the connection
  // state says the socket closed.
  for (const first of ["failure", "state"]) {
    const failureFirst = first === "failure"
    it.live(
      `a slash command held across a dropped listing runs once the reconnect lists (${first} first)`,
      () =>
        Effect.gen(function* () {
          const drop = yield* Deferred.make<void>()
          const failed = yield* Deferred.make<void>()
          const requests: Array<unknown> = []
          let listings = 0
          const lifecycle = createMutableRuntime(
            ConnectionState.cases.Connected.make({ generation: 0 }),
          )
          let ext = Option.none<ReturnType<typeof useExtensionUI>>()
          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <App />
                  <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
                </>
              ),
              {
                client: createMockClient({
                  auth: { listProviders: () => Effect.succeed([]) },
                  branch: { getTree: () => Effect.succeed([]) },
                  extension: {
                    listSlashCommands: () =>
                      Effect.suspend(() => {
                        listings += 1
                        if (listings === 1) {
                          return Deferred.await(drop).pipe(
                            Effect.andThen(
                              Effect.fail(
                                new RpcClientError({
                                  reason: new SocketCloseError({ code: 1006 }),
                                }),
                              ),
                            ),
                            Effect.ensuring(Deferred.succeed(failed, void 0)),
                          )
                        }
                        return Effect.succeed([
                          {
                            name: "probe",
                            extensionId: "@test/server-probe",
                            capabilityId: "probe",
                          },
                        ])
                      }),
                    request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
                      Effect.sync(() => {
                        if (input.capabilityId === "probe") requests.push(input.input)
                      }),
                  },
                }),
                runtime: lifecycle.runtime,
                builtins: builtinClientModules,
                initialSession: {
                  id: SessionId.make("session-a"),
                  activeBranchId: BranchId.make("branch-a"),
                  name: "Session A",
                  createdAt: dateFromMillis(0),
                  updatedAt: dateFromMillis(0),
                },
              },
            ),
          )
          yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
          yield* waitForFrame(
            setup,
            () => Option.exists(ext, (value) => value.loaded()),
            "client extensions loaded",
          )
          yield* Effect.promise(() => setup.mockInput.typeText("/probe now"))
          yield* waitForFrame(setup, (frame) => frame.includes("/probe now"), "the typed command")
          setup.mockInput.pressEnter()
          yield* waitForFrame(setup, (frame) => !frame.includes("/probe now"), "the command held")
          // The connection drops with the listing in flight.
          const reconnecting = () =>
            lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
          if (!failureFirst) reconnecting()
          yield* Deferred.succeed(drop, void 0)
          yield* Deferred.await(failed)
          // Two render passes let the host take the failed reply.
          yield* waitForFrame(setup, () => true, "the failed reply taken")
          yield* waitForFrame(setup, () => true, "the failed reply taken")
          expect(renderFrame(setup)).not.toContain("Unknown command")
          if (failureFirst) reconnecting()
          lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
          yield* waitForFrame(setup, () => requests.length === 1, "the server command ran")
          expect(requests).toEqual(["now"])
          expect(listings).toBe(2)
          expect(renderFrame(setup)).not.toContain("Unknown command")
          setup.renderer.destroy()
        }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // Settled means settled for this connection: a listing the last connection
  // answered says nothing of the server the reconnect reached. A command
  // submitted while the new listing is in flight waits for it.
  it.live("a slash command submitted while a reconnect lists again waits for that listing", () =>
    Effect.gen(function* () {
      const relisted = yield* Deferred.make<void>()
      const requests: Array<unknown> = []
      let listings = 0
      const lifecycle = createMutableRuntime(
        ConnectionState.cases.Connected.make({ generation: 0 }),
      )
      let ext = Option.none<ReturnType<typeof useExtensionUI>>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
            </>
          ),
          {
            client: createMockClient({
              auth: { listProviders: () => Effect.succeed([]) },
              branch: { getTree: () => Effect.succeed([]) },
              extension: {
                listSlashCommands: () =>
                  Effect.suspend(() => {
                    listings += 1
                    // The first server has no /probe; the one the reconnect reaches has.
                    if (listings === 1) return Effect.succeed([])
                    return Deferred.await(relisted).pipe(
                      Effect.as([
                        {
                          name: "probe",
                          extensionId: "@test/server-probe",
                          capabilityId: "probe",
                        },
                      ]),
                    )
                  }),
                request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
                  Effect.sync(() => {
                    if (input.capabilityId === "probe") requests.push(input.input)
                  }),
              },
            }),
            runtime: lifecycle.runtime,
            builtins: builtinClientModules,
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* waitForFrame(
        setup,
        () => Option.exists(ext, (value) => value.loaded() && value.commandsSettled()),
        "the first listing settled",
      )
      lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
      lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
      yield* waitForFrame(setup, () => listings === 2, "the reconnect lists again")
      yield* Effect.promise(() => setup.mockInput.typeText("/probe now"))
      yield* waitForFrame(setup, (frame) => frame.includes("/probe now"), "the typed command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Unknown command") || !frame.includes("/probe now"),
        "the command sent",
      )
      expect(renderFrame(setup)).not.toContain("Unknown command")
      yield* Deferred.succeed(relisted, void 0)
      yield* waitForFrame(setup, () => requests.length === 1, "the server command ran")
      expect(requests).toEqual(["now"])
      expect(renderFrame(setup)).not.toContain("Unknown command")
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  /**
   * The docked pane closes inside the terminal: its bottom rule is the last
   * row drawn, or the key hint under it is.
   */
  const closesInside = (drawn: ReadonlyArray<string>) => {
    const rule = drawn.findLastIndex((line) => line.startsWith("─"))
    return rule >= 0 && drawn.length - 1 - rule <= 1
  }
  // At 14 rows the composer takes four of the footer's twelve once its blank
  // rows give way, and the agents pane's rules and title take three more: the
  // filter row, the section heading and the cursor row fit. The trays, the
  // blank rows and the detail line give way for them.
  it.live("the agents pane keeps its cursor row in view at the smallest height that holds it", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(14)
      yield* waitForFrame(setup, (frame) => frame.includes("alarm in now"), "the alarm tray")
      setup.mockInput.pressKey("t", { ctrl: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Agents ·") && frame.includes("delegate: task 3 · running"),
        "the agents pane with its cursor row",
      )
      const opened = renderFrame(setup)
      expect(opened).toContain("┃")
      expect(opened).not.toContain("alarm in now")
      const drawn = opened.split("\n").filter((line) => line.trim().length > 0)
      expect(closesInside(drawn)).toBe(true)
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes("delegate: task 4") && !frame.includes("delegate: task 3 · running"),
        "the cursor row after one move down",
      )
      setup.mockInput.pressEscape()
      yield* waitForFrame(
        setup,
        (frame) => !frame.includes("Agents ·") && frame.includes("alarm in now"),
        "the trays back once the pane closes",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Below 14 rows the pane has fewer rows than its fixed lines. It drops its
  // optional lines in order (the detail line, the section headings, the
  // filter row) and keeps one row for the cursor; at 11 rows the frame's
  // title gives way too. Rows are cut, never drawn over each other or over
  // the rule.
  for (const height of [13, 12, 11]) {
    it.live(`the agents pane at ${height} rows keeps its cursor row and overdraws nothing`, () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(height)
        yield* waitForFrame(setup, (frame) => frame.includes("alarm in now"), "the alarm tray")
        setup.mockInput.pressKey("t", { ctrl: true })
        yield* waitForFrame(setup, (frame) => !frame.includes("alarm in now"), "the agents pane")
        const frame = yield* waitForFrame(
          setup,
          (current) => current.includes("delegate: task 3 · running"),
          `the cursor row at ${height} rows`,
        )
        const drawn = frame.split("\n").filter((line) => line.trim().length > 0)
        const ruled = drawn
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.startsWith("─"))
          .map(({ index }) => index)
        const pane = drawn.slice(ruled.at(-2))
        // Each rule is only rule: no row of text drawn over it.
        const rules = pane.filter((line) => line.startsWith("─"))
        expect(rules).toHaveLength(2)
        for (const rule of rules) expect(rule.trim()).toMatch(/^─+$/)
        // The cursor row holds only its own text, not the detail line's.
        const cursor = pane.filter((line) => line.includes("delegate: task 3"))
        expect(cursor).toHaveLength(1)
        expect(cursor[0]).not.toContain("turn ")
        expect(closesInside(pane)).toBe(true)
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // The thread pane and the filtered settings pickers keep the same order on
  // a short terminal: the detail line, the headings and the filter row give
  // way, one row stays for the cursor, and nothing draws over a rule.
  const threadMessages: ReadonlyArray<StoredMessage> = [
    StoredMessage.cases.regular.make({
      id: MessageId.make("u1"),
      sessionId: SessionId.make("session-btw"),
      branchId: BranchId.make("branch-btw"),
      role: "user",
      parts: [Prompt.textPart({ text: "first ask" })],
      createdAt: dateFromMillis(1_000),
    }),
    StoredMessage.cases.regular.make({
      id: MessageId.make("a1"),
      sessionId: SessionId.make("session-btw"),
      branchId: BranchId.make("branch-btw"),
      role: "assistant",
      parts: [Prompt.textPart({ text: "an answer" })],
      createdAt: dateFromMillis(2_000),
    }),
  ]
  /** The docked pane is the frame's last two rules and the rows between them. */
  const expectPaneFits = (frame: string, cursorText: string, notOnCursor: string) => {
    const drawn = frame.split("\n").filter((line) => line.trim().length > 0)
    const ruled = drawn
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith("─"))
      .map(({ index }) => index)
    const pane = drawn.slice(ruled.at(-2))
    const rules = pane.filter((line) => line.startsWith("─"))
    expect(rules).toHaveLength(2)
    for (const rule of rules) expect(rule.trim()).toMatch(/^─+$/)
    const cursor = pane.filter((line) => line.includes(cursorText))
    expect(cursor).toHaveLength(1)
    expect(cursor[0]).not.toContain(notOnCursor)
    expect(closesInside(pane)).toBe(true)
  }
  for (const height of [13, 12, 11]) {
    it.live(`the thread pane at ${height} rows keeps its cursor row and overdraws nothing`, () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(height, threadMessages)
        yield* Effect.promise(() => setup.mockInput.typeText("/thread"))
        setup.mockInput.pressEnter()
        yield* waitForFrame(setup, (frame) => !frame.includes("alarm in now"), "the thread pane")
        const frame = yield* waitForFrame(
          setup,
          (current) => current.includes("window 1"),
          `the cursor row at ${height} rows`,
        )
        expectPaneFits(frame, "window 1", "u1 … a1")
      }).pipe(Effect.timeout("10 seconds")),
    )
    it.live(
      `the reasoning picker at ${height} rows keeps its cursor row and overdraws nothing`,
      () =>
        Effect.gen(function* () {
          const setup = yield* mountShortTerminalWithTrays(height)
          yield* Effect.promise(() => setup.mockInput.typeText("/think"))
          setup.mockInput.pressEnter()
          const frame = yield* waitForFrame(
            setup,
            (current) => !current.includes("alarm in now") && current.includes("● default"),
            `the cursor row at ${height} rows`,
          )
          expectPaneFits(frame, "● default", "›")
        }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // The autocomplete popup and the command palette draw their query line above
  // the list, inside the composer: it gives way like a filter row, and the
  // cursor row stays between two clean rules.
  const expectPopupFits = (frame: string, cursorText: string) => {
    const drawn = frame.split("\n").filter((line) => line.trim().length > 0)
    const ruled = drawn
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith("─"))
      .map(({ index }) => index)
    expect(ruled.length).toBeGreaterThanOrEqual(2)
    const top = ruled.at(-2) ?? 0
    const bottom = ruled.at(-1) ?? 0
    for (const index of [top, bottom]) expect(drawn[index]?.trim()).toMatch(/^─+$/)
    const inside = drawn.slice(top + 1, bottom)
    expect(inside.filter((line) => line.includes(cursorText))).toHaveLength(1)
  }
  for (const height of [13, 12, 11]) {
    it.live(`the autocomplete popup at ${height} rows keeps its cursor row`, () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(height)
        yield* Effect.promise(() => setup.mockInput.typeText("/thre"))
        const frame = yield* waitForFrame(
          setup,
          (current) => !current.includes("alarm in now") && current.includes("/thread"),
          `the cursor row at ${height} rows`,
        )
        expectPopupFits(frame, "/thread")
      }).pipe(Effect.timeout("10 seconds")),
    )
    it.live(`the command palette at ${height} rows keeps its cursor row`, () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(height)
        setup.mockInput.pressKey("p", { ctrl: true })
        yield* waitForFrame(setup, (current) => !current.includes("alarm in now"), "the palette")
        yield* Effect.promise(() => setup.mockInput.typeText("thread"))
        const frame = yield* waitForFrame(
          setup,
          (current) => current.includes("Thread"),
          `the cursor row at ${height} rows`,
        )
        expectPopupFits(frame, "Thread")
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // Under 9 rows, with a turn running and the blank footer rows given way,
  // the "Generating" row, the input and the status row leave a pane two rows,
  // one or none (8 rows: 3, 7: 2, 6: 1, 5: none). Under three rows the frame
  // drops its rules and note row, so its rows go to the cursor row; at none it
  // draws nothing. Either way no row is drawn over a rule or over the status row.
  const sendPrompts = (view: { readonly setup: TestSetup; readonly sent: Array<string> }) =>
    Effect.gen(function* () {
      for (const prompt of ["first prompt", "second prompt"]) {
        yield* Effect.promise(() => view.setup.mockInput.typeText(prompt))
        view.setup.mockInput.pressEnter()
        yield* waitForFrame(view.setup, () => view.sent.includes(prompt), `sent ${prompt}`)
      }
    })
  const shortPanes: ReadonlyArray<{
    readonly name: string
    readonly open: (view: {
      readonly setup: TestSetup
      readonly sent: Array<string>
    }) => Effect.Effect<void, RenderWaitTimeoutError>
    /** Drawn while the pane is open at full height. */
    readonly shown: string
    /** A row of the pane holds one entry, never two drawn over each other. */
    readonly rowClean: (line: string) => boolean
  }> = [
    {
      name: "reasoning picker",
      open: (view) => typeCommand("/think")(view.setup),
      shown: "● default",
      rowClean: (line) => !line.includes("●") || line.includes("● default"),
    },
    {
      name: "command palette",
      open: (view) => Effect.sync(() => view.setup.mockInput.pressKey("p", { ctrl: true })),
      shown: "Switch color theme",
      rowClean: (line) => !line.includes("Switch") || line.trim().startsWith("Theme"),
    },
    {
      name: "prompt search",
      open: (view) =>
        sendPrompts(view).pipe(
          Effect.andThen(Effect.sync(() => view.setup.mockInput.pressKey("r", { ctrl: true }))),
        ),
      shown: "second prompt",
      rowClean: (line) => !line.includes("prompt") || /(first|second) prompt$/.test(line.trimEnd()),
    },
    {
      name: "agents pane",
      open: (view) => Effect.sync(() => view.setup.mockInput.pressArrow("left")),
      shown: "Agents ·",
      rowClean: () => true,
    },
  ]
  /** A rule is only rule, and no pane row is two rows drawn over each other. */
  const overdrawsNothing = (frame: string, rowClean: (line: string) => boolean) =>
    frame
      .split("\n")
      .every((line) => (!line.includes("─") || /^─+$/.test(line.trim())) && rowClean(line))
  for (const pane of shortPanes) {
    it.live(`the ${pane.name} overdraws nothing from 10 rows down to 5`, () =>
      Effect.gen(function* () {
        const view = yield* mountRunningTurn()
        yield* pane.open(view)
        yield* waitForFrame(view.setup, (frame) => frame.includes(pane.shown), "the pane")
        const width = view.setup.renderer.terminalWidth
        for (const height of [10, 9, 8, 7, 6, 5]) {
          view.setup.resize(width, height)
          yield* waitForFrame(
            view.setup,
            (frame) =>
              view.setup.renderer.terminalHeight === height &&
              frame.includes("┃") &&
              overdrawsNothing(frame, pane.rowClean),
            `the ${pane.name} at ${height} rows`,
          )
        }
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // With a turn running, the footer's three blank rows (above the activity
  // row, above the input, above the status row) give way before a pane loses
  // its cursor row: the reasoning picker keeps "● default" down to 6 rows.
  it.live("the blank footer rows give way so a pane keeps its cursor row down to 6 rows", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      yield* typeCommand("/think")(view.setup)
      yield* waitForFrame(view.setup, (frame) => frame.includes("● default"), "the pane")
      const width = view.setup.renderer.terminalWidth
      for (const height of [8, 7, 6]) {
        view.setup.resize(width, height)
        yield* waitForFrame(
          view.setup,
          (frame) =>
            view.setup.renderer.terminalHeight === height &&
            frame.includes("● default") &&
            frame.includes("┃") &&
            // The activity row is whole: the transcript tail, left no row,
            // draws nothing over it.
            frame.split("\n").some((line) => line.startsWith("  Generating")),
          `the cursor row at ${height} rows`,
        )
      }
      // Grown back, the blank rows return: a blank row sits above the input.
      view.setup.resize(width, 24)
      yield* waitForFrame(
        view.setup,
        (current) => {
          const lines = current.split("\n")
          const input = lines.findIndex((line) => line.startsWith("┃"))
          return (
            view.setup.renderer.terminalHeight === 24 &&
            current.includes("● default") &&
            input > 0 &&
            lines[input - 1]?.trim() === ""
          )
        },
        "the blank rows back on the full terminal",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The give-way is reckoned as if the blank rows were drawn, so a pane that
  // fits once they give way does not bring them back and lose its rows again:
  // at 10-12 rows (a squeezed reasoning picker) the blank rows stay given and
  // the frame holds still across draws.
  const withoutClock = (frame: string) => frame.replace(/\(\d+s\)/g, "")
  const blankRowsGiven = (frame: string) => {
    const lines = frame.split("\n")
    const generating = lines.findIndex((line) => line.includes("Generating"))
    return generating >= 0 && lines[generating + 1]?.startsWith("┃") === true
  }
  for (const height of [12, 11, 10]) {
    it.live(`the footer holds still at ${height} rows with a pane open`, () =>
      Effect.gen(function* () {
        const view = yield* mountRunningTurn()
        yield* typeCommand("/think")(view.setup)
        yield* waitForFrame(view.setup, (frame) => frame.includes("● default"), "the pane")
        view.setup.resize(view.setup.renderer.terminalWidth, height)
        yield* waitForFrame(
          view.setup,
          (frame) =>
            view.setup.renderer.terminalHeight === height &&
            frame.includes("● default") &&
            blankRowsGiven(frame),
          `the pane at ${height} rows, its blank rows given`,
        )
        // The pane reads its new rows one draw after the layout gives them.
        for (let draw = 0; draw < 4; draw++) yield* Effect.promise(() => view.setup.renderOnce())
        const seen = new Set<string>()
        for (let draw = 0; draw < 6; draw++) {
          yield* Effect.promise(() => view.setup.renderOnce())
          seen.add(withoutClock(renderFrame(view.setup)))
        }
        expect(seen.size).toBe(1)
        expect(blankRowsGiven(renderFrame(view.setup))).toBe(true)
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // The ghost line offers what the popup's cursor row already shows, so it
  // gives way with the blank rows: at 11 rows the popup keeps its key hint,
  // no ghost line draws, and the frame holds still across draws.
  it.live("the ghost line gives way with the blank rows for a squeezed popup", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.resize(view.setup.renderer.terminalWidth, 11)
      yield* Effect.promise(() => view.setup.mockInput.typeText("/thre"))
      yield* waitForFrame(
        view.setup,
        (frame) =>
          view.setup.renderer.terminalHeight === 11 &&
          frame.includes("/thread") &&
          blankRowsGiven(frame),
        "the popup at 11 rows, its blank rows given",
      )
      for (let draw = 0; draw < 4; draw++) yield* Effect.promise(() => view.setup.renderOnce())
      const seen = new Set<string>()
      for (let draw = 0; draw < 6; draw++) {
        yield* Effect.promise(() => view.setup.renderOnce())
        seen.add(withoutClock(renderFrame(view.setup)))
      }
      expect(seen.size).toBe(1)
      const frame = renderFrame(view.setup)
      expect(frame).not.toContain("⇥")
      expect(frame).toContain("Tab Complete")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A pane with no row on screen takes no keys: the reader cannot see what a
  // key would do there. Typing goes past the agents pane to the composer.
  it.live("typing reaches the composer past an agents pane that has no row", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressArrow("left")
      yield* waitForFrame(view.setup, (frame) => frame.includes("Agents ·"), "the agents pane")
      view.setup.resize(view.setup.renderer.terminalWidth, 5)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 5 && !frame.includes("›"),
        "the agents pane with no row",
      )
      yield* Effect.promise(() => view.setup.mockInput.typeText("typed past"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("┃ typed past"), "the draft")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A held pane with no row takes no keys, yet Esc still closes it, as the
  // pane's own Esc does, and the turn runs on.
  it.live("esc closes a held pane that has no row and leaves the turn running", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      yield* typeCommand("/think")(view.setup)
      yield* waitForFrame(view.setup, (frame) => frame.includes("● default"), "the pane")
      const width = view.setup.renderer.terminalWidth
      view.setup.resize(width, 5)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 5 && !frame.includes("● default"),
        "the pane with no row",
      )
      view.setup.mockInput.pressEscape()
      // gent/no-sleep: allow a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      // The held pane let go of the composer: typing at 5 rows reaches it. With
      // no pane open the blank rows are back, so the draft shows once the
      // terminal grows.
      yield* Effect.promise(() => view.setup.mockInput.typeText("after"))
      view.setup.resize(width, 24)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 24 && frame.includes("┃ after"),
        "the full terminal",
      )
      expect(renderFrame(view.setup)).not.toContain("Reasoning ·")
      expect(view.steers).toEqual([])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // An extension pane with no row takes no keys either, and Esc closes it the
  // same way: the turn runs on, and the pane is gone when the terminal grows.
  it.live("esc closes an extension pane that has no row and leaves the turn running", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressArrow("left")
      yield* waitForFrame(view.setup, (frame) => frame.includes("Agents ·"), "the agents pane")
      const width = view.setup.renderer.terminalWidth
      view.setup.resize(width, 5)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 5 && !frame.includes("Agents ·"),
        "the agents pane with no row",
      )
      view.setup.mockInput.pressEscape()
      // gent/no-sleep: allow a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      view.setup.resize(width, 24)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 24 && frame.includes("Generating"),
        "the full terminal",
      )
      expect(renderFrame(view.setup)).not.toContain("Agents ·")
      expect(view.steers).toEqual([])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The live run: an alarm and three working children filled the trays, and
  // the btw pane showed its question but not the fork's stored answer.
  it.live("the btw pane keeps the fork's answer in view on a short terminal with full trays", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(16)
      yield* waitForFrame(setup, (frame) => frame.includes("+1 more working"), "full trays")
      yield* Effect.promise(() => setup.mockInput.typeText("/btw which task is hardest?"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("btw: which task is hardest?"),
        "btw pane over full trays",
      )
      // The newest content, the answer's end, stays in view, and so does the
      // rest of the pane: the footer never runs past the terminal's last row.
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes("ANSWER-TAIL") && frame.includes("ask ›") && frame.includes("esc close"),
        "the fork's answer, the ask line and the pane footer",
      )
      const frame = renderFrame(setup)
      // The trays hid while the pane the reader opened is open.
      expect(frame).not.toContain("alarm in now")
      expect(frame).not.toContain("+1 more working")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // At 10 rows (the blank footer rows given way) the btw pane has one body
  // row: it holds the answer's last line, not the blank row between turns,
  // and the pane still closes on its rule.
  it.live("the btw pane holds the answer's last line in a one-row body", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(10)
      yield* Effect.promise(() => setup.mockInput.typeText("/btw which task is hardest?"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("ANSWER-TAIL") && frame.includes("ask ›"),
        "the answer's last line and the ask line",
      )
      const drawn = renderFrame(setup)
        .split("\n")
        .filter((line) => line.trim().length > 0)
      expect(drawn.at(-1)?.startsWith("─")).toBe(true)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Below one body row the btw transcript has no row: it hides whole, and the
  // ask line keeps its row, never drawn over by the transcript's top line.
  it.live("the btw ask line is never drawn over when the transcript has no row", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(24)
      yield* Effect.promise(() => setup.mockInput.typeText("/btw which task is hardest?"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("ANSWER-TAIL") && frame.includes("ask ›"),
        "the btw pane",
      )
      const width = setup.renderer.terminalWidth
      for (const height of [9, 8, 6]) {
        setup.resize(width, height)
        yield* waitForFrame(
          setup,
          (frame) => setup.renderer.terminalHeight === height && frame.includes("ask ›"),
          `the ask line at ${height} rows`,
        )
        for (let draw = 0; draw < 4; draw++) yield* Effect.promise(() => setup.renderOnce())
        const asks = renderFrame(setup)
          .split("\n")
          .filter((line) => line.includes("›"))
        expect(asks).toHaveLength(1)
        expect(asks[0]?.trimEnd()).toBe(" ask › │")
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("an interjection steers a running turn while an error shows", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      yield* Effect.promise(() => view.setup.mockInput.typeText("steer this"))
      view.setup.mockInput.pressEnter({ meta: true })
      yield* waitForFrame(
        view.setup,
        () => view.steers.length + view.sent.length === 1,
        "interjection",
      )
      expect(view.steers).toEqual(["Interject"])
      expect(view.sent).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  const quitKeys: ReadonlyArray<{ readonly name: string; readonly press: (s: TestSetup) => void }> =
    [
      { name: "escape", press: (setup) => setup.mockInput.pressEscape() },
      { name: "ctrl+c", press: (setup) => setup.mockInput.pressKey("c", { ctrl: true }) },
    ]
  /** A resumed session with two branches: the boot branch picker is open over it. */
  const mountBootBranchPicker = Effect.gen(function* () {
    const client = createMockClient({
      auth: { listProviders: () => Effect.succeed([]) },
      branch: { getTree: () => Effect.succeed([]) },
    })
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <App
            initialBranches={Option.some([
              {
                id: BranchId.make("branch-a"),
                sessionId: SessionId.make("session-a"),
                name: "main",
                createdAt: dateFromMillis(0),
              },
              {
                id: BranchId.make("branch-b"),
                sessionId: SessionId.make("session-a"),
                name: "side",
                createdAt: dateFromMillis(1),
              },
            ])}
          />
        ),
        {
          client,
          runtime: createMockRuntime(),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "Session A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        },
      ),
    )
    yield* waitForFrame(setup, (frame) => frame.includes("Resume: Session A"), "picker")
    return setup
  })
  // A key the picker's list declines does not reach the composer behind it:
  // `!` does not turn the composer to shell mode.
  it.live("a key the boot branch picker declines leaves the composer alone", () =>
    Effect.gen(function* () {
      const setup = yield* mountBootBranchPicker
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* waitForFrame(setup, () => true, "the key taken")
      yield* waitForFrame(setup, () => true, "the key taken")
      setup.mockInput.pressEnter()
      const frame = yield* waitForFrame(
        setup,
        (next) => !next.includes("Resume: Session A"),
        "the branch chosen",
      )
      expect(frame).not.toContain("$")
      expect(frame).toContain("┃")
    }).pipe(Effect.timeout("10 seconds")),
  )
  for (const key of quitKeys)
    it.live(`${key.name} in the boot branch picker quits, because no branch was chosen`, () =>
      Effect.gen(function* () {
        // The picker is where a resumed multi-branch session starts. With no
        // branch chosen there is nothing behind it to fall back to, so escape
        // has to leave the program, not just close the pane.
        let shutdowns = 0
        const setup = yield* mountBootBranchPicker
        // `useEnv().shutdown` is a no-op in the harness, so observe the renderer
        // teardown the controller performs alongside it.
        const destroy = setup.renderer.destroy.bind(setup.renderer)
        setup.renderer.destroy = () => {
          shutdowns += 1
        }
        key.press(setup)
        yield* waitForFrame(setup, () => shutdowns > 0, "quit")
        setup.renderer.destroy = destroy
        expect(shutdowns).toBe(1)
        setup.renderer.destroy()
      }),
    )
  it.live("branch picker does not trigger auth gating before a branch is selected", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
        branch: {
          getTree: () =>
            Effect.succeed([
              {
                branch: {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  name: "Main",
                  createdAt: dateFromMillis(0),
                },
                messageCount: 3,
                children: [],
              },
              {
                branch: {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  name: "Side",
                  createdAt: dateFromMillis(1),
                },
                messageCount: 1,
                children: [],
              },
            ]),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <App
              initialBranches={Option.some([
                {
                  id: BranchId.make("branch-a"),
                  sessionId: SessionId.make("session-a"),
                  createdAt: dateFromMillis(0),
                },
                {
                  id: BranchId.make("branch-b"),
                  sessionId: SessionId.make("session-a"),
                  createdAt: dateFromMillis(1),
                },
              ])}
            />
          ),
          {
            client,
            runtime,
            // An agent is what makes the auth check runnable at all. Without one
            // the gate short-circuits before it reads the picker, and this test
            // proves nothing.
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "Session A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      yield* waitForFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker")
      expect(calls).toEqual([])

      // Choosing a branch closes the picker, and only then does the gate run.
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(calls.map((call) => call.agentName)).toEqual(["cowork"])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt and missing auth defers the prompt until auth resolves", () =>
    Effect.gen(function* () {
      const providersDeferred = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: typeof absent
        }>
      >()
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () => Deferred.await(providersDeferred),
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("build a feature"),
        }),
      )
      // Auth is pending — prompt must not be sent yet
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      // Resolve auth — keys are required but missing
      yield* Deferred.succeed(providersDeferred, [
        {
          provider: "openai",
          hasKey: false,
          required: true,
          source: "none",
          authType: absent,
        },
      ])
      // Auth overlay should appear
      const authFrame = yield* waitForFrame(
        setup,
        (next) => next.includes("Sign in ·"),
        "auth overlay",
      )
      expect(authFrame).toContain("Sign in ·")
      // Prompt still not sent while auth overlay is open
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
  // An enforced sign-in holds the slot: with a required key missing there is
  // no session to fall back to, so ctrl+c quits over it.
  it.live("ctrl+c over an enforced sign-in quits", () =>
    Effect.gen(function* () {
      let shutdowns = 0
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: "none",
                authType: absent,
              },
            ]),
          listMethods: () => Effect.succeed({ openai: [apiMethod] }),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime: createMockRuntime(),
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in ·"), "the sign-in")
      const destroy = setup.renderer.destroy.bind(setup.renderer)
      setup.renderer.destroy = () => {
        shutdowns += 1
      }
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => shutdowns > 0, "quit")
      setup.renderer.destroy = destroy
      setup.renderer.destroy()
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("cold start with prompt does not continue when auth checking fails", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(new ProviderAuthError({ message: "session auth lookup failed" })),
              ),
            ),
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("must not send"),
        }),
      )
      yield* waitForFrame(setup, () => authChecks > 0, "auth check failure")
      // gent/no-sleep: allow real-clock gap so any spurious send fiber has time to surface (negative assertion follows)
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
  it.live("cold start with prompt recovers after a transient auth check failure", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                (() => {
                  if (authChecks === 1) {
                    return Effect.fail(
                      new ProviderAuthError({ message: "temporary auth lookup failed" }),
                    )
                  }
                  return Effect.succeed([])
                })(),
              ),
            ),
          listMethods: () => Effect.succeed({}),
        },
        message: {
          send: (input: { content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
          initialPrompt: Option.some("send after retry"),
        }),
      )
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === "send after retry"),
        "sent message",
      )
      expect(authChecks).toBeGreaterThan(1)
      setup.renderer.destroy()
    }),
  )
  it.live("enforced auth overlay can retry failed provider loads", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const client = createMockClient({
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              authChecks += 1
            }).pipe(
              Effect.flatMap(() =>
                (() => {
                  if (authChecks < 3) {
                    return Effect.fail(
                      new ProviderAuthError({ message: "temporary auth lookup failed" }),
                    )
                  }
                  return Effect.succeed([])
                })(),
              ),
            ),
          listMethods: () => Effect.succeed({}),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <App />, {
          client,
          runtime,
          initialAgent: AgentName.make("cowork"),
          initialSession: {
            id: SessionId.make("session-a"),
            activeBranchId: BranchId.make("branch-a"),
            name: "A",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes("temporary auth lookup failed") && frame.includes("Press r to retry"),
        "retryable auth error",
      )
      setup.mockInput.pressKey("r")
      yield* waitForFrame(setup, (frame) => !frame.includes("Sign in ·"), "auth retry resolved")
      expect(authChecks).toBe(3)
      setup.renderer.destroy()
    }),
  )
  it.live("branch resume pane gates auth, sends deferred prompt, and searches prompt history", () =>
    Effect.gen(function* () {
      let hasOpenAiKey = false
      let initialAuthCheckResolved = false
      const initialAuthCheck = yield* Deferred.make<void>()
      const sentMessages: Array<{
        sessionId: SessionId
        branchId: BranchId
        content: string
        requestId: string
      }> = []
      const alphaSessionId = SessionId.make("session-alpha")
      const alphaBranchId = BranchId.make("branch-alpha")
      const betaBranchId = BranchId.make("branch-beta")
      const initialPrompt = "deferred route-flow prompt"
      const historyPrompt = "resume prompt search route flow"
      const client = createMockClient({
        session: {
          getSnapshot: ({
            sessionId,
            branchId,
          }: {
            readonly sessionId: SessionId
            readonly branchId: BranchId
          }) =>
            Effect.succeed({
              sessionId,
              branchId,
              messages: [],
              lastEventId: nullValue,
              reasoningLevel: absent,
              agent: "cowork",
              runtime: {
                _tag: "Idle",
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        branch: {
          getTree: () =>
            Effect.succeed([
              {
                branch: {
                  id: alphaBranchId,
                  sessionId: alphaSessionId,
                  name: "Main",
                  createdAt: dateFromMillis(0),
                },
                messageCount: 3,
                children: [],
              },
              {
                branch: {
                  id: betaBranchId,
                  sessionId: alphaSessionId,
                  name: "Side",
                  createdAt: dateFromMillis(1),
                },
                messageCount: 1,
                children: [],
              },
            ]),
        },
        auth: {
          listProviders: () => {
            const providers = [
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: authSource(hasOpenAiKey),
                authType: absent,
              },
            ]
            if (hasOpenAiKey || initialAuthCheckResolved) return Effect.succeed(providers)
            return Deferred.await(initialAuthCheck).pipe(Effect.as(providers))
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
          setKey: ({ key }: { readonly key: string }) =>
            Effect.sync(() => {
              hasOpenAiKey = key.length > 0
            }),
        },
        message: {
          send: (input: {
            readonly sessionId: SessionId
            readonly branchId: BranchId
            readonly content: string
            readonly requestId: string
          }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App
                initialBranches={Option.some([
                  {
                    id: alphaBranchId,
                    sessionId: alphaSessionId,
                    name: "Main",
                    createdAt: dateFromMillis(0),
                  },
                  {
                    id: betaBranchId,
                    sessionId: alphaSessionId,
                    name: "Side",
                    createdAt: dateFromMillis(1),
                  },
                ])}
              />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: alphaSessionId,
              activeBranchId: alphaBranchId,
              name: "Alpha",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(1),
            },
            initialPrompt: Option.some(initialPrompt),
            width: 100,
            height: 30,
          },
        ),
      )
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Resume: Alpha") && frame.includes("Side (1)"),
        "branch picker",
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages).toEqual([])
      initialAuthCheckResolved = true
      yield* Deferred.succeed(initialAuthCheck, void 0)
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in ·"), "auth gate")
      expect(sentMessages).toEqual([])
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sign in · openai · API key"),
        "openai key input",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("Sign in ·"), "auth overlay closed")
      expect(hasOpenAiKey).toBe(true)
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      expect(sentMessages.find((message) => message.content === initialPrompt)).toMatchObject({
        sessionId: alphaSessionId,
        branchId: betaBranchId,
      })
      yield* Effect.promise(() => setup.mockInput.typeText(historyPrompt))
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === historyPrompt),
        "sent message",
      )
      setup.mockInput.pressKey("r", { ctrl: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Prompt search") && frame.includes(historyPrompt),
        "prompt search history",
      )
      setup.mockInput.pressEscape()
      yield* waitForFrame(
        setup,
        (frame) => !frame.includes("Prompt search"),
        "prompt search closed",
      )
      setup.renderer.destroy()
    }),
  )
  it.live("stale auth checks cannot reopen the auth gate after key save", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      let hasOpenAiKey = false
      let sessionAuthChecks = 0
      const staleSessionCheck = yield* Deferred.make<
        Array<{
          provider: string
          hasKey: boolean
          required: boolean
          source: string
          authType: typeof absent
        }>
      >()
      const sentMessages: Array<{
        content: string
      }> = []
      const initialPrompt = "stale auth race prompt"
      const client = createMockClient({
        auth: {
          listProviders: (input: {
            readonly sessionId?: SessionId
            readonly agentName?: string
          }) => {
            const sessionId = Option.fromNullishOr(input.sessionId)
            if (Option.isSome(sessionId)) {
              sessionAuthChecks++
              if (sessionAuthChecks === 1) {
                return Effect.succeed([
                  {
                    provider: "openai",
                    hasKey: false,
                    required: true,
                    source: authSource(false),
                    authType: absent,
                  },
                ])
              }
              if (sessionAuthChecks === 2) return Deferred.await(staleSessionCheck)
              return Effect.succeed([
                {
                  provider: "openai",
                  hasKey: hasOpenAiKey,
                  required: true,
                  source: authSource(hasOpenAiKey),
                  authType: absent,
                },
              ])
            }
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: hasOpenAiKey,
                required: true,
                source: authSource(hasOpenAiKey),
                authType: absent,
              },
            ])
          },
          listMethods: () =>
            Effect.succeed({
              openai: [apiMethod],
            }),
          setKey: ({ key }: { readonly key: string }) =>
            Effect.sync(() => {
              hasOpenAiKey = key.length > 0
            }),
        },
        message: {
          send: (input: { readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
            width: 100,
            height: 30,
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in ·"), "auth gate")
      applySnapshotAgent(clientContext, AgentName.make("deepwork"))
      yield* waitForFrame(setup, () => sessionAuthChecks >= 2, "stale session auth check started")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sign in · openai · API key"),
        "openai key input",
      )
      yield* Effect.promise(() => setup.mockInput.typeText("sk-test"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("Sign in ·"), "auth resolved")
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      yield* Deferred.succeed(staleSessionCheck, [
        {
          provider: "openai",
          hasKey: false,
          required: true,
          source: "none",
          authType: absent,
        },
      ])
      // gent/no-sleep: allow real-clock gap so the resumed-send fiber resolves before assertion
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("Sign in ·")
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
      setup.renderer.destroy()
    }),
  )
  it.live("a renamed session keeps its view and does not send the startup prompt again", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const sentMessages: Array<{ readonly content: string }> = []
      const initialPrompt = "send me once"
      const client = createMockClient({
        message: {
          send: (input: { readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      // The server names the session after the first turn. The record is new;
      // the session is the same one.
      clientContext.switchSession(
        SessionId.make("session-a"),
        BranchId.make("branch-a"),
        "A better name",
      )
      yield* Effect.promise(() => setup.renderOnce())
      // gent/no-sleep: allow real-clock gap so a second send, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
      setup.renderer.destroy()
    }),
  )
  it.live("a startup prompt the server refuses comes back to the draft with its reason", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      const attempts: Array<{ readonly content: string; readonly requestId?: string }> = []
      const initialPrompt = "survive one failure"
      const client = createMockClient({
        message: {
          send: (input: { readonly content: string; readonly requestId?: string }) =>
            Effect.suspend(() => {
              attempts.push(input)
              if (attempts.length === 1) {
                return Effect.fail(new ProviderAuthError({ message: "send refused" }))
              }
              return Effect.void
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      // The refusal is an answer: the prompt comes back as a draft, with why.
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes(`┃ ${initialPrompt}`) &&
          Option.exists(Option.fromNullishOr(clientContext.error()), (error) =>
            error.includes("send refused"),
          ),
        "prompt back in the draft",
      )
      expect(attempts).toHaveLength(1)
      // The reader sends it; nothing sends it on its own.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => attempts.length === 2, "sent by the reader")
      expect(attempts[1]?.content).toBe(initialPrompt)
      setup.renderer.destroy()
    }),
  )
  it.live(
    "a startup prompt whose replies were lost goes again under its request id",
    () =>
      Effect.gen(function* () {
        const ids: Array<string> = []
        const initialPrompt = "lost on the way back"
        const client = createMockClient({
          message: {
            send: (input: { readonly content: string; readonly requestId?: string }) =>
              Effect.suspend(() => {
                ids.push(input.requestId ?? "<missing>")
                // The first send and its four retries: admitted, reply lost.
                if (ids.length <= 5) {
                  return Effect.fail(
                    new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
                  )
                }
                return Effect.void
              }),
          },
        })
        const setup = yield* Effect.promise(() =>
          renderWithProviders(() => <App />, {
            client,
            runtime: createMockRuntime(),
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
            initialPrompt: Option.some(initialPrompt),
          }),
        )
        yield* waitForFrame(
          setup,
          (frame) => frame.includes(`┃ ${initialPrompt}`),
          "prompt back in the draft",
          8_000,
        )
        expect(ids).toHaveLength(5)
        setup.mockInput.pressEnter()
        yield* waitForFrame(setup, () => ids.length === 6, "sent by the reader")
        expect(new Set(ids).size).toBe(1)
        setup.renderer.destroy()
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
  it.live("a renamed session does not refetch the extension slash commands", () =>
    Effect.gen(function* () {
      let ctx: Option.Option<ClientContextValue> = Option.none()
      let slashCommandCalls = 0
      const client = createMockClient({
        extension: {
          listSlashCommands: () =>
            Effect.sync(() => {
              slashCommandCalls += 1
              return []
            }),
        },
      })
      const runtime = createMockRuntime()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime,
            initialAgent: AgentName.make("cowork"),
            initialSession: {
              id: SessionId.make("session-a"),
              activeBranchId: BranchId.make("branch-a"),
              name: "A",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const clientContext = yield* requireClient(ctx)
      yield* waitForFrame(setup, () => slashCommandCalls >= 1, "slash commands fetched")
      const before = slashCommandCalls
      // The extension-contributed rows belong to the session, not to its name.
      clientContext.switchSession(
        SessionId.make("session-a"),
        BranchId.make("branch-a"),
        "A better name",
      )
      yield* Effect.promise(() => setup.renderOnce())
      // gent/no-sleep: allow real-clock gap so a refetch, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(slashCommandCalls).toBe(before)
      setup.renderer.destroy()
    }),
  )
})

// ── widgets render ──────────────────────────────────────────────────────────

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
    ...createMockRuntime(),
    lifecycle: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        listener(state)
        return () => {
          listeners.delete(listener)
        }
      },
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

// ── agents view on the left arrow ───────────────────────────────────────────

describe("agents view on the left arrow", () => {
  const paneOpen = (frame: string) => frame.includes("Agents ·")

  it.live("← on an empty composer opens the agents pane; ← again and Esc close it", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(30)
      setup.mockInput.pressArrow("left")
      yield* waitForFrame(setup, paneOpen, "the agents pane opened by ←")
      setup.mockInput.pressArrow("left")
      yield* waitForFrame(setup, (frame) => !paneOpen(frame), "the pane closed by ←")
      setup.mockInput.pressArrow("left")
      yield* waitForFrame(setup, paneOpen, "the pane opened again")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !paneOpen(frame), "the pane closed by Esc")
      // The composer has the keys back.
      yield* Effect.promise(() => setup.mockInput.typeText("hi"))
      yield* waitForFrame(setup, (frame) => frame.includes("┃ hi"), "typed text in the composer")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("← with a draft moves the text cursor and opens nothing", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(30)
      yield* Effect.promise(() => setup.mockInput.typeText("ac"))
      setup.mockInput.pressArrow("left")
      yield* Effect.promise(() => setup.mockInput.typeText("b"))
      const frame = yield* waitForFrame(setup, (current) => current.includes("┃ abc"), "abc")
      expect(paneOpen(frame)).toBe(false)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("← in shell mode opens nothing", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(30)
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* waitForFrame(setup, (frame) => frame.includes("$"), "shell mode")
      setup.mockInput.pressArrow("left")
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(paneOpen(renderFrame(setup))).toBe(false)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("← in the command palette pops a level and opens no pane", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(30)
      setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("Esc Close"), "the palette root")
      // Theme is the first row.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("Esc Back"), "the theme level")
      setup.mockInput.pressArrow("left")
      const frame = yield* waitForFrame(
        setup,
        (current) => current.includes("Esc Close"),
        "the palette root again",
      )
      expect(paneOpen(frame)).toBe(false)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("→ on a row switches to that agent and closes the pane", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* mountShortTerminalWithTrays(30, [], {
        onClient: (value) => (ctx = Option.some(value)),
      })
      setup.mockInput.pressArrow("left")
      yield* waitForFrame(setup, paneOpen, "the agents pane")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("right")
      yield* waitForFrame(setup, (frame) => !paneOpen(frame), "the pane closed")
      const client = yield* requireClient(ctx)
      expect(client.session()?.sessionId).toBe(SessionId.make("child-4"))
    }).pipe(Effect.timeout("10 seconds")),
  )
})

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
      // The reason, not only the id: a broken config names its parse error.
      expect(frame).toContain("@gent/memory: startup boom")
    }),
  )
  it.live("ConnectionWidget names a model catalog that did not load", () =>
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
                      manifest: { id: "@user/local-models" },
                      scope: "user",
                      sourcePath: "/home/.gent/extensions/local-models.ts",
                      _tag: "Degraded",
                      issues: [
                        {
                          _tag: "ModelCatalogFailed",
                          driverId: "ollama",
                          error: "connect ECONNREFUSED",
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
      expect(frame).toContain("some models unavailable")
      expect(frame).toContain("ollama: connect ECONNREFUSED")
      expect(frame).not.toContain("failed extensions")
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
  // The status row and the activity report read `isReconnecting`, so both
  // wire states that mean "not connected yet" have to answer true.
  it.live("isReconnecting follows the connecting and reconnecting states", () =>
    Effect.gen(function* () {
      const lifecycle = createMutableRuntime(
        ConnectionState.cases.Connected.make({ generation: 0 }),
      )
      const ReconnectProbe = () => {
        const client = useClient()
        return <text>{`reconnecting:${String(client.isReconnecting())}`}</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ReconnectProbe />, { runtime: lifecycle.runtime }),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:false"), "connected")
      lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:true"), "reconnecting")
      lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:false"), "reconnected")
      lifecycle.emit(ConnectionState.cases.Connecting.make({}))
      yield* waitForFrame(setup, (frame) => frame.includes("reconnecting:true"), "connecting")
    }).pipe(Effect.timeout("10 seconds")),
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

// ── debug playground ────────────────────────────────────────────────────────

describe("debug playground", () => {
  it.live(
    "the session view renders the seeded transcript with the shipped tool ids",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Gent.server({
            cwd: "/tmp",
            debug: true,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const { client, runtime } = yield* Gent.client(server, { cwd: "/tmp" })
          const [session] = yield* client.session.list()
          const initialSession = yield* Effect.fromNullishOr(session)
          const setup = yield* Effect.promise(() =>
            renderWithProviders(() => <App />, {
              client,
              runtime,
              initialSession,
              cwd: "/tmp",
              width: 120,
              height: 40,
            }),
          )
          const frame = yield* waitForFrame(
            setup,
            (text) => text.includes("Review the TUI renderer cleanup"),
            "seeded transcript",
            5_000,
          )
          setup.renderer.destroy()
          expect(frame).toContain("✓ 5 tool calls · 1 read · 1 grep · 1 bash · 1 edit · 1 write")
          expect(frame).toContain("✓ 3 tool calls · 2 delegate.start · 1 read_session")
          expect(frame).toContain("Audit lines up")
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )
})

describe("client extension status", () => {
  it.live("a /driver usage hint lands in the footer and never starts a model turn", () =>
    Effect.gen(function* () {
      const sentMessages: Array<{ readonly content: string }> = []
      const client = createMockClient({
        auth: { listProviders: () => Effect.succeed([]) },
        message: {
          send: (input: { readonly content: string }) =>
            Effect.sync(() => {
              sentMessages.push(input)
            }),
        },
      })
      let ext = Option.none<ReturnType<typeof useExtensionUI>>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <App />
              <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
            </>
          ),
          {
            client,
            runtime: createMockRuntime(),
            width: 140,
            initialSession: {
              id: SessionId.make("session-driver"),
              activeBranchId: BranchId.make("branch-driver"),
              name: "Driver",
              createdAt: dateFromMillis(0),
              updatedAt: dateFromMillis(0),
            },
          },
        ),
      )
      const driverCommand = () =>
        ext.pipe(
          Option.flatMap((value) =>
            Option.fromUndefinedOr(value.commands().find((command) => command.slash === "driver")),
          ),
        )
      yield* waitForFrame(setup, () => Option.isSome(driverCommand()), "driver command loaded")
      const command = driverCommand()
      if (Option.isNone(command)) return yield* Effect.die("driver command not loaded")
      command.value.onSlash?.("")
      const frame = yield* waitForFrame(
        setup,
        (text) => text.includes("Usage: /driver <agent> <driver-id|default>"),
        "driver usage in the footer",
      )
      expect(frame).toContain("Usage: /driver")
      expect(sentMessages).toEqual([])
      setup.renderer.destroy()
    }),
  )
})
