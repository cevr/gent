/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import {
  Cause,
  Clock,
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Queue,
  Ref,
  References,
  Schema,
  Scope,
  Stream,
} from "effect"
import { Base64 } from "effect/encoding"
import { BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import { RpcClientError } from "effect/rpc/RpcClientError"
import { SocketCloseError } from "effect/socket/Socket"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Prompt from "effect/ai/Prompt"
import {
  AgentDefinition,
  AgentName,
  BranchId,
  dateFromMillis,
  DEFAULT_AGENT_NAME,
  GentRpcError,
  MessageId,
  Model,
  ModelId,
  ProviderId,
  Message as StoredMessage,
  Session,
  SessionId,
  ToolCallId,
  ConnectionState,
  AgentEvent,
  EventEnvelope,
  type ExtensionHealthSnapshot,
  type GentClientRpcError,
  type QueueEntryInfo,
  QueueSnapshot,
  userMessageIdForRequest,
} from "@gent/core/protocol"
import {
  createRpcHarness,
  emptyQueueSnapshot,
  EventId,
  type ExtensionStatusScope,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  testAgent,
  textStep,
  waitFor,
} from "@gent/core/test-utils"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { Gent, type GentRuntime } from "@gent/sdk"
import { BuiltinExtensions } from "@gent/extensions"
import {
  App,
  AppBootstrapError,
  ConnectionWidget,
  type HeadlessState,
  QueueWidget,
  resolveHeadlessState,
  resolveInteractiveState,
  resolveHeadlessMissingSignIns,
  resolveInteractiveBootstrap,
  activityLine,
  statusModelName,
  NO_MODEL_LABEL,
} from "../src/app"
import {
  applySnapshotAgent,
  createMockClient,
  createMockRuntime,
  createMutableRuntime,
  holdingReplies,
  mountClient,
  renderFrame,
  renderScoped,
  TerminalOutput,
  snapshotNaming,
  testPlatformLayer,
} from "./render-harness-boundary"
import { LinkOpener, LinkOpenerError } from "../src/os"
import { createSignal, onMount, Show, type Signal } from "solid-js"
import {
  defineExtension,
  ExtensionHost,
  ExtensionId,
  ProviderAuthError,
} from "@gent/core/extensions/api"
import { type ClientContextValue, useClient } from "../src/client"
import {
  type RenderWaitTimeoutError,
  untilExtensionsLoaded,
  waitForFrame,
  waitForTerminal,
  waitUntil,
  waitUntilAdvancing,
} from "./helpers-boundary"
import { useTerminalDimensions } from "../src/terminal"
import { useWorkspace } from "../src/workspace"
import { useTheme } from "../src/theme"
import { useExtensionUI } from "../src/extensions/host"
import { builtinClientModules } from "../src/extensions/builtins"
import {
  ClientContext,
  autocompleteContribution,
  clientCommandContribution,
  clientContributions,
  defineClientExtension,
  type AnyExtensionClientModule,
  type ClientContributions,
  interactionRendererContribution,
  messageRendererContribution,
  type NoticeRow,
  noticeRowContribution,
  rendererContribution,
  STATUS_YIELD,
  statusLabelContribution,
  stoppableContribution,
  widgetContribution,
} from "../src/extensions/client-facets"
import { NOTICE_ROWS_BOUND, useExit, useSessionController } from "../src/session"
import { seedDebugSession } from "../src/ops"

// ── app bootstrap ───────────────────────────────────────────────────────────

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
// eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
const nullValue = null
const idleTag = "Idle" satisfies "Idle"
const refusedInA = Schema.decodeSync(GentRpcError)({
  _tag: "InvalidStateError",
  message: "send refused in A",
})
const noModel = Schema.decodeSync(GentRpcError)({
  _tag: "NoModelError",
  message: 'No model is set for agent "main". Pick one with /model',
  agent: "main",
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

const sessionA = {
  id: SessionId.make("session-a"),
  activeBranchId: BranchId.make("branch-a"),
  name: "Session A",
  createdAt: dateFromMillis(0),
  updatedAt: dateFromMillis(0),
  cwd: "/nonexistent/gent-test-cwd",
  reasoningLevel: absent,
  parentSessionId: absent,
  parentBranchId: absent,
}

const branchOf = (id: string, createdAtMs: number) => ({
  id: BranchId.make(id),
  sessionId: sessionA.id,
  createdAt: dateFromMillis(createdAtMs),
})

describe("startup and headless auth", () => {
  // The session view reads the agent from the snapshot it loads; startup
  // reads neither the snapshot nor the providers before it renders.
  it.live("interactive startup reads no snapshot and lists no providers", () =>
    Effect.gen(function* () {
      const reads: Array<string> = []
      const client = createMockClient({
        branch: { list: () => Effect.succeed([branchOf("branch-a", 0)]) },
        session: {
          get: () => Effect.succeed(sessionA),
          getSnapshot: () =>
            Effect.sync(() => {
              reads.push("getSnapshot")
            }).pipe(Effect.andThen(Effect.die("startup reads no snapshot"))),
        },
        auth: {
          listProviders: () =>
            Effect.sync(() => {
              reads.push("listProviders")
              return []
            }),
        },
      })
      const bootstrap = yield* resolveInteractiveBootstrap({
        client,
        cwd: "/nonexistent/gent-test-cwd",
        sessionId: "session-a",
        continue_: false,
      })
      expect(bootstrap.initialSession.sessionId).toBe(sessionA.id)
      expect(reads).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a headless session names the missing sign-ins of the agent it runs", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([
              {
                provider: "opencode",
                name: "OpenCode",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
              {
                provider: "anthropic",
                name: "Anthropic",
                hasKey: true,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
              {
                provider: "mirror-a",
                name: "Mirror",
                hasKey: false,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
              {
                provider: "mirror-b",
                name: "Mirror",
                hasKey: true,
                required: true,
                source: noAuthSource,
                authType: absent,
              },
            ])
          },
        },
      })
      const state: HeadlessState = {
        session: {
          id: SessionId.make("session-a"),
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/nonexistent/gent-test-cwd",
          reasoningLevel: absent,
          parentSessionId: absent,
          parentBranchId: absent,
        },
        prompt: "hi",
      }
      // Named as `/auth` names them: the driver's name, else its id, and a
      // name two drivers share keeps the id beside it.
      const missing = yield* resolveHeadlessMissingSignIns({ client, state })
      expect(missing).toEqual(["OpenCode", "openai", "Mirror (mirror-a)"])
      // The session id is the question: the server answers for the agent the
      // session runs.
      expect(calls).toEqual([{ sessionId: SessionId.make("session-a") }])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.live("a session with several branches boots into the branch picker", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        branch: {
          list: () => Effect.succeed([branchOf("branch-a", 0), branchOf("branch-b", 1)]),
        },
        session: { get: () => Effect.succeed(sessionA) },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) =>
            Effect.sync(() => {
              calls.push(input)
              return []
            }),
        },
      })
      const bootstrap = yield* resolveInteractiveBootstrap({
        client,
        cwd: "/nonexistent/gent-test-cwd",
        sessionId: "session-a",
        continue_: false,
      })
      expect(Option.map(bootstrap.initialBranches, (branches) => branches.length)).toEqual(
        Option.some(2),
      )
      expect(calls).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A session record with no branch is a typed failure, so `gent -s <id>`
  // prints one line for it, as it does for a missing session.
  it.live("a resumed session with no branch fails with a typed bootstrap error", () =>
    Effect.gen(function* () {
      const branchless = { ...sessionA, activeBranchId: absent }
      const error = yield* expectAppBootstrapFailure(
        resolveInteractiveBootstrap({
          client: createMockClient({
            branch: { list: () => Effect.succeed([]) },
            session: { get: () => Effect.succeed(branchless) },
          }),
          cwd: "/nonexistent/gent-test-cwd",
          sessionId: "session-a",
          continue_: false,
        }),
      )
      expect(error.reason).toBe("missing-branch")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("startup state", () => {
  it.live("fails with typed bootstrap error when headless prompt is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveHeadlessState({
          client: createMockClient(),
          cwd: "/nonexistent/gent-test-cwd",
          session: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // The composer sends nothing for a blank draft; headless holds the same line.
  it.live("a whitespace-only headless prompt is a missing prompt", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveHeadlessState({
          client: createMockClient(),
          cwd: "/nonexistent/gent-test-cwd",
          session: Option.none(),
          promptArg: Option.some(" \n\t "),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }).pipe(Effect.timeout("10 seconds")),
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
        agent: AgentName.make("secondary"),
        runSpec: { overrides: { maxSteps: 3 } },
      }
      const state = yield* resolveHeadlessState({
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
        cwd: "/nonexistent/gent-test-cwd",
        session: Option.none(),
        promptArg: Option.some("hi"),
        admission,
      })
      expect(state).toMatchObject({ session: { id: "session-test" } })
      // The agent is fixed on the session; the prompt's turn carries none.
      expect(created.map((input) => input.admission)).toEqual([admission])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("fails with typed bootstrap error when requested session is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInteractiveState({
          client: createMockClient(),
          cwd: "/nonexistent/gent-test-cwd",
          session: Option.some("missing-session"),
          continue_: false,
          prompt: Option.none(),
        }),
      )
      expect(error.reason).toBe("session-not-found")
      expect(error.sessionId).toBe(SessionId.make("missing-session"))
    }).pipe(Effect.timeout("10 seconds")),
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
      const state = yield* resolveInteractiveState({
        client: createMockClient({
          session: { list: () => Effect.succeed([child, root, handoff]) },
        }),
        cwd: "/work",
        session: Option.none(),
        continue_: true,
        prompt: Option.none(),
      })
      expect(state).toMatchObject({ _tag: "session", session: { id: "handoff" } })
    }).pipe(Effect.timeout("10 seconds")),
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

/** What a probe gave once it mounted. */
const requireProbe = <A,>(
  probe: Option.Option<A>,
  name: string,
): Effect.Effect<A, MessageTimeoutError> =>
  Effect.fromOption(probe).pipe(
    Effect.mapError(() => new MessageTimeoutError({ message: `${name} not ready` })),
  )

const requireClient = (context: Option.Option<ClientContextValue>) =>
  requireProbe(context, "client context")

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

function ExtensionUIProbe(props: {
  readonly onReady: (ext: ReturnType<typeof useExtensionUI>) => void
}) {
  const ext = useExtensionUI()
  onMount(() => {
    props.onReady(ext)
  })
  return <box />
}

/** The session a mount starts on, as the client holds it. */
const sessionNamed = (id: string, branch: string, name: string) => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(branch),
  name,
})

/** A `message` namespace that records each sent content. */
const recordSends = (sent: Array<string>) => ({
  send: (input: { readonly content: string }) =>
    Effect.sync(() => {
      sent.push(input.content)
    }),
})

type RenderOptions = NonNullable<Parameters<typeof renderScoped>[1]>

/**
 * The app on a mock client. `client` replaces the mock's methods it names;
 * the mock lists no providers and an empty branch tree. `replies` holds the
 * mock's replies, and `app` holds the props of `App`. The probes give the
 * client context and the extension UI.
 */
const mountApp = (
  options: Omit<RenderOptions, "client"> & {
    readonly client?: Parameters<typeof createMockClient>[0]
    readonly replies?: Parameters<typeof createMockClient>[1]
    readonly app?: Parameters<typeof App>[0]
  } = {},
) =>
  Effect.gen(function* () {
    const { client, replies, app, ...render } = options
    let ctx = Option.none<ClientContextValue>()
    let ext = Option.none<ReturnType<typeof useExtensionUI>>()
    const setup = yield* renderScoped(
      () => (
        <>
          <App {...app} />
          <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
          <ExtensionUIProbe onReady={(value) => (ext = Option.some(value))} />
        </>
      ),
      { ...render, client: createMockClient(client, replies) },
    )
    return {
      setup,
      client: yield* requireClient(ctx),
      ext: yield* requireProbe(ext, "extension UI"),
    }
  })

/**
 * Counts the renderer teardowns the app performs in place of them, so a test
 * reads the frame after an exit: `useEnv().shutdown` is a no-op in the
 * harness. The scope gives the renderer its teardown back before the harness
 * destroys it, so no renderer outlives its test.
 */
const countShutdowns = (setup: TestSetup) =>
  Effect.gen(function* () {
    let shutdowns = 0
    const destroy = setup.renderer.destroy.bind(setup.renderer)
    setup.renderer.destroy = () => {
      shutdowns += 1
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setup.renderer.destroy = destroy
      }),
    )
    return { shutdowns: () => shutdowns, destroy }
  })

/** A turn that started now, on the real clock, with nothing waiting. */
const runningNow = () => ({
  _tag: "Running" satisfies "Running",
  startedAtMs: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  queue: emptyQueueSnapshot(),
})

/**
 * The session view over a turn that runs, on a terminal `height` rows tall.
 * The runtime stream says Running once and then stays quiet, as it does
 * through a long generation or a long tool call.
 */
const mountRunningTurn = (
  height = 24,
  extensions: ReadonlyArray<AnyExtensionClientModule> = [],
  terminal: { readonly kittyKeyboard?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sessionId = SessionId.make("session-running")
    const branchId = BranchId.make("branch-running")
    const running = runningNow()
    const steers: Array<string> = []
    const sent: Array<string> = []
    let readActivity = () => "unmounted"
    const activityProbe = defineClientExtension("@test/activity-probe", {
      setup: Effect.gen(function* () {
        const { activity } = yield* ClientContext
        readActivity = () => activity.snapshot().state
        return clientContributions()
      }),
    })
    const { setup, client } = yield* mountApp({
      client: {
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
        queue: {
          // One follow-up waits behind the turn; alt+up takes it back into the draft.
          drain: () =>
            Effect.succeed({
              steering: [],
              followUp: [
                {
                  _tag: "FollowUp" satisfies "FollowUp",
                  id: MessageId.make("queued-follow-up"),
                  content: "the queued follow-up",
                  createdAt: 0,
                },
              ],
            }),
        },
        message: recordSends(sent),
      },
      builtins: [...builtinClientModules, activityProbe, ...extensions],
      height,
      ...terminal,
      initialSession: sessionNamed(sessionId, branchId, "Running"),
    })
    const { shutdowns } = yield* countShutdowns(setup)
    yield* waitForFrame(setup, () => client.isStreaming(), "running turn")
    yield* waitForFrame(setup, () => readActivity() !== "unmounted", "activity probe loaded")
    return {
      setup,
      client,
      steers,
      sent,
      shutdowns,
      activity: () => readActivity(),
    }
  })

type TestSetup = Effect.Success<ReturnType<typeof renderScoped>>

const pairA = { sessionId: SessionId.make("session-a"), branchId: BranchId.make("branch-a") }
const pairB = { sessionId: SessionId.make("session-b"), branchId: BranchId.make("branch-b") }

/** A queue drain that answers `content` once the test completes `answer`. */
const gatedDrain = (content: string) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>()
    const answer = yield* Deferred.make<void>()
    const drain = () =>
      Deferred.complete(asked, Effect.void).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.as({
          steering: [],
          followUp: [
            {
              _tag: "FollowUp" satisfies "FollowUp",
              id: MessageId.make("queued"),
              content,
              createdAt: 0,
            },
          ],
        }),
      )
    return { asked, answer, drain }
  })

/**
 * The session view on A, with B one switch away: a test starts an action in
 * A, moves to B before A's server answers, and reads where the answer lands.
 */
const mountSessionPair = (overrides: Parameters<typeof createMockClient>[0]) =>
  Effect.gen(function* () {
    const { setup, client: clientCtx } = yield* mountApp({
      client: overrides,
      initialSession: sessionNamed(pairA.sessionId, pairA.branchId, "Session A"),
    })
    yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session A")
    const switchTo = (pair: typeof pairA, name: string) =>
      Effect.gen(function* () {
        clientCtx.switchSession(pair.sessionId, pair.branchId, name)
        yield* waitForFrame(
          setup,
          (frame) =>
            clientCtx.sessionIdentity().sessionId === pair.sessionId && frame.includes("ready ·"),
          name,
        )
      })
    /** A few frames for anything a late answer would draw. */
    const settle = Effect.gen(function* () {
      for (let frame = 0; frame < 3; frame++) {
        yield* Effect.yieldNow
        yield* Effect.promise(() => setup.renderOnce())
      }
    })
    return { setup, client: clientCtx, switchTo, settle }
  })

const ESC_CUE = "esc again to clear"
const CTRL_C_CUE = "ctrl+c again to exit"

/**
 * An idle session view with no draft; `shutdowns` counts the exits it
 * performs, and `sent` holds each message it sent.
 */
const mountIdleSession = (
  runtime: GentRuntime = createMockRuntime(),
  terminal: {
    readonly kittyKeyboard?: boolean
    readonly width?: number
    readonly resumable?: boolean
    readonly writeTerminal?: (text: string) => void
  } = {},
) =>
  Effect.gen(function* () {
    const sent: Array<string> = []
    const { setup } = yield* mountApp({
      client: { message: recordSends(sent) },
      runtime,
      ...terminal,
      initialSession: sessionNamed("session-a", "branch-a", "Session A"),
    })
    yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
    const { shutdowns, destroy } = yield* countShutdowns(setup)
    return {
      setup,
      shutdowns,
      sent: (): ReadonlyArray<string> => sent,
      /** Tears the view down, as the harness does after the test. */
      unmount: destroy,
      /** Time for a key to be parsed and handled before a negative assertion. */
      // oxlint-disable-next-line effect/noFixedWaitInTests -- A lone escape byte stays in the stdin parser until its real-clock timeout flushes it as a key; no event marks the flush.
      settle: Effect.sleep("100 millis"),
    }
  })

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
    /** What `session.delete` answers; the default deletes. */
    readonly deleteSession?: Effect.Effect<void, GentClientRpcError>
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
      // Tasks 3 and 4 report no activity line: their rows hold only their
      // names. A short pane keeps one row, the cursor row, so the one task
      // drawn marks where the cursor is.
      if (n <= 4) return row
      return { ...row, activity: "bash" }
    }
    const running = runningNow()
    const { setup, client } = yield* mountApp({
      client: {
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
          delete: () => options.deleteSession ?? Effect.void,
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
      },
      builtins: builtinClientModules,
      height,
      width: options.width,
      initialSession: sessionNamed(sessionId, branchId, "Session BTW"),
    })
    options.onClient?.(client)
    yield* waitForFrame(
      setup,
      (frame) => frame.includes("✻ ") && frame.includes("delegate: task 3"),
      "a running turn over the trays",
    )
    return setup
  })

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
    const withClock = createMockRuntime(
      new Map<string, unknown>([
        [Clock.Clock.key, clock],
        [Logger.CurrentLoggers.key, new Set([capture])],
        [References.MinimumLogLevel.key, "All"],
      ]),
    )
    const runtime: GentRuntime = {
      ...createMockRuntime(),
      cast: withClock.cast,
      fork: withClock.fork,
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
    const { setup, ext } = yield* mountApp({
      runtime,
      builtins: [...builtinClientModules, extension],
      initialSession: sessionNamed("session-silent", "branch-silent", "Silent"),
    })
    yield* waitForFrame(setup, (frame) => frame.includes("ready ·") && ext.loaded(), "loaded")
    const sources = (): ReadonlyArray<string> => ext.noticeRows().map((source) => source.id)
    const failed = () => ext.failures().some((failure) => failure.id === "@test/silent-notices")
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
      yield* waitForTerminal(setup, (text) => text.includes("LATE-NOTICE-ROW"), "the late row")
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
      yield* waitForTerminal(setup, (text) => text.includes("ON-TIME-ROW"), "the on-time row")
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
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App sign-in pane", () => {
  // A scripted model (`--debug`, `--mock-empty`) answers with no key: the
  // session view asks for no sign-in, as headless does not.
  it.scopedLive("a scripted model opens the session with no sign-in", () =>
    Effect.gen(function* () {
      let checks = 0
      const { setup, client } = yield* mountApp({
        app: { scriptedModel: true },
        client: {
          auth: {
            listProviders: () =>
              Effect.sync(() => {
                checks += 1
                return [
                  {
                    provider: "anthropic",
                    hasKey: false,
                    required: true,
                    source: noAuthSource,
                    authType: absent,
                  },
                ]
              }),
          },
        },
        initialSession: sessionNamed("session-scripted", "branch-scripted", "Scripted"),
      })
      yield* waitForFrame(setup, (next) => next.includes("ready ·"), "session view")
      // The agent resolves: the point where a keyed model checks its sign-ins.
      applySnapshotAgent(client, AgentName.make("main"))
      yield* Effect.promise(() => setup.renderOnce())
      const frame = yield* Effect.promise(() => setup.renderOnce()).pipe(
        Effect.map(() => renderFrame(setup)),
      )
      expect(frame).not.toContain("Sign in ·")
      expect(checks).toBe(0)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("rechecks auth requirements when the selected agent changes", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
      }> = []
      const { setup, client } = yield* mountApp({
        client: {
          auth: {
            listProviders: (input: { agentName?: string }) => {
              calls.push(input)
              if (input.agentName === "secondary") {
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
            listMethods: () => Effect.succeed({ openai: [apiMethod] }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      applySnapshotAgent(client, AgentName.make("secondary"))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Sign in ·"),
        "API Keys after agent switch",
      )
      expect(calls.length).toBeGreaterThan(0)
      expect(frame).toContain("Sign in ·")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("the startup auth check asks for the agent the session's snapshot names", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
        sessionId?: string
      }> = []
      const { setup } = yield* mountApp({
        client: {
          session: snapshotNaming(AgentName.make("secondary")),
          auth: {
            listProviders: (input: { agentName?: string; sessionId?: string }) => {
              calls.push(input)
              if (input.agentName === "secondary") {
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
            listMethods: () => Effect.succeed({ openai: [apiMethod] }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Sign in ·"),
        "API Keys from initial agent",
      )
      // The auth check names the session the client holds.
      expect(calls[0]).toEqual({
        agentName: AgentName.make("secondary"),
        sessionId: SessionId.make("session-a"),
      })
      // The gate opens the auth overlay itself, and the branch picker is read
      // off that same overlay. A gate that ran again on its own write would
      // keep checking; it settles at two checks instead.
      expect(calls.length).toBe(2)
      expect(frame).toContain("Sign in ·")
    }).pipe(Effect.timeout("10 seconds")),
  )
  /**
   * The enforced sign-in on a `height`-row terminal: openai is required and
   * has no key, zzprovider is optional. The gate opens the pane on openai's
   * sign-in methods.
   */
  const mountSignIn = (height = 24, savedKeys: Array<string> = []) =>
    Effect.gen(function* () {
      const { setup } = yield* mountApp({
        client: {
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
        },
        height,
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("API key [api]"), "openai's methods")
      return setup
    })
  // The method screen is its own pane: the provider list it came from is gone,
  // so its rows never read as the choice. The key screen draws no list at all.
  it.scopedLive("the sign-in method and key screens draw no provider rows", () =>
    Effect.gen(function* () {
      const setup = yield* mountSignIn()
      const methods = renderFrame(setup)
      expect(methods).not.toContain("zzprovider")
      expect(methods).not.toContain("openai [none]")
      setup.mockInput.pressEnter()
      const key = yield* waitForFrame(setup, (frame) => frame.includes("API key ›"), "key line")
      expect(key).not.toContain("zzprovider")
      expect(key).not.toContain("API key [api]")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Docked, not modal: the sign-in draws under the composer's status row like
  // every pane, and a short terminal keeps its cursor row.
  it.scopedLive("the sign-in docks under the composer and keeps its cursor row at 10 rows", () =>
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
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A paste can carry terminal escape sequences (a colour code copied out of
  // another terminal) and C1 controls. The key keeps only its text: whole
  // sequences drop, not just their escape byte.
  it.scopedLive("a pasted key drops whole escape sequences and C1 controls", () =>
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
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A key longer than the row shows the tail of its mask, so the caret the
  // reader types at stays on screen.
  it.scopedLive("a long key keeps the caret on screen", () =>
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
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App session view and fatal screen", () => {
  it.scopedLive("shares one terminal resize source across App and cleans it up", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <>
            <App />
            <TerminalDimensionsProbe />
          </>
        ),
        { initialSession: sessionNamed("session-resize", "branch-resize", "Resize") },
      )
      expect(setup.renderer.listenerCount("resize")).toBe(1)
      expect(renderFrame(setup)).toContain("80x24")

      setup.renderer.resize(100, 30)
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("100x30")

      setup.renderer.destroy()
      expect(setup.renderer.listenerCount("resize")).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Mermaid draws inline in the transcript. No key opens a full-screen
  // viewer over the session: panes dock, and the composer keeps the keys.
  it.scopedLive("ctrl+shift+m keeps the session view and its composer", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { kittyKeyboard: true })
      view.setup.mockInput.pressKey("m", { ctrl: true, shift: true })
      yield* view.settle
      yield* Effect.promise(() => view.setup.mockInput.typeText("hi"))
      const frame = yield* waitForFrame(
        view.setup,
        (current) => current.includes("┃ hi") || current.includes("Fatal error"),
        "the draft",
      )
      expect(frame).not.toContain("Fatal error")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A client extension's code that the view runs while it draws fails that
  // extension, by name, as a setup throw does: the session view stays and
  // takes keys, and the host's own renderer draws in a renderer's place.
  // Each contribution bucket names its case below, or why it has none: a new
  // bucket does not compile until it is placed.
  const renderThrowCoverage = {
    widgets: ["widget"],
    statusLabels: ["status label"],
    noticeRows: ["notice row"],
    messageRenderers: ["message renderer", "message prompt", "message queue label"],
    renderers: ["tool renderer"],
    interactionRenderers: ["interaction renderer"],
    // A command runs on a key, outside the draw.
    commands: [],
    autocomplete: ["autocomplete items", "autocomplete open"],
    // A stoppable runs on Esc, outside the draw; its Esc test covers a throw.
    stoppables: [],
  } as const satisfies Record<keyof ClientContributions, ReadonlyArray<string>>
  const breaksSession = sessionNamed("session-breaks", "branch-breaks", "Breaks")
  const breaksEnvelope = (id: number, event: EventEnvelope["event"]) =>
    EventEnvelope.make({ id: EventId.make(id), createdAt: id, event })
  const breaksAnswerId = MessageId.make("breaks-answer")
  const breaksUserMessage = AgentEvent.cases.MessageReceived.make({
    message: StoredMessage.cases.regular.make({
      id: MessageId.make("breaks-message"),
      sessionId: breaksSession.sessionId,
      branchId: breaksSession.branchId,
      role: "user",
      parts: [Prompt.textPart({ text: "plain breaks text" })],
      createdAt: dateFromMillis(1),
      metadata: { customType: "breaks-row" },
    }),
  })
  const breaksEvents = {
    widget: [],
    "status label": [],
    "notice row": [],
    "autocomplete items": [],
    "autocomplete open": [],
    "message renderer": [breaksUserMessage],
    "message prompt": [breaksUserMessage],
    // The queue label draws from the runtime's queue (`breaksRuntime`), not from an event.
    "message queue label": [],
    "tool renderer": [
      AgentEvent.cases.MessageReceived.make({
        message: StoredMessage.cases.regular.make({
          id: breaksAnswerId,
          sessionId: breaksSession.sessionId,
          branchId: breaksSession.branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text: "calling the tool" })],
          createdAt: dateFromMillis(1),
        }),
      }),
      AgentEvent.cases.ToolCallStarted.make({
        sessionId: breaksSession.sessionId,
        branchId: breaksSession.branchId,
        toolCallId: ToolCallId.make("breaks-call"),
        toolName: "breaks_tool",
        input: { command: "plain breaks input" },
        assistantMessageId: breaksAnswerId,
      }),
    ],
    "interaction renderer": [
      AgentEvent.cases.InteractionPresented.make({
        sessionId: breaksSession.sessionId,
        branchId: breaksSession.branchId,
        requestId: InteractionRequestId.make("breaks-request"),
        text: "plain breaks question",
        metadata: { type: "breaks-ask" },
      }),
    ],
  } satisfies Record<
    (typeof renderThrowCoverage)[keyof ClientContributions][number],
    ReadonlyArray<EventEnvelope["event"]>
  >
  // The text the host draws in place of the extension's.
  const breaksFallback = (surface: keyof typeof breaksEvents) => {
    switch (surface) {
      case "message renderer":
        return Option.some("plain breaks text")
      case "tool renderer":
        return Option.some("breaks_tool")
      case "interaction renderer":
        return Option.some("plain breaks question")
      case "message queue label":
        return Option.some("┊ next step · plain breaks queued")
      default:
        return Option.none<string>()
    }
  }
  // A turn runs with one steer waiting, of the custom type the queue label names.
  const breaksRuntime = (surface: keyof typeof breaksEvents) => {
    if (surface !== "message queue label") return Stream.never
    const queue = new QueueSnapshot({
      steering: [
        {
          _tag: "Steering",
          id: MessageId.make("breaks-queued"),
          content: "plain breaks queued",
          createdAt: 1,
          // The reader's own: only the reader's waiting messages draw.
          metadata: { customType: "breaks-row", fromClient: true },
        },
      ],
      followUp: [],
    })
    return Stream.concat(Stream.make({ ...runningNow(), queue }), Stream.never)
  }
  for (const surface of Object.values(renderThrowCoverage).flat()) {
    it.scopedLive(
      `an extension's ${surface} that throws while the view draws fails its extension and the view stays`,
      () =>
        Effect.gen(function* () {
          const [broken, setBroken] = createSignal(false)
          // Throws once `broken` turns true: its decode fails.
          const explode = () => Schema.decodeUnknownSync(Schema.Literal("fine"))("render broke")
          const Breaks = () => (
            <Show when={broken()} fallback={<text>breaks-drawn</text>}>
              <text>{explode()}</text>
            </Show>
          )
          // How often the popup ran an autocomplete source's code.
          let asked = 0
          const contribution = () => {
            switch (surface) {
              case "widget":
                return widgetContribution({ id: "breaks", slot: "below-input", component: Breaks })
              case "status label":
                return statusLabelContribution({
                  produce: () => {
                    if (broken()) explode()
                    return [{ text: "breaks-drawn", color: "info" as const }]
                  },
                })
              case "notice row":
                return noticeRowContribution({
                  id: "breaks",
                  rows: () => {
                    if (broken()) explode()
                    return Option.some([
                      {
                        key: "breaks",
                        createdAt: 1,
                        glyph: "•",
                        color: "info",
                        text: "breaks-drawn",
                      },
                    ])
                  },
                })
              case "message renderer":
                return messageRendererContribution("breaks-row", Breaks)
              case "message prompt":
                return messageRendererContribution("breaks-row", () => <text>breaks-drawn</text>, {
                  prompt: (content) => {
                    if (broken()) explode()
                    return content
                  },
                })
              case "message queue label":
                return messageRendererContribution("breaks-row", () => <text>breaks-row</text>, {
                  queueLabel: () => {
                    if (broken()) explode()
                    return "breaks-drawn"
                  },
                })
              case "tool renderer":
                return rendererContribution(["breaks_tool"], Breaks)
              case "interaction renderer":
                return interactionRendererContribution(Breaks, "breaks-ask")
              // A source the popup runs on `%`: its `items` dies inside its
              // Effect, or its `onOpen` throws, once `broken` turns true.
              case "autocomplete items":
                return autocompleteContribution({
                  prefix: "%",
                  title: "Breaks",
                  items: () => {
                    asked += 1
                    return Effect.sync(() => {
                      if (broken()) explode()
                      return [{ id: "breaks-drawn", label: "breaks-drawn" }]
                    })
                  },
                })
              case "autocomplete open":
                return autocompleteContribution({
                  prefix: "%",
                  title: "Breaks",
                  items: () => {
                    asked += 1
                    return [{ id: "breaks-drawn", label: "breaks-drawn" }]
                  },
                  onOpen: () => {
                    asked += 1
                    if (broken()) explode()
                  },
                })
            }
          }
          const autocomplete = surface.startsWith("autocomplete")
          // An autocomplete source loads only once the session reads `ready`:
          // the order a loaded machine gives, where `ready` comes first.
          const readySeen = Deferred.makeUnsafe<void>()
          let loadGate: Effect.Effect<void> = Effect.void
          if (autocomplete) loadGate = Deferred.await(readySeen)
          const extension = defineClientExtension("@test/breaks", {
            setup: loadGate.pipe(Effect.as(clientContributions(contribution()))),
          })
          const responded: Array<boolean> = []
          const { setup, ext } = yield* mountApp({
            builtins: [...builtinClientModules, extension],
            width: 120,
            initialSession: breaksSession,
            client: {
              session: {
                watchRuntime: () => breaksRuntime(surface),
                events: () =>
                  Stream.concat(
                    Stream.make(
                      breaksEnvelope(
                        0,
                        AgentEvent.cases.StreamSynchronized.make({
                          sessionId: breaksSession.sessionId,
                          branchId: breaksSession.branchId,
                          lastEventId: EventId.make(0),
                        }),
                      ),
                      ...breaksEvents[surface].map((event, index) =>
                        breaksEnvelope(index + 1, event),
                      ),
                    ),
                    Stream.never,
                  ),
              },
              interaction: {
                respondInteraction: (input: { readonly approved: boolean }) =>
                  Effect.sync(() => {
                    responded.push(input.approved)
                  }),
              },
            },
          })
          if (surface === "tool renderer") {
            // ctrl+o opens the collapsed call to its full rows.
            yield* waitForFrame(setup, (frame) => frame.includes("breaks_tool 1×"), "the call")
            setup.mockInput.pressKey("o", { ctrl: true })
            setup.mockInput.pressKey("o", { ctrl: true })
          }
          if (autocomplete) {
            // A `%` typed before the extensions load opens nothing, and `ready`
            // is the session's word, not the load's: wait for the load itself.
            yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "the session ready")
            Deferred.doneUnsafe(readySeen, Exit.void)
            yield* untilExtensionsLoaded(setup, ext.loaded)
            yield* Effect.promise(() => setup.mockInput.typeText("%"))
          }
          yield* waitForFrame(
            setup,
            (frame) => frame.includes("breaks-drawn"),
            "the extension draws",
          )
          setBroken(true)
          if (autocomplete) {
            // The popup opens again and runs the source.
            setup.mockInput.pressBackspace()
            yield* waitForFrame(setup, (frame) => !frame.includes("breaks-drawn"), "closed")
            yield* Effect.promise(() => setup.mockInput.typeText("%"))
          }
          // A session whose last message is the reader's runs a turn: no `ready`.
          const idle = !surface.startsWith("message") && surface !== "interaction renderer"
          const frame = yield* waitForFrame(
            setup,
            (current) =>
              current.includes("@test/breaks: render failed") &&
              (!idle || current.includes("ready ·")),
            "the failure named",
          )
          expect(frame).not.toContain("Fatal error")
          const fallback = breaksFallback(surface)
          if (Option.isSome(fallback)) {
            yield* waitForFrame(
              setup,
              (current) => current.includes(fallback.value) && !current.includes("breaks-drawn"),
              "the host's renderer in its place",
            )
          }
          if (surface === "interaction renderer") {
            // The host's prompt answers the ask.
            setup.mockInput.pressEnter()
            yield* waitFor(
              Effect.succeed(responded),
              (answers) => answers.length === 1,
              5_000,
              "the prompt answered",
            )
            expect(responded).toEqual([true])
            return
          }
          if (autocomplete) {
            // The failed source is offered no more: a `%` opens no popup.
            const askedBefore = asked
            setup.mockInput.pressBackspace()
            yield* waitForFrame(setup, (current) => !current.includes("┃ %"), "the % deleted")
            yield* Effect.promise(() => setup.mockInput.typeText("%"))
            yield* waitForFrame(setup, (current) => current.includes("┃ %"), "the % again")
            yield* Effect.promise(() => setup.renderOnce())
            expect(asked).toBe(askedBefore)
            setup.mockInput.pressBackspace()
          }
          yield* Effect.promise(() => setup.mockInput.typeText("still here"))
          yield* waitForFrame(setup, (current) => current.includes("┃ still here"), "the draft")
        }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // A host render throw replaces the whole view: a server reply the client
  // takes as is (an extension health report without its lists). The screen
  // it leaves names a way out, ctrl+c takes it and prints the way back, and
  // the client log keeps the error.
  it.scopedLive("the fatal screen logs the error and exits on ctrl+c with the resume hint", () =>
    Effect.gen(function* () {
      const logged: Array<string> = []
      const record = (msg: string) => logged.push(msg)
      const written: Array<string> = []
      const { setup } = yield* mountApp({
        client: { extension: { listStatus: () => Effect.succeed({ _tag: "Degraded" }) } },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: record },
        writeTerminal: (text) => written.push(text),
        initialSession: sessionNamed("session-fatal", "branch-fatal", "Fatal"),
      })
      const { shutdowns } = yield* countShutdowns(setup)
      const frame = yield* waitForFrame(
        setup,
        (current) => current.includes("Fatal error"),
        "fatal",
      )
      expect(frame).toContain("ctrl+c")
      expect(logged).toContain("app.fatal")
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => shutdowns() === 1, "exit")
      expect(written).toEqual(["\nto resume: gent resume session-fatal\n"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // `/new` keeps the session in view until the server answers. A create the
  // server refuses leaves the reader where they were, with the reason.
  it.scopedLive("a /new the server refuses keeps the session in view and shows why", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const { setup, client: clientContext } = yield* mountApp({
        client: {
          session: {
            create: () =>
              Deferred.await(release).pipe(
                Effect.andThen(Effect.fail(new ProviderAuthError({ message: "create refused" }))),
              ),
          },
        },
        initialSession: sessionNamed("session-kept", "branch-kept", "Kept"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* typeCommand("/new")(setup)
      // While the create is in flight, the session stays mounted.
      yield* waitForFrame(setup, (frame) => !frame.includes("/new"), "command sent")
      expect(clientContext.session().sessionId).toEqual(SessionId.make("session-kept"))
      expect(renderFrame(setup)).toContain("ready ·")
      yield* Deferred.succeed(release, void 0)
      const frame = yield* waitForFrame(
        setup,
        (current) => current.includes("create refused"),
        "the refusal on the status row",
      )
      expect(frame).toContain("┃")
      expect(clientContext.session().sessionId).toEqual(SessionId.make("session-kept"))
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App draft, shell and exit keys", () => {
  // Esc on an idle, empty composer stops what an extension holds pending,
  // such as an auto-resume. A user extension gets the same key as a shipped
  // one; a draft is nearer, so Esc steps through it first.
  it.scopedLive("Esc on an empty idle composer stops an extension's pending stoppable", () =>
    Effect.gen(function* () {
      const [pendingStop, setPendingStop] = createSignal(true)
      let stops = 0
      const extension = defineClientExtension("@test/stoppable", {
        setup: Effect.succeed(
          stoppableContribution({
            id: "probe-pending",
            active: pendingStop,
            stop: () => {
              stops += 1
              setPendingStop(false)
            },
          }),
        ),
      })
      // Its id sorts first, so Esc asks it first: its throw fails it by name,
      // and the press goes on to the next stoppable.
      const throwing = defineClientExtension("@test/a-stoppable-throws", {
        setup: Effect.succeed(
          stoppableContribution({
            id: "probe-throws",
            active: () => Schema.decodeUnknownSync(Schema.Boolean)("active broke"),
            stop: () => {},
          }),
        ),
      })
      const { setup, ext } = yield* mountApp({
        builtins: [...builtinClientModules, throwing, extension],
        initialSession: sessionNamed("session-stop", "branch-stop", "Stop"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·") && ext.loaded(), "loaded")
      const { shutdowns } = yield* countShutdowns(setup)
      // A draft is nearer: the press arms its clear and stops nothing.
      yield* Effect.promise(() => setup.mockInput.typeText("keep me"))
      yield* waitForFrame(setup, (frame) => frame.includes("keep me"), "the draft")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => frame.includes(ESC_CUE), "the clear cue")
      expect(stops).toBe(0)
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !frame.includes("keep me"), "the draft cleared")
      expect(stops).toBe(0)
      // On the empty composer the press stops the pending one.
      setup.mockInput.pressEscape()
      yield* waitUntil(() => stops === 1, "the stoppable stopped")
      // Nothing is pending now, so the next press does nothing.
      setup.mockInput.pressEscape()
      // oxlint-disable-next-line effect/noFixedWaitInTests -- A lone escape byte stays in the stdin parser until its real-clock timeout flushes it as a key; no event marks the flush.
      yield* Effect.sleep("100 millis")
      expect(stops).toBe(1)
      expect(shutdowns()).toBe(0)
      expect(ext.failures().map((failure) => failure.id)).toEqual(["@test/a-stoppable-throws"])
    }).pipe(Effect.timeout("10 seconds")),
  )

  // Esc never quits: on a draft the first press arms and says so, and the
  // second clears the draft.
  it.scopedLive("Esc Esc on a draft clears it and never quits", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("keep me"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("keep me"), "the draft")
      view.setup.mockInput.pressEscape()
      const armed = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes(ESC_CUE),
        "the clear cue",
      )
      expect(armed).toContain("keep me")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(
        view.setup,
        (frame) => !frame.includes("keep me") && !frame.includes(ESC_CUE),
        "the draft cleared",
      )
      // Esc on the empty composer does nothing.
      view.setup.mockInput.pressEscape()
      yield* view.settle
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a keybind between two escapes disarms the clear", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("keep me"))
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => frame.includes(ESC_CUE), "the clear cue")
      view.setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("Commands"), "palette")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("Commands"), "palette closed")
      // The clear is disarmed, so this escape only arms it again.
      view.setup.mockInput.pressEscape()
      const frame = yield* waitForFrame(
        view.setup,
        (next) => next.includes(ESC_CUE),
        "the clear cue again",
      )
      expect(frame).toContain("keep me")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("one ctrl+c on an idle empty composer draws the cue and does not quit", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      expect(view.shutdowns()).toBe(0)
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
    }).pipe(Effect.timeout("10 seconds")),
  )
  for (const [protocol, kittyKeyboard] of [
    ["legacy", false],
    ["kitty", true],
  ] as const) {
    it.scopedLive(`ctrl+c over the palette closes it and arms nothing (${protocol} keys)`, () =>
      Effect.gen(function* () {
        const view = yield* mountIdleSession(createMockRuntime(), { kittyKeyboard })
        view.setup.mockInput.pressKey("p", { ctrl: true })
        yield* waitForFrame(view.setup, (frame) => frame.includes("Commands"), "palette")
        view.setup.mockInput.pressKey("c", { ctrl: true })
        const frame = yield* waitForFrame(
          view.setup,
          (next) => !next.includes("Commands"),
          "palette closed",
        )
        expect(frame).not.toContain(CTRL_C_CUE)
        view.setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(view.setup, (next) => next.includes(CTRL_C_CUE), "the exit cue")
        expect(view.shutdowns()).toBe(0)
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // The name column fits the longest name it shows; the description gives
  // way instead.
  it.scopedLive("the palette keeps command names whole and cuts the description", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { width: 80 })
      view.setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("Commands"), "palette")
      yield* Effect.promise(() => view.setup.mockInput.typeText("ranking"))
      const frame = yield* waitForFrame(
        view.setup,
        (next) => next.includes("› ranking"),
        "the filtered palette",
      )
      expect(frame).toContain("Reset Autocomplete Ranking")
      expect(frame).toContain("Forget which")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ctrl+c on a draft clears it and never quits over it", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("keep me"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("keep me"), "the draft")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      const frame = yield* waitForFrame(
        view.setup,
        (next) => !next.includes("keep me"),
        "the draft cleared",
      )
      expect(frame).not.toContain(CTRL_C_CUE)
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("the exit cue disarms after its window", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      const onClock = createMockRuntime(new Map([[Clock.Clock.key, clock]]))
      const view = yield* mountIdleSession({
        ...createMockRuntime(),
        cast: onClock.cast,
        fork: onClock.fork,
      })
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      yield* clock.adjust(Duration.seconds(5))
      yield* waitForFrame(view.setup, (frame) => !frame.includes(CTRL_C_CUE), "the cue gone")
      // Disarmed: the next press arms again and does not quit.
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes(CTRL_C_CUE), "the cue again")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("the exit cue's window ends with the session view", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      const onClock = createMockRuntime(new Map([[Clock.Clock.key, clock]]))
      // The fibers the ctrl+c press starts; the paused clock keeps a timer open.
      const started: Array<Fiber.Fiber<unknown, unknown>> = []
      let recording = false
      const track = <A, E>(fiber: Fiber.Fiber<A, E>): Fiber.Fiber<A, E> => {
        if (recording) started.push(fiber)
        return fiber
      }
      const view = yield* mountIdleSession({
        ...createMockRuntime(),
        cast: (effect) => {
          track(onClock.fork(effect))
        },
        fork: (effect) => track(onClock.fork(effect)),
      })
      recording = true
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      recording = false
      expect(started.length).toBeGreaterThan(0)
      view.unmount()
      for (const fiber of started) {
        yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("an Esc that leaves shell mode disarms a pending exit", () =>
    Effect.gen(function* () {
      // A paused clock: the arm lasts until a key disarms it.
      const clock = yield* TestClock.make()
      const onClock = createMockRuntime(new Map([[Clock.Clock.key, clock]]))
      const view = yield* mountIdleSession({
        ...createMockRuntime(),
        cast: onClock.cast,
        fork: onClock.fork,
      })
      yield* Effect.promise(() => view.setup.mockInput.typeText("!"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("$"), "shell mode")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(
        view.setup,
        (frame) => !frame.includes(CTRL_C_CUE) && !frame.includes("┃ $"),
        "shell mode left and the cue gone",
      )
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes(CTRL_C_CUE), "armed again")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("Esc on a shell draft arms its clear; Esc on an empty shell draft leaves", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("!ls -la"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("ls -la"), "the shell draft")
      view.setup.mockInput.pressEscape()
      const armed = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes(ESC_CUE),
        "the clear cue",
      )
      expect(armed).toContain("ls -la")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("ls -la"), "the draft cleared")
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("┃ $"), "shell mode left")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The `!` is not in the draft: Backspace leaves shell mode only at the
  // draft's start, where it stands for deleting the `!`. Anywhere else it
  // deletes a character of the command.
  it.scopedLive("Backspace in shell mode edits the command and leaves only at its start", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("!l"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("┃ $ l"), "the shell draft")
      view.setup.mockInput.pressBackspace()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("┃ $ l"), "the l deleted")
      expect(renderFrame(view.setup)).toContain("┃ $")
      yield* Effect.promise(() => view.setup.mockInput.typeText("ls"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("┃ $ ls"), "a second command")
      view.setup.mockInput.pressArrow("left")
      view.setup.mockInput.pressBackspace()
      yield* waitForFrame(view.setup, (frame) => frame.includes("┃ $ s"), "the l deleted")
      view.setup.mockInput.pressBackspace()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("┃ $"), "shell mode left")
      expect(renderFrame(view.setup)).toContain("┃ s")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A `!cmd` has no time limit, so ctrl+c is how the reader ends one. While
  // it runs the activity row names it; the press stops it, sends nothing, and
  // arms no exit.
  it.scopedLive("ctrl+c stops a running !cmd, and its output is not sent", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("!sleep 30"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("┃ $ sleep 30"), "the command")
      view.setup.mockInput.pressEnter()
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("$ sleep 30") && !frame.includes("┃ $ sleep 30"),
        "the activity row names the command",
      )
      view.setup.mockInput.pressKey("c", { ctrl: true })
      const stopped = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("Stopped: $ sleep 30"),
        "the stop notice",
      )
      expect(stopped).not.toContain(CTRL_C_CUE)
      expect(view.sent()).toEqual([])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ctrl+d on an empty composer exits; on a draft it does not", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* Effect.promise(() => view.setup.mockInput.typeText("x"))
      yield* waitForFrame(view.setup, (frame) => frame.includes("┃ x"), "the draft")
      view.setup.mockInput.pressKey("d", { ctrl: true })
      yield* view.settle
      expect(view.shutdowns()).toBe(0)
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => !frame.includes("┃ x"), "the draft cleared")
      view.setup.mockInput.pressKey("d", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The expanded transcript is a layer, as for Esc and ctrl+c: ctrl+d over it
  // does not exit. Once it collapses, ctrl+d on the empty composer does.
  it.scopedLive("ctrl+d over the expanded transcript does not exit", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { kittyKeyboard: true })
      view.setup.mockInput.pressKey("o", { ctrl: true, shift: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("transcript ·"), "transcript")
      view.setup.mockInput.pressKey("d", { ctrl: true })
      yield* view.settle
      expect(view.shutdowns()).toBe(0)
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => frame.includes("ready ·"), "collapsed")
      view.setup.mockInput.pressKey("d", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App status and activity rows", () => {
  // Every hint row spells a key the same way: lowercase key, one verb.
  it.scopedLive("the empty state and the transcript label use the hint spelling", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { kittyKeyboard: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("gent · ctrl+p commands"), "empty")
      view.setup.mockInput.pressKey("o", { ctrl: true, shift: true })
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("transcript · esc close"),
        "transcript",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ctrl+j starts a new line under the kitty keyboard protocol", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { kittyKeyboard: true })
      yield* Effect.promise(() => view.setup.mockInput.typeText("second"))
      view.setup.mockInput.pressKey("j", { ctrl: true })
      yield* Effect.promise(() => view.setup.mockInput.typeText("third"))
      const frame = yield* waitForFrame(
        view.setup,
        (next) => next.includes("third"),
        "the second line",
      )
      expect(frame).not.toContain("secondthird")
      expect(frame).toContain("┃ second")
    }).pipe(Effect.timeout("10 seconds")),
  )
  for (const resumable of [true, false]) {
    it.scopedLive(
      `exit names the way back only when the session outlives the process (${resumable})`,
      () =>
        Effect.gen(function* () {
          const written: string[] = []
          const view = yield* mountIdleSession(createMockRuntime(), {
            resumable,
            writeTerminal: (text) => written.push(text),
          })
          view.setup.mockInput.pressKey("d", { ctrl: true })
          yield* waitForFrame(view.setup, () => view.shutdowns() > 0, "quit")
          // First the cursor goes back up over the cleared split region, so
          // what follows lands right under the transcript.
          const [cursor, ...rest] = written
          expect(cursor).toMatch(new RegExp(`^${String.fromCharCode(27)}\\[[1-9][0-9]*A$`))
          if (resumable) expect(rest).toEqual(["\nto resume: gent resume session-a\n"])
          else expect(rest).toEqual([])
        }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // The session view remounts per identity and the fatal screen has its own
  // exit: an exit from a second view while the first one leaves is the same exit.
  it.scopedLive("two views that exit leave the terminal once", () =>
    Effect.gen(function* () {
      const written: string[] = []
      const exits: Array<() => void> = []
      function ExitProbe() {
        exits.push(useExit())
        return <text>probe</text>
      }
      const setup = yield* renderScoped(
        () => (
          <>
            <ExitProbe />
            <ExitProbe />
          </>
        ),
        { writeTerminal: (text) => written.push(text) },
      )
      const { shutdowns } = yield* countShutdowns(setup)
      expect(exits).toHaveLength(2)
      for (const exit of exits) exit()
      yield* waitUntil(() => written.some((text) => text.includes("to resume")), "the resume hint")
      for (let frame = 0; frame < 3; frame++) yield* Effect.yieldNow
      expect(shutdowns()).toBe(1)
      expect(written.filter((text) => text.includes("to resume"))).toHaveLength(1)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a session cost under a cent reads as the turn row spells it, not as free", () =>
    Effect.gen(function* () {
      const { setup } = yield* mountApp({
        client: {
          session: {
            getSnapshot: () =>
              Effect.succeed({
                sessionId: SessionId.make("session-a"),
                branchId: BranchId.make("branch-a"),
                messages: [],
                lastEventId: nullValue,
                reasoningLevel: absent,
                resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
                agent: AgentName.make("main"),
                runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                metrics: { turns: 1, durationMs: 0, costUsd: 0.002, lastInputTokens: 0 },
              }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      const frame = yield* waitForFrame(setup, (next) => next.includes("$0.0"), "the cost label")
      expect(frame).toContain("$0.002")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("an error shown during a running turn leaves the turn running", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurnWithError
      expect(view.client.isStreaming()).toBe(true)
      expect(view.client.error()).toEqual(Option.some('No model matches "typo"'))
      expect(view.activity()).toBe("working")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a running turn's live line leads with its glyph and shows esc cancel", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      const frame = yield* waitForFrame(view.setup, (next) => next.includes("✻ "), "busy")
      const row = frame.split("\n").find((line) => line.includes("✻ ")) ?? ""
      // Col 2, the glyph, the phase: no answer text has streamed, so the model thinks.
      expect(row.trimEnd()).toMatch(/^ {2}✻ Thinking( \(\d+s\))? · esc cancel$/)
    }).pipe(Effect.timeout("4 seconds")),
  )
  test("a narrow activity row drops the elapsed time first, then cuts the label, and keeps the way out", () => {
    expect(activityLine("Generating", " (12s)", 40)).toBe("Generating (12s) · esc cancel")
    expect(activityLine("Generating", " (12s)", 24)).toBe("Generating · esc cancel")
    expect(activityLine("read(src/very/long/path.ts)", " (3s)", 20)).toBe("read(s… · esc cancel")
  })
  // Two catalogs can share a model name; the row says which provider runs,
  // and bills, the next turn.
  it.scopedLive("the status row names the provider of a model whose name another shares", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-shared-name")
      const branchId = BranchId.make("branch-shared-name")
      const sonnet = (provider: string) =>
        new Model({
          id: ModelId.make(`${provider}/claude-sonnet-5`),
          name: "Claude Sonnet 5",
          provider: ProviderId.make(provider),
        })
      const provider = (id: string, name: string) => ({
        provider: id,
        name,
        hasKey: true,
        required: false,
        source: "stored" satisfies "stored",
        authType: absent,
      })
      const { setup } = yield* mountApp({
        client: {
          auth: {
            listProviders: () =>
              Effect.succeed([
                provider("anthropic", "Anthropic"),
                provider("opencode", "OpenCode"),
              ]),
          },
          model: { list: () => Effect.succeed([sonnet("anthropic"), sonnet("opencode")]) },
          driver: {
            list: () =>
              Effect.succeed({
                drivers: [{ id: "anthropic" }, { id: "opencode" }],
                overrides: {},
                agents: [testAgent],
              }),
          },
          session: {
            getSnapshot: () =>
              Effect.succeed({
                sessionId,
                branchId,
                messages: [],
                lastEventId: nullValue,
                reasoningLevel: absent,
                resolvedModelId: ModelId.make("opencode/claude-sonnet-5"),
                agent: AgentName.make("main"),
                runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
              }),
          },
        },
        width: 120,
        initialSession: sessionNamed(sessionId, branchId, "Shared"),
      })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Claude Sonnet 5 (OpenCode)"),
        "the provider in the status row",
      )
    }).pipe(Effect.timeout("4 seconds")),
  )
  // Gent ships no default model: a session nobody named one for says so, and
  // a send it refuses opens the model picker, with the draft kept.
  it.scopedLive("a session with no model says so, and a refused send opens the model picker", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-no-model")
      const branchId = BranchId.make("branch-no-model")
      const opus = new Model({
        id: ModelId.make("anthropic/claude-opus-5-5"),
        name: "Claude Opus 5.5",
        provider: ProviderId.make("anthropic"),
      })
      const { setup } = yield* mountApp({
        client: {
          model: { list: () => Effect.succeed([opus]) },
          message: { send: () => Effect.fail(noModel) },
          session: {
            updateSettings: () => Effect.succeed({ modelId: opus.id, reasoningLevel: absent }),
            getSnapshot: () =>
              Effect.succeed({
                sessionId,
                branchId,
                messages: [],
                lastEventId: nullValue,
                reasoningLevel: absent,
                agent: AgentName.make("main"),
                runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
              }),
          },
        },
        width: 120,
        initialSession: sessionNamed(sessionId, branchId, "No model"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes(NO_MODEL_LABEL), "the no-model label")
      yield* Effect.promise(() => setup.mockInput.typeText("hello there"))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Model · 1") && next.includes("Claude Opus 5.5"),
        "the model picker",
      )
      expect(frame).toContain("hello there")
      expect(frame).toContain("No model is set")
      // The pick answers the refusal: its hint goes, and the draft stays to send.
      setup.mockInput.pressEnter()
      const picked = yield* waitForFrame(
        setup,
        (next) => !next.includes("Model · 1") && !next.includes("No model is set"),
        "the picker and the hint gone",
      )
      expect(picked).toContain("hello there")
    }).pipe(Effect.timeout("10 seconds")),
  )
  test("a model name no other provider shares stays bare", () => {
    const model = new Model({
      id: ModelId.make("anthropic/claude-opus-5"),
      name: "Claude Opus 5",
      provider: ProviderId.make("anthropic"),
    })
    expect(statusModelName(model, [model], [])).toBe("Claude Opus 5")
  })
  // A virtual model routes each turn: the row names it, the model its newest
  // route chose and that route's effort, and the gauge reads the chosen
  // model's window. A narrow row keeps the pair.
  for (const width of [120, 60]) {
    it.scopedLive(
      `the status row names a virtual model and the model its route chose at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const sessionId = SessionId.make(`session-routed-${width}`)
          const branchId = BranchId.make(`branch-routed-${width}`)
          const auto = new Model({
            id: ModelId.make("router/auto"),
            name: "Auto",
            provider: ProviderId.make("router"),
            kind: "virtual",
          })
          const sonnet = new Model({
            id: ModelId.make("anthropic/claude-sonnet-5"),
            name: "Sonnet 5",
            provider: ProviderId.make("anthropic"),
            contextLength: 1_000_000,
            inputLimit: 100_000,
            outputLimit: 8_000,
          })
          const { setup } = yield* mountApp({
            client: {
              model: { list: () => Effect.succeed([sonnet, auto]) },
              session: {
                getSnapshot: () =>
                  Effect.succeed({
                    sessionId,
                    branchId,
                    messages: [],
                    lastEventId: nullValue,
                    reasoningLevel: absent,
                    resolvedModelId: auto.id,
                    agent: AgentName.make("main"),
                    runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                    metrics: {
                      turns: 1,
                      durationMs: 0,
                      costUsd: 0,
                      lastInputTokens: 50_000,
                      routed: {
                        selected: auto.id,
                        model: sonnet.id,
                        effort: "high",
                        reason: "choice 2: difficult work",
                      },
                    },
                  }),
              },
            },
            width,
            initialSession: sessionNamed(sessionId, branchId, "Routed"),
          })
          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("Auto → Sonnet 5"),
            "the routed model in the status row",
          )
          expect(frame).toContain("high")
          expect(frame).toContain("(50%)")
          // The picker lists the virtual model by its label, beside its id.
          yield* typeCommand("/model")(setup)
          const picker = yield* waitForFrame(
            setup,
            (next) => next.includes("Model ·") && next.includes("router/auto"),
            "the virtual model in the picker",
          )
          expect(
            picker.split("\n").some((row) => row.includes("Auto") && row.includes("router/auto")),
          ).toBe(true)
        }).pipe(Effect.timeout("4 seconds")),
    )
  }
  // The row as a live session draws it: the phase, the cwd, a routed model
  // whose name another provider shares, its effort, the debug mark, and the
  // cache label beside the gauge and the cost. A row too narrow for every
  // label in full takes their short forms by its budget: the debug mark, then
  // the cwd, then the model (no provider label, no family word), then the
  // phase word; a label that fits again in full after a later one shortened
  // gets its full form back.
  const cacheLabel = defineClientExtension("@test/cache-label", {
    setup: Effect.succeed(
      statusLabelContribution({
        anchor: "right",
        produce: () => [{ text: "cache cold", color: "textMuted" as const }],
      }),
    ),
  })
  for (const [width, left, hidden] of [
    [120, "idle · work · Auto → Claude Sonnet 5 (anthropic) · high · debug", []],
    [80, "idle · work · Auto → Sonnet 5 · high · debug", ["Claude", "(anthropic)"]],
    [60, "Auto → Sonnet 5 · high", ["Claude", "(anthropic)", "debug", "idle", "work"]],
  ] as const) {
    it.scopedLive(
      `the status row at ${width} columns takes the short forms its budget needs, the cwd before the model`,
      () =>
        Effect.gen(function* () {
          const sessionId = SessionId.make(`session-routed-shared-${width}`)
          const branchId = BranchId.make(`branch-routed-shared-${width}`)
          const auto = new Model({
            id: ModelId.make("router/auto"),
            name: "Auto",
            provider: ProviderId.make("router"),
            kind: "virtual",
          })
          const sonnet = (provider: string) =>
            new Model({
              id: ModelId.make(`${provider}/claude-sonnet-5`),
              name: "Claude Sonnet 5",
              provider: ProviderId.make(provider),
              contextLength: 1_000_000,
              inputLimit: 100_000,
              outputLimit: 8_000,
            })
          const { setup } = yield* mountApp({
            client: {
              model: {
                list: () => Effect.succeed([sonnet("anthropic"), sonnet("opencode"), auto]),
              },
              session: {
                getSnapshot: () =>
                  Effect.succeed({
                    sessionId,
                    branchId,
                    messages: [],
                    lastEventId: nullValue,
                    reasoningLevel: absent,
                    resolvedModelId: auto.id,
                    agent: AgentName.make("main"),
                    runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                    metrics: {
                      turns: 1,
                      durationMs: 0,
                      costUsd: 0.0004,
                      lastInputTokens: 500,
                      routed: {
                        selected: auto.id,
                        model: ModelId.make("anthropic/claude-sonnet-5"),
                        effort: "high",
                        reason: "choice 2: difficult work",
                      },
                    },
                  }),
              },
            },
            app: { debugMode: true },
            builtins: [...builtinClientModules, cacheLabel],
            cwd: "/work",
            width,
            initialSession: sessionNamed(sessionId, branchId, "Routed shared"),
          })
          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("cache cold") && next.includes("Auto →"),
            "the routed model in the status row",
          )
          const row = Option.getOrThrow(
            Option.fromUndefinedOr(frame.split("\n").find((line) => line.includes("Auto →"))),
          )
          expect(row.trimStart().slice(0, left.length)).toBe(left)
          expect(row).toContain("cache cold")
          for (const text of hidden) expect([text, row.includes(text)]).toEqual([text, false])
        }).pipe(Effect.timeout("4 seconds")),
    )
  }
  // An extension label gives way as a host label does: its short form takes
  // its place by rank on a narrow row, and its full form comes back once the
  // row is wide again.
  const changeLabel = defineClientExtension("@test/change-label", {
    setup: Effect.succeed(
      statusLabelContribution({
        produce: () => [
          {
            text: "changes: 4 files +120 -31",
            color: "textMuted" as const,
            short: { text: "+120 -31", rank: STATUS_YIELD.cwd + 0.5 },
          },
        ],
      }),
    ),
  })
  it.scopedLive(
    "an extension label takes its short form on a narrow row and its full form after a resize",
    () =>
      Effect.gen(function* () {
        const { setup } = yield* mountApp({
          builtins: [changeLabel],
          cwd: "/work",
          width: 120,
          initialSession: sessionNamed("session-short-label", "branch-short-label", "Short"),
        })
        const statusRow = (frame: string) =>
          frame.split("\n").find((line) => line.includes("+120 -31")) ?? ""
        const wide = yield* waitForFrame(setup, (next) => next.includes("changes:"), "full form")
        expect(statusRow(wide)).toContain("changes: 4 files +120 -31")
        setup.resize(32, 24)
        const narrow = yield* waitForFrame(
          setup,
          (next) => !next.includes("changes:") && next.includes("+120 -31"),
          "short form",
        )
        expect(statusRow(narrow)).toContain("+120 -31")
        setup.resize(120, 24)
        const again = yield* waitForFrame(setup, (next) => next.includes("changes:"), "full again")
        expect(statusRow(again)).toContain("changes: 4 files +120 -31")
      }).pipe(Effect.timeout("4 seconds")),
  )
  // A turn runs at the effort of its first step; a level set while it runs
  // takes effect at the next turn. The row names the level the running turn
  // runs at until the turn completes, then the session's.
  it.scopedLive(
    "the status row keeps the running turn's effort until the turn completes, then shows the new one",
    () =>
      Effect.gen(function* () {
        const reasoner = new Model({
          id: ModelId.make("effort-test/thinker"),
          name: "Thinker 1",
          provider: ProviderId.make("effort-test"),
          contextLength: 200_000,
          reasoning: true,
          efforts: ["low", "medium", "high"],
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal("The answer.")
        const harness = yield* createRpcHarness({
          providerLayer,
          agents: [AgentDefinition.make({ name: DEFAULT_AGENT_NAME, model: reasoner.id })],
          extensionInputs: [],
          models: [reasoner],
        })
        // The held reply ends before the server closes, whether the test passes or not.
        yield* Effect.addFinalizer(() => controls.emitAll)
        let ctx = Option.none<ClientContextValue>()
        const setup = yield* renderScoped(
          () => (
            <>
              <App />
              <ClientProbe onReady={(value) => (ctx = Option.some(value))} />
            </>
          ),
          {
            client: harness.client,
            runtime: createMockRuntime(),
            width: 100,
            initialSession: sessionNamed(harness.sessionId, harness.branchId, "Effort"),
          },
        )
        const client = yield* requireClient(ctx)
        // What the server published, in order: the test reads when the turn ends.
        const published = yield* Ref.make<ReadonlyArray<string>>([])
        yield* harness.client.session
          .events({ sessionId: harness.sessionId, branchId: harness.branchId })
          .pipe(
            Stream.runForEach(({ event }) => Ref.update(published, (all) => [...all, event._tag])),
            Effect.forkScoped,
          )
        const completed = Effect.map(Ref.get(published), (all) => all.includes("TurnCompleted"))
        // The row names the session's directory, the harness's temporary one.
        const statusRow = (frame: string) =>
          frame.split("\n").find((line) => line.includes("gent-test-cwd-")) ?? ""
        yield* typeCommand("/effort low")(setup)
        yield* waitForFrame(setup, (frame) => statusRow(frame).includes("· low"), "low set")
        yield* Effect.promise(() => setup.mockInput.typeText("think"))
        setup.mockInput.pressEnter()
        yield* controls.waitForStreamStart.pipe(Effect.timeout("3 seconds"))
        yield* typeCommand("/effort high")(setup)
        yield* waitUntil(
          () => Option.contains(client.reasoningLevel(), "high"),
          "the session's level is high",
        )
        // The reply streams its text and holds its end: the turn still runs.
        yield* controls.emitNext
        const during = yield* waitForFrame(
          setup,
          (frame) => frame.includes("The answer.") && statusRow(frame).length > 0,
          "the reply's text during the turn",
        )
        expect(yield* completed).toBe(false)
        expect(statusRow(during)).toContain("· low")
        expect(statusRow(during)).not.toContain("high")
        yield* controls.emitAll
        yield* waitFor(completed, (done) => done, 3_000, "the turn completed")
        const after = yield* waitForFrame(
          setup,
          (frame) => statusRow(frame).includes("· high"),
          "the new level after the turn",
        )
        expect(statusRow(after)).not.toContain("low")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
  // Under a virtual model the effort picker reads the routed model: its
  // levels, and a default row that names the route's level, which the turn
  // asks for before the agent's, clamped to what the routed model takes.
  it.scopedLive("the effort picker under a virtual model lists the routed model's levels", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-routed-effort")
      const branchId = BranchId.make("branch-routed-effort")
      const auto = new Model({
        id: ModelId.make("router/auto"),
        name: "Auto",
        provider: ProviderId.make("router"),
        kind: "virtual",
      })
      const sonnet = new Model({
        id: ModelId.make("anthropic/claude-sonnet-5"),
        name: "Sonnet 5",
        provider: ProviderId.make("anthropic"),
        reasoning: true,
        efforts: ["low", "medium", "high"],
      })
      const { setup } = yield* mountApp({
        client: {
          model: { list: () => Effect.succeed([sonnet, auto]) },
          session: {
            getSnapshot: () =>
              Effect.succeed({
                sessionId,
                branchId,
                messages: [],
                lastEventId: nullValue,
                reasoningLevel: absent,
                defaultReasoningLevel: "medium",
                resolvedModelId: auto.id,
                agent: AgentName.make("main"),
                runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                metrics: {
                  turns: 1,
                  durationMs: 0,
                  costUsd: 0,
                  lastInputTokens: 0,
                  routed: {
                    selected: auto.id,
                    model: sonnet.id,
                    effort: "max",
                    reason: "choice 2: difficult work",
                  },
                },
              }),
          },
        },
        width: 120,
        initialSession: sessionNamed(sessionId, branchId, "Routed effort"),
      })
      // The row shows what the routed model is sent for the route's `max`.
      yield* waitForFrame(setup, (next) => next.includes("Auto → Sonnet 5 · high"), "the row")
      yield* typeCommand("/effort")(setup)
      const picker = yield* waitForFrame(
        setup,
        (next) => next.includes("Effort · 5"),
        "the effort picker",
      )
      expect(picker).toContain("the route's choice (max, sends high)")
      expect(picker).not.toContain("minimal")
    }).pipe(Effect.timeout("4 seconds")),
  )
  // The route belongs to the virtual model: once the session leaves it, the
  // row names the concrete model alone.
  it.scopedLive("a route of a virtual model the session left is not named", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-left-router")
      const branchId = BranchId.make("branch-left-router")
      const opus = new Model({
        id: ModelId.make("anthropic/claude-opus-5"),
        name: "Opus 5",
        provider: ProviderId.make("anthropic"),
      })
      const sonnet = new Model({
        id: ModelId.make("anthropic/claude-sonnet-5"),
        name: "Sonnet 5",
        provider: ProviderId.make("anthropic"),
      })
      const { setup } = yield* mountApp({
        client: {
          model: { list: () => Effect.succeed([opus, sonnet]) },
          session: {
            getSnapshot: () =>
              Effect.succeed({
                sessionId,
                branchId,
                messages: [],
                lastEventId: nullValue,
                reasoningLevel: absent,
                resolvedModelId: opus.id,
                agent: AgentName.make("main"),
                runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                metrics: {
                  turns: 1,
                  durationMs: 0,
                  costUsd: 0,
                  lastInputTokens: 0,
                  routed: {
                    selected: ModelId.make("router/auto"),
                    model: sonnet.id,
                    reason: "choice 1",
                  },
                },
              }),
          },
        },
        width: 120,
        initialSession: sessionNamed(sessionId, branchId, "Left"),
      })
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Opus 5"),
        "the concrete model in the status row",
      )
      expect(frame).not.toContain("→ Sonnet 5")
    }).pipe(Effect.timeout("4 seconds")),
  )
  // `/effort auto`: the row names auto and the level its newest effort route
  // picked, clamped as the request was sent; a narrow row keeps both.
  for (const [width, left] of [
    [120, "idle · work · Claude Opus 5 · auto → high · debug"],
    [60, "Opus 5 · auto → high"],
  ] as const) {
    it.scopedLive(
      `the status row on /effort auto names auto and its routed level at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const sessionId = SessionId.make(`session-effort-auto-${width}`)
          const branchId = BranchId.make(`branch-effort-auto-${width}`)
          const opus = new Model({
            id: ModelId.make("anthropic/claude-opus-5"),
            name: "Claude Opus 5",
            provider: ProviderId.make("anthropic"),
            contextLength: 1_000_000,
            reasoning: true,
            efforts: ["low", "medium", "high", "xhigh", "max"],
          })
          const cacheLabel = defineClientExtension("@test/auto-cache-label", {
            setup: Effect.succeed(
              statusLabelContribution({
                anchor: "right",
                produce: () => [{ text: "cache cold", color: "textMuted" as const }],
              }),
            ),
          })
          const { setup } = yield* mountApp({
            client: {
              model: { list: () => Effect.succeed([opus]) },
              session: {
                getSnapshot: () =>
                  Effect.succeed({
                    sessionId,
                    branchId,
                    messages: [],
                    lastEventId: nullValue,
                    reasoningLevel: absent,
                    reasoningAuto: true,
                    defaultReasoningLevel: "medium",
                    resolvedModelId: opus.id,
                    agent: AgentName.make("main"),
                    runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                    metrics: {
                      turns: 1,
                      durationMs: 0,
                      costUsd: 0.0004,
                      lastInputTokens: 500,
                      effortRouted: { model: opus.id, effort: "high", reason: "hard work (0.90)" },
                    },
                  }),
              },
            },
            app: { debugMode: true },
            builtins: [...builtinClientModules, cacheLabel],
            cwd: "/work",
            width,
            initialSession: sessionNamed(sessionId, branchId, "Effort auto"),
          })
          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("cache cold") && next.includes("auto"),
            "auto in the status row",
          )
          const row = Option.getOrThrow(
            Option.fromUndefinedOr(frame.split("\n").find((line) => line.includes("cache cold"))),
          )
          expect(row.trimStart().slice(0, left.length)).toBe(left)
          // The effort picker marks `auto` as the session's.
          yield* typeCommand("/effort")(setup)
          const picker = yield* waitForFrame(setup, (next) => next.includes("Effort ·"), "picker")
          expect(picker).toContain("● auto")
        }).pipe(Effect.timeout("4 seconds")),
    )
  }
  it.scopedLive(
    "with no classifier signed in, the effort picker's auto row says routes fall back",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-effort-fallback")
        const branchId = BranchId.make("branch-effort-fallback")
        const opus = new Model({
          id: ModelId.make("anthropic/claude-opus-5"),
          name: "Claude Opus 5",
          provider: ProviderId.make("anthropic"),
          contextLength: 1_000_000,
          reasoning: true,
          efforts: ["low", "medium", "high", "xhigh", "max"],
        })
        const { setup } = yield* mountApp({
          client: {
            model: { list: () => Effect.succeed([opus]) },
            session: {
              getSnapshot: () =>
                Effect.succeed({
                  sessionId,
                  branchId,
                  messages: [],
                  lastEventId: nullValue,
                  reasoningLevel: absent,
                  reasoningAuto: true,
                  defaultReasoningLevel: "medium",
                  resolvedModelId: opus.id,
                  agent: AgentName.make("main"),
                  runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                  metrics: {
                    turns: 1,
                    durationMs: 0,
                    costUsd: 0,
                    lastInputTokens: 500,
                    effortRouted: {
                      model: opus.id,
                      effort: "high",
                      reason: "no classifier model has a credential",
                      fallback: true,
                    },
                  },
                }),
            },
          },
          app: { debugMode: true },
          cwd: "/work",
          width: 120,
          initialSession: sessionNamed(sessionId, branchId, "Effort fallback"),
        })
        yield* waitForFrame(setup, (next) => next.includes("auto"), "auto in the status row")
        yield* typeCommand("/effort")(setup)
        const picker = yield* waitForFrame(setup, (next) => next.includes("Effort ·"), "picker")
        expect(picker).toContain("routes fall back: no classifier model has a credential")
      }).pipe(Effect.timeout("4 seconds")),
  )
  // The whole path on a server: `/effort auto` stores auto, a turn asks the
  // effort router, the row names its pick, and `/effort high` leaves auto.
  for (const width of [120, 60]) {
    it.scopedLive(
      `/effort auto names the level the router picked after a turn, and /effort high leaves auto, at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const thinker = new Model({
            id: ModelId.make("effort-test/thinker"),
            name: "Thinker 1",
            provider: ProviderId.make("effort-test"),
            contextLength: 200_000,
            reasoning: true,
            efforts: ["low", "medium", "high"],
          })
          const effortRouter = defineExtension({
            id: "test-effort-router",
            setup: Effect.gen(function* () {
              yield* (yield* ExtensionHost).register("modelRouter", {
                id: "router",
                name: "Test router",
                models: [],
                effort: {
                  name: "effort",
                  label: "Effort",
                  choices: [
                    { effort: "low", reason: "quick" },
                    { effort: "high", reason: "hard" },
                  ],
                  fallback: 1,
                },
                route: () => Effect.succeed({ choice: 0, reason: "quick" }),
              })
            }),
          })
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("The answer."),
          ])
          const harness = yield* createRpcHarness({
            providerLayer,
            agents: [AgentDefinition.make({ name: DEFAULT_AGENT_NAME, model: thinker.id })],
            extensionInputs: [effortRouter],
            models: [thinker],
          })
          const setup = yield* renderScoped(() => <App />, {
            client: harness.client,
            runtime: createMockRuntime(),
            width,
            initialSession: sessionNamed(harness.sessionId, harness.branchId, "Effort auto"),
          })
          // The row that names the harness cwd (the client lists no model of a
          // provider it has no sign-in for).
          const statusRow = (frame: string) =>
            Option.getOrElse(
              Option.fromUndefinedOr(
                frame.split("\n").find((line) => line.includes("gent-test-cwd")),
              ),
              () => "",
            )
          yield* typeCommand("/effort auto")(setup)
          yield* waitForFrame(
            setup,
            (frame) => statusRow(frame).includes("auto"),
            "auto before a route",
          )
          yield* Effect.promise(() => setup.mockInput.typeText("think"))
          setup.mockInput.pressEnter()
          const routed = yield* waitForFrame(
            setup,
            (frame) => frame.includes("The answer.") && statusRow(frame).includes("auto → low"),
            "the routed level after the turn",
          )
          expect(statusRow(routed)).not.toContain("high")
          yield* typeCommand("/effort high")(setup)
          const left = yield* waitForFrame(
            setup,
            (frame) => statusRow(frame).includes("high"),
            "the level set by hand",
          )
          expect(statusRow(left)).not.toContain("auto")
        }).pipe(Effect.timeout("10 seconds")),
      15_000,
    )
  }
})

describe("App drafts, queue restore and forks across session switches", () => {
  // Every state shows its way out: a running turn names the key that stops it.
  // The tray's hint names alt+up; the key it names takes the queue back.
  it.scopedLive("alt+up takes the queued follow-up back into the draft", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressArrow("up", { meta: true })
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("the queued follow-up"),
        "the restored draft",
      )
    }).pipe(Effect.timeout("4 seconds")),
  )
  // The reader sends in A and moves to B before A's server answers. The
  // refusal belongs to A: B shows none of it, and A has both on return.
  for (const [outcome, superseded] of [
    ["clears its reason", false],
    ["keeps a newer error", true],
  ] as const) {
    it.scopedLive(
      `a send refused after a switch restores its draft and ${outcome} when edited`,
      () =>
        Effect.gen(function* () {
          const sentOut = yield* Deferred.make<void>()
          const answer = yield* Deferred.make<void>()
          const answered = yield* Deferred.make<void>()
          const view = yield* mountSessionPair({
            message: {
              send: () =>
                Deferred.complete(sentOut, Effect.void).pipe(
                  Effect.andThen(Deferred.await(answer)),
                  Effect.andThen(Effect.fail(refusedInA)),
                  Effect.ensuring(Deferred.complete(answered, Effect.void)),
                ),
            },
          })
          const { setup, client } = view
          yield* Effect.promise(() => setup.mockInput.typeText("keep me in A"))
          yield* Effect.promise(() => setup.renderOnce())
          setup.mockInput.pressEnter()
          yield* Deferred.await(sentOut)
          yield* view.switchTo(pairB, "Session B")
          yield* Deferred.complete(answer, Effect.void)
          yield* Deferred.await(answered)
          yield* view.settle
          const inB = renderFrame(setup)
          expect(inB).not.toContain("send refused in A")
          expect(inB).not.toContain("keep me in A")
          expect(client.error()).toEqual(Option.none())
          client.switchSession(pairA.sessionId, pairA.branchId, "Session A")
          yield* waitForFrame(setup, (frame) => frame.includes("keep me in A"), "draft back in A")
          yield* waitForFrame(setup, (frame) => frame.includes("send refused in A"), "reason in A")
          if (superseded) {
            client.setErrorIn(pairA, "a newer server error")
            yield* waitForFrame(
              setup,
              (frame) => frame.includes("a newer server error"),
              "newer error",
            )
          }
          setup.mockInput.pressKey("u", { ctrl: true })
          yield* waitForFrame(
            setup,
            (frame) => !frame.includes("keep me in A") && !frame.includes("send refused in A"),
            "the returned draft and its refusal gone",
          )
          if (superseded) expect(renderFrame(setup)).toContain("a newer server error")
        }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // A fork answers late. Its branch stays, but the reader's later choice of
  // where to be wins: the fork is not shown, and no switch names another view.
  // With no move, the switch names the branch forked from.
  for (const [moveTo, title] of [
    [Option.none(), "a fork that answers with no move since shows the fork"],
    [Option.some(pairB), "a fork that answers after a move to another session does not take it"],
    [
      Option.some({ sessionId: pairA.sessionId, branchId: BranchId.make("branch-a2") }),
      "a fork that answers after a move to another branch does not take it",
    ],
  ] as const) {
    it.scopedLive(title, () =>
      Effect.gen(function* () {
        const forkAsked = yield* Deferred.make<void>()
        const answer = yield* Deferred.make<void>()
        const answered = yield* Deferred.make<void>()
        interface SwitchAsked {
          readonly sessionId: SessionId
          readonly fromBranchId: BranchId
          readonly toBranchId: BranchId
        }
        const switches: Array<SwitchAsked> = []
        const view = yield* mountSessionPair({
          message: {
            list: () =>
              Effect.succeed([
                StoredMessage.cases.regular.make({
                  id: MessageId.make("fork-here"),
                  sessionId: pairA.sessionId,
                  branchId: pairA.branchId,
                  role: "user",
                  parts: [Prompt.textPart({ text: "fork from this" })],
                  createdAt: dateFromMillis(1),
                }),
              ]),
          },
          branch: {
            fork: () =>
              Deferred.complete(forkAsked, Effect.void).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.as({ branchId: BranchId.make("branch-forked") }),
                Effect.ensuring(Deferred.complete(answered, Effect.void)),
              ),
            switch: (input: SwitchAsked) =>
              Effect.sync(() => {
                const { sessionId, fromBranchId, toBranchId } = input
                switches.push({ sessionId, fromBranchId, toBranchId })
              }),
          },
        })
        yield* Effect.promise(() => view.setup.mockInput.typeText("/fork"))
        view.setup.mockInput.pressEnter()
        yield* waitForFrame(
          view.setup,
          (frame) => frame.includes("Fork from message"),
          "the fork pane",
        )
        view.setup.mockInput.pressEnter()
        yield* Deferred.await(forkAsked)
        if (Option.isSome(moveTo)) yield* view.switchTo(moveTo.value, "Moved")
        yield* Deferred.complete(answer, Effect.void)
        yield* Deferred.await(answered)
        yield* view.settle
        if (Option.isSome(moveTo)) {
          expect(switches).toEqual([])
          expect(view.client.sessionIdentity()).toEqual(moveTo.value)
        } else {
          yield* waitForFrame(view.setup, () => switches.length === 1, "the switch to the fork")
          expect(switches).toEqual([
            {
              sessionId: pairA.sessionId,
              fromBranchId: pairA.branchId,
              toBranchId: BranchId.make("branch-forked"),
            },
          ])
        }
        expect(view.client.error()).toEqual(Option.none())
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // A session's catalog loads again when the reader returns to it. Until it
  // settles, the session has no models yet, which is not the same as none:
  // the picker says it is loading, and `/model <query>` says so too.
  for (const [surface, typed, expected] of [
    ["picker", "/model", "Loading the session's models"],
    ["slash command", "/model sonnet", "Models are still loading"],
  ] as const) {
    it.scopedLive(`the ${surface} on a returning session's loading catalog says it loads`, () =>
      Effect.gen(function* () {
        const reload = yield* Deferred.make<void>()
        let readsOfA = 0
        const view = yield* mountSessionPair({
          model: {
            list: (input: { readonly sessionId: SessionId }) =>
              Effect.suspend(() => {
                const sonnet = Model.make({
                  id: ModelId.make("anthropic/sonnet"),
                  name: "Sonnet",
                  provider: ProviderId.make("anthropic"),
                })
                if (input.sessionId !== pairA.sessionId) return Effect.succeed([sonnet])
                readsOfA += 1
                if (readsOfA === 1) return Effect.succeed([sonnet])
                return Deferred.await(reload).pipe(Effect.as([sonnet]))
              }),
          },
          driver: {
            list: () =>
              Effect.succeed({
                drivers: [{ id: "anthropic" }],
                overrides: {},
                agents: [testAgent],
              }),
          },
        })
        yield* waitForFrame(view.setup, () => view.client.models().length === 1, "A's catalog")
        yield* view.switchTo(pairB, "Session B")
        yield* view.switchTo(pairA, "Session A")
        yield* waitForFrame(view.setup, () => readsOfA === 2, "A's catalog read again")
        yield* typeCommand(typed)(view.setup)
        const frame = yield* waitForFrame(
          view.setup,
          (next) => next.includes(expected),
          "the loading note",
        )
        expect(frame).not.toContain("No model matches")
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // Two forks out at once: the one asked for last is the reader's choice,
  // whichever answers first.
  for (const order of [
    ["older", "newer"],
    ["newer", "older"],
  ] as const) {
    it.scopedLive(`of two forks the newer is shown when the ${order[0]} answers first`, () =>
      Effect.gen(function* () {
        const asked = { older: yield* Deferred.make<void>(), newer: yield* Deferred.make<void>() }
        const answer = { older: yield* Deferred.make<void>(), newer: yield* Deferred.make<void>() }
        const answered = {
          older: yield* Deferred.make<void>(),
          newer: yield* Deferred.make<void>(),
        }
        const switched: Array<BranchId> = []
        let forks = 0
        const view = yield* mountSessionPair({
          message: {
            list: () =>
              Effect.succeed([
                StoredMessage.cases.regular.make({
                  id: MessageId.make("fork-here"),
                  sessionId: pairA.sessionId,
                  branchId: pairA.branchId,
                  role: "user",
                  parts: [Prompt.textPart({ text: "fork from this" })],
                  createdAt: dateFromMillis(1),
                }),
              ]),
          },
          branch: {
            fork: () =>
              Effect.suspend(() => {
                forks += 1
                let which: "older" | "newer" = "newer"
                if (forks === 1) which = "older"
                return Deferred.complete(asked[which], Effect.void).pipe(
                  Effect.andThen(Deferred.await(answer[which])),
                  Effect.as({ branchId: BranchId.make(`branch-${which}`) }),
                  Effect.ensuring(Deferred.complete(answered[which], Effect.void)),
                )
              }),
            switch: (input: { readonly toBranchId: BranchId }) =>
              Effect.sync(() => {
                switched.push(input.toBranchId)
              }),
          },
        })
        const forkFromPane = Effect.gen(function* () {
          yield* Effect.promise(() => view.setup.mockInput.typeText("/fork"))
          view.setup.mockInput.pressEnter()
          yield* waitForFrame(
            view.setup,
            (frame) => frame.includes("Fork from message"),
            "the fork pane",
          )
          view.setup.mockInput.pressEnter()
        })
        yield* forkFromPane
        yield* Deferred.await(asked.older)
        yield* forkFromPane
        yield* Deferred.await(asked.newer)
        for (const which of order) {
          yield* Deferred.complete(answer[which], Effect.void)
          yield* Deferred.await(answered[which])
          yield* view.settle
        }
        yield* waitForFrame(view.setup, () => switched.length > 0, "a switch")
        expect(switched).toEqual([BranchId.make("branch-newer")])
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // The drain commits on the server before it answers: the text it took
  // belongs to A's draft, even when A's view is gone by then.
  it.scopedLive("a queue taken back after a switch lands in its own session's draft", () =>
    Effect.gen(function* () {
      const drainAsked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const drained: Array<SessionId> = []
      const view = yield* mountSessionPair({
        queue: {
          drain: (input: { readonly sessionId: SessionId }) =>
            Deferred.complete(drainAsked, Effect.void).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.andThen(
                Effect.sync(() => {
                  drained.push(input.sessionId)
                  return {
                    steering: [],
                    followUp: [
                      {
                        _tag: "FollowUp" satisfies "FollowUp",
                        id: MessageId.make("queued-in-a"),
                        content: "queued in A",
                        createdAt: 0,
                      },
                    ],
                  }
                }),
              ),
              Effect.ensuring(Deferred.complete(answered, Effect.void)),
            ),
        },
      })
      view.setup.mockInput.pressArrow("up", { meta: true })
      yield* Deferred.await(drainAsked)
      yield* view.switchTo(pairB, "Session B")
      yield* Deferred.complete(answer, Effect.void)
      yield* Deferred.await(answered)
      yield* view.settle
      expect(drained).toEqual([pairA.sessionId])
      expect(renderFrame(view.setup)).not.toContain("queued in A")
      expect(view.client.error()).toEqual(Option.none())
      yield* view.switchTo(pairA, "Session A")
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("queued in A"),
        "the queued text back in A's draft",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Text the reader typed is never lost to a restore: the queued text goes
  // ahead of the draft, as a refused send does. The draft can change while
  // the drain is out, in the composer on screen or in a kept draft.
  for (const [where, title] of [
    ["now", "alt+up keeps the draft and puts the queued text ahead of it"],
    ["waiting", "text typed while the drain is out stays behind the queued text"],
    ["returned", "a kept draft edited after a return stays behind the queued text"],
  ] as const) {
    it.scopedLive(title, () =>
      Effect.gen(function* () {
        const drain = yield* gatedDrain("queued in A")
        const view = yield* mountSessionPair({ queue: { drain: drain.drain } })
        const typeIn = (text: string) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => view.setup.mockInput.typeText(text))
            yield* waitForFrame(view.setup, (frame) => frame.includes(text), text)
          })
        if (where === "now") yield* typeIn("my own draft")
        view.setup.mockInput.pressArrow("up", { meta: true })
        yield* Deferred.await(drain.asked)
        if (where === "waiting") yield* typeIn("my own draft")
        if (where === "returned") {
          yield* view.switchTo(pairB, "Session B")
          yield* view.switchTo(pairA, "Session A")
          yield* typeIn("my own draft")
        }
        yield* Deferred.complete(drain.answer, Effect.void)
        const frame = yield* waitForFrame(
          view.setup,
          (next) => next.includes("queued in A") && next.includes("my own draft"),
          "the queued text and the draft",
        )
        expect(frame.indexOf("queued in A")).toBeLessThan(frame.indexOf("my own draft"))
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // A send whose replies were lost comes back to the draft, but the server
  // may have queued it. Taking the queue back then gives the text once, as
  // the reader wrote it (the server holds its `@file` expanded), and the next
  // send is new: the old request id names the send the drain took.
  it.scopedLive(
    "a lost `@file` send the server queued comes back once when the queue is taken back",
    () =>
      Effect.gen(function* () {
        const sends: Array<{ readonly content: string; readonly requestId: string }> = []
        const drained = yield* Deferred.make<void>()
        const view = yield* mountSessionPair({
          message: {
            send: (input: { readonly content: string; readonly requestId: string }) =>
              Effect.suspend(() => {
                sends.push({ content: input.content, requestId: input.requestId })
                // The first send and its four retries: queued, reply lost.
                if (sends.length <= 5) {
                  return Effect.fail(
                    new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
                  )
                }
                return Effect.void
              }),
          },
          queue: {
            // The server queued the first send under its request id.
            drain: () =>
              Effect.sync(() => ({
                steering: [],
                followUp: [
                  {
                    _tag: "FollowUp" satisfies "FollowUp",
                    id: userMessageIdForRequest(sends[0]?.requestId ?? "none"),
                    content: sends[0]?.content ?? "",
                    createdAt: 0,
                  },
                ],
              })).pipe(Effect.ensuring(Deferred.complete(drained, Effect.void))),
          },
        })
        const draft = "resend @package.json"
        yield* Effect.promise(() => view.setup.mockInput.typeText(draft))
        yield* Effect.promise(() => view.setup.renderOnce())
        view.setup.mockInput.pressEnter()
        yield* waitForFrame(
          view.setup,
          (frame) => sends.length === 5 && frame.includes(`┃ ${draft}`),
          "the lost send back in the draft",
          8_000,
        )
        expect(sends[0]?.content).not.toBe(draft)
        view.setup.mockInput.pressArrow("up", { meta: true })
        yield* Deferred.await(drained)
        yield* view.settle
        expect(renderFrame(view.setup).split("resend").length - 1).toBe(1)
        view.setup.mockInput.pressEnter()
        yield* waitForFrame(view.setup, () => sends.length === 6, "sent again")
        expect(sends[5]?.content).toBe(sends[0]?.content)
        expect(sends[5]?.requestId).not.toBe(sends[0]?.requestId)
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
  // Refused sends come back in send order at the draft's start. Queue text
  // taken back between two refusals goes after them, not between them.
  it.scopedLive("queue text taken back between two refusals goes after both", () =>
    Effect.gen(function* () {
      const asked = { earlier: yield* Deferred.make<void>(), later: yield* Deferred.make<void>() }
      const answer = { earlier: yield* Deferred.make<void>(), later: yield* Deferred.make<void>() }
      const answered = {
        earlier: yield* Deferred.make<void>(),
        later: yield* Deferred.make<void>(),
      }
      const drain = yield* gatedDrain("queued text")
      const drained = yield* Deferred.make<void>()
      const gate = (which: "earlier" | "later") =>
        Deferred.complete(asked[which], Effect.void).pipe(
          Effect.andThen(Deferred.await(answer[which])),
          Effect.andThen(Effect.fail(refusedInA)),
          Effect.ensuring(Deferred.complete(answered[which], Effect.void)),
        )
      const view = yield* mountSessionPair({
        message: {
          send: (input: { readonly content: string }) => {
            if (input.content === "earlier send") return gate("earlier")
            return gate("later")
          },
        },
        queue: {
          drain: () => drain.drain().pipe(Effect.ensuring(Deferred.complete(drained, Effect.void))),
        },
      })
      const send = (text: string) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => view.setup.mockInput.typeText(text))
          yield* Effect.promise(() => view.setup.renderOnce())
          view.setup.mockInput.pressEnter()
        })
      yield* send("earlier send")
      yield* Deferred.await(asked.earlier)
      yield* send("later send")
      yield* Deferred.await(asked.later)
      view.setup.mockInput.pressArrow("up", { meta: true })
      yield* Deferred.await(drain.asked)
      yield* Deferred.complete(answer.earlier, Effect.void)
      yield* Deferred.await(answered.earlier)
      yield* waitForFrame(view.setup, (frame) => frame.includes("earlier send"), "earlier back")
      yield* Deferred.complete(drain.answer, Effect.void)
      yield* Deferred.await(drained)
      yield* waitForFrame(view.setup, (frame) => frame.includes("queued text"), "queue back")
      yield* Deferred.complete(answer.later, Effect.void)
      yield* Deferred.await(answered.later)
      const frame = yield* waitForFrame(
        view.setup,
        (next) => next.includes("later send"),
        "later back",
      )
      const at = (text: string) => frame.indexOf(text)
      expect(at("earlier send")).toBeLessThan(at("later send"))
      expect(at("later send")).toBeLessThan(at("queued text"))
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A refused paste-sized message comes back as a placeholder; the kept
  // draft holds its text once the view leaves. A refusal that lands after a
  // return still joins the block in send order.
  it.scopedLive("a refusal after a switch joins a refused paste in send order", () =>
    Effect.gen(function* () {
      const large = "LARGE one\nline two\nline three"
      const asked = { large: yield* Deferred.make<void>(), small: yield* Deferred.make<void>() }
      const answer = { large: yield* Deferred.make<void>(), small: yield* Deferred.make<void>() }
      const gate = (which: "large" | "small") =>
        Deferred.complete(asked[which], Effect.void).pipe(
          Effect.andThen(Deferred.await(answer[which])),
          Effect.andThen(Effect.fail(refusedInA)),
        )
      const view = yield* mountSessionPair({
        message: {
          send: (input: { readonly content: string }) => {
            if (input.content.startsWith("LARGE")) return gate("large")
            return gate("small")
          },
        },
      })
      yield* Effect.promise(() => view.setup.mockInput.pasteBracketedText(large))
      yield* waitForFrame(view.setup, (frame) => frame.includes("[Pasted"), "the paste chip")
      view.setup.mockInput.pressEnter()
      yield* Deferred.await(asked.large)
      yield* Effect.promise(() => view.setup.mockInput.typeText("second send"))
      yield* Effect.promise(() => view.setup.renderOnce())
      view.setup.mockInput.pressEnter()
      yield* Deferred.await(asked.small)
      yield* Deferred.complete(answer.large, Effect.void)
      yield* waitForFrame(view.setup, (frame) => frame.includes("[Pasted"), "the refused paste")
      yield* view.switchTo(pairB, "Session B")
      yield* view.switchTo(pairA, "Session A")
      yield* waitForFrame(view.setup, (frame) => frame.includes("LARGE one"), "the kept text")
      yield* Deferred.complete(answer.small, Effect.void)
      yield* waitForFrame(view.setup, (frame) => frame.includes("second send"), "the later refusal")
      // The earlier text comes first, as itself or written again as a placeholder.
      const frame = renderFrame(view.setup)
      const first = Math.max(frame.indexOf("LARGE one"), frame.indexOf("[Pasted"))
      expect(first).toBeGreaterThanOrEqual(0)
      expect(first).toBeLessThan(frame.indexOf("second send"))
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("no reply asked for in the session the reader left draws in the next one", () =>
    Effect.gen(function* () {
      // The session-keyed reads answer per session, so a reply for A that
      // lands in B shows: A's catalog names the model its own way and A's
      // health fails an extension.
      const sonnetNamed = (name: string) =>
        new Model({
          id: ModelId.make("anthropic/claude-sonnet-5"),
          name,
          provider: ProviderId.make("anthropic"),
        })
      const ofA = <A,>(sessionId: SessionId, inA: A, elsewhere: A) =>
        Option.getOrElse(
          Option.map(
            Option.liftPredicate(sessionId, (id) => id === pairA.sessionId),
            () => inA,
          ),
          () => elsewhere,
        )
      const perSession = {
        model: {
          list: (input: { readonly sessionId: SessionId }) =>
            Effect.succeed([sonnetNamed(ofA(input.sessionId, "Sonnet of A", "Claude Sonnet 5"))]),
        },
        extension: {
          listStatus: (input: { readonly scope: { readonly id: SessionId } }) =>
            Effect.succeed(
              ofA(input.scope.id, scheduledFailureHealth("@a/only", "failed in A"), healthyHealth),
            ),
        },
      }
      const sessionB = (view: TestSetup) =>
        waitForFrame(
          view,
          (frame) => frame.includes("ready ·") && frame.includes("Claude Sonnet 5"),
          "session B",
        )
      const mountOnA = (replies?: Parameters<typeof createMockClient>[1]) =>
        mountApp({
          client: perSession,
          replies,
          width: 120,
          // No repository: the status row reads no git branch, which lands on its own time.
          cwd: "/nonexistent/gent-test-cwd",
          initialSession: sessionNamed(pairA.sessionId, pairA.branchId, "Session A"),
        })
      const settle = (setup: TestSetup) =>
        Effect.gen(function* () {
          for (let frame = 0; frame < 5; frame++) {
            yield* Effect.yieldNow
            yield* Effect.promise(() => setup.renderOnce())
          }
        })

      // Control: A answers, then the reader moves to B.
      const control = yield* mountOnA()
      yield* waitForFrame(control.setup, (frame) => frame.includes("Sonnet of A"), "session A")
      control.client.switchSession(pairB.sessionId, pairB.branchId, "Session B")
      yield* sessionB(control.setup)
      yield* settle(control.setup)
      const expected = renderFrame(control.setup)
      expect(expected).not.toContain("@a/only")

      // Every reply of A is still out when the reader moves to B, and lands last.
      const holding = holdingReplies()
      const held = yield* mountOnA(holding)
      yield* Effect.promise(() => held.setup.renderOnce())
      held.client.switchSession(pairB.sessionId, pairB.branchId, "Session B")
      yield* Effect.promise(() => held.setup.renderOnce())
      expect(holding.held()).toBeGreaterThan(0)
      yield* holding.release
      yield* waitForFrame(held.setup, (frame) => frame === expected, "the control frame")
      yield* settle(held.setup)
      expect(renderFrame(held.setup)).toBe(expected)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App cancel and quit keys during a turn", () => {
  it.scopedLive("escape cancels a running turn while an error shows, and never quits", () =>
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
  it.scopedLive("ctrl+c with an empty draft cancels a running turn while an error shows", () =>
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
  it.scopedLive("an extension keybind on ctrl+c is refused, and ctrl+c cancels the turn", () =>
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
  it.scopedLive("a second ctrl+c after one that cancelled a turn quits while a turn runs", () =>
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
  it.scopedLive("a second ctrl+c quits while the btw pane is open and a turn runs", () =>
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
    { name: "/effort", title: "Effort ·", open: typeCommand("/effort"), draft: Option.none() },
    { name: "/auth", title: "Sign in ·", open: typeCommand("/auth"), draft: Option.none() },
    {
      name: "prompt search",
      title: "Prompt search",
      open: (setup) => Effect.sync(() => setup.mockInput.pressKey("r", { ctrl: true })),
      draft: Option.some("kept draft"),
    },
  ]
  for (const pane of heldPanes) {
    it.scopedLive(`ctrl+c closes the ${pane.name} pane before it cancels the turn`, () =>
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
  // The palette is a layer as for Esc: ctrl+c closes it and arms nothing,
  // and the turn behind it runs on.
  it.scopedLive("ctrl+c closes the command palette before it cancels the turn", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("Commands"), "palette")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      const frame = yield* waitForFrame(
        view.setup,
        (next) => !next.includes("Commands"),
        "palette closed",
      )
      expect(frame).not.toContain(CTRL_C_CUE)
      expect(view.steers).toEqual([])
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "the turn cancelled")
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Prompt search holds the composer: a paste while it previews an entry
  // does not land in the draft behind it.
  it.scopedLive("a paste during prompt search does not reach the composer", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      for (const prompt of ["first prompt", "second prompt"]) {
        yield* Effect.promise(() => view.setup.mockInput.typeText(prompt))
        view.setup.mockInput.pressEnter()
        yield* waitForFrame(view.setup, () => view.sent.includes(prompt), `sent ${prompt}`)
      }
      view.setup.mockInput.pressKey("r", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("Prompt search · 2"), "search")
      // The paste is the search's query, never the composer's draft.
      yield* Effect.promise(() => view.setup.mockInput.pasteBracketedText("PASTED-ZQ"))
      const pasted = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("› PASTED-ZQ"),
        "the paste in the query",
      )
      expect(pasted).not.toContain("┃ PASTED-ZQ")
      // Esc clears the query; the cursor then moves to the older prompt.
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("Prompt search · 2") && !frame.includes("PASTED-ZQ"),
        "the query cleared",
      )
      view.setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => view.setup.renderOnce())
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
  // Each render has its own home: no prompt an earlier test or run sent is
  // in its history.
  it.scopedLive("a render starts with an empty prompt history", () =>
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
  it.scopedLive(
    "a key the btw ask line takes between two ctrl+c presses makes the second cancel",
    () =>
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
  it.scopedLive(
    "a paste the btw ask line takes between two ctrl+c presses makes the second cancel",
    () =>
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
  it.scopedLive("a ctrl+c after a cancel and a new draft clears the draft, and does not quit", () =>
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
  // The expanded transcript is a layer: after a ctrl+c that cancelled the
  // turn and armed the exit, the next ctrl+c collapses the transcript, and
  // the press after that goes on down the ladder instead of quitting.
  it.scopedLive("ctrl+c over the expanded transcript collapses it and does not quit", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn(24, [], { kittyKeyboard: true })
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, () => view.steers.length === 1, "cancel")
      view.setup.mockInput.pressKey("o", { ctrl: true, shift: true })
      yield* waitForFrame(view.setup, (frame) => frame.includes("transcript ·"), "transcript")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      const frame = yield* waitForFrame(
        view.setup,
        (next) => !next.includes("transcript ·"),
        "the transcript collapsed",
      )
      expect(frame).not.toContain(CTRL_C_CUE)
      expect(view.steers).toEqual(["Cancel"])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Esc over the expanded transcript collapses it; the turn behind it runs on.
  it.scopedLive(
    "esc over the expanded transcript during a turn collapses it and cancels nothing",
    () =>
      Effect.gen(function* () {
        const view = yield* mountRunningTurn(24, [], { kittyKeyboard: true })
        view.setup.mockInput.pressKey("o", { ctrl: true, shift: true })
        yield* waitForFrame(view.setup, (frame) => frame.includes("transcript ·"), "transcript")
        view.setup.mockInput.pressEscape()
        yield* waitForFrame(
          view.setup,
          (frame) => !frame.includes("transcript ·"),
          "the transcript collapsed",
        )
        expect(view.steers).toEqual([])
        view.setup.mockInput.pressEscape()
        yield* waitForFrame(view.setup, () => view.steers.length === 1, "the turn cancelled")
      }).pipe(Effect.timeout("10 seconds")),
  )
  // ctrl+o changes only how tool groups draw, so nothing nearer is left for
  // the next press to undo: the key itself has to disarm the quit.
  it.scopedLive(
    "a disclosure key between two ctrl+c presses makes the second cancel, not quit",
    () =>
      Effect.gen(function* () {
        const view = yield* mountRunningTurnWithError
        view.setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(view.setup, () => view.steers.length === 1, "first cancel")
        // The parser takes the bytes in order: ctrl+o is handled before ctrl+c.
        view.setup.mockInput.pressKey("o", { ctrl: true })
        view.setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(view.setup, () => view.steers.length === 2, "second cancel")
        expect(view.shutdowns()).toBe(0)
      }).pipe(Effect.timeout("10 seconds")),
  )
  // The quit arm is per key: a ctrl+c that cancelled a turn, then an escape
  // on the idle session, is two gestures and does not quit.
  it.scopedLive("escape after a ctrl+c that cancelled a turn does not quit", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-cancel")
      const branchId = BranchId.make("branch-cancel")
      const running = runningNow()
      const idle = { _tag: idleTag, queue: emptyQueueSnapshot() }
      const runtime = yield* Queue.unbounded<typeof running | typeof idle>()
      yield* Queue.offer(runtime, running)
      const { setup, client } = yield* mountApp({
        client: {
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
        },
        initialSession: sessionNamed(sessionId, branchId, "Cancel"),
      })
      const { shutdowns } = yield* countShutdowns(setup)
      const streaming = () => client.isStreaming()
      yield* waitForFrame(setup, streaming, "running turn")
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => !streaming(), "turn cancelled")
      setup.mockInput.pressEscape()
      // oxlint-disable-next-line effect/noFixedWaitInTests -- the escape must be parsed and handled before the negative assertion
      yield* Effect.sleep("100 millis")
      expect(shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ctrl+c twice quits an idle session while the btw pane is open", () =>
    Effect.gen(function* () {
      const { setup } = yield* mountApp({
        builtins: builtinClientModules,
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* Effect.promise(() => setup.mockInput.typeText("/btw"))
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("btw · fork"), "btw pane")
      const { shutdowns } = yield* countShutdowns(setup)
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      expect(shutdowns()).toBe(0)
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => shutdowns() > 0, "quit")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App slash commands", () => {
  it.scopedLive("a slash command typed before the client extensions load runs once they do", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const held = defineClientExtension("@test/held-load", {
        setup: Deferred.await(release).pipe(Effect.as(clientContributions())),
      })
      const sent: Array<string> = []
      const { setup, ext } = yield* mountApp({
        client: { message: recordSends(sent) },
        builtins: [...builtinClientModules, held],
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      expect(ext.loaded()).toBe(false)
      yield* Effect.promise(() => setup.mockInput.typeText("/btw"))
      yield* waitForFrame(setup, (frame) => frame.includes("/btw"), "the typed command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("/btw"), "the command sent")
      // A name no extension carries yet waits too; once the load settles it
      // is no command, and it comes back to the draft.
      yield* Effect.promise(() => setup.mockInput.typeText("/nonesuch"))
      yield* waitForFrame(setup, (frame) => frame.includes("/nonesuch"), "the unknown command")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => !frame.includes("/nonesuch"), "the draft left")
      expect(sent).toEqual([])
      yield* Deferred.complete(release, Effect.void)
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("btw · fork") && frame.includes("Unknown command: /nonesuch"),
        "btw pane and the settled name refused",
      )
      expect(sent).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // `/help` is the usual way to look for commands: it opens the one list of
  // them and starts no turn.
  it.scopedLive("/help opens the command palette and sends nothing", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* typeCommand("/help")(view.setup)
      yield* waitForFrame(view.setup, (frame) => frame.includes("Commands"), "the palette")
      expect(view.sent()).toEqual([])
    }).pipe(Effect.timeout("4 seconds")),
  )
  // A first word that reads as a path, with a second `/` or a `.`, is text
  // for the model.
  it.scopedLive("a slash word that reads as a path is sent as text", () =>
    Effect.gen(function* () {
      for (const path of ["/tmp/x what is this", "/notes.md read it"]) {
        const view = yield* mountIdleSession()
        yield* typeCommand(path)(view.setup)
        yield* waitUntil(() => view.sent().length > 0, "the path sent")
        expect(view.sent()).toEqual([path])
        view.unmount()
      }
    }).pipe(Effect.timeout("4 seconds")),
  )
  // A `/word` no command source names is a typo, not a message: it stays in
  // the draft with the way to the commands. The refusal names the draft it
  // gave back: once the reader changes that draft, the reason goes with it.
  it.scopedLive("an unknown command's refusal leaves the status row with its draft", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      yield* typeCommand("/zzq")(view.setup)
      yield* waitForFrame(
        view.setup,
        (frame) =>
          frame.includes("Unknown command: /zzq · ctrl+p commands") && frame.includes("┃ /zzq"),
        "the refusal and the draft back",
      )
      expect(view.sent()).toEqual([])
      view.setup.mockInput.pressKey("u", { ctrl: true })
      yield* waitForFrame(
        view.setup,
        (frame) => !frame.includes("/zzq") && !frame.includes("Unknown command"),
        "the draft and its refusal gone",
      )
      yield* typeCommand("/zzq")(view.setup)
      yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("Unknown command: /zzq") && frame.includes("┃ /zzq"),
        "a later refusal and its draft",
      )
    }).pipe(Effect.timeout("4 seconds")),
  )
  for (const { name, gateSetup } of [
    {
      name: "a pane that opens over a previewing prompt search gives the draft back",
      gateSetup: false,
    },
    {
      name: "a pane loaded after a previewing prompt search gives the draft back",
      gateSetup: true,
    },
  ]) {
    it.scopedLive(name, () =>
      Effect.gen(function* () {
        const setupRelease = yield* Deferred.make<void>()
        const { setup, ext } = yield* mountApp({
          builtins: builtinClientModules.map((extension) => {
            if (!gateSetup) return extension
            return {
              ...extension,
              setup: Deferred.await(setupRelease).pipe(Effect.andThen(extension.setup)),
            }
          }),
          initialSession: sessionNamed("session-a", "branch-a", "Session A"),
        })
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
        // Core prompt search can preview before client extensions finish setup.
        // Ctrl+T belongs to an extension: its contribution must exist at dispatch.
        const keybindReady = () => ext.commands().some((command) => command.keybind === "ctrl+t")
        if (gateSetup) {
          expect(keybindReady()).toBe(false)
          yield* Deferred.complete(setupRelease, Effect.void)
        }
        yield* waitForFrame(setup, keybindReady, "the sessions keybind loaded")
        setup.mockInput.pressKey("t", { ctrl: true })
        yield* waitForFrame(setup, (frame) => !frame.includes("Prompt search"), "search replaced")
        yield* waitForFrame(setup, (frame) => frame.includes("┃ mine"), "the draft back")
      }).pipe(Effect.timeout("10 seconds")),
    )
  }
  it.scopedLive(
    "a slash command typed before the session's server commands list waits for them",
    () =>
      Effect.gen(function* () {
        const listed = yield* Deferred.make<void>()
        const requests: Array<unknown> = []
        const sent: Array<string> = []
        const { setup, ext } = yield* mountApp({
          client: {
            message: recordSends(sent),
            extension: {
              listSlashCommands: () =>
                Deferred.await(listed).pipe(
                  Effect.as([
                    { name: "probe", extensionId: "@test/server-probe", capabilityId: "probe" },
                  ]),
                ),
              request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
                Effect.sync(() => {
                  if (input.capabilityId === "probe") requests.push(input.input)
                }),
            },
          },
          builtins: builtinClientModules,
          initialSession: sessionNamed("session-a", "branch-a", "Session A"),
        })
        yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
        yield* waitForFrame(setup, () => ext.loaded(), "client extensions loaded")
        yield* Effect.promise(() => setup.mockInput.typeText("/probe now"))
        yield* waitForFrame(setup, (frame) => frame.includes("/probe now"), "the typed command")
        setup.mockInput.pressEnter()
        yield* waitForFrame(setup, (frame) => !frame.includes("/probe now"), "the command sent")
        expect(sent).toEqual([])
        expect(requests).toHaveLength(0)
        yield* Deferred.complete(listed, Effect.void)
        yield* waitForFrame(setup, () => requests.length === 1, "the server command ran")
        expect(requests).toEqual(["now"])
        expect(sent).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )
  // A command an extension registers after the session listed its commands is
  // still a command: a name the list lacks is checked against a fresh list
  // before it goes to the model, and a name no list carries still goes there.
  it.scopedLive("a server command registered after the listing runs, not sent as a message", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = []
      const sent: Array<string> = []
      let listings = 0
      const { setup, ext } = yield* mountApp({
        client: {
          message: recordSends(sent),
          extension: {
            // The first listing is from before the extension registered.
            listSlashCommands: () =>
              Effect.sync(() => {
                listings += 1
                if (listings === 1) return []
                return [{ name: "late", extensionId: "@test/late", capabilityId: "late" }]
              }),
            request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
              Effect.sync(() => {
                if (input.capabilityId === "late") requests.push(input.input)
              }),
          },
        },
        builtins: builtinClientModules,
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* waitForFrame(setup, () => ext.commandsSettled(), "the commands settled")
      yield* typeCommand("/late now")(setup)
      yield* waitForFrame(setup, () => requests.length + sent.length > 0, "the command answered")
      expect(requests).toEqual(["now"])
      expect(sent).toEqual([])
      // The second listing knows no `/nowhere` either: it is refused.
      yield* typeCommand("/nowhere else")(setup)
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Unknown command: /nowhere"),
        "the unknown name refused",
      )
      expect(sent).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A server command the server refuses says so on the status row: the
  // extension's own reason, on one row that fits 60 columns.
  const auditRefused = Schema.decodeSync(GentRpcError)({
    _tag: "ExtensionProtocolError",
    extensionId: "@test/server-audit",
    tag: "audit",
    message: "audit refused on this branch",
  })
  it.scopedLive("a server slash command that fails shows why until the next one runs", () =>
    Effect.gen(function* () {
      const { setup } = yield* mountApp({
        client: {
          extension: {
            listSlashCommands: () =>
              Effect.succeed([
                {
                  name: "audit",
                  displayName: "Audit",
                  description: "Detect, audit, and report code issues",
                  extensionId: "@test/server-audit",
                  capabilityId: "audit",
                },
                {
                  name: "note",
                  displayName: "Note",
                  description: "Take a note",
                  extensionId: "@test/server-note",
                  capabilityId: "note",
                },
              ]),
            request: (input: { readonly capabilityId: string }) =>
              Effect.suspend(() => {
                if (input.capabilityId === "note") return Effect.void
                return Effect.fail(auditRefused)
              }),
          },
        },
        builtins: builtinClientModules,
        width: 60,
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* typeCommand("/audit now")(setup)
      const failed = yield* waitForFrame(
        setup,
        (frame) => frame.includes("audit refused"),
        "the failure",
      )
      const row = failed.split("\n").find((line) => line.includes("audit refused")) ?? ""
      // The error stays whole; the cwd and the model give way to it.
      expect(row.trim()).toStartWith("/audit failed: audit refused on this branch")
      expect(row).not.toContain("…")
      yield* typeCommand("/note")(setup)
      const frame = yield* waitForFrame(
        setup,
        (next) => !next.includes("audit refused") && next.includes("ready ·"),
        "the failure gone",
      )
      expect(frame).not.toContain("/audit failed")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("the slash popup shows a server command's description", () =>
    Effect.gen(function* () {
      const { setup } = yield* mountApp({
        client: {
          extension: {
            listSlashCommands: () =>
              Effect.succeed([
                {
                  name: "audit",
                  displayName: "Audit",
                  description: "Detect, audit, and report code issues",
                  extensionId: "@test/server-audit",
                  capabilityId: "audit",
                },
              ]),
          },
        },
        builtins: builtinClientModules,
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* Effect.promise(() => setup.mockInput.typeText("/aud"))
      yield* waitForFrame(setup, (frame) => frame.includes("/audit"), "the popup row")
      expect(renderFrame(setup)).toContain("Detect, audit")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A connection drop while the list is in flight is not an answer: the held
  // command waits, and the reconnect lists the server commands again.
  // The failed reply may reach the client before or after the connection
  // state says the socket closed.
  for (const first of ["failure", "state"]) {
    const failureFirst = first === "failure"
    it.scopedLive(
      `a slash command held across a dropped listing runs once the reconnect lists (${first} first)`,
      () =>
        Effect.gen(function* () {
          const drop = yield* Deferred.make<void>()
          const failed = yield* Deferred.make<void>()
          const requests: Array<unknown> = []
          const sent: Array<string> = []
          let listings = 0
          const lifecycle = createMutableRuntime(
            ConnectionState.cases.Connected.make({ generation: 0 }),
          )
          const { setup, ext } = yield* mountApp({
            client: {
              message: recordSends(sent),
              extension: {
                listSlashCommands: () =>
                  Effect.suspend(() => {
                    listings += 1
                    if (listings === 1) {
                      return Deferred.await(drop).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
                          ),
                        ),
                        Effect.ensuring(Deferred.succeed(failed, void 0)),
                      )
                    }
                    return Effect.succeed([
                      { name: "probe", extensionId: "@test/server-probe", capabilityId: "probe" },
                    ])
                  }),
                request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
                  Effect.sync(() => {
                    if (input.capabilityId === "probe") requests.push(input.input)
                  }),
              },
            },
            runtime: lifecycle.runtime,
            builtins: builtinClientModules,
            initialSession: sessionNamed("session-a", "branch-a", "Session A"),
          })
          yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
          yield* waitForFrame(setup, () => ext.loaded(), "client extensions loaded")
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
          expect(sent).toEqual([])
          if (failureFirst) reconnecting()
          lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
          yield* waitForFrame(setup, () => requests.length === 1, "the server command ran")
          expect(requests).toEqual(["now"])
          expect(listings).toBe(2)
          expect(sent).toEqual([])
        }).pipe(Effect.timeout("10 seconds")),
    )
  }
  // Settled means settled for this connection: a listing the last connection
  // answered says nothing of the server the reconnect reached. A command
  // submitted while the new listing is in flight waits for it.
  it.scopedLive(
    "a slash command submitted while a reconnect lists again waits for that listing",
    () =>
      Effect.gen(function* () {
        const relisted = yield* Deferred.make<void>()
        const requests: Array<unknown> = []
        const sent: Array<string> = []
        let listings = 0
        const lifecycle = createMutableRuntime(
          ConnectionState.cases.Connected.make({ generation: 0 }),
        )
        const { setup, ext } = yield* mountApp({
          client: {
            message: recordSends(sent),
            extension: {
              listSlashCommands: () =>
                Effect.suspend(() => {
                  listings += 1
                  // The first server has no /probe; the one the reconnect reaches has.
                  if (listings === 1) return Effect.succeed([])
                  return Deferred.await(relisted).pipe(
                    Effect.as([
                      { name: "probe", extensionId: "@test/server-probe", capabilityId: "probe" },
                    ]),
                  )
                }),
              request: (input: { readonly capabilityId: string; readonly input: unknown }) =>
                Effect.sync(() => {
                  if (input.capabilityId === "probe") requests.push(input.input)
                }),
            },
          },
          runtime: lifecycle.runtime,
          builtins: builtinClientModules,
          initialSession: sessionNamed("session-a", "branch-a", "Session A"),
        })
        yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
        yield* waitForFrame(
          setup,
          () => ext.loaded() && ext.commandsSettled(),
          "the first listing settled",
        )
        lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
        lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
        yield* waitForFrame(setup, () => listings === 2, "the reconnect lists again")
        yield* Effect.promise(() => setup.mockInput.typeText("/probe now"))
        yield* waitForFrame(setup, (frame) => frame.includes("/probe now"), "the typed command")
        setup.mockInput.pressEnter()
        yield* waitForFrame(setup, (frame) => !frame.includes("/probe now"), "the command sent")
        expect(sent).toEqual([])
        yield* Deferred.succeed(relisted, void 0)
        yield* waitForFrame(setup, () => requests.length === 1, "the server command ran")
        expect(requests).toEqual(["now"])
        expect(sent).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App docked panes at short heights", () => {
  /**
   * The docked pane closes inside the terminal: its bottom rule is the last
   * row drawn, or the key hint under it is.
   */
  const closesInside = (drawn: ReadonlyArray<string>) => {
    const rule = drawn.findLastIndex((line) => line.startsWith("─"))
    return rule >= 0 && drawn.length - 1 - rule <= 1
  }
  // A delete the server refuses says so: the row stays, and the status row
  // names the failure.
  it.scopedLive("an agents-pane delete the server refuses shows why", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(24, [], {
        deleteSession: Effect.fail(new ProviderAuthError({ message: "delete refused" })),
      })
      setup.mockInput.pressKey("t", { ctrl: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sessions ·") && frame.includes("delegate: task 3"),
        "the agents pane",
      )
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again"), "the armed delete")
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("delete refused"), "the failure")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // At 14 rows the composer takes four of the footer's twelve once its blank
  // rows give way, and the agents pane's rules and title take three more: the
  // filter row, the section heading and the cursor row fit. The trays, the
  // blank rows and the detail line give way for them.
  it.scopedLive(
    "the agents pane keeps its cursor row in view at the smallest height that holds it",
    () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(14)
        yield* waitForFrame(setup, (frame) => frame.includes("alarm in now"), "the alarm tray")
        setup.mockInput.pressKey("t", { ctrl: true })
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("Sessions ·") && frame.includes("delegate: task 3"),
          "the agents pane with its cursor row",
        )
        const opened = renderFrame(setup)
        expect(opened).toContain("┃")
        expect(opened).not.toContain("alarm in now")
        const drawn = opened.split("\n").filter((line) => line.trim().length > 0)
        expect(closesInside(drawn)).toBe(true)
        // The cursor row is marked by its background, not by a word.
        const backgroundUnder = (text: string) =>
          setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .find((span) => span.text.includes(text))?.bg
        const cursor = backgroundUnder("delegate: task 3")
        setup.mockInput.pressArrow("down")
        yield* waitForFrame(
          setup,
          () =>
            backgroundUnder("delegate: task 4")?.equals(cursor) === true &&
            backgroundUnder("delegate: task 3")?.equals(cursor) !== true,
          "the cursor row after one move down",
        )
        setup.mockInput.pressEscape()
        yield* waitForFrame(
          setup,
          (frame) => !frame.includes("Sessions ·") && frame.includes("alarm in now"),
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
    it.scopedLive(
      `the agents pane at ${height} rows keeps its cursor row and overdraws nothing`,
      () =>
        Effect.gen(function* () {
          const setup = yield* mountShortTerminalWithTrays(height)
          yield* waitForFrame(setup, (frame) => frame.includes("alarm in now"), "the alarm tray")
          setup.mockInput.pressKey("t", { ctrl: true })
          yield* waitForFrame(setup, (frame) => !frame.includes("alarm in now"), "the agents pane")
          const frame = yield* waitForFrame(
            setup,
            (current) => current.includes("delegate: task 3"),
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
    it.scopedLive(
      `the thread pane at ${height} rows keeps its cursor row and overdraws nothing`,
      () =>
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
    it.scopedLive(
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
    it.scopedLive(`the autocomplete popup at ${height} rows keeps its cursor row`, () =>
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
    it.scopedLive(`the command palette at ${height} rows keeps its cursor row`, () =>
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
  // the live line, the input and the status row leave a pane two rows,
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
      shown: "Sessions ·",
      rowClean: () => true,
    },
  ]
  /** A rule is only rule, and no pane row is two rows drawn over each other. */
  const overdrawsNothing = (frame: string, rowClean: (line: string) => boolean) =>
    frame
      .split("\n")
      .every((line) => (!line.includes("─") || /^─+$/.test(line.trim())) && rowClean(line))
  for (const pane of shortPanes) {
    it.scopedLive(`the ${pane.name} overdraws nothing from 10 rows down to 5`, () =>
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
  it.scopedLive(
    "the blank footer rows give way so a pane keeps its cursor row down to 6 rows",
    () =>
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
              frame.split("\n").some((line) => line.startsWith("  ✻ ")),
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
    const generating = lines.findIndex((line) => line.includes("✻ "))
    return generating >= 0 && lines[generating + 1]?.startsWith("┃") === true
  }
  for (const height of [12, 11, 10]) {
    it.scopedLive(`the footer holds still at ${height} rows with a pane open`, () =>
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
  it.scopedLive("the ghost line gives way with the blank rows for a squeezed popup", () =>
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
      expect(frame).toContain("tab complete")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A pane with no row on screen takes no keys: the reader cannot see what a
  // key would do there. Typing goes past the agents pane to the composer.
  it.scopedLive("typing reaches the composer past an agents pane that has no row", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressArrow("left")
      yield* waitForFrame(view.setup, (frame) => frame.includes("Sessions ·"), "the agents pane")
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
  it.scopedLive("esc closes a held pane that has no row and leaves the turn running", () =>
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
      // oxlint-disable-next-line effect/noFixedWaitInTests -- a lone escape byte stays in the stdin parser until its timeout flushes it as a key
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
      expect(renderFrame(view.setup)).not.toContain("Effort ·")
      expect(view.steers).toEqual([])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // An extension pane with no row takes no keys either, and Esc closes it the
  // same way: the turn runs on, and the pane is gone when the terminal grows.
  it.scopedLive("esc closes an extension pane that has no row and leaves the turn running", () =>
    Effect.gen(function* () {
      const view = yield* mountRunningTurn()
      view.setup.mockInput.pressArrow("left")
      yield* waitForFrame(view.setup, (frame) => frame.includes("Sessions ·"), "the agents pane")
      const width = view.setup.renderer.terminalWidth
      view.setup.resize(width, 5)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 5 && !frame.includes("Sessions ·"),
        "the agents pane with no row",
      )
      view.setup.mockInput.pressEscape()
      // oxlint-disable-next-line effect/noFixedWaitInTests -- a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      view.setup.resize(width, 24)
      yield* waitForFrame(
        view.setup,
        (frame) => view.setup.renderer.terminalHeight === 24 && frame.includes("✻ "),
        "the full terminal",
      )
      expect(renderFrame(view.setup)).not.toContain("Sessions ·")
      expect(view.steers).toEqual([])
      expect(view.shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The live run: an alarm and three working children filled the trays, and
  // the btw pane showed its question but not the fork's stored answer.
  it.scopedLive(
    "the btw pane keeps the fork's answer in view on a short terminal with full trays",
    () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(16)
        yield* waitForFrame(setup, (frame) => frame.includes("+1 more"), "full trays")
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
        expect(frame).not.toContain("+1 more")
      }).pipe(Effect.timeout("10 seconds")),
  )
  // At 10 rows (the blank footer rows given way) the btw pane has one body
  // row: it holds the answer's last line, not the blank row between turns,
  // and the pane still closes on its rule.
  it.scopedLive("the btw pane holds the answer's last line in a one-row body", () =>
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
  it.scopedLive("the btw ask line is never drawn over when the transcript has no row", () =>
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
})

describe("App interjections and the boot branch picker", () => {
  it.scopedLive("an interjection steers a running turn while an error shows", () =>
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
  /** A resumed session with two branches: the boot branch picker is open over it. */
  const mountBootBranchPicker = Effect.gen(function* () {
    const { setup } = yield* mountApp({
      app: {
        initialBranches: Option.some([
          { ...branchOf("branch-a", 0), name: "main" },
          { ...branchOf("branch-b", 1), name: "side" },
        ]),
      },
      initialSession: sessionNamed("session-a", "branch-a", "Session A"),
    })
    yield* waitForFrame(setup, (frame) => frame.includes("Resume: Session A"), "picker")
    return setup
  })
  // A key the picker's list declines does not reach the composer behind it:
  // `!` does not turn the composer to shell mode.
  it.scopedLive("a key the boot branch picker declines leaves the composer alone", () =>
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
  // The picker is where a resumed multi-branch session starts. With no branch
  // chosen there is nothing behind it to fall back to: Esc never quits, so it
  // does nothing here, and the hint names the way out.
  it.scopedLive("Esc in the boot branch picker does nothing; its hint says ctrl+c exits", () =>
    Effect.gen(function* () {
      const setup = yield* mountBootBranchPicker
      const { shutdowns } = yield* countShutdowns(setup)
      expect(renderFrame(setup)).toContain("ctrl+c exit")
      setup.mockInput.pressEscape()
      // oxlint-disable-next-line effect/noFixedWaitInTests -- a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      const frame = yield* waitForFrame(setup, () => true, "the key handled")
      expect(frame).toContain("Resume: Session A")
      expect(shutdowns()).toBe(0)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ctrl+c in the boot branch picker arms the exit, and a second quits", () =>
    Effect.gen(function* () {
      const setup = yield* mountBootBranchPicker
      const { shutdowns } = yield* countShutdowns(setup)
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      expect(shutdowns()).toBe(0)
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => shutdowns() > 0, "quit")
      expect(shutdowns()).toBe(1)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App auth gate at startup", () => {
  it.scopedLive("branch picker does not trigger auth gating before a branch is selected", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: string
      }> = []
      // The mock's snapshot names an agent, which makes the auth check
      // runnable. Without one the gate stops before it reads the picker, and
      // this test proves nothing.
      const { setup } = yield* mountApp({
        app: { initialBranches: Option.some([branchOf("branch-a", 0), branchOf("branch-b", 1)]) },
        client: {
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
                  branch: { ...branchOf("branch-a", 0), name: "Main" },
                  messageCount: 3,
                  children: [],
                },
                {
                  branch: { ...branchOf("branch-b", 1), name: "Side" },
                  messageCount: 1,
                  children: [],
                },
              ]),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "Session A"),
      })
      yield* waitForFrame(setup, (next) => next.includes("Resume: Session A"), "branch picker")
      expect(calls).toEqual([])

      // Choosing a branch closes the picker, and only then does the gate run.
      setup.mockInput.pressEnter()
      yield* waitUntil(() => calls.length > 0, "the gate runs")
      expect(calls.map((call) => call.agentName)).toEqual(["primary"])
    }).pipe(Effect.timeout("10 seconds")),
  )
  // An enforced sign-in holds the slot: with a required key missing there is
  // no session to fall back to, so ctrl+c quits over it.
  it.scopedLive("ctrl+c over an enforced sign-in arms the exit, and a second quits", () =>
    Effect.gen(function* () {
      const { setup } = yield* mountApp({
        client: {
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
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in ·"), "the sign-in")
      const { shutdowns } = yield* countShutdowns(setup)
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes(CTRL_C_CUE), "the exit cue")
      expect(shutdowns()).toBe(0)
      setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(setup, () => shutdowns() > 0, "quit")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // Esc never quits, and an enforced sign-in holds the slot: Esc on its
  // provider list does nothing. It neither closes the pane (the gate would
  // open a fresh one that loads the providers again and jumps back to the
  // method screen) nor claims to.
  it.scopedLive("Esc on an enforced sign-in's provider list keeps it and loads nothing again", () =>
    Effect.gen(function* () {
      let loads = 0
      const { setup } = yield* mountApp({
        client: {
          auth: {
            listProviders: () =>
              Effect.sync(() => {
                loads += 1
                return [
                  {
                    provider: "openai",
                    hasKey: false,
                    required: true,
                    source: noAuthSource,
                    authType: absent,
                  },
                ]
              }),
            listMethods: () => Effect.succeed({ openai: [apiMethod] }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("· method"), "the method screen")
      setup.mockInput.pressEscape()
      const list = yield* waitForFrame(
        setup,
        (frame) => frame.includes("Sign in · 1 provider"),
        "the provider list",
      )
      expect(list).toContain("ctrl+c exit")
      expect(list).not.toContain("esc close")
      const atList = loads
      setup.mockInput.pressEscape()
      // oxlint-disable-next-line effect/noFixedWaitInTests -- a lone escape byte stays in the stdin parser until its timeout flushes it as a key
      yield* Effect.sleep("100 millis")
      const frame = yield* waitForFrame(setup, () => true, "the key handled")
      expect(frame).toContain("Sign in · 1 provider")
      expect(frame).not.toContain("· method")
      expect(loads).toBe(atList)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("cold start with prompt does not continue when auth checking fails", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const { setup } = yield* mountApp({
        client: {
          auth: {
            listProviders: () =>
              Effect.sync(() => {
                authChecks += 1
              }).pipe(
                Effect.flatMap(() =>
                  Effect.fail(new ProviderAuthError({ message: "session auth lookup failed" })),
                ),
              ),
            listMethods: () => Effect.succeed({ openai: [apiMethod] }),
          },
          message: {
            send: (input: { content: string }) =>
              Effect.sync(() => {
                sentMessages.push(input)
              }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
        initialPrompt: Option.some("must not send"),
      })
      // The failed check has settled once its retry note draws.
      yield* waitForFrame(
        setup,
        (frame) => authChecks > 0 && frame.includes("Press r to retry"),
        "auth check failure",
      )
      expect(sentMessages).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("cold start with prompt recovers after a transient auth check failure", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const sentMessages: Array<{
        content: string
      }> = []
      const { setup } = yield* mountApp({
        client: {
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
          },
          message: {
            send: (input: { content: string }) =>
              Effect.sync(() => {
                sentMessages.push(input)
              }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
        initialPrompt: Option.some("send after retry"),
      })
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === "send after retry"),
        "sent message",
      )
      expect(authChecks).toBeGreaterThan(1)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("enforced auth overlay can retry failed provider loads", () =>
    Effect.gen(function* () {
      let authChecks = 0
      const { setup } = yield* mountApp({
        client: {
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
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes("temporary auth lookup failed") && frame.includes("Press r to retry"),
        "retryable auth error",
      )
      setup.mockInput.pressKey("r")
      yield* waitForFrame(setup, (frame) => !frame.includes("Sign in ·"), "auth retry resolved")
      expect(authChecks).toBe(3)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "the boot branch picker gates auth and sends the startup prompt on the chosen branch",
    () =>
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
        const main = {
          id: alphaBranchId,
          sessionId: alphaSessionId,
          name: "Main",
          createdAt: dateFromMillis(0),
        }
        const side = {
          id: betaBranchId,
          sessionId: alphaSessionId,
          name: "Side",
          createdAt: dateFromMillis(1),
        }
        const initialPrompt = "deferred startup prompt"
        const { setup } = yield* mountApp({
          app: { initialBranches: Option.some([main, side]) },
          client: {
            branch: {
              getTree: () =>
                Effect.succeed([
                  { branch: main, messageCount: 3, children: [] },
                  { branch: side, messageCount: 1, children: [] },
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
              listMethods: () => Effect.succeed({ openai: [apiMethod] }),
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
          },
          initialSession: sessionNamed(alphaSessionId, alphaBranchId, "Alpha"),
          initialPrompt: Option.some(initialPrompt),
          width: 100,
          height: 30,
        })
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
      }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("stale auth checks cannot reopen the auth gate after key save", () =>
    Effect.gen(function* () {
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
      const { setup, client: clientContext } = yield* mountApp({
        client: {
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
            listMethods: () => Effect.succeed({ openai: [apiMethod] }),
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
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
        initialPrompt: Option.some(initialPrompt),
        width: 100,
        height: 30,
      })
      yield* waitForFrame(setup, (frame) => frame.includes("Sign in ·"), "auth gate")
      applySnapshotAgent(clientContext, AgentName.make("secondary"))
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
      // oxlint-disable-next-line effect/noFixedWaitInTests -- real-clock gap so the resumed-send fiber resolves before assertion
      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("Sign in ·")
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("App startup prompt and renames", () => {
  /**
   * The server renames session-a, as it does after the first turn: a
   * `SessionNameUpdated` event gives the client a new record for the same
   * session. Settles once the client holds the new name.
   */
  const renameSessionA = (setup: TestSetup, clientContext: ClientContextValue) =>
    Effect.gen(function* () {
      clientContext.applySessionEvent(
        EventEnvelope.make({
          id: EventId.make(1_000),
          createdAt: 0,
          event: AgentEvent.cases.SessionNameUpdated.make({
            sessionId: SessionId.make("session-a"),
            name: "A better name",
          }),
        }),
      )
      yield* waitForFrame(
        setup,
        () => clientContext.session().name === "A better name",
        "the session renamed",
      )
    })
  // The boot picker mounts the session view again on the chosen branch, so
  // the prompt outlives one mount. A session the reader opens after that is
  // a different session and starts empty.
  it.scopedLive("the startup prompt belongs to the boot session, not the next one", () =>
    Effect.gen(function* () {
      const nextSessionId = SessionId.make("session-next")
      const startupPrompt = "only for the boot session"
      const sentMessages: Array<{ sessionId: SessionId; content: string }> = []
      const { setup, client } = yield* mountApp({
        client: {
          session: {
            create: () =>
              Effect.succeed({
                sessionId: nextSessionId,
                branchId: BranchId.make("branch-next"),
                name: "Next",
              }),
          },
          message: {
            send: (input: { readonly sessionId: SessionId; readonly content: string }) =>
              Effect.sync(() => {
                sentMessages.push(input)
              }),
          },
        },
        initialPrompt: Option.some(startupPrompt),
        initialSession: sessionNamed("session-boot", "branch-boot", "Boot"),
      })
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === startupPrompt),
        "sent message",
      )
      expect(sentMessages).toHaveLength(1)
      client.createSession()
      yield* waitForFrame(
        setup,
        () => client.session().sessionId === nextSessionId,
        "next session mounted",
      )
      // Several frames for the new session's feed to settle.
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      expect(sentMessages.filter((message) => message.sessionId === nextSessionId)).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a renamed session keeps its view and does not send the startup prompt again", () =>
    Effect.gen(function* () {
      const sentMessages: Array<{ readonly content: string }> = []
      const initialPrompt = "send me once"
      const { setup, client: clientContext } = yield* mountApp({
        client: {
          message: {
            send: (input: { readonly content: string }) =>
              Effect.sync(() => {
                sentMessages.push(input)
              }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
        initialPrompt: Option.some(initialPrompt),
      })
      yield* waitForFrame(
        setup,
        () => sentMessages.some((message) => message.content === initialPrompt),
        "sent message",
      )
      // The docked effort pane is part of the session view: a new mount
      // would close it. `/think` is the command's earlier name.
      yield* typeCommand("/think")(setup)
      yield* waitForFrame(setup, (frame) => frame.includes("Effort ·"), "the effort pane")
      // The server names the session after the first turn. The record is new;
      // the session is the same one.
      yield* renameSessionA(setup, clientContext)
      const frame = yield* waitForFrame(setup, () => true, "the frame after the rename")
      expect(frame).toContain("Effort ·")
      expect(sentMessages.filter((message) => message.content === initialPrompt)).toHaveLength(1)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a startup prompt the server refuses comes back to the draft with its reason", () =>
    Effect.gen(function* () {
      const attempts: Array<{ readonly content: string; readonly requestId?: string }> = []
      const initialPrompt = "survive one failure"
      const { setup, client: clientContext } = yield* mountApp({
        client: {
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
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
        initialPrompt: Option.some(initialPrompt),
      })
      // The refusal is an answer: the prompt comes back as a draft, with why.
      yield* waitForFrame(
        setup,
        (frame) =>
          frame.includes(`┃ ${initialPrompt}`) &&
          Option.exists(clientContext.error(), (error) => error.includes("send refused")),
        "prompt back in the draft",
      )
      expect(attempts).toHaveLength(1)
      // The reader sends it; nothing sends it on its own.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => attempts.length === 2, "sent by the reader")
      expect(attempts[1]?.content).toBe(initialPrompt)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "a startup prompt whose replies were lost goes again under its request id",
    () =>
      Effect.gen(function* () {
        const ids: Array<string> = []
        const initialPrompt = "lost on the way back"
        const { setup } = yield* mountApp({
          client: {
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
          },
          initialSession: sessionNamed("session-a", "branch-a", "A"),
          initialPrompt: Option.some(initialPrompt),
        })
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
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
  it.scopedLive("a renamed session does not refetch the extension slash commands", () =>
    Effect.gen(function* () {
      let slashCommandCalls = 0
      const { setup, client: clientContext } = yield* mountApp({
        client: {
          extension: {
            listSlashCommands: () =>
              Effect.sync(() => {
                slashCommandCalls += 1
                return []
              }),
          },
        },
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      yield* waitForFrame(setup, () => slashCommandCalls >= 1, "slash commands fetched")
      const before = slashCommandCalls
      // The extension-contributed rows belong to the session, not to its name.
      yield* renameSessionA(setup, clientContext)
      expect(slashCommandCalls).toBe(before)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── widgets render ──────────────────────────────────────────────────────────

const testSession: Session = {
  id: SessionId.make("session-test"),
  name: "Test Session",
  cwd: "/nonexistent/gent-test-session",
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
  cwd: "/nonexistent/gent-test-next-session",
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
  expose: (controls: { switchSession: () => void; switchBranchSameSession: () => void }) => void
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

// ── clipboard ───────────────────────────────────────────────────────────────

describe("App clipboard", () => {
  const deviceUrl = "https://auth.openai.com/codex/device"

  /**
   * Services whose link opener fails as on a box with no browser, so the URL
   * stays on screen. `host` adds to them: an environment, a process spawner.
   */
  const noBrowserServices = (host: Layer.Layer<never> = Layer.empty) =>
    Effect.gen(function* () {
      const built = yield* Layer.build(
        Layer.mergeAll(
          testPlatformLayer(),
          LinkOpener.Test({
            open: (url) => Effect.fail(new LinkOpenerError({ message: `no browser for ${url}` })),
          }),
          host,
        ),
      )
      const scope = yield* Scope.Scope
      return Context.makeUnsafe<unknown>(Context.add(built, Scope.Scope, scope).mapUnsafe)
    })

  /** A host inside tmux, by its environment. */
  const tmuxEnv = { TMUX: "/nonexistent/gent-probe-tmux,1,0" }

  /**
   * A host with the environment `env` whose `tmux` never runs: each run's
   * arguments and stdin land in `runs`, and `standIn` (a program and its
   * arguments) runs in its place, under the tmux run's kill options, its
   * handle in `children`. Every other command runs for real.
   */
  const recordedTmux = (
    runs: Array<{ args: ReadonlyArray<string>; stdin: string }>,
    env: Record<string, string>,
    standIn: readonly [string, ...string[]] = ["true"],
    children: Array<ChildProcessSpawner.ChildProcessHandle> = [],
  ) =>
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const real = yield* ChildProcessSpawner.ChildProcessSpawner
          return ChildProcessSpawner.make((command) => {
            if (!ChildProcess.isStandardCommand(command) || command.command !== "tmux")
              return real.spawn(command)
            const input = command.options.stdin
            return Effect.gen(function* () {
              let stdin = ""
              if (Stream.isStream(input)) {
                const chunks = yield* Stream.runCollect(input)
                stdin = new TextDecoder().decode(Buffer.concat(chunks))
              }
              runs.push({ args: command.args, stdin })
              const [program, ...args] = standIn
              const child = yield* real.spawn(
                ChildProcess.make(program, args, {
                  killSignal: command.options.killSignal,
                  forceKillAfter: command.options.forceKillAfter,
                }),
              )
              children.push(child)
              return child
            }).pipe(Effect.orDie)
          })
        }),
      ).pipe(Layer.provide(testPlatformLayer())),
    )

  /** The bytes an OSC 52 copy of `text` to the clipboard sends the terminal. */
  const osc52 = (text: string) => `\u001b]52;c;${Base64.encode(text)}\u001b\\`

  /**
   * The enforced sign-in on its OAuth screen, the device URL `url` on screen,
   * on a terminal that keeps what the renderer writes. The sign-in pane is an
   * overlay, so OpenTUI tracks the mouse: the terminal sees no drag.
   */
  const mountOAuthScreen = (url: string, host: Layer.Layer<never> = Layer.empty) =>
    Effect.gen(function* () {
      const output = new TerminalOutput()
      const { setup } = yield* mountApp({
        client: {
          auth: {
            listProviders: () =>
              Effect.succeed([
                {
                  provider: "openai",
                  hasKey: false,
                  required: true,
                  source: noAuthSource,
                  authType: absent,
                },
              ]),
            listMethods: () =>
              Effect.succeed({ openai: [{ label: "ChatGPT (device code)", type: "oauth" }] }),
            authorize: () =>
              Effect.succeed({
                authorizationId: "auth-device",
                url,
                method: "auto",
                instructions: "Open the URL and enter this code:\nWXYZ-1234",
              }),
            // The device poll waits for a code the reader never enters.
            callback: () => Effect.never,
          },
        },
        services: yield* noBrowserServices(host),
        output,
        initialSession: sessionNamed("session-a", "branch-a", "A"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ChatGPT (device code)"), "methods")
      setup.mockInput.pressEnter()
      const head = url.slice(0, 24)
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes(head) && next.includes("WXYZ-1234"),
        "the device URL on the sign-in pane",
      )
      return { setup, output, span: urlSpan(frame, url) }
    })

  /**
   * Where `url` sits in the frame: its first cell, and the row and the column
   * just past its last cell. A long URL wraps, so it runs on over rows at the
   * column it starts at.
   */
  const urlSpan = (frame: string, url: string) => {
    const rows = frame.split("\n")
    const top = rows.findIndex((line) => line.includes(url.slice(0, 24)))
    const column = rows[top]?.indexOf(url.slice(0, 24)) ?? -1
    let consumed = 0
    let bottom = top
    let end = column
    while (consumed < url.length && bottom < rows.length) {
      const line = rows[bottom] ?? ""
      let length = 0
      while (line[column + length] === url[consumed + length] && consumed + length < url.length)
        length += 1
      consumed += length
      end = column + length
      if (consumed < url.length) bottom += 1
    }
    expect(consumed).toBe(url.length)
    return { column, top, bottom, end }
  }

  it.scopedLive("a mouse selection over the sign-in URL copies it through OSC 52", () =>
    Effect.gen(function* () {
      const { setup, output, span } = yield* mountOAuthScreen(deviceUrl)
      expect(span.top).toBe(span.bottom)
      expect(output.written()).not.toContain("\u001b]52;")

      yield* Effect.promise(() => setup.mockMouse.drag(span.column, span.top, span.end, span.top))
      yield* waitUntil(
        () => output.written().includes(osc52(deviceUrl)),
        "the OSC 52 copy of the URL",
      )
      expect(output.written()).toContain(osc52(deviceUrl))
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a URL that wraps copies whole, with no line break where it wraps", () =>
    Effect.gen(function* () {
      const longUrl = `https://auth.example.com/oauth/authorize?client_id=gent&scope=${"x".repeat(150)}&state=end`
      const { setup, output, span } = yield* mountOAuthScreen(longUrl)
      expect(span.bottom).toBeGreaterThan(span.top)

      yield* Effect.promise(() =>
        setup.mockMouse.drag(span.column, span.top, span.end, span.bottom),
      )
      yield* waitUntil(() => output.written().includes("\u001b]52;"), "an OSC 52 copy")
      expect(output.written()).toContain(osc52(longUrl))
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a click on the URL selects nothing and copies nothing", () =>
    Effect.gen(function* () {
      const { setup, output, span } = yield* mountOAuthScreen(deviceUrl)

      yield* Effect.promise(() => setup.mockMouse.click(span.column + 3, span.top))
      yield* waitForFrame(setup, () => true)
      expect(output.written()).not.toContain("\u001b]52;")
    }).pipe(Effect.timeout("8 seconds")),
  )

  // A wrapped sign-in URL runs over several rows: a drag must start and end
  // on its exact first and last cells. One key copies it whole, as Codex,
  // Claude Code and OpenCode offer.
  it.scopedLive("ctrl+y on the sign-in pane copies the whole URL and says it did", () =>
    Effect.gen(function* () {
      const longUrl = `https://auth.example.com/oauth/authorize?client_id=gent&scope=${"x".repeat(150)}&state=end`
      const { setup, output } = yield* mountOAuthScreen(longUrl)
      expect(renderFrame(setup)).toContain("ctrl+y copy URL")

      setup.mockInput.pressKey("y", { ctrl: true })
      yield* waitUntil(() => output.written().includes(osc52(longUrl)), "the OSC 52 copy")
      yield* waitForFrame(setup, (frame) => frame.includes("URL copied"), "the copied note")
    }).pipe(Effect.timeout("8 seconds")),
  )

  // The copy key prints nothing, so every letter of a code typed by hand
  // reaches the code line, a first `c` or `C` too.
  it.scopedLive("a code typed by hand keeps every letter and copies nothing", () =>
    Effect.gen(function* () {
      const { setup, output } = yield* mountOAuthScreen(deviceUrl)
      yield* Effect.promise(() => setup.mockInput.typeText("cat"))
      yield* waitForFrame(setup, (frame) => frame.includes("optional): cat"), "the typed code")
      for (const _ of "cat") setup.mockInput.pressBackspace()
      yield* Effect.promise(() => setup.mockInput.typeText("Cat"))
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("optional): Cat"),
        "the capital code",
      )
      expect(frame).toContain("ctrl+y copy URL")
      expect(output.written()).not.toContain("\u001b]52;")
    }).pipe(Effect.timeout("8 seconds")),
  )

  // tmux drops an application's OSC 52 under its defaults: the DCS wrap needs
  // `allow-passthrough on`, a plain write `set-clipboard on`. `load-buffer -w`
  // reaches the outer terminal under the default `set-clipboard external`.
  it.scopedLive("inside tmux a copy also loads the text into tmux's clipboard", () =>
    Effect.gen(function* () {
      const runs: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
      const { setup, output } = yield* mountOAuthScreen(deviceUrl, recordedTmux(runs, tmuxEnv))

      setup.mockInput.pressKey("y", { ctrl: true })
      yield* waitUntil(() => runs.length > 0, "the tmux run")
      expect(runs).toEqual([{ args: ["load-buffer", "-w", "-"], stdin: deviceUrl }])
      expect(output.written()).toContain(Base64.encode(deviceUrl))
    }).pipe(Effect.timeout("8 seconds")),
  )

  // The run stops at its timeout. A tmux that ignores SIGTERM would hold the
  // run's cleanup open for good; it gets SIGKILL after a grace period.
  it.scopedLive(
    "a tmux that ignores SIGTERM is killed after the copy's timeout",
    () =>
      Effect.gen(function* () {
        const runs: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
        const children: Array<ChildProcessSpawner.ChildProcessHandle> = []
        const stubborn = recordedTmux(
          runs,
          tmuxEnv,
          ["sh", "-c", "trap '' TERM; sleep 30"],
          children,
        )
        const { setup } = yield* mountOAuthScreen(deviceUrl, stubborn)

        setup.mockInput.pressKey("y", { ctrl: true })
        yield* waitUntil(() => children.length > 0, "the stand-in tmux")
        const child = Option.fromNullishOr(children[0])
        if (Option.isNone(child)) return yield* Effect.die("no stand-in tmux")
        const running = child.value.isRunning.pipe(Effect.orElseSucceed(() => false))
        expect(yield* running).toBe(true)
        let stopped = false
        yield* waitUntilAdvancing(
          running.pipe(
            Effect.map((value) => {
              stopped = !value
            }),
          ),
          () => stopped,
          "the stand-in killed",
          6_000,
        )
      }).pipe(Effect.timeout("9 seconds")),
    12_000,
  )

  it.scopedLive("outside tmux a copy runs no tmux", () =>
    Effect.gen(function* () {
      const runs: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
      const { setup, output } = yield* mountOAuthScreen(deviceUrl, recordedTmux(runs, {}))

      setup.mockInput.pressKey("y", { ctrl: true })
      yield* waitUntil(() => output.written().includes(osc52(deviceUrl)), "the OSC 52 copy")
      expect(runs).toEqual([])
    }).pipe(Effect.timeout("8 seconds")),
  )

  // OpenTUI refuses an OSC 52 write on a terminal that reports no support. A
  // sent write is only an attempt (no terminal confirms one), so the note
  // says copied; a copy no route took says so, and how to copy instead.
  const refusesOsc52 = (setup: {
    renderer: { copyToClipboardOSC52: (text: string) => boolean }
  }) => {
    setup.renderer.copyToClipboardOSC52 = () => false
  }

  it.scopedLive("a copy no route takes says the clipboard is out of reach", () =>
    Effect.gen(function* () {
      const runs: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
      const { setup } = yield* mountOAuthScreen(deviceUrl, recordedTmux(runs, {}))
      refusesOsc52(setup)

      setup.mockInput.pressKey("y", { ctrl: true })
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Could not reach the clipboard"),
        "the unreachable note",
      )
      expect(frame).toContain("select the URL instead")
      expect(frame).not.toContain("URL copied")
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("tmux taking a copy the terminal refused still counts as copied", () =>
    Effect.gen(function* () {
      const runs: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
      const { setup } = yield* mountOAuthScreen(deviceUrl, recordedTmux(runs, tmuxEnv))
      refusesOsc52(setup)

      setup.mockInput.pressKey("y", { ctrl: true })
      yield* waitForFrame(setup, (next) => next.includes("URL copied"), "the copied note")
      expect(runs.length).toBe(1)
    }).pipe(Effect.timeout("8 seconds")),
  )

  // Inside tmux OpenTUI sends the DCS-wrapped OSC 52, which tmux drops by
  // default, so a sent write proves nothing there: only tmux's exit does. A
  // tmux too old for `load-buffer -w`, or with `set-clipboard off`, exits 1.
  it.scopedLive("inside tmux a copy tmux refuses is no copy, though OSC 52 was sent", () =>
    Effect.gen(function* () {
      const runs: Array<{ args: ReadonlyArray<string>; stdin: string }> = []
      const { setup, output } = yield* mountOAuthScreen(
        deviceUrl,
        recordedTmux(runs, tmuxEnv, ["false"]),
      )

      setup.mockInput.pressKey("y", { ctrl: true })
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Could not reach the clipboard"),
        "the unreachable note",
      )
      expect(frame).not.toContain("URL copied")
      expect(output.written()).toContain(Base64.encode(deviceUrl))
      expect(runs.length).toBe(1)
    }).pipe(Effect.timeout("8 seconds")),
  )
})

// ── agents view on the left arrow ───────────────────────────────────────────

describe("agents view on the left arrow", () => {
  const paneOpen = (frame: string) => frame.includes("Sessions ·")

  it.scopedLive("← on an empty composer opens the agents pane; ← again and Esc close it", () =>
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

  it.scopedLive(
    "/sessions filters on pasted and Unicode text, and the composer draft stays empty",
    () =>
      Effect.gen(function* () {
        const setup = yield* mountShortTerminalWithTrays(30)
        yield* typeCommand("/sessions")(setup)
        yield* waitForFrame(setup, paneOpen, "the agents pane")
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText("task 4"))
        yield* Effect.promise(() => setup.mockInput.typeText("é"))
        const filtered = yield* waitForFrame(
          setup,
          (frame) => frame.includes("› task 4é"),
          "the filter holds the paste and the typed letter",
        )
        expect(filtered).not.toContain("┃ task 4")
        expect(filtered).not.toContain("┃ é")
        // Esc clears the filter, Esc closes the pane: the composer holds only what is typed next.
        setup.mockInput.pressEscape()
        yield* waitForFrame(setup, (frame) => !frame.includes("› task 4"), "the filter cleared")
        setup.mockInput.pressEscape()
        yield* waitForFrame(setup, (frame) => !paneOpen(frame), "the pane closed")
        yield* Effect.promise(() => setup.mockInput.typeText("x"))
        const after = yield* waitForFrame(setup, (frame) => frame.includes("┃ x"), "the draft")
        expect(after).not.toContain("┃ task")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("← with a draft moves the text cursor and opens nothing", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(30)
      yield* Effect.promise(() => setup.mockInput.typeText("ac"))
      setup.mockInput.pressArrow("left")
      yield* Effect.promise(() => setup.mockInput.typeText("b"))
      const frame = yield* waitForFrame(setup, (current) => current.includes("┃ abc"), "abc")
      expect(paneOpen(frame)).toBe(false)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("← in shell mode opens nothing", () =>
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

  it.scopedLive("← in the command palette pops a level and opens no pane", () =>
    Effect.gen(function* () {
      const setup = yield* mountShortTerminalWithTrays(30)
      setup.mockInput.pressKey("p", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("esc close"), "the palette root")
      // Theme is the first row.
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("esc back"), "the theme level")
      setup.mockInput.pressArrow("left")
      const frame = yield* waitForFrame(
        setup,
        (current) => current.includes("esc close"),
        "the palette root again",
      )
      expect(paneOpen(frame)).toBe(false)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("→ on a row switches to that agent and closes the pane", () =>
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
      expect(client.session().sessionId).toEqual(SessionId.make("child-4"))
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("TUI renderer surfaces", () => {
  // The answer in progress is the one the feed holds open, not the row that
  // sorts last. A step's answer is stored before its tools run; through the
  // tool run the turn is still running, and the stored answer draws its
  // diagram.
  it.scopedLive("a stored answer draws its diagram while its tool runs", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-diagram")
      const branchId = BranchId.make("branch-diagram")
      const envelope = (id: number, event: EventEnvelope["event"]) =>
        EventEnvelope.make({ id: EventId.make(id), createdAt: id, event })
      const answerId = MessageId.make("answer-diagram")
      const client = {
        session: {
          events: () =>
            Stream.concat(
              Stream.make(
                envelope(
                  0,
                  AgentEvent.cases.StreamSynchronized.make({
                    sessionId,
                    branchId,
                    lastEventId: EventId.make(0),
                  }),
                ),
                envelope(
                  1,
                  AgentEvent.cases.MessageReceived.make({
                    message: StoredMessage.cases.regular.make({
                      id: MessageId.make("ask-diagram"),
                      sessionId,
                      branchId,
                      role: "user",
                      parts: [Prompt.textPart({ text: "draw it" })],
                      createdAt: dateFromMillis(1),
                    }),
                  }),
                ),
                envelope(
                  2,
                  AgentEvent.cases.MessageReceived.make({
                    message: StoredMessage.cases.regular.make({
                      id: answerId,
                      sessionId,
                      branchId,
                      role: "assistant",
                      parts: [
                        Prompt.textPart({
                          text: "```mermaid\ngraph LR\n  Alpha-->Beta\n```",
                        }),
                      ],
                      createdAt: dateFromMillis(2),
                    }),
                  }),
                ),
                envelope(
                  3,
                  AgentEvent.cases.ToolCallStarted.make({
                    sessionId,
                    branchId,
                    toolCallId: ToolCallId.make("call-diagram"),
                    toolName: "bash",
                    input: { command: "sleep 20" },
                    assistantMessageId: answerId,
                  }),
                ),
              ),
              Stream.never,
            ),
        },
      }
      const { setup } = yield* mountApp({
        client,
        width: 80,
        height: 30,
        initialSession: sessionNamed(sessionId, branchId, "Diagram"),
      })
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("Alpha") && next.includes("sleep 20"),
        "the answer and its running tool",
      )
      // Drawn: the box's edge, and no raw edge statement.
      expect(frame).not.toContain("Alpha-->Beta")
      expect(frame).toContain("┌")
    }).pipe(Effect.timeout("4 seconds")),
  )
  // A text too wide for its column is cut once, at its end, by gent; the
  // renderer's own cut (`...` in the middle) never shows.
  it.scopedLive("at 40 columns the slash popup and the palette cut a text once, at its end", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { width: 40 })
      yield* Effect.promise(() => view.setup.mockInput.typeText("/frec"))
      const popup = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("Forget"),
        "the popup row",
      )
      const popupRow = popup.split("\n").find((line) => line.includes("Forget")) ?? ""
      expect(popupRow).not.toContain("...")
      expect(popupRow.trimEnd().endsWith("…")).toBe(true)
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("Forget"), "popup closed")
      view.setup.mockInput.pressKey("c", { ctrl: true })
      view.setup.mockInput.pressKey("p", { ctrl: true })
      const palette = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("[All]"),
        "the palette",
      )
      const title = palette.split("\n").find((line) => line.includes("[All]")) ?? ""
      expect(title).not.toContain("...")
      const paletteRows = palette.split("\n").filter((line) => line.includes("Forget"))
      for (const row of paletteRows) expect(row).not.toContain("...")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // A command has its title and its slash names; the palette search finds it
  // by either, as the `/` popup finds it by the slash name. A query spelled
  // as the composer spells the command, with its "/", finds it too.
  it.scopedLive("the palette search finds a command by its slash name and its alias", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession(createMockRuntime(), { width: 80 })
      for (const [query, title] of [
        ["frecency", "Reset Autocomplete Ranking"],
        ["clear", "New Session"],
        ["/clear", "New Session"],
      ] as const) {
        view.setup.mockInput.pressKey("p", { ctrl: true })
        yield* waitForFrame(view.setup, (frame) => frame.includes("[All]"), "the palette")
        yield* Effect.promise(() => view.setup.mockInput.typeText(query))
        yield* waitForFrame(
          view.setup,
          (frame) => frame.includes(`› ${query}`) && frame.includes(title),
          `${title} found by ${query}`,
        )
        view.setup.mockInput.pressEscape()
        yield* waitForFrame(
          view.setup,
          (frame) => !frame.includes(`› ${query}`),
          "the query cleared",
        )
        view.setup.mockInput.pressEscape()
        yield* waitForFrame(view.setup, (frame) => !frame.includes("[All]"), "the palette closed")
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  // One dock slot: the status row stays under the input, and the slash popup,
  // the palette and the panes all dock under it.
  it.scopedLive("every docked pane, the slash popup included, docks under the status row", () =>
    Effect.gen(function* () {
      const view = yield* mountIdleSession()
      const statusRowAbove = (frame: string, title: string) => {
        const lines = frame.split("\n")
        const status = lines.findIndex((line) => line.startsWith("ready ·"))
        const pane = lines.findIndex((line) => line.startsWith(title))
        return status >= 0 && pane > status
      }
      yield* Effect.promise(() => view.setup.mockInput.typeText("/"))
      const popup = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("Commands"),
        "the slash popup",
      )
      expect(statusRowAbove(popup, "Commands")).toBe(true)
      view.setup.mockInput.pressKey("c", { ctrl: true })
      yield* waitForFrame(view.setup, (frame) => !frame.includes("Commands"), "the draft cleared")
      view.setup.mockInput.pressKey("p", { ctrl: true })
      const palette = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("esc close"),
        "the palette",
      )
      expect(statusRowAbove(palette, "Commands")).toBe(true)
      view.setup.mockInput.pressEscape()
      yield* waitForFrame(view.setup, (frame) => !frame.includes("esc close"), "palette closed")
      yield* typeCommand("/effort")(view.setup)
      const effort = yield* waitForFrame(
        view.setup,
        (frame) => frame.includes("Effort ·"),
        "the effort pane",
      )
      expect(statusRowAbove(effort, "Effort ·")).toBe(true)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a resumed session with turns behind it reads idle, not ready", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
      const { setup } = yield* mountApp({
        client: {
          session: {
            getSnapshot: () =>
              Effect.succeed({
                sessionId,
                branchId,
                messages: [],
                lastEventId: nullValue,
                reasoningLevel: absent,
                resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
                agent: AgentName.make("primary"),
                runtime: { _tag: idleTag, queue: emptyQueueSnapshot() },
                metrics: { turns: 3, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
              }),
          },
        },
        initialSession: sessionNamed(sessionId, branchId, "Resumed"),
      })
      yield* waitForFrame(setup, (drawn) => drawn.includes("idle ·"), "the resumed status")
      expect(renderFrame(setup)).not.toContain("ready ·")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "waiting entries sit dim in the reader's lane above the composer until delivered or restored",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-queue")
        const branchId = BranchId.make("branch-queue")
        const queue = new QueueSnapshot({
          steering: [
            {
              _tag: "Steering",
              id: MessageId.make("steer-queue"),
              content: "STEER-WAIT",
              createdAt: 0,
              metadata: { fromClient: true },
            },
          ],
          followUp: [
            {
              _tag: "FollowUp",
              id: MessageId.make("follow-queue"),
              content: "FOLLOW-WAIT",
              createdAt: 1,
              metadata: { fromClient: true },
            },
          ],
        })
        const running = { _tag: "Running" satisfies "Running", startedAtMs: 0, queue }
        const runtimes = yield* Queue.unbounded<typeof running>()
        const events = yield* Queue.unbounded<EventEnvelope>()
        const sent: string[] = []
        const steers: string[] = []
        const { setup } = yield* mountApp({
          client: {
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
              watchRuntime: () => Stream.fromQueue(runtimes),
              events: () => Stream.fromQueue(events),
            },
            queue: {
              drain: () =>
                Queue.offer(runtimes, { ...running, queue: emptyQueueSnapshot() }).pipe(
                  Effect.as(queue),
                ),
            },
            message: {
              send: (input: { content: string }) =>
                Effect.sync(() => {
                  sent.push(input.content)
                }),
            },
            steer: {
              command: (input: { command: { _tag: string } }) =>
                Effect.sync(() => {
                  steers.push(input.command._tag)
                }),
            },
          },
          initialSession: sessionNamed(sessionId, branchId, "Queue"),
        })
        yield* Effect.promise(() => setup.mockInput.typeText("COMPOSER-DRAFT"))
        const sizes: ReadonlyArray<readonly [number, number]> = [
          [100, 30],
          [60, 20],
          [90, 25],
        ]
        for (const [width, height] of sizes) {
          setup.resize(width, height)
          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("┊ next turn · FOLLOW-WAIT") && next.includes("COMPOSER-DRAFT"),
            "pinned queue",
          )
          // Between the live line and the composer, the steer (read at the next step) first.
          const order = [
            "✻ Thinking",
            "┊ next step · STEER-WAIT",
            "┊ next turn · FOLLOW-WAIT",
            "alt+up edit",
            "COMPOSER-DRAFT",
          ].map((text) => frame.indexOf(text))
          expect(order.every((at) => at >= 0)).toBe(true)
          expect(order).toEqual(order.toSorted((a, b) => a - b))
          expect(frame.match(/STEER-WAIT/g)).toHaveLength(1)
          expect(frame.match(/FOLLOW-WAIT/g)).toHaveLength(1)
          // The reader's lane, dashed: not a delivered message's rail.
          const row = frame.split("\n").find((line) => line.includes("FOLLOW-WAIT")) ?? ""
          expect(row.startsWith("┊ next turn · ")).toBe(true)
          expect(row).not.toContain("┃")
        }
        yield* Queue.offer(runtimes, {
          ...running,
          queue: new QueueSnapshot({ steering: [], followUp: queue.followUp }),
        })
        yield* Queue.offer(
          events,
          EventEnvelope.make({
            id: EventId.make(1),
            createdAt: 1,
            event: AgentEvent.cases.MessageReceived.make({
              message: StoredMessage.cases.interjection.make({
                id: MessageId.make("steer-queue"),
                sessionId,
                branchId,
                role: "user",
                parts: [Prompt.textPart({ text: "STEER-WAIT" })],
                createdAt: dateFromMillis(1),
                metadata: { fromClient: true },
              }),
            }),
          }),
        )
        // Delivered: it leaves the pinned rows and lands in the transcript as a user message.
        const delivered = yield* waitForFrame(
          setup,
          (next) => !next.includes("┊ next step") && next.includes("STEER-WAIT"),
          "delivered steer",
        )
        expect(delivered.match(/STEER-WAIT/g)).toHaveLength(1)
        expect(delivered.indexOf("STEER-WAIT")).toBeLessThan(delivered.indexOf("✻"))
        const landed = delivered.split("\n").find((line) => line.includes("STEER-WAIT")) ?? ""
        expect(landed).toContain("┃")
        expect(delivered).toContain("┊ next turn · FOLLOW-WAIT")
        setup.mockInput.pressArrow("up", { meta: true })
        const restored = yield* waitForFrame(
          setup,
          (next) => !next.includes("┊ next turn") && next.includes("FOLLOW-WAIT"),
          "restored queue",
        )
        expect(restored.match(/FOLLOW-WAIT/g)).toHaveLength(1)
        expect(restored).toContain("COMPOSER-DRAFT")
        expect(restored).not.toContain("alt+up edit")
        expect(sent).toEqual([])
        expect(steers).toEqual([])
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a message another agent queued draws nowhere until delivered, then once in the transcript",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-agent-queue")
        const branchId = BranchId.make("branch-agent-queue")
        const reader: QueueEntryInfo = {
          _tag: "FollowUp",
          id: MessageId.make("reader-queue"),
          content: "READER-WAIT",
          createdAt: 1,
          metadata: { fromClient: true },
        }
        // A child's `Session.send` with delivery `queue`: no client origin.
        const agent: QueueEntryInfo = {
          _tag: "FollowUp",
          id: MessageId.make("agent-queue"),
          content: "AGENT-WAIT",
          createdAt: 0,
          metadata: { extensionId: "@gent/delegate" },
        }
        const running = {
          _tag: "Running" satisfies "Running",
          startedAtMs: 0,
          queue: new QueueSnapshot({ steering: [], followUp: [agent, reader] }),
        }
        const runtimes = yield* Queue.unbounded<typeof running>()
        const events = yield* Queue.unbounded<EventEnvelope>()
        const { setup } = yield* mountApp({
          client: {
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
              watchRuntime: () => Stream.concat(Stream.make(running), Stream.fromQueue(runtimes)),
              events: () => Stream.fromQueue(events),
            },
          },
          initialSession: sessionNamed(sessionId, branchId, "Agent queue"),
        })
        for (const [width, height] of [
          [100, 30],
          [60, 20],
        ] as const) {
          setup.resize(width, height)
          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("┊ next turn · READER-WAIT"),
            "the reader's entry",
          )
          // Only the reader's own entry: the agent's is neither pinned, counted nor in the transcript.
          expect(frame).not.toContain("AGENT-WAIT")
          expect(frame).not.toContain("more")
          expect(frame.match(/┊/g)).toHaveLength(1)
        }
        // Delivered: the agent's message lands in the transcript, once.
        yield* Queue.offer(runtimes, {
          ...running,
          queue: new QueueSnapshot({ steering: [], followUp: [reader] }),
        })
        yield* Queue.offer(
          events,
          EventEnvelope.make({
            id: EventId.make(1),
            createdAt: 1,
            event: AgentEvent.cases.MessageReceived.make({
              message: StoredMessage.cases.regular.make({
                id: MessageId.make("agent-queue"),
                sessionId,
                branchId,
                role: "user",
                parts: [Prompt.textPart({ text: "AGENT-WAIT" })],
                createdAt: dateFromMillis(1),
                metadata: { extensionId: "@gent/delegate" },
              }),
            }),
          }),
        )
        const delivered = yield* waitForFrame(
          setup,
          (next) => next.includes("AGENT-WAIT"),
          "the agent's message delivered",
        )
        expect(delivered.match(/AGENT-WAIT/g)).toHaveLength(1)
        expect(delivered.indexOf("AGENT-WAIT")).toBeLessThan(delivered.indexOf("✻"))
        expect(delivered).toContain("┊ next turn · READER-WAIT")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a waiting entry is one dim truncated row at every width", () =>
    Effect.gen(function* () {
      let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
      const setup = yield* renderScoped(
        () => {
          colors = Option.some(useTheme().theme)
          return (
            <QueueWidget
              steerMessages={[]}
              queuedMessages={[
                {
                  _tag: "FollowUp",
                  id: MessageId.make("long-queue"),
                  content: "QUEUE-START " + "wide text ".repeat(20) + "QUEUE-END",
                  createdAt: 0,
                  metadata: { fromClient: true },
                },
              ]}
              messageRenderers={new Map()}
            />
          )
        },
        { width: 60, height: 20 },
      )
      const theme = yield* Option.match(colors, {
        onNone: () => Effect.die("no theme"),
        onSome: Effect.succeed,
      })
      for (const width of [60, 32, 100]) {
        setup.resize(width, 20)
        yield* Effect.promise(() => setup.renderOnce())
        const lines = renderFrame(setup)
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
        expect(lines).toHaveLength(2)
        expect(lines[0]?.startsWith("┊ next turn · QUEUE-START")).toBe(true)
        expect(lines[0]).toContain("…")
        expect(lines[1]).toBe("  alt+up edit")
        expect(renderFrame(setup)).not.toContain("QUEUE-END")
        // The whole row is dim, the dashed rail too: not a message's text color.
        const row = setup
          .captureSpans()
          .lines.find((line) => line.spans.some((span) => span.text.includes("QUEUE-START")))
        const drawn = (row?.spans ?? []).filter((span) => span.text.trim().length > 0)
        expect(drawn.length).toBeGreaterThan(0)
        expect(drawn.every((span) => span.fg.equals(theme.textMuted))).toBe(true)
      }
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a waiting entry names its other lines, and past three entries the rest count",
    () =>
      Effect.gen(function* () {
        const entry = (id: string, content: string): QueueEntryInfo => ({
          _tag: "FollowUp",
          id: MessageId.make(id),
          content,
          createdAt: 0,
          metadata: { fromClient: true },
        })
        const setup = yield* renderScoped(
          () => (
            <QueueWidget
              steerMessages={[]}
              queuedMessages={[
                entry("q1", "MULTI-HEAD " + "long ".repeat(20) + "\nsecond line\nthird line"),
                entry("q2", "SECOND-ENTRY"),
                entry("q3", "THIRD-ENTRY"),
                entry("q4", "FOURTH-ENTRY"),
                entry("q5", "FIFTH-ENTRY"),
              ]}
              messageRenderers={new Map()}
            />
          ),
          { width: 60, height: 12 },
        )
        for (const width of [60, 40]) {
          setup.resize(width, 12)
          yield* Effect.promise(() => setup.renderOnce())
          const lines = renderFrame(setup)
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0)
          expect(lines).toEqual([
            expect.stringMatching(/^┊ next turn · MULTI-HEAD .*… \+2 lines$/),
            "┊ next turn · SECOND-ENTRY",
            "┊ next turn · THIRD-ENTRY",
            "┊ +2 more",
            "  alt+up edit",
          ])
          expect(lines[0]?.length).toBeLessThan(width)
        }
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "the live line counts the whole turn through its tool calls and an ask, and the next turn starts again",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const onClock = createMockRuntime(new Map([[Clock.Clock.key, clock]]))
        const sessionId = SessionId.make("session-timer")
        const branchId = BranchId.make("branch-timer")
        const running = {
          _tag: "Running" satisfies "Running",
          startedAtMs: 0,
          queue: emptyQueueSnapshot(),
        }
        const runtimes = yield* Queue.unbounded<{
          readonly _tag: "Running" | "WaitingForInteraction"
          readonly startedAtMs: number
          readonly queue: typeof running.queue
        }>()
        const events = yield* Queue.unbounded<EventEnvelope>()
        const { setup } = yield* mountApp({
          runtime: { ...createMockRuntime(), cast: onClock.cast, fork: onClock.fork },
          client: {
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
              watchRuntime: () => Stream.concat(Stream.make(running), Stream.fromQueue(runtimes)),
              events: () => Stream.fromQueue(events),
            },
          },
          initialSession: sessionNamed(sessionId, branchId, "Timer"),
        })
        const event = (id: number, agentEvent: AgentEvent) =>
          Queue.offer(
            events,
            EventEnvelope.make({ id: EventId.make(id), createdAt: id, event: agentEvent }),
          )
        // No answer text yet: the model thinks.
        yield* waitForFrame(setup, (next) => next.includes("✻ Thinking ·"), "the turn")
        yield* clock.adjust(Duration.seconds(4))
        yield* waitForFrame(setup, (next) => next.includes("✻ Thinking (4s)"), "4s in")
        // A tool call changes the phase word, not the count.
        yield* event(
          1,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("timer-call"),
            toolName: "bash",
            input: { command: "TIMER-TOOL" },
          }),
        )
        yield* waitForFrame(
          setup,
          (next) => next.includes("✻ Running TIMER-TOOL (4s)") && !next.includes("Thinking"),
          "the tool keeps the count",
        )
        yield* clock.adjust(Duration.seconds(3))
        yield* waitForFrame(setup, (next) => next.includes("✻ Running TIMER-TOOL (7s)"), "7s in")
        yield* event(
          2,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("timer-call"),
            toolName: "bash",
            summary: "done",
            output: "{}",
          }),
        )
        yield* waitForFrame(setup, (next) => next.includes("✻ Thinking (7s)"), "back to the turn")
        // Answer text streams: the model generates.
        yield* event(3, AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "ANSWER" }))
        yield* waitForFrame(setup, (next) => next.includes("✻ Generating (7s)"), "the answer")
        // An ask inside the turn: the same turn, the same count.
        yield* Queue.offer(runtimes, {
          ...running,
          _tag: "WaitingForInteraction" satisfies "WaitingForInteraction",
        })
        yield* waitForFrame(
          setup,
          (next) => next.includes("✻ Waiting for your answer (7s)"),
          "the ask",
        )
        // The next turn counts from its own start.
        yield* Queue.offer(runtimes, {
          ...running,
          _tag: "Running" satisfies "Running",
          startedAtMs: clock.currentTimeMillisUnsafe(),
        })
        yield* waitForFrame(
          setup,
          (next) => next.includes("✻ Generating ·") && !next.includes("(7s)"),
          "the next turn",
        )
        yield* clock.adjust(Duration.seconds(2))
        yield* waitForFrame(setup, (next) => next.includes("✻ Generating (2s)"), "2s into the next")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a pending retry is the live line's phase and counts down; the transcript draws no row for it",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const onClock = createMockRuntime(new Map([[Clock.Clock.key, clock]]))
        const sessionId = SessionId.make("session-retry-phase")
        const branchId = BranchId.make("branch-retry-phase")
        const running = {
          _tag: "Running" satisfies "Running",
          startedAtMs: 0,
          queue: emptyQueueSnapshot(),
        }
        const events = yield* Queue.unbounded<EventEnvelope>()
        const { setup } = yield* mountApp({
          runtime: { ...createMockRuntime(), cast: onClock.cast, fork: onClock.fork },
          client: {
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
              watchRuntime: () => Stream.concat(Stream.make(running), Stream.never),
              events: () => Stream.fromQueue(events),
            },
          },
          initialSession: sessionNamed(sessionId, branchId, "Retry phase"),
        })
        const event = (id: number, agentEvent: AgentEvent) =>
          Queue.offer(
            events,
            EventEnvelope.make({ id: EventId.make(id), createdAt: id, event: agentEvent }),
          )
        yield* waitForFrame(setup, (next) => next.includes("✻ Thinking ·"), "the turn")
        yield* event(
          1,
          AgentEvent.cases.ProviderRetrying.make({
            sessionId,
            branchId,
            attempt: 1,
            maxAttempts: 3,
            delayMs: 3_000,
            error: "Rate limit exceeded",
          }),
        )
        const retrying = yield* waitForFrame(
          setup,
          (next) => next.includes("✻ Retrying in 3s · 1/3 · Rate limit exceeded"),
          "the retry phase",
        )
        // The live line is the retry's one row.
        expect(retrying.split("\n").filter((line) => line.includes("Retr"))).toHaveLength(1)
        yield* clock.adjust(Duration.seconds(2))
        yield* waitForFrame(setup, (next) => next.includes("✻ Retrying in 1s · 1/3"), "1s left")
        // The retry ran: the model answers, and the settled retry waits for the preview.
        yield* event(2, AgentEvent.cases.StreamStarted.make({ sessionId, branchId }))
        yield* event(3, AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "ANSWER" }))
        const answering = yield* waitForFrame(
          setup,
          (next) => next.includes("✻ Generating") && next.includes("ANSWER"),
          "the answer",
        )
        expect(answering).not.toContain("Retr")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("QueueWidget renders steer and queued summaries", () =>
    Effect.gen(function* () {
      const steerMessages: QueueEntryInfo[] = [
        {
          _tag: "Steering",
          id: MessageId.make("m1"),
          content: "switch to secondary",
          createdAt: 0,
          metadata: { fromClient: true },
        },
      ]
      const queuedMessages: QueueEntryInfo[] = [
        {
          _tag: "FollowUp",
          id: MessageId.make("m2"),
          content: "line one\nline two\nline three",
          createdAt: 0,
          metadata: { fromClient: true },
        },
      ]
      const setup = yield* renderScoped(() => (
        <QueueWidget
          queuedMessages={queuedMessages}
          steerMessages={steerMessages}
          messageRenderers={new Map()}
        />
      ))
      const frame = renderFrame(setup)
      expect(frame).toContain("┊ next step · switch to secondary")
      expect(frame).toContain("┊ next turn · line one +2 lines")
      expect(frame).toContain("alt+up edit")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget renders nothing when no connection issue", () =>
    Effect.gen(function* () {
      // ConnectionWidget reads the client itself. The default mock client has
      // no connection issue, so the widget draws nothing.
      const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />)
      const frame = renderFrame(setup)
      expect(frame).not.toContain("connection")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget surfaces failed extension activation", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />, {
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
      })
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("1 extension failed")
      // The reason, not only the id: a broken config names its parse error.
      expect(frame).toContain("@gent/memory: startup boom")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget names the version a failed reload still runs", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />, {
        width: 100,
        client: createMockClient({
          extension: {
            listStatus: () =>
              Effect.succeed({
                _tag: "Degraded",
                healthyExtensions: [],
                degradedExtensions: [
                  {
                    manifest: { id: "@user/notes" },
                    scope: "user",
                    sourcePath: "/home/u/.gent/extensions/notes.ts",
                    _tag: "Degraded",
                    issues: [
                      {
                        _tag: "ActivationFailed",
                        phase: "setup",
                        error: "setup boom",
                        runningVersion: "0123456789abcdef0123",
                      },
                    ],
                  },
                ],
              }),
          },
        }),
      })
      const frame = renderFrame(setup)
      expect(frame).toContain("1 extension failed")
      expect(frame).toContain("@user/notes: setup boom; version 0123456789ab still runs")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget names a model catalog that did not load", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />, {
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
      })
      const frame = renderFrame(setup)
      expect(frame).toContain("1 model catalog unavailable")
      expect(frame).toContain("ollama: connect ECONNREFUSED")
      expect(frame).not.toContain("1 extension failed")
    }).pipe(Effect.timeout("10 seconds")),
  )
  // The widget is a node on the ctrl+o ladder: collapsed counts the issues on
  // one line; preview and full list one tree row each.
  const catalogFailures = (count: number) =>
    createMockClient({
      extension: {
        listStatus: () =>
          Effect.succeed({
            _tag: "Degraded",
            healthyExtensions: [],
            degradedExtensions: [
              {
                manifest: { id: "@gent/providers" },
                scope: "builtin",
                sourcePath: "builtin",
                _tag: "Degraded",
                issues: Array.from({ length: count }, (_, index) => ({
                  _tag: "ModelCatalogFailed" as const,
                  driverId: `driver-${index + 1}`,
                  error:
                    "models.dev catalog unavailable: no snapshot stored and models.dev unreachable",
                })),
              },
            ],
          }),
      },
    })
  it.scopedLive("ConnectionWidget folds to one line at collapsed, at 120 and 60 columns", () =>
    Effect.gen(function* () {
      for (const width of [120, 60]) {
        const setup = yield* renderScoped(() => <ConnectionWidget disclosure="collapsed" />, {
          client: catalogFailures(6),
          width,
          height: 12,
        })
        const lines = renderFrame(setup)
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
        expect(lines).toEqual(["  • connection · 6 model catalogs unavailable · ctrl+o"])
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget lists one tree row per issue at preview, cut to the width", () =>
    Effect.gen(function* () {
      for (const width of [120, 60]) {
        const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />, {
          client: catalogFailures(3),
          width,
          height: 12,
        })
        const lines = renderFrame(setup)
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
        expect(lines[0]).toBe("  • connection · 3 model catalogs unavailable")
        expect(lines.slice(1).map((line) => line.slice(0, 15))).toEqual([
          "  ├ driver-1: m",
          "  ├ driver-2: m",
          "  └ driver-3: m",
        ])
        expect(lines.every((line) => line.length <= width - 1)).toBe(true)
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget keeps a failed extension's row at collapsed", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ConnectionWidget disclosure="collapsed" />, {
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
                      { _tag: "ActivationFailed", phase: "startup", error: "startup boom" },
                      { _tag: "ModelCatalogFailed", driverId: "ollama", error: "ECONNREFUSED" },
                    ],
                  },
                ],
              }),
          },
        }),
        width: 60,
        height: 12,
      })
      const lines = renderFrame(setup)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
      expect(lines).toEqual([
        "  • connection · 1 extension failed · 1 model cat… · ctrl+o",
        "  └ @gent/memory: startup boom",
      ])
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget surfaces failed extensions for the active session", () =>
    Effect.gen(function* () {
      const scopes: Array<ExtensionStatusScope> = []
      const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />, {
        initialSession: testSession,
        client: createMockClient({
          extension: {
            listStatus: ({ scope }: { scope: ExtensionStatusScope }) => {
              scopes.push(scope)
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
      })
      const frame = renderFrame(setup)
      expect(frame).toContain("connection")
      expect(frame).toContain("1 extension failed")
      expect(frame).toContain("@gent/plan")
      expect(scopes).not.toHaveLength(0)
      for (const scope of scopes) expect(scope).toEqual({ _tag: "Session", id: testSession.id })
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "ConnectionWidget refreshes extension status after reconnect generation changes",
    () =>
      Effect.gen(function* () {
        const lifecycle = createMutableRuntime(
          ConnectionState.cases.Connected.make({ generation: 0 }),
        )
        let callCount = 0
        const scopes: Array<ExtensionStatusScope> = []
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
        const setup = yield* renderScoped(() => <ConnectionWidget disclosure="preview" />, {
          initialSession: testSession,
          runtime: lifecycle.runtime,
          client: createMockClient({
            extension: {
              listStatus: ({ scope }: { scope: ExtensionStatusScope }) => {
                callCount += 1
                scopes.push(scope)
                return Effect.succeed(currentHealth)
              },
            },
          }),
        })
        expect(renderFrame(setup)).toContain("1 extension failed")
        expect(callCount).toBe(1)
        currentHealth = {
          _tag: "Healthy",
          extensions: [],
        }
        lifecycle.emit(ConnectionState.cases.Reconnecting.make({ attempt: 1, generation: 1 }))
        yield* Effect.yieldNow
        yield* Effect.promise(() => setup.renderOnce())
        lifecycle.emit(ConnectionState.cases.Connected.make({ generation: 1 }))
        const frame = yield* waitForFrame(
          setup,
          (next) => !next.includes("failed extensions"),
          "the status read again",
        )
        expect(callCount).toBe(2)
        for (const scope of scopes) expect(scope).toEqual({ _tag: "Session", id: testSession.id })
        expect(frame).not.toContain("1 extension failed")
        expect(frame).not.toContain("@gent/plan")
      }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("ConnectionWidget clears stale extension status when switching sessions", () =>
    Effect.gen(function* () {
      let controls = Option.none<{
        switchSession: () => void
      }>()
      const setup = yield* renderScoped(
        () => (
          <>
            <ConnectionWidget disclosure="preview" />
            <HealthControlsProbe expose={(next) => (controls = Option.some(next))} />
          </>
        ),
        {
          initialSession: testSession,
          client: createMockClient({
            extension: {
              listStatus: ({ scope }: { scope: ExtensionStatusScope }) => {
                if (scope._tag === "Session" && scope.id === testSession.id) {
                  return Effect.succeed(scheduledFailureHealth("@gent/plan", "launchd boom"))
                }
                return Effect.succeed(healthyHealth)
              },
            },
          }),
        },
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      if (Option.isNone(controls)) return yield* Effect.die("health controls not ready")
      controls.value.switchSession()
      const frame = yield* waitForFrame(
        setup,
        (next) => !next.includes("failed extensions"),
        "the other session's status",
      )
      expect(frame).not.toContain("@gent/plan")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("same-session branch switches preserve session-scoped extension health", () =>
    Effect.gen(function* () {
      let controls = Option.none<{
        switchSession: () => void
        switchBranchSameSession: () => void
      }>()
      const setup = yield* renderScoped(
        () => (
          <>
            <HealthControlsProbe expose={(value) => (controls = Option.some(value))} />
            <ConnectionWidget disclosure="preview" />
          </>
        ),
        {
          initialSession: testSession,
          client: createMockClient({
            extension: {
              listStatus: ({ scope }: { scope: ExtensionStatusScope }) => {
                if (scope._tag === "Session" && scope.id === testSession.id) {
                  return Effect.succeed(scheduledFailureHealth("@gent/plan", "launchd boom"))
                }
                return Effect.succeed(healthyHealth)
              },
            },
          }),
        },
      )
      expect(renderFrame(setup)).toContain("@gent/plan")
      if (Option.isNone(controls)) return yield* Effect.die("health controls not ready")
      controls.value.switchBranchSameSession()
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("1 extension failed")
      expect(frame).toContain("@gent/plan")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── debug playground ────────────────────────────────────────────────────────

describe("debug playground", () => {
  it.live(
    "the session view renders the seeded transcript with the shipped tool ids",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
          const server = yield* Gent.server({
            cwd,
            seed: seedDebugSession(cwd),
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
            // The shipped tools draw the transcript. The provider drivers
            // would list their models.dev catalog, which a cold home fetches;
            // the scripted model needs none of them.
            extensions: BuiltinExtensions.filter(
              (extension) => !extension.manifest.id.startsWith("@gent/provider-"),
            ),
          })
          const { client, runtime } = yield* Gent.client(server, { cwd })
          const [session] = yield* client.session.list()
          const initialSession = yield* Effect.fromNullishOr(session)
          const setup = yield* renderScoped(() => <App />, {
            client,
            runtime,
            initialSession,
            cwd,
            width: 120,
            height: 40,
          })
          const frame = yield* waitForTerminal(
            setup,
            (text) =>
              text.includes("Review the TUI renderer cleanup") && text.includes("◆ explore"),
            "seeded transcript",
            5_000,
          )
          setup.renderer.destroy()
          expect(frame).toContain(
            "● Read 1 file · searched 1 pattern · ran 1 command · edited 1 file · wrote 1 file",
          )
          expect(frame).toContain("● Started 2 agents · read 1 session")
          expect(frame).toContain("Audit lines up")
          // The child's report is its own muted row, off the reader's rail.
          expect(frame).toContain(
            "  » child explore · 0e493eaf · The double border comes from two surfaces drawing one",
          )
          expect(frame).toContain(
            "  ◆ explore · Read 4 files · searched 2 patterns · 41s · ↑1.2k ↓300 $0.01",
          )
          expect(frame).toContain("┃ Review the TUI renderer cleanup")
          expect(frame).not.toContain("┃ » ")
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )
})

describe("client extension status", () => {
  // Opening a session replays its stored pulses. They are history: the
  // session reads health once for all of them, when the replay ends. A live
  // pulse after it reads health again.
  it.scopedLive("a session whose log holds many extension pulses reads health once for them", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-pulses")
      const branchId = BranchId.make("branch-pulses")
      let healthReads = 0
      const envelope = (id: number, event: EventEnvelope["event"]) =>
        EventEnvelope.make({ id: EventId.make(id), createdAt: id, event })
      const pulse = (id: number) =>
        envelope(
          id,
          AgentEvent.cases.ExtensionStateChanged.make({
            sessionId,
            branchId,
            extensionId: ExtensionId.make("pulse-source"),
          }),
        )
      const idle = { _tag: "Idle" satisfies "Idle", queue: emptyQueueSnapshot() }
      const client = {
        extension: {
          listStatus: () =>
            Effect.sync(() => {
              healthReads += 1
              return { _tag: "Healthy" satisfies "Healthy", extensions: [] }
            }),
        },
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId,
              branchId,
              messages: [],
              lastEventId: 5,
              reasoningLevel: absent,
              resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
              agent: AgentName.make("main"),
              runtime: idle,
              metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
            }),
          watchRuntime: () => Stream.concat(Stream.make(idle), Stream.never),
          events: () =>
            Stream.concat(
              Stream.make(
                pulse(1),
                pulse(2),
                pulse(3),
                pulse(4),
                pulse(5),
                envelope(
                  5,
                  AgentEvent.cases.StreamSynchronized.make({
                    sessionId,
                    branchId,
                    lastEventId: EventId.make(5),
                  }),
                ),
                pulse(6),
              ),
              Stream.never,
            ),
        },
      }
      const { setup } = yield* mountApp({
        client,
        initialSession: sessionNamed(sessionId, branchId, "Pulses"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      // The mount read, one read for the replayed five, and one for the live pulse.
      yield* waitUntil(() => healthReads >= 3, "the live pulse reads health")
      yield* waitForFrame(setup, () => true)
      expect(healthReads).toBe(3)
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive(
    "a turn's end loads a client file written since the last load, and the shell's reload loads an edit at once",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sessionId = SessionId.make("session-client-reload")
        const branchId = BranchId.make("branch-client-reload")
        let shell = Option.none<ClientContext["Service"]["shell"]>()
        const shellProbe = defineClientExtension("@test/shell-probe", {
          setup: Effect.gen(function* () {
            shell = Option.some((yield* ClientContext).shell)
            return {}
          }),
        })
        let held = Option.none<{
          readonly ext: ReturnType<typeof useExtensionUI>
          readonly home: string
        }>()
        const Probe = () => {
          const ext = useExtensionUI()
          const workspace = useWorkspace()
          held = Option.some({ ext, home: workspace.home })
          return <box />
        }
        const { client } = yield* mountClient({
          builtins: [shellProbe],
          initialSession: sessionNamed(sessionId, branchId, "Reload"),
          view: () => <Probe />,
        })
        const { ext, home } = yield* Effect.fromOption(held)
        yield* waitUntil(() => ext.loaded(), "the first load")
        const commandIds = () => ext.commands().map((command) => command.id)
        const dir = `${home}/.gent/extensions`
        yield* fs.makeDirectory(dir, { recursive: true })
        const hello = (command: string) =>
          `import { Effect } from "effect"
import { clientCommandContribution, defineClientExtension } from "@gent/tui/extensions"
export default defineClientExtension("@test/hello", {
  setup: Effect.succeed(clientCommandContribution({ id: "${command}", title: "${command}", onSelect: () => {} })),
})
`
        yield* fs.writeFileString(`${dir}/hello.client.ts`, hello("hello-v1"))
        expect(commandIds()).not.toContain("hello-v1")
        client.applySessionEvent(
          EventEnvelope.make({
            id: EventId.make(1),
            createdAt: 1,
            event: AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 10 }),
          }),
        )
        yield* waitUntil(() => commandIds().includes("hello-v1"), "the new file after the turn")
        yield* fs.writeFileString(`${dir}/hello.client.ts`, hello("hello-v22"))
        ;(yield* Effect.fromOption(shell)).reloadExtensions()
        yield* waitUntil(
          () => commandIds().includes("hello-v22") && !commandIds().includes("hello-v1"),
          "the edit after the shell's reload",
        )
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )
  it.live("a client reload keeps the widgets of an extension it kept mounted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      let mounts = 0
      let home = Option.none<string>()
      let shell = Option.none<ClientContext["Service"]["shell"]>()
      const counted = defineClientExtension("@test/counted-widget", {
        setup: Effect.gen(function* () {
          shell = Option.some((yield* ClientContext).shell)
          return clientContributions(
            widgetContribution({
              id: "counted",
              slot: "below-input",
              component: () => {
                mounts += 1
                home = Option.some(useWorkspace().home)
                return <text>counted widget</text>
              },
            }),
          )
        }),
      })
      const { setup, ext } = yield* mountApp({
        builtins: [counted],
        initialSession: sessionNamed(
          SessionId.make("session-kept-widget"),
          BranchId.make("branch-kept-widget"),
          "Kept",
        ),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("counted widget"), "the widget")
      const dir = `${yield* Effect.fromOption(home)}/.gent/extensions`
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(
        `${dir}/added.client.ts`,
        `import { Effect } from "effect"
import { clientCommandContribution, defineClientExtension } from "@gent/tui/extensions"
export default defineClientExtension("@test/added", {
  setup: Effect.succeed(clientCommandContribution({ id: "added", title: "added", onSelect: () => {} })),
})
`,
      )
      ;(yield* Effect.fromOption(shell)).reloadExtensions()
      yield* waitUntil(() => ext.commands().some((command) => command.id === "added"), "the reload")
      expect(renderFrame(setup)).toContain("counted widget")
      expect(mounts).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )
  // The pane turns an extension off in the configs of the session in view,
  // and the server loads that session's project: a move to a session rooted
  // in another project loads that project's client files, with no turn.
  it.scopedLive("a move to a session in another project loads that project's client files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "gent-session-place-" }),
      )
      const launch = `${root}/launch`
      const project = `${root}/project`
      yield* fs.makeDirectory(launch, { recursive: true })
      yield* fs.makeDirectory(`${project}/.gent/extensions`, { recursive: true })
      yield* fs.writeFileString(
        `${project}/.gent/extensions/there.client.ts`,
        `import { Effect } from "effect"
import { clientCommandContribution, defineClientExtension } from "@gent/tui/extensions"
export default defineClientExtension("@test/there", {
  setup: Effect.succeed(clientCommandContribution({ id: "there", title: "there", onSelect: () => {} })),
})
`,
      )
      const there = SessionId.make("session-place-there")
      let held = Option.none<{
        readonly ext: ReturnType<typeof useExtensionUI>
        readonly home: string
      }>()
      const Probe = () => {
        held = Option.some({ ext: useExtensionUI(), home: useWorkspace().home })
        return <box />
      }
      const { client } = yield* mountClient({
        cwd: launch,
        client: createMockClient({
          session: {
            get: (input: { readonly sessionId: SessionId }) =>
              Effect.succeed({
                ...sessionA,
                id: input.sessionId,
                cwd: Option.getOrElse(
                  Option.as(
                    Option.liftPredicate(input.sessionId, (id) => id === there),
                    project,
                  ),
                  () => launch,
                ),
              }),
          },
        }),
        initialSession: sessionNamed("session-place-here", "branch-place-here", "Here"),
        view: () => <Probe />,
      })
      const { ext, home } = yield* Effect.fromOption(held)
      yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
      const grant = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ trustedProjects: Schema.Array(Schema.String) })),
      )({ trustedProjects: [launch, project] })
      yield* fs.writeFileString(`${home}/.gent/config.json`, grant)
      yield* waitUntil(() => ext.loaded(), "the first load")
      const commandIds = () => ext.commands().map((command) => command.id)
      expect(commandIds()).not.toContain("there")
      client.switchSession(there, BranchId.make("branch-place-there"), "There")
      yield* waitUntil(() => commandIds().includes("there"), "the project of the session in view")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )
  it.scopedLive("a turn's end in the session in view reads extension health again", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-health-turn")
      const branchId = BranchId.make("branch-health-turn")
      let healthReads = 0
      const { client } = yield* mountClient({
        client: createMockClient({
          extension: {
            listStatus: () =>
              Effect.sync(() => {
                healthReads += 1
                return { _tag: "Healthy" satisfies "Healthy", extensions: [] }
              }),
          },
        }),
        initialSession: sessionNamed(sessionId, branchId, "Health"),
      })
      yield* waitUntil(() => healthReads >= 1, "the mount's health read")
      const before = healthReads
      client.applySessionEvent(
        EventEnvelope.make({
          id: EventId.make(1),
          createdAt: 1,
          event: AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 10 }),
        }),
      )
      yield* waitUntil(() => healthReads === before + 1, "the turn's health read")
    }).pipe(Effect.timeout("10 seconds")),
  )
  it.scopedLive("a /driver usage hint lands in the footer and never starts a model turn", () =>
    Effect.gen(function* () {
      const sentMessages: Array<{ readonly content: string }> = []
      const { setup } = yield* mountApp({
        client: {
          message: {
            send: (input: { readonly content: string }) =>
              Effect.sync(() => {
                sentMessages.push(input)
              }),
          },
        },
        width: 140,
        initialSession: sessionNamed("session-driver", "branch-driver", "Driver"),
      })
      yield* waitForFrame(setup, (frame) => frame.includes("ready ·"), "session view")
      yield* typeCommand("/driver")(setup)
      yield* waitForFrame(
        setup,
        (text) => text.includes("Usage: /driver <agent> <driver-id|default>"),
        "driver usage in the footer",
      )
      expect(sentMessages).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
})
